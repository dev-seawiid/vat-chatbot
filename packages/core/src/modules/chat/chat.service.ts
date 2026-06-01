import { AIMessage, type BaseMessage, HumanMessage } from "@langchain/core/messages";

import type { Citation } from "#common/citation";
import type { RetrieveOptions, SearchResult } from "#modules/retrieval/index";

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

// AskResult를 한 곳에서 만들어 ask/answer 두 메서드가 공유 — 직렬화 로직 중복 차단.
function toAskResult(args: {
  answer: string;
  citations: Citation[];
  chunks: SearchResult[];
  modelId: string;
}): AskResult {
  const { answer, citations, chunks, modelId } = args;
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
  const ask: AskFn = async (query, opts = {}) => {
    const messages = await buildMessages(query, opts.conversationId);
    const final = await rag.graph.invoke({ messages }, { recursionLimit: 10 });
    return toAskResult({
      answer: final.answer ?? "",
      citations: final.citations ?? [],
      chunks: final.toolChunks ?? [],
      modelId,
    });
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
