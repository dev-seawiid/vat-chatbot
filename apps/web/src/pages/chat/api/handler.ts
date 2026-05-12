import "server-only";

import { propagateAttributes } from "@langfuse/tracing";
import { trace } from "@opentelemetry/api";
import { type Core, createCore, parseEnv } from "@vat/core";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { after } from "next/server";
import { z } from "zod";

import { type ChatUIMessage, lastUserText } from "@/entities/message";
import { langfuseSpanProcessor } from "@/shared/lib/observability/server";
import { withRateLimit } from "@/shared/lib/security/server";

// 단일 user query 길이 상한 — 1회 LLM 호출 input 토큰 비용 cap.
const MAX_QUERY_LENGTH = 2000;

// messages는 unknown[]로 두고 lastUserText의 type guard에서 안전 추출 — 외부 입력에 대해
// ChatUIMessage[] 강제 캐스팅 금지(zod로 UIMessage 풀스키마를 검증하지 않으므로 정직하지 못함).
const ChatRequestBodySchema = z.object({
  messages: z.array(z.unknown()),
  conversationId: z.string().uuid(),
});
type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;

// Next.js dev mode HMR에서 모듈이 재평가되며 새 postgres 풀이 누적되는 문제를 막기
// 위해 globalThis에 core 인스턴스를 캐시한다 (Prisma·Drizzle 가이드와 동일 패턴).
const globalForCore = globalThis as unknown as { __vatCore?: Core };

function getCore(): Core {
  if (!globalForCore.__vatCore) {
    const env = parseEnv(process.env);
    globalForCore.__vatCore = createCore({
      databaseUrl: env.DATABASE_URL,
      embeddingApiKey: env.VOYAGE_API_KEY,
      generationApiKey: env.OPENAI_API_KEY,
      // web plane만 OTEL SpanProcessor를 부팅(instrumentation.node.ts) — 따라서 telemetry
      // 활성화도 여기서만 결정한다. CLI는 createCore에 telemetry 미주입 → spans 미발생.
      telemetry: { isEnabled: true, functionId: "rag.ask" },
    });
  }
  return globalForCore.__vatCore;
}

async function handleChat(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const parsed = await parseChatRequest(req);
  if (!parsed.ok) return parsed.response;

  const response = await streamChatResponse({
    core: getCore(),
    conversationId: parsed.body.conversationId,
    query: parsed.query,
    startedAt,
  });
  scheduleLangfuseFlush();
  return response;
}

// rate-limit은 횡단 관심사 — 비즈니스 핸들러는 그대로 두고 wrapper로 합성.
export const POST = withRateLimit(handleChat);

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

type ParseResult =
  | { ok: true; body: ChatRequestBody; query: string }
  | { ok: false; response: Response };

async function parseChatRequest(req: Request): Promise<ParseResult> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: badRequest("invalid json") };
  }

  const parsed = ChatRequestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: badRequest("invalid request body") };
  }

  const query = lastUserText(parsed.data.messages);
  if (!query) return { ok: false, response: badRequest("empty query") };
  if (query.length > MAX_QUERY_LENGTH) {
    return { ok: false, response: badRequest("query too long") };
  }

  return { ok: true, body: parsed.data, query };
}

async function streamChatResponse({
  core,
  conversationId,
  query,
  startedAt,
}: {
  core: Core;
  conversationId: string;
  query: string;
  startedAt: number;
}): Promise<Response> {
  // Next.js OTEL 기본 span("executing api route")이 활성 상태이므로 여기서 trace_id를 박제.
  // streamText의 generation span은 같은 trace에 속하게 되어 messages.trace_id와 1:1 join 가능.
  // SDK 미부팅 환경에선 undefined → null로 저장(graceful degrade).
  const traceId = trace.getActiveSpan()?.spanContext().traceId ?? null;

  // propagateAttributes는 호출 시점의 active span + 콜백 안에서 생성되는 모든 child span에
  // sessionId/traceName을 박는다. streamText는 core.ask 내부에서 호출되므로 그 시점 context를
  // 캡처해야 — 즉 core.ask 자체를 감싸야 한다(콜백 종료 후 stream consumption은 컨텍스트
  // 밖이지만, 중요한 건 span CREATION 시점 컨텍스트라 문제 없음).
  const { textStream, citations, chunks, finish } = await propagateAttributes(
    { sessionId: conversationId, traceName: "chat-message" },
    () => core.ask(query),
  );

  const stream = createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }) => {
      // traceId가 있을 때만 송출 — 텔레메트리 미부팅 환경에선 part 자체 없음(클라 측
      // FeedbackBar는 traceId 부재 시 미렌더하여 의미 없는 클릭을 차단).
      if (traceId) {
        writer.write({ type: "data-trace", data: { id: traceId } });
      }
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
          conversationId,
          query,
          text: meta.text,
          citations,
          retrievedChunkIds: chunks.map((c) => c.chunk_id),
          model: meta.model,
          latencyMs: Date.now() - startedAt,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          traceId,
        });
      } catch (err) {
        // spec §4 — persist 실패는 답변이 이미 보여진 상태이므로 사용자 영향 없이 서버 로그만.
        console.error("[persist] savePair failed:", err);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

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
