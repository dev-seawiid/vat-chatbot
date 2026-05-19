import { traceRetriever } from "#common/telemetry";

import type { EmbedFn } from "./embedding.adapter";
import type {
  ChunkRepository,
  SearchFilter,
  SearchResult,
} from "./chunk.repository";

export type RetrieveOptions = {
  k?: number;
  filter?: SearchFilter;
};

export type RetrieveFn = (
  query: string,
  opts?: RetrieveOptions,
) => Promise<SearchResult[]>;

export type RetrievalService = ReturnType<typeof createRetrievalService>;

// spec §3.2 — top-k=8 (recall과 system prompt 길이 균형). 호출자가 opts.k로 override 가능.
const DEFAULT_TOP_K = 8;

/**
 * spec §3.2 retrieval — 질문 텍스트를 query 모드로 임베딩 후 chunk repository.search 합성.
 * CLI(scripts/retrieve.ts)에서 직접 호출하므로 service로 단독 노출(chat service 내부가 아님).
 */
export function createRetrievalService(deps: {
  embed: EmbedFn;
  chunkRepo: ChunkRepository;
}) {
  const { embed, chunkRepo } = deps;
  const retrieve: RetrieveFn = traceRetriever(
    {
      name: "retrieval",
      attrs: ([query, opts]) => ({
        input: {
          query,
          k: opts?.k ?? DEFAULT_TOP_K,
          filter: opts?.filter ?? null,
        },
      }),
      // content 전문 박제 — Ragas류 evaluator 입력 + 디버깅에서 어떤 청크였는지 한 화면에.
      output: (results) => ({
        count: results.length,
        topSimilarity: results[0]?.similarity ?? null,
        contexts: results.map((r) => ({
          chunkId: r.chunkId,
          docTitle: r.docTitle,
          page: r.page,
          similarity: r.similarity,
          content: r.content,
        })),
      }),
    },
    async (query, opts = {}) => {
      const k = opts.k ?? DEFAULT_TOP_K;
      const queryEmbedding = await embed(query, { input_type: "query" });
      return chunkRepo.search({
        embedding: queryEmbedding,
        k,
        filter: opts.filter,
      });
    },
  );
  return { retrieve };
}
