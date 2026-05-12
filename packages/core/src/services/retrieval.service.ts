import type { EmbedFn } from "../providers/embedding";
import type {
  ChunkRepository,
  SearchFilter,
  SearchResult,
} from "../repositories/chunk.repository";

export type RetrieveOptions = {
  k?: number;
  filter?: SearchFilter;
};

export type RetrieveFn = (
  query: string,
  opts?: RetrieveOptions,
) => Promise<SearchResult[]>;

export type RetrievalService = ReturnType<typeof createRetrievalService>;

/**
 * spec §3.2 retrieval — 질문 텍스트를 query 모드로 임베딩 후 chunk repository.search 합성.
 * CLI(scripts/retrieve.ts)에서 직접 호출하므로 service로 단독 노출(chat service 내부가 아님).
 */
export function createRetrievalService(deps: {
  embed: EmbedFn;
  chunkRepo: ChunkRepository;
}) {
  const { embed, chunkRepo } = deps;
  const retrieve: RetrieveFn = async (query, opts = {}) => {
    const queryEmbedding = await embed(query, { input_type: "query" });
    return chunkRepo.search({
      embedding: queryEmbedding,
      k: opts.k ?? 8,
      filter: opts.filter,
    });
  };
  return { retrieve };
}
