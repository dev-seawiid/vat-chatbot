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

// 데이터 모델은 spec §2가 정의한다 — 본 파일이 그 spec을 코드로 구현하는 단일 진실.
// W1에선 documents + chunks만 정의하고, 나머지(conversations/messages/feedback/audit_log/
// eval_*/users)는 도입되는 주차(W2~W4)에 추가한다.

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  sourceUrl: text("source_url"),
  version: text("version"),
  // file_hash UNIQUE — 같은 파일을 두 번 ingest해도 documents 한 행만 유지(idempotent fetch).
  // spec §3.1 "documents.file_hash UNIQUE" invariant.
  fileHash: text("file_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docId: uuid("doc_id")
      .notNull()
      // 부모 documents 행 삭제 시 청크도 함께 정리 — orphan 청크가 검색 결과에 섞이는 사고 방지.
      .references(() => documents.id, { onDelete: "cascade" }),
    page: integer("page"),
    sectionPath: text("section_path"),
    content: text("content").notNull(),
    // 청크 내용 식별자 — 임베딩 캐시 키와 동일. 재실행/재크롤 안전성에 핵심.
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // spec §2.1 invariant — 같은 doc 안에서 동일 청크 중복 방지(서로 다른 doc은 동일 텍스트 가능).
    uqDocContent: unique("uq_chunks_doc_content_hash").on(t.docId, t.contentHash),
    docIdIdx: index("idx_chunks_doc_id").on(t.docId),
    // 벡터 검색 인덱스 — spec §2 결정에 따라 HNSW + cosine. 파라미터(m·ef_construction)는
    // pgvector 기본값(16/64)으로 두고, ef_search는 SQL 런타임 SET으로 조정.
    embeddingIdx: index("idx_chunks_embedding").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);
