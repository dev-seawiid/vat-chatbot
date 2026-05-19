import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// 골든셋 정답 — `data/eval/golden.json`이 단일 진실이고, 본 테이블은 join/리포팅용 보조 인덱스.
// id는 슬러그 자연키(예: `vat-input-medium-3`)이므로 uuid 아님. eval CLI 시작 시 JSON에서
// upsert(idempotent)로 동기화. 정답을 두 군데서 보관하지만 JSON이 항상 우선 — 충돌 시 JSON이
// 진실.
export const evalItems = pgTable("eval_items", {
  id: text().primaryKey(),
  question: text().notNull(),
  expectedKeywords: text().array().notNull(),
  // sources.json의 자연키. chunks.metadata.source_id 와 동일 도메인.
  expectedCitationDoc: text().notNull(),
  category: text().notNull(),
  difficulty: text().notNull(),
  taxType: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// 1회 실행 = 1행. results는 항목별 점수 배열, summary는 가중평균·축별 평균·카테고리 분해.
// 실험 비교 키: model + embedding_model + retrieval_k + prompt_version + goldenset_version.
export const evalRuns = pgTable("eval_runs", {
  id: uuid().primaryKey().defaultRandom(),
  ranAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  model: text().notNull(),
  embeddingModel: text().notNull(),
  retrievalK: integer().notNull(),
  // 프롬프트 버전은 prompt.ts의 상수 박제값(없으면 NULL) — 마스터 spec §4.7 비교 키.
  promptVersion: text(),
  // golden.json.version 값 그대로 — 골든셋 자체가 바뀌면 같은 모델끼리도 비교 불가하므로 명시.
  goldensetVersion: text().notNull(),
  results: jsonb().notNull(),
  summary: jsonb().notNull(),
});
