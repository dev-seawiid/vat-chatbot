import { cosineDistance, eq, sql } from "drizzle-orm";

import { traceSpan } from "#common/telemetry";
import type { Db } from "#database/client";
import { chunks, documents } from "#database/schema/retrieval";

// spec §2.1 — chunks aggregate에 대한 Repository. Drizzle 객체 + SQL을 외부에 노출하지 않고
// retrieval service가 본 모듈을 통해서만 query.

export type SearchOptions = {
  embedding: number[];
  k?: number;
};

export type SearchResult = {
  chunkId: string;
  docId: string;
  docTitle: string;
  docVersion: string | null;
  // documents.source_url — sources.json의 url(예: NTS 다운로드 링크). UI 인용 패널에서
  // "원본 PDF 다운로드" 앵커로 사용. 적재 시 nullable이므로 호출자도 분기 처리.
  sourceUrl: string | null;
  page: number | null;
  sectionPath: string | null;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

export type ChunkRepository = ReturnType<typeof createChunkRepository>;

export function createChunkRepository(db: Db) {
  /**
   * spec §3.2 retrieval — pgvector cosineDistance(<=>) top-k.
   * version 가중·최신 우선은 의도적으로 builder 밖에 둠(generation 단 정책).
   * documents JOIN으로 인용 모달 표시에 필요한 docTitle·docVersion까지 한 번에 반환.
   * Drizzle builder가 SELECT alias를 객체 키로 자동 매핑 → 도메인은 camelCase 유지.
   */
  const search = traceSpan(
    {
      name: "pgvector.search",
      attrs: ([{ embedding, k = 8 }]) => ({
        input: { k, dim: embedding.length },
      }),
      output: (rows) => ({
        hitCount: rows.length,
        topSimilarity: rows[0]?.similarity ?? null,
      }),
    },
    async ({ embedding, k = 8 }: SearchOptions): Promise<SearchResult[]> => {
      const distance = cosineDistance(chunks.embedding, embedding);

      return db
        .select({
          chunkId: sql<string>`${chunks.id}::text`.as("chunkId"),
          docId: sql<string>`${chunks.docId}::text`.as("docId"),
          docTitle: documents.title,
          docVersion: documents.version,
          sourceUrl: documents.sourceUrl,
          page: chunks.page,
          sectionPath: chunks.sectionPath,
          content: chunks.content,
          metadata: chunks.metadata,
          similarity: sql<number>`1 - (${distance})`.as("similarity"),
        })
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.docId))
        .orderBy(distance)
        .limit(k) as Promise<SearchResult[]>;
    },
  );

  return { search };
}
