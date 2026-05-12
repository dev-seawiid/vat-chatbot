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

import type { Citation } from "../rag/citation";

// 데이터 모델은 spec §2가 정의한다 — 본 파일이 그 spec을 코드로 구현하는 단일 진실.
// W1: documents + chunks (ingest)
// W3: conversations + messages (chat 영속) + eval_items + eval_runs
// users / feedback / audit_log는 §0.4 영구 비범위.

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

// 골든셋 정답 — `data/eval/golden.json`이 단일 진실이고, 본 테이블은 join/리포팅용 보조 인덱스.
// id는 슬러그 자연키(예: `vat-input-medium-3`)이므로 uuid 아님. eval CLI 시작 시 JSON에서
// upsert(idempotent)로 동기화. 정답을 두 군데서 보관하지만 JSON이 항상 우선 — 충돌 시 JSON이
// 진실. 2026-05-07 eval 슬라이스 §4.2.
export const evalItems = pgTable("eval_items", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  expectedKeywords: text("expected_keywords").array().notNull(),
  // sources.json의 자연키. chunks.metadata.source_id 와 동일 도메인.
  expectedCitationDoc: text("expected_citation_doc").notNull(),
  category: text("category").notNull(),
  difficulty: text("difficulty").notNull(),
  taxType: text("tax_type").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// 1회 실행 = 1행. results는 항목별 점수 배열, summary는 가중평균·축별 평균·카테고리 분해.
// 실험 비교 키: model + embedding_model + retrieval_k + prompt_version + goldenset_version.
// 2026-05-07 eval 슬라이스 §4.1, §5.
export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  model: text("model").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  retrievalK: integer("retrieval_k").notNull(),
  // 프롬프트 버전은 prompt.ts의 상수 박제값(없으면 NULL) — 마스터 spec §4.7 비교 키.
  promptVersion: text("prompt_version"),
  // golden.json.version 값 그대로 — 골든셋 자체가 바뀌면 같은 모델끼리도 비교 불가하므로 명시.
  goldensetVersion: text("goldenset_version").notNull(),
  results: jsonb("results").notNull(),
  summary: jsonb("summary").notNull(),
});
