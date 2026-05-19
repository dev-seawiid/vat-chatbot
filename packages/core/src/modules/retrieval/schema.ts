import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const documents = pgTable("documents", {
  id: uuid().primaryKey().defaultRandom(),
  title: text().notNull(),
  sourceUrl: text(),
  version: text(),
  fileHash: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const chunks = pgTable(
  "chunks",
  {
    id: uuid().primaryKey().defaultRandom(),
    docId: uuid()
      .notNull()
      // 부모 documents 행 삭제 시 청크도 함께 정리 — orphan 청크가 검색 결과에 섞이는 사고 방지.
      .references(() => documents.id, { onDelete: "cascade" }),
    page: integer(),
    sectionPath: text(),
    content: text().notNull(),
    // 청크 내용 식별자 — 임베딩 캐시 키와 동일. 재실행/재크롤 안전성에 핵심.
    contentHash: text().notNull(),
    embedding: vector({ dimensions: 1024 }).notNull(),
    metadata: jsonb().notNull().default({}),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // 같은 doc 안에서 동일 청크 중복 방지(서로 다른 doc은 동일 텍스트 가능).
    uqDocContent: unique("uq_chunks_doc_content_hash").on(
      t.docId,
      t.contentHash,
    ),
    docIdIdx: index("idx_chunks_doc_id").on(t.docId),
    // 벡터 검색 인덱스 — spec §2 결정에 따라 HNSW + cosine. 파라미터(m·ef_construction)는
    // pgvector 기본값(16/64)으로 두고, ef_search는 SQL 런타임 SET으로 조정.
    embeddingIdx: index("idx_chunks_embedding").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);
