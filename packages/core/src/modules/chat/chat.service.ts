import { AIMessage, HumanMessage } from "@langchain/core/messages";

import type { Citation } from "#common/citation";
import type { SearchResult } from "#modules/retrieval/chunk.repository";
import type { RetrieveOptions } from "#modules/retrieval/retrieval.service";

import type { MessageRepository, SavePairArgs } from "./message.repository";
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
  // rerank 통과한 top-k(generator가 본 청크). 호출자 persist 시 retrievedChunkIds로 사용.
  chunks: SearchResult[];
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

export function createChatService(deps: {
  graph: RagGraph;
  messageRepo: MessageRepository;
  // persist용 라벨 — finish.model로 박제, retrievedChunkIds와 join 키 역할.
  modelId: string;
}) {
  const { graph, messageRepo, modelId } = deps;

  const ask: AskFn = async (query, opts = {}) => {
    const history = opts.conversationId
      ? await messageRepo.recentTurns(opts.conversationId, HISTORY_WINDOW)
      : [];

    const messages = [
      ...history.map((m) =>
        m.role === "user"
          ? new HumanMessage(m.content)
          : new AIMessage(m.content),
      ),
      new HumanMessage(query),
    ];

    // 최악 경로 14 노드: ha_rewrite → retrieve → rerank → grade_docs (fail) → mqr×2 + rerank+grade_docs ×2
    // → generate → grade_answer (fail) → regenerate → grade_answer → END. +1 안전 마진.
    const final = await graph.invoke({ messages }, { recursionLimit: 15 });

    const chunks: SearchResult[] = final.documents.map(
      (d) => d.metadata.searchResult,
    );
    const citations = final.citations ?? [];
    const answer = final.answer ?? "";

    // 인터페이스 호환을 위해 stream wrapper로 1회 emit. UI는 text-delta 한 번 + citation N건 burst로 받음.
    const textQueue = makeQueue<string>();
    const citationQueue = makeQueue<Citation>();
    textQueue.push(answer);
    textQueue.end();
    for (const c of citations) citationQueue.push(c);
    citationQueue.end();

    return {
      textStream: textQueue.iterable(),
      citationStream: citationQueue.iterable(),
      chunks,
      // usage 토큰 카운트는 LangChain ChatOpenAI usage_metadata 노출 경로가 별도 — 후속 슬라이스에서 callback으로.
      finish: Promise.resolve({
        text: answer,
        citations,
        inputTokens: undefined,
        outputTokens: undefined,
        finishReason: "stop",
        model: modelId,
      }),
    };
  };

  return {
    ask,
    async recordChatTurn(args: SavePairArgs): Promise<void> {
      await messageRepo.savePair(args);
    },
  };
}
