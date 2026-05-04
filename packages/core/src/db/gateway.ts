import { sql } from "drizzle-orm";

import { getDb } from "./client";

// spec §2.1 인터페이스의 W2 부분 — chunks.search만. 다른 도메인(messages/feedback/audit/eval)은
// 도입되는 주차에 같은 gateway 객체에 추가한다.

export type SearchFilter = {
  // metadata.tax_type 정확 일치. spec §3.1 라벨 컨벤션의 `vat-general`/`vat-simplified`/
  // `vat-common` 중 하나, 또는 미래 세목 prefix(`inc-`/`corp-` 등).
  tax_type?: string;
};

export type SearchOptions = {
  embedding: number[];
  k?: number;
  filter?: SearchFilter;
};

export type SearchResult = {
  chunk_id: string;
  doc_id: string;
  doc_title: string;
  doc_version: string | null;
  page: number | null;
  section_path: string | null;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

export const gateway = {
  chunks: {
    /**
     * spec §3.2 retrieval SQL — pgvector cosine top-k + tax_type 메타 필터.
     * version 가중·최신 우선은 의도적으로 SQL 밖에 둠(generation 단 정책).
     * documents JOIN으로 인용 모달 표시에 필요한 doc_title·doc_version까지 한 번에 반환.
     */
    async search({
      embedding,
      k = 8,
      filter,
    }: SearchOptions): Promise<SearchResult[]> {
      const db = getDb();
      // pgvector 바인딩은 "[a,b,c]" 텍스트 → ::vector 캐스트 형태가 가장 폭넓게 호환.
      // postgres-js에 array 직접 바인딩은 dimension 메타 손실 위험이 있어 회피.
      const vec = `[${embedding.join(",")}]`;
      const taxType = filter?.tax_type ?? null;

      const rows = await db.execute<SearchResult>(sql`
        SELECT c.id::text                            AS chunk_id,
               c.doc_id::text                        AS doc_id,
               d.title                               AS doc_title,
               d.version                             AS doc_version,
               c.page,
               c.section_path,
               c.content,
               c.metadata,
               1 - (c.embedding <=> ${vec}::vector)  AS similarity
        FROM chunks c
        JOIN documents d ON d.id = c.doc_id
        WHERE (${taxType}::text IS NULL OR c.metadata->>'tax_type' = ${taxType}::text)
        ORDER BY c.embedding <=> ${vec}::vector
        LIMIT ${k}
      `);
      return rows as unknown as SearchResult[];
    },
  },
};
