import { desc, eq } from "drizzle-orm";

import type { Citation } from "#common/citation";
import type { Db } from "#database/client";

import { conversations, messages } from "./schema";

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

// AI SDK ModelMessage role과 호환되도록 좁힌 union. tool-call 메타는 history에 미포함.
export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type MessageRepository = ReturnType<typeof createMessageRepository>;

export function createMessageRepository(db: Db) {
  return {
    // invariant: user/assistant 두 메시지가 함께 남거나 함께 없거나.
    // conversations 행은 첫 turn에만 생성(onConflictDoNothing). title은 query 앞 60자.
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

    // DB에선 desc + LIMIT로 끝만 잘라오고, 도메인엔 asc(시간순)로 펼쳐 반환.
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
