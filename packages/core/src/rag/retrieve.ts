import { gateway, type SearchFilter, type SearchResult } from "../db/gateway";
import { embed } from "./voyage";

export type RetrieveOptions = {
  k?: number;
  filter?: SearchFilter;
};

/**
 * spec §3.2 retrieval — 질문 텍스트를 query 모드로 임베딩 후 chunks.search 합성.
 * 두 단계를 같은 함수에서 묶어 호출자(/api/chat, eval runner)는 한 줄로 사용.
 */
export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<SearchResult[]> {
  const queryEmbedding = await embed(query, { input_type: "query" });
  return gateway.chunks.search({
    embedding: queryEmbedding,
    k: opts.k ?? 8,
    filter: opts.filter,
  });
}
