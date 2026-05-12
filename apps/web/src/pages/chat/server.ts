import "server-only";

import { propagateAttributes } from "@langfuse/tracing";
import { trace } from "@opentelemetry/api";
import { type Core, createCore, parseEnv } from "@vat/core";
import { createUIMessageStream, type UIMessageStreamWriter } from "ai";

import { type ChatUIMessage } from "@/entities/message";

type StreamChatInput = {
  conversationId: string;
  query: string;
  startedAt: number;
};

// Next.js dev mode HMR에서 모듈이 재평가되며 새 postgres 풀이 누적되는 문제를 막기 위해
// globalThis에 core 인스턴스를 캐시한다 (Prisma·Drizzle 가이드와 동일 패턴).
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

// Next.js OTEL 기본 span("executing api route")이 활성 상태이므로 여기서 trace_id를 박제.
// streamText의 generation span은 같은 trace에 속하게 되어 messages.trace_id와 1:1 join 가능.
// SDK 미부팅 환경에선 undefined → null로 저장(graceful degrade).
export async function streamChat(input: StreamChatInput) {
  const core = getCore();
  const traceId = trace.getActiveSpan()?.spanContext().traceId ?? null;

  // propagateAttributes는 호출 시점의 active span + 콜백 안에서 생성되는 모든 child span에
  // sessionId/traceName을 박는다. streamText는 chat.ask 내부에서 호출되므로 그 시점 context를
  // 캡처해야 — 즉 chat.ask 자체를 감싸야 한다(콜백 종료 후 stream consumption은 컨텍스트
  // 밖이지만, 중요한 건 span CREATION 시점 컨텍스트라 문제 없음).
  const { textStream, citations, chunks, finish } = await propagateAttributes(
    { sessionId: input.conversationId, traceName: "chat-message" },
    () => core.chat.ask(input.query),
  );

  return createUIMessageStream<ChatUIMessage>({
    execute: async ({ writer }: { writer: UIMessageStreamWriter<ChatUIMessage> }) => {
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
        await core.chat.recordChatTurn({
          conversationId: input.conversationId,
          query: input.query,
          text: meta.text,
          citations,
          retrievedChunkIds: chunks.map((c) => c.chunkId),
          model: meta.model,
          latencyMs: Date.now() - input.startedAt,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          traceId,
        });
      } catch (err) {
        // spec §4 — persist 실패는 답변이 이미 보여진 상태이므로 사용자 영향 없이 서버 로그만.
        console.error("[persist] recordChatTurn failed:", err);
      }
    },
  });
}
