import { cosineDistance, eq, sql } from "drizzle-orm";

import { traceSpan } from "#common/telemetry";
import type { Db } from "#database/client";

import { chunks, documents } from "./schema";

// spec §2.1 — chunks aggregate에 대한 Repository. Drizzle 객체 + SQL을 외부에 노출하지 않고
// retrieval service가 본 모듈을 통해서만 query.

export type SearchFilter = {
  // metadata.tax_type(jsonb 키는 spec §3.1의 snake case 그대로) 정확 일치 필터. 도메인 표면
  // 컨벤션은 camelCase로 통일해 TS 호출자가 SQL 내부 키와 분리되도록 한다.
  taxType?: string;
};

export type SearchOptions = {
  embedding: number[];
  k?: number;
  filter?: SearchFilter;
};

export type SearchResult = {
  chunkId: string;
  docId: string;
  sourceId: string;
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
   * spec §3.2 retrieval — pgvector cosineDistance(<=>) top-k + tax_type 메타 필터.
   * version 가중·최신 우선은 의도적으로 builder 밖에 둠(generation 단 정책).
   * documents JOIN으로 인용 모달 표시에 필요한 docTitle·docVersion까지 한 번에 반환.
   * Drizzle builder가 SELECT alias를 객체 키로 자동 매핑 → 도메인은 camelCase 유지.
   */
  const search = traceSpan(
    {
      name: "pgvector.search",
      attrs: ([{ embedding, k = 8, filter }]) => ({
        input: { k, filter: filter ?? null, dim: embedding.length },
      }),
      output: (rows) => ({
        hitCount: rows.length,
        topSimilarity: rows[0]?.similarity ?? null,
      }),
    },
    async ({
      embedding,
      k = 8,
      filter,
    }: SearchOptions): Promise<SearchResult[]> => {
      const distance = cosineDistance(chunks.embedding, embedding);
      const taxType = filter?.taxType ?? null;

      return db
        .select({
          chunkId: sql<string>`${chunks.id}::text`.as("chunkId"),
          docId: sql<string>`${chunks.docId}::text`.as("docId"),
          // chunks.metadata jsonb의 키는 spec §3.1 컨벤션 그대로(snake) — SQL 내부의 키이므로
          // 도메인 camel 표면과 격리. ingest 단(Python)이 동일 키로 적재.
          sourceId: sql<string>`${chunks.metadata}->>'source_id'`.as("sourceId"),
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
        .where(
          sql`(${taxType}::text IS NULL OR ${chunks.metadata}->>'tax_type' = ${taxType}::text)`,
        )
        .orderBy(distance)
        .limit(k) as Promise<SearchResult[]>;
    },
  );

  /**
   * 조문 번호 직접 조회 — agent의 `article_lookup` 도구 백엔드.
   * metadata.law·article·paragraph로 필터, embedding 무관.
   * paragraph가 주어지면 정확 일치, 없으면 같은 law·article의 모든 항을 반환.
   */
  const findByArticle = traceSpan(
    {
      name: "pgvector.find_by_article",
      attrs: ([{ law, article, paragraph }]) => ({
        input: { law, article, paragraph: paragraph ?? null },
      }),
      output: (rows) => ({ hitCount: rows.length }),
    },
    async ({
      law,
      article,
      paragraph,
    }: {
      law: string;
      article: string;
      paragraph?: number;
    }): Promise<SearchResult[]> => {
      const paragraphVal = paragraph ?? null;

      return db
        .select({
          chunkId: sql<string>`${chunks.id}::text`.as("chunkId"),
          docId: sql<string>`${chunks.docId}::text`.as("docId"),
          sourceId: sql<string>`${chunks.metadata}->>'source_id'`.as("sourceId"),
          docTitle: documents.title,
          docVersion: documents.version,
          sourceUrl: documents.sourceUrl,
          page: chunks.page,
          sectionPath: chunks.sectionPath,
          content: chunks.content,
          metadata: chunks.metadata,
          // 임베딩 비교가 없으니 0으로 둠 — SearchResult 인터페이스만 맞춤. agent는 similarity를 안 봄.
          similarity: sql<number>`0`.as("similarity"),
        })
        .from(chunks)
        .innerJoin(documents, eq(documents.id, chunks.docId))
        .where(
          sql`${chunks.metadata}->>'law' = ${law} AND ${chunks.metadata}->>'article' = ${article} AND (${paragraphVal}::int IS NULL OR (${chunks.metadata}->>'paragraph')::int = ${paragraphVal}::int)`,
        )
        .orderBy(
          sql`COALESCE((${chunks.metadata}->>'paragraph')::int, 0), COALESCE((${chunks.metadata}->>'item')::int, 0)`,
        ) as Promise<SearchResult[]>;
    },
  );

  return { search, findByArticle };
}
