import type { Citation } from "../domain/citation";
import type { Db } from "../db/client";
import { conversations, messages } from "../db/schema";

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
  };
}
