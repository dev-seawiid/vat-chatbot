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

// dev HMR로 모듈 재평가 시 새 postgres 풀이 누적되는 것 방지 (Prisma/Drizzle 패턴).
const globalForCore = globalThis as unknown as { __vatCore?: Core };

function getCore(): Core {
  if (!globalForCore.__vatCore) {
    const env = parseEnv(process.env);
    globalForCore.__vatCore = createCore({
      databaseUrl: env.DATABASE_URL,
      embeddingApiKey: env.VOYAGE_API_KEY,
      generationApiKey: env.OPENAI_API_KEY,
      // web plane만 OTEL SpanProcessor를 부팅하므로 telemetry 결정도 여기서만.
      telemetry: { isEnabled: true, functionId: "rag.ask" },
    });
  }
  return globalForCore.__vatCore;
}

export async function streamChat(input: StreamChatInput) {
  const core = getCore();
  // Next.js OTEL 기본 span의 trace_id를 박제 — streamText generation span과 같은 trace.
  const traceId = trace.getActiveSpan()?.spanContext().traceId ?? null;

  // propagateAttributes는 span CREATION 시점 context를 캡처 — ask 호출 자체를 감싼다.
  const { textStream, citationStream, chunks, finish } =
    await propagateAttributes(
      { sessionId: input.conversationId, traceName: "chat-message" },
      () =>
        core.chat.ask(input.query, {
          conversationId: input.conversationId,
        }),
    );

  return createUIMessageStream<ChatUIMessage>({
    execute: async ({
      writer,
    }: {
      writer: UIMessageStreamWriter<ChatUIMessage>;
    }) => {
      if (traceId) {
        writer.write({ type: "data-trace", data: { id: traceId } });
      }

      // text와 citation 두 채널 병렬 drain — 어느 쪽도 다른 쪽을 막지 않게.
      const textId = crypto.randomUUID();
      const textPump = (async () => {
        writer.write({ type: "text-start", id: textId });
        for await (const delta of textStream) {
          writer.write({ type: "text-delta", id: textId, delta });
        }
        writer.write({ type: "text-end", id: textId });
      })();

      const citationPump = (async () => {
        for await (const citation of citationStream) {
          writer.write({ type: "data-citation", data: citation });
        }
      })();

      await Promise.all([textPump, citationPump]);

      const meta = await finish;
      try {
        await core.chat.recordChatTurn({
          conversationId: input.conversationId,
          query: input.query,
          text: meta.text,
          // verify 통과 list만 박제 — 환각 인용이 영속 저장소에 새지 않도록.
          citations: meta.citations,
          retrievedChunkIds: chunks.map((c) => c.chunkId),
          model: meta.model,
          latencyMs: Date.now() - input.startedAt,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          traceId,
        });
      } catch (err) {
        // persist 실패해도 답변은 이미 전달 — 서버 로그만.
        console.error("[persist] recordChatTurn failed:", err);
      }
    },
  });
}
