import { desc, eq } from "drizzle-orm";

import type { Citation } from "../shared/citation";
import type { Db } from "../db/client";
import { conversations, messages } from "./schema";

// spec §3.4 — conversations + messages aggregate에 대한 Repository. chat service가 본 모듈을
// 통해서만 영속화. transaction 경계는 본 repository가 소유 (turn 단위 원자성 invariant).

export type SavePairArgs = {
  conversationId: string;
  query: string;
  text: string;
  citations: Citation[];
  retrievedChunkIds: string[];
  model: string;
  latencyMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  traceId: string | null;
};

// multi-turn RAG context — recentTurns가 반환하는 한 메시지의 도메인 형태.
// AI SDK ModelMessage role 키와 호환되도록 좁은 union으로 두고, content는 plain text.
// (assistant turn에 박혔던 tool-call 메타는 history에 포함하지 않음 — 텍스트 답변만 컨텍스트로
// 활용해도 multi-turn 이해엔 충분하고, tool 호출은 그 turn 종료 후 의미가 없다.)
export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MessageRepository = ReturnType<typeof createMessageRepository>;

export function createMessageRepository(db: Db) {
  return {
    /**
     * 한 chat turn(user 질문 + assistant 답변)을 단일 트랜잭션에 기록.
     * invariant: 두 메시지가 함께 남거나 함께 없거나 — 한쪽만 남는 어긋난 상태를 막는다.
     * conversations 행은 첫 turn에만 생성(onConflictDoNothing) → 단일 롤링 대화에서
     * 두 번째 turn부터는 messages 2건만 추가. title은 첫 user query 앞 60자.
     */
    async savePair(args: SavePairArgs): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .insert(conversations)
          .values({
            id: args.conversationId,
            title: args.query.slice(0, 60),
          })
          .onConflictDoNothing();

        await tx.insert(messages).values([
          {
            conversationId: args.conversationId,
            role: "user",
            content: args.query,
            citations: [],
            retrievedChunkIds: null,
          },
          {
            conversationId: args.conversationId,
            role: "assistant",
            content: args.text,
            citations: args.citations,
            retrievedChunkIds: args.retrievedChunkIds,
            model: args.model,
            latencyMs: args.latencyMs,
            inputTokens: args.inputTokens,
            outputTokens: args.outputTokens,
            traceId: args.traceId,
          },
        ]);
      });
    },

    /**
     * multi-turn RAG용 history fetch — 한 conversation의 마지막 limit개 메시지를 시간순(asc)으로
     * 반환. DB에선 createdAt desc + LIMIT으로 끝 부분만 잘라 가져온 뒤 도메인엔 asc로 노출
     * (호출자가 그대로 model messages 배열에 펼칠 수 있도록). user/assistant turn은 짝으로
     * 누적되지만 limit은 *메시지 수* 기준이므로 홀수 limit이면 끝이 user/assistant 중 어느
     * 쪽이든 될 수 있다 — 호출자가 짝 단위로 윈도우 잡고 싶으면 짝수 limit을 넘긴다.
     */
    async recentTurns(
      conversationId: string,
      limit: number,
    ): Promise<ConversationMessage[]> {
      if (limit <= 0) return [];
      const rows = await db
        .select({ role: messages.role, content: messages.content })
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(limit);

      return rows
        .reverse()
        .filter((r): r is ConversationMessage =>
          r.role === "user" || r.role === "assistant",
        );
    },
  };
}
