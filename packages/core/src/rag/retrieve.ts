import type {
  Gateway,
  SearchFilter,
  SearchResult,
} from "../db/gateway";
import type { EmbedFn } from "../providers/embedding";

export type RetrieveOptions = {
  k?: number;
  filter?: SearchFilter;
};

export type RetrieveFn = (
  query: string,
  opts?: RetrieveOptions,
) => Promise<SearchResult[]>;

/**
 * spec §3.2 retrieval — 질문 텍스트를 query 모드로 임베딩 후 chunks.search 합성.
 * 두 단계를 같은 함수에서 묶어 호출자(/api/chat, eval runner)는 한 줄로 사용.
 */
export function createRetrieve({
  embed,
  gateway,
}: {
  embed: EmbedFn;
  gateway: Gateway;
}): RetrieveFn {
  return async (query, opts = {}) => {
    const queryEmbedding = await embed(query, { input_type: "query" });
    return gateway.chunks.search({
      embedding: queryEmbedding,
      k: opts.k ?? 8,
      filter: opts.filter,
    });
  };
}
