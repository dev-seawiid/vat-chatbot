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

// spec §3.4 인용 객체 — 별도 모듈을 두지 않고 schema와 함께 두어 jsonb 컬럼 타이핑에 직접 사용.
// rag/ 레이어는 이 타입을 import해 retrieve 결과를 변환한다.
export type Citation = {
  chunk_id: string;
  doc_id: string;
  doc_title: string;
  doc_version: string | null;
  page: number | null;
  section_path: string | null;
  snippet: string;
};

// 데이터 모델은 spec §2가 정의한다 — 본 파일이 그 spec을 코드로 구현하는 단일 진실.
// W1: documents + chunks (ingest)
// W3: conversations + messages (chat 영속) — feedback/audit_log/eval_*/users는 W3~W4에 추가
// users 테이블은 W4 NextAuth와 함께 도입 — 그때까지 conversations.user_id는 FK 제약 없는 uuid.

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

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  // user_id FK는 W4 NextAuth와 함께 — 지금은 nullable uuid로 두어 CLI/익명 호출 허용.
  userId: uuid("user_id"),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    // spec §3.4 인용 객체 배열 — UI [n] 클릭 시 모달 데이터 소스. 빈 배열은 도구 응답 등 인용 없는 메시지.
    citations: jsonb("citations").$type<Citation[]>().notNull().default([]),
    // retrieve가 골라낸 청크 ID — Langfuse trace의 retrieve span과 join 키 역할.
    retrievedChunkIds: uuid("retrieved_chunk_ids").array(),
    model: text("model"),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    conversationIdx: index("idx_messages_conversation_id").on(t.conversationId),
  }),
);
