import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import type { Citation } from "../shared/citation";

export const conversations = pgTable("conversations", {
  id: uuid().primaryKey().defaultRandom(),
  title: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  "messages",
  {
    id: uuid().primaryKey().defaultRandom(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text().notNull(),
    content: text().notNull(),
    // spec §3.4 인용 객체 배열 — UI [n] 클릭 시 모달 데이터 소스. 빈 배열은 도구 응답 등 인용 없는 메시지.
    citations: jsonb().$type<Citation[]>().notNull().default([]),
    // retrieve가 골라낸 청크 ID — Langfuse trace의 retrieve span과 join 키 역할.
    retrievedChunkIds: uuid().array(),
    model: text(),
    latencyMs: integer(),
    inputTokens: integer(),
    outputTokens: integer(),
    traceId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversationIdx: index("idx_messages_conversation_id").on(t.conversationId),
  }),
);
