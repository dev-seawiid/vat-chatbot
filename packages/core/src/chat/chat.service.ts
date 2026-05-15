import { stepCountIs, streamText, type TelemetrySettings } from "ai";

import { type Citation, toCitation } from "../shared/citation";
import type { GenerationModel } from "../adapters/generation";
import type { SearchResult } from "../retrieval/chunk.repository";
import type { RetrievalService, RetrieveOptions } from "../retrieval/retrieval.service";
import type {
  MessageRepository,
  SavePairArgs,
} from "./message.repository";
import { buildSystemMessage } from "./prompt";
import { CiteChunkInputSchema, tools } from "./tools";

export type AskOptions = RetrieveOptions;

export type AskResult = {
  /** 답변 본문 토큰 — [n] 같은 마커는 박히지 않는다. plain text 그대로 렌더. */
  textStream: AsyncIterable<string>;
  /** 모델이 cite_chunk를 호출할 때마다 검증 통과한 인용 1건씩 emit. tool-call 시점이
   *  곧 인용 선언이므로 본문 텍스트와 시간 순서가 일치한다. */
  citationStream: AsyncIterable<Citation>;
  /** retrieve가 고른 청크 원본 — messages.retrievedChunkIds 박제용. */
  chunks: SearchResult[];
  /** stream 종료 시점에 resolve — citations는 본 ask에서 검증 통과한 누적 list. */
  finish: Promise<{
    text: string;
    citations: Citation[];
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    finishReason: string;
    /** 이번 호출에서 실제로 사용한 모델 ID — messages.model 라벨로 그대로 기록 */
    model: string;
  }>;
};

export type AskFn = (query: string, opts?: AskOptions) => Promise<AskResult>;

export type ChatService = ReturnType<typeof createChatService>;

// 백그라운드 fullStream 소비를 두 AsyncIterable로 fan-out하기 위한 단일 소비자 큐.
// AI SDK의 fullStream은 단일 소비라 직접 두 곳에서 await for할 수 없다 — 본 큐로
// text와 citation을 분리 채널로 push한 뒤 외부엔 iterable만 노출한다.
type QueueItem<T> = { done: false; value: T } | { done: true };

function makeQueue<T>() {
  const buffer: QueueItem<T>[] = [];
  const waiters: ((item: QueueItem<T>) => void)[] = [];

  return {
    push(value: T) {
      const item: QueueItem<T> = { done: false, value };
      const w = waiters.shift();
      if (w) w(item);
      else buffer.push(item);
    },
    end() {
      const item: QueueItem<T> = { done: true };
      while (waiters.length) waiters.shift()!(item);
      buffer.push(item);
    },
    async *iterable(): AsyncGenerator<T> {
      while (true) {
        const next = buffer.length
          ? buffer.shift()!
          : await new Promise<QueueItem<T>>((resolve) => waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

// quote 검증 — chunk 본문 안 strict substring으로 위치까지 한 번에 결정. normalize 없음:
// content 좌표와 일치하는 quoteStart를 박제해야 UI highlight가 정확하므로, 통과 조건을
// "원본 그대로의 substring"으로 좁힌다(prompt에서 quote를 chunk 본문에서 그대로 발췌하라고
// 명시 — 모델이 paraphrase하면 verify가 -1로 fail해서 drop). 실패율이 의미 있게 높아지면
// fuzzy fallback 도입은 후속 슬라이스.
function findQuoteStart(content: string, quote: string): number {
  return content.indexOf(quote);
}

/**
 * spec §3.3 — chat 도메인 use case. ask(질문 → 두 stream + finish meta)와 recordChatTurn
 * (영속화)을 묶는다. controller(apps/web route handler, eval CLI)는 본 service만 호출하고
 * repository를 직접 보지 않는다.
 *
 * 인용 메커니즘은 본문 [n] 마커가 아닌 cite_chunk tool 호출 — 모델이 chunkId/quote를
 * tool 인자로 직접 선언하면, fullStream 순회가 그 tool-call 이벤트를 가로채 quote가 실제
 * chunk content에 substring으로 존재하는지 검증 후 citationStream으로 emit한다(post-hoc
 * verify). 검증 실패한 인용은 drop — 모델 환각이 클라까지 새지 않도록.
 *
 * tool-call 라운드트립을 허용하도록 stopWhen=stepCountIs(5) — calc_vat·cite_chunk 호출 후
 * 답변 생성 마무리까지.
 */
export function createChatService(deps: {
  retrieval: RetrievalService;
  generationModel: GenerationModel;
  messageRepo: MessageRepository;
  /** AI SDK telemetry settings — undefined면 spans 미발생. 켤지 여부와 functionId는 composition
   *  root가 결정한다(라이브러리는 OTEL 부팅 상태를 모르므로 enable 결정권 없음). */
  telemetry?: TelemetrySettings;
}) {
  const { retrieval, generationModel, messageRepo, telemetry } = deps;
  const { model, modelId } = generationModel;

  const ask: AskFn = async (query, opts = {}) => {
    const chunks = await retrieval.retrieve(query, {
      k: opts.k,
      filter: opts.filter,
    });
    const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));

    const result = streamText({
      model,
      system: buildSystemMessage(chunks),
      prompt: query,
      tools,
      stopWhen: stepCountIs(5),
      experimental_telemetry: telemetry,
    });

    const textQueue = makeQueue<string>();
    const citationQueue = makeQueue<Citation>();
    const citations: Citation[] = [];

    // fullStream을 단일 백그라운드 루프로 소비하면서 두 큐로 분기. finish promise는
    // 본 루프가 종료된 뒤 usage·text·finishReason을 모아 resolve한다. 외부 소비자가
    // textStream/citationStream을 await for 하면 push에 의해 자연 backpressure 발생.
    const finish = (async () => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            textQueue.push(part.text);
          } else if (
            part.type === "tool-call" &&
            part.toolName === "cite_chunk"
          ) {
            // part.input은 SDK 타입상 zod-추론된 형태이지만 dynamic/invalid 분기가
            // 섞일 수 있어 unknown으로 받고 safeParse로 결정적으로 좁힌다 — 모델이
            // schema 외 형태로 호출하면 drop. as 단언 대신 zod runtime 검증.
            const parsed = CiteChunkInputSchema.safeParse(part.input);
            if (!parsed.success) continue;
            const { chunkId, quote } = parsed.data;
            const chunk = chunkById.get(chunkId);
            if (!chunk) continue;
            const quoteStart = findQuoteStart(chunk.content, quote);
            if (quoteStart < 0) continue;
            const citation = toCitation(chunk, quote, quoteStart);
            citations.push(citation);
            citationQueue.push(citation);
          }
        }
      } finally {
        textQueue.end();
        citationQueue.end();
      }

      const usage = await result.usage;
      return {
        text: await result.text,
        citations,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        finishReason: await result.finishReason,
        model: modelId,
      };
    })();

    return {
      textStream: textQueue.iterable(),
      citationStream: citationQueue.iterable(),
      chunks,
      finish,
    };
  };

  return {
    ask,
    async recordChatTurn(args: SavePairArgs): Promise<void> {
      await messageRepo.savePair(args);
    },
  };
}
