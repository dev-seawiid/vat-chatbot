import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";

import type { Citation } from "#common/citation";
import type { RetrieveOptions, SearchResult } from "#modules/retrieval/index";

import type { MessageRepository, SavePairArgs } from "./message.repository";
import {
  makeStagePusher,
  NODE_STAGE,
  type ProgressEvent,
} from "./progress";
import type { RagGraph } from "./rag-graph";

// k/filter는 현재 graph 내부 retriever가 고정 옵션(k=50)으로 동작 — CLI(scripts/ask.ts) 인자는
// 수신만 하고 효과 없음. 후속 슬라이스에서 RagState로 전파해 wire-through 예정.
export type AskOptions = RetrieveOptions & {
  /** 주입 시 messageRepo.recentTurns로 history fetch → multi-turn. 미주입 시 single-turn. */
  conversationId?: string;
};

export type AskResult = {
  // ADR-0003 §3 — 본문 token streaming 폐기. 인터페이스 보존을 위해 stream으로 노출하되 1회 emit.
  textStream: AsyncIterable<string>;
  citationStream: AsyncIterable<Citation>;
  // ADR-0003 §8 — retrieval 단계별 진행 stage. 노드 완료마다 emit, 그래프 종료 시 end.
  eventStream: AsyncIterable<ProgressEvent>;
  finish: Promise<{
    text: string;
    citations: Citation[];
    // rerank 통과한 top-k(generator가 본 청크). persist retrievedChunkIds 키 — 그래프 완료 후 확정.
    chunks: SearchResult[];
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    finishReason: string;
    model: string;
  }>;
};

export type AskFn = (query: string, opts?: AskOptions) => Promise<AskResult>;
export type RetrieveFn = (query: string) => Promise<{ chunks: SearchResult[] }>;
export type GenerateFn = (
  query: string,
  chunks: SearchResult[],
) => Promise<AskResult>;

export type ChatService = ReturnType<typeof createChatService>;

// 한 결과를 textStream/citationStream으로 분기 — single emit이지만 기존 소비자 인터페이스 보존.
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

// window cap이 메시지 수 기준 — 6 = user+assistant 짝 3 round-trip.
const HISTORY_WINDOW = 6;

// 이미 완성된 결과(generate/eval 경로)를 AskResult로 — live 이벤트 없음, eventStream 즉시 end.
function toAskResult(args: {
  answer: string;
  citations: Citation[];
  chunks: SearchResult[];
  modelId: string;
}): AskResult {
  const { answer, citations, chunks, modelId } = args;
  const textQueue = makeQueue<string>();
  const citationQueue = makeQueue<Citation>();
  const eventQueue = makeQueue<ProgressEvent>();
  textQueue.push(answer);
  textQueue.end();
  for (const c of citations) citationQueue.push(c);
  citationQueue.end();
  eventQueue.end();

  return {
    textStream: textQueue.iterable(),
    citationStream: citationQueue.iterable(),
    eventStream: eventQueue.iterable(),
    // usage 토큰 카운트는 LangChain ChatOpenAI usage_metadata 노출 경로가 별도 — 후속 슬라이스에서 callback으로.
    finish: Promise.resolve({
      text: answer,
      citations,
      chunks,
      inputTokens: undefined,
      outputTokens: undefined,
      finishReason: "stop",
      model: modelId,
    }),
  };
}

export function createChatService(deps: {
  rag: RagGraph;
  messageRepo: MessageRepository;
  // persist용 라벨 — finish.model로 박제, retrievedChunkIds와 join 키 역할.
  modelId: string;
}) {
  const { rag, messageRepo, modelId } = deps;

  // history fetch → messages 빌드. ask/answer 공유 (retrieve는 history 무관 — query만).
  async function buildMessages(
    query: string,
    conversationId: string | undefined,
  ): Promise<BaseMessage[]> {
    const history = conversationId
      ? await messageRepo.recentTurns(conversationId, HISTORY_WINDOW)
      : [];
    return [
      ...history.map((m) =>
        m.role === "user"
          ? new HumanMessage(m.content)
          : new AIMessage(m.content),
      ),
      new HumanMessage(query),
    ];
  }

  // full pipeline — RAG 그래프(rewrite_query → 결정적 search 노드 + RRF fuse → answer structured output).
  // graph.stream으로 소비 — 노드 완료마다 progress stage emit(ADR-0003 §8), 종료 시 text/citation 1회 emit.
  // ask가 그래프 완주 전에 반환하므로 background로 drain. server의 propagateAttributes ALS scope
  // 안에서 IIFE가 생성돼 노드 span의 trace 속성 전파가 유지된다.
  const ask: AskFn = async (query, opts = {}) => {
    const messages = await buildMessages(query, opts.conversationId);

    const textQueue = makeQueue<string>();
    const citationQueue = makeQueue<Citation>();
    const eventQueue = makeQueue<ProgressEvent>();
    const pushStage = makeStagePusher((event) => eventQueue.push(event));

    type NodeDelta = {
      toolChunks?: SearchResult[];
      answer?: string;
      citations?: Citation[];
    };

    const finish = (async () => {
      let answerText = "";
      let citations: Citation[] = [];
      let chunks: SearchResult[] = [];
      try {
        pushStage("analyzing");
        const stream = await rag.graph.stream(
          { messages },
          { streamMode: "updates", subgraphs: true, recursionLimit: 10 },
        );
        for await (const [, update] of stream) {
          for (const [node, delta] of Object.entries(
            update as Record<string, NodeDelta>,
          )) {
            const stage = NODE_STAGE[node];
            if (stage) pushStage(stage);
            if (delta.toolChunks) chunks = delta.toolChunks;
            if (delta.answer != null) answerText = delta.answer;
            if (delta.citations) citations = delta.citations;
          }
        }
      } finally {
        // 성공·실패 무관 큐 종료 — 소비자 pump가 무한 대기하지 않도록. 실패 시 throw는
        // finally 후 전파돼 finish reject → 소비자의 await finish에서 surface.
        textQueue.push(answerText);
        textQueue.end();
        for (const c of citations) citationQueue.push(c);
        citationQueue.end();
        eventQueue.end();
      }
      return {
        text: answerText,
        citations,
        chunks,
        inputTokens: undefined,
        outputTokens: undefined,
        finishReason: "stop",
        model: modelId,
      };
    })();

    return {
      textStream: textQueue.iterable(),
      citationStream: citationQueue.iterable(),
      eventStream: eventQueue.iterable(),
      finish,
    };
  };

  // retrieval-only — lbr-eval(LegalBench-RAG)용. generate_answer 노드 우회.
  // generation LLM은 draft 1회만 호출(HyDE+claims). history 무관 — 단일 query만.
  const retrieve: RetrieveFn = async (query) => {
    return rag.retrievalOnly([new HumanMessage(query)]);
  };

  // generation-only — 외부 주입 chunks로 answer만. eval factorial design·디버깅·재현 테스트용.
  // history 무관 — 단일 query + chunks.
  const generate: GenerateFn = async (query, chunks) => {
    const result = await rag.generateOnly([new HumanMessage(query)], chunks);
    return toAskResult({
      answer: result.answer,
      citations: result.citations,
      chunks: result.chunks,
      modelId,
    });
  };

  return {
    ask,
    retrieve,
    generate,
    async recordChatTurn(args: SavePairArgs): Promise<void> {
      await messageRepo.savePair(args);
    },
  };
}
