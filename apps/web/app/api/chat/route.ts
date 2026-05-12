import { createUIMessageStreamResponse } from "ai";
import { after } from "next/server";
import { z } from "zod";

import { extractUserText, MAX_MESSAGE_LENGTH } from "@/entities/message";
import { streamChat } from "@/pages/chat/server";
import { badRequest, parseJsonBody } from "@/shared/api/server";
import { langfuseSpanProcessor } from "@/shared/lib/observability/server";
import { withRateLimit } from "@/shared/lib/security/server";

// 클라 transport(prepareSendMessagesRequest)가 마지막 user 메시지 한 건만 보낸다.
// message는 unknown으로 두고 extractUserText의 type guard로 안전 추출 — 외부 입력에 대해
// UIMessage 강제 캐스팅 금지(zod로 풀스키마를 검증하지 않으므로 정직하지 못함).
const ChatRequestBodySchema = z.object({
  message: z.unknown(),
  conversationId: z.string().uuid(),
});

async function handleChat(req: Request): Promise<Response> {
  const startedAt = Date.now();

  const parsed = await parseJsonBody(req, ChatRequestBodySchema);
  if (!parsed.ok) return parsed.response;

  const query = extractUserText(parsed.data.message);
  if (!query) return badRequest("empty query");
  if (query.length > MAX_MESSAGE_LENGTH) return badRequest("query too long");

  const stream = await streamChat({
    conversationId: parsed.data.conversationId,
    query,
    startedAt,
  });

  scheduleLangfuseFlush();
  return createUIMessageStreamResponse({ stream });
}

// rate-limit은 횡단 관심사 — 비즈니스 핸들러는 그대로 두고 wrapper로 합성.
export const POST = withRateLimit(handleChat);

// 서버리스(Vercel) 환경에서 응답 종료 후 Langfuse로 spans을 강제 export — 미호출 시 함수
// 종료와 함께 buffer가 유실된다(spec §4.1 "서버리스 flush").
function scheduleLangfuseFlush(): void {
  after(async () => {
    try {
      await langfuseSpanProcessor.forceFlush();
    } catch (err) {
      console.error("[langfuse] forceFlush failed:", err);
    }
  });
}
