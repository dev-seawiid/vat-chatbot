import { type Core, createCore, parseEnv } from "@vat/core";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";

import { lastUserText } from "@/entities/message/lib/parts";
import type { ChatUIMessage } from "@/entities/message/types";

export const runtime = "nodejs";

// 입력 검증 한도 — DoS / 토큰 비용 폭주 방어. 값은 spec §3.3 retrieval k=8과 multi-turn
// 대화 평균 길이를 감안한 보수 추정. 초과 시 400 반환.
const MAX_MESSAGES = 50;
const MAX_QUERY_LENGTH = 2000;

const ChatRequestBodySchema = z.object({
  messages: z.array(z.unknown()).max(MAX_MESSAGES),
  conversationId: z.string().uuid(),
});

// Next.js dev mode HMR에서 모듈이 재평가되며 새 postgres 풀이 누적되는 문제를 막기
// 위해 globalThis에 core 인스턴스를 캐시한다 (Prisma·Drizzle 가이드와 동일 패턴).
const globalForCore = globalThis as unknown as { __vatCore?: Core };

function getCore(): Core {
  if (!globalForCore.__vatCore) {
    const env = parseEnv(process.env);
    globalForCore.__vatCore = createCore({
      databaseUrl: env.DATABASE_URL,
      voyageApiKey: env.VOYAGE_API_KEY,
      googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
  }
  return globalForCore.__vatCore;
}

export async function POST(req: Request) {
  const startedAt = Date.now();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const parsed = ChatRequestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return new Response("invalid request body", { status: 400 });
  }
  const body = parsed.data as { messages: ChatUIMessage[]; conversationId: string };
  const query = lastUserText(body.messages);

  if (!query) {
    return new Response("empty query", { status: 400 });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return new Response("query too long", { status: 400 });
  }

  const core = getCore();
  const { textStream, citations, chunks, finish } = await core.ask(query);

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "data-citations", data: citations });

      const textId = crypto.randomUUID();
      writer.write({ type: "text-start", id: textId });
      for await (const delta of textStream) {
        writer.write({ type: "text-delta", id: textId, delta });
      }
      writer.write({ type: "text-end", id: textId });

      const meta = await finish;
      try {
        await core.gateway.messages.savePair({
          conversationId: body.conversationId,
          query,
          text: meta.text,
          citations,
          retrievedChunkIds: chunks.map((c) => c.chunk_id),
          model: meta.model,
          latencyMs: Date.now() - startedAt,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          traceId: null,
        });
      } catch (err) {
        // spec §4 — persist 실패는 답변이 이미 보여진 상태이므로 사용자 영향 없이 서버 로그만.
        console.error("[persist] savePair failed:", err);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
