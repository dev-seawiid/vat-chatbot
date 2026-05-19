import { stepCountIs, streamText } from "ai";

import { type Citation, toCitation } from "#common/citation";
import { AI_SDK_TELEMETRY } from "#common/telemetry";
import type { SearchResult } from "#modules/retrieval/chunk.repository";
import type {
  RetrievalService,
  RetrieveOptions,
} from "#modules/retrieval/retrieval.service";

import type { GenerationModel } from "./generation.adapter";
import type {
  MessageRepository,
  SavePairArgs,
} from "./message.repository";
import { buildSystemMessage } from "./prompt";
import { CiteChunkInputSchema, tools } from "./tools";

export type AskOptions = RetrieveOptions & {
  /** 주입 시 messageRepo.recentTurns로 history fetch → multi-turn. 미주입 시 single-turn. */
  conversationId?: string;
};

export type AskResult = {
  textStream: AsyncIterable<string>;
  /** cite_chunk 호출 + quote 검증 통과 시점에 1건씩 emit. */
  citationStream: AsyncIterable<Citation>;
  chunks: SearchResult[];
  /** stream 종료 시 resolve. citations는 검증 통과 누적 list. */
  finish: Promise<{
    text: string;
    citations: Citation[];
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    finishReason: string;
    model: string;
  }>;
};

export type AskFn = (query: string, opts?: AskOptions) => Promise<AskResult>;

export type ChatService = ReturnType<typeof createChatService>;

// 한 fullStream을 두 AsyncIterable로 fan-out — 단일 소비자 큐.
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

// strict substring — UI highlight 좌표 정확성을 위해 normalize 없이 그대로.
function findQuoteStart(content: string, quote: string): number {
  return content.indexOf(quote);
}

// window cap이 메시지 수 기준 — 6 = user+assistant 짝 3 round-trip.
const HISTORY_WINDOW = 6;

export function createChatService(deps: {
  retrieval: RetrievalService;
  generationModel: GenerationModel;
  messageRepo: MessageRepository;
}) {
  const { retrieval, generationModel, messageRepo } = deps;
  const { model, modelId } = generationModel;

  const ask: AskFn = async (query, opts = {}) => {
    const chunks = await retrieval.retrieve(query, {
      k: opts.k,
      filter: opts.filter,
    });
    const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));

    const history = opts.conversationId
      ? await messageRepo.recentTurns(opts.conversationId, HISTORY_WINDOW)
      : [];

    const result = streamText({
      model,
      system: buildSystemMessage(chunks),
      messages: [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: query },
      ],
      tools,
      stopWhen: stepCountIs(5),
      experimental_telemetry: AI_SDK_TELEMETRY,
    });

    const textQueue = makeQueue<string>();
    const citationQueue = makeQueue<Citation>();
    const citations: Citation[] = [];

    const finish = (async () => {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            textQueue.push(part.text);
          } else if (
            part.type === "tool-call" &&
            part.toolName === "cite_chunk"
          ) {
            // dynamic/invalid tool-call이 섞일 수 있어 unknown으로 받고 safeParse.
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
