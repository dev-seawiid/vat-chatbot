# Observability

LLM 호출 자동 추적(trace) + 사용자 만족도 수집(score). 둘 다 Langfuse를 단일 destination으로 사용하고 `messages.trace_id`를 join 키로 공유.

## 1. 스택

```
Vercel AI SDK (streamText) ──emit──▶ OTEL spans
                                       │
@opentelemetry/sdk-node (NodeSDK) ──┐  │ register
                                    ▼  ▼
                       @langfuse/otel · LangfuseSpanProcessor
                                    │
                                    ▼
                              Langfuse Cloud / self-host
                                    ▲
                                    │ score API
@langfuse/client (LangfuseClient) ──┘
       ▲
       │
사용자 👍/👎 → POST /api/feedback
```

레거시 `langfuse` v3 단일 패키지·`langfuse-vercel`은 비채택 — 공식 v5 문서가 OTEL 라우트만 안내.

## 2. 부트스트랩

`apps/web/instrumentation.ts` — Next.js 컨벤션. NodeSDK는 edge runtime 비호환이라 분기:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
```

`apps/web/instrumentation.node.ts` — NodeSDK 등록:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { langfuseSpanProcessor } from "@/shared/lib/observability/langfuse";

const sdk = new NodeSDK({ spanProcessors: [langfuseSpanProcessor] });
sdk.start();
```

`apps/web/src/shared/lib/observability/langfuse.ts` — 싱글톤 SpanProcessor:

```ts
import { LangfuseSpanProcessor } from "@langfuse/otel";
export const langfuseSpanProcessor = new LangfuseSpanProcessor();
```

instrumentation.node.ts(등록)와 route handler(forceFlush)가 같은 인스턴스를 공유 — Node 모듈 캐시가 process-global이라 import 경로만 같으면 보장. env(`LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASEURL`)는 SpanProcessor가 직접 읽음. 미설정 시에도 인스턴스 생성은 성공하고 export 시점에 키 부재로 spans drop — dev 마찰 0(graceful).

`/api/chat` 라우트는 `export const runtime = 'nodejs'` 강제 (NodeSDK 의존).

## 3. 호출측 통합

### AI SDK telemetry 주입

`CoreConfig.telemetry`로 web plane만 활성화:

```ts
// apps/web/src/pages/chat/server.ts
createCore({
  // ...
  telemetry: { isEnabled: true, functionId: "rag.ask" },
});
```

`packages/core/src/chat/chat.service.ts`가 `streamText({ experimental_telemetry })`에 그대로 전달. AI SDK가 generation span(`ai.streamText`), tool-call span(`ai.toolCall.calc_vat`, `ai.toolCall.cite_chunk`)을 자동 생성.

CLI는 `createCore`에 telemetry 미주입 → spans 미발생.

### propagateAttributes로 trace 메타

`apps/web/src/pages/chat/server.ts`:

```ts
const { ... } = await propagateAttributes(
  { sessionId: input.conversationId, traceName: "chat-message" },
  () => core.chat.ask(input.query, { conversationId: input.conversationId }),
);
```

호출 시점의 active span + 콜백 안에서 생성되는 모든 child span에 `sessionId`/`traceName` 박는다. streamText는 ask 내부에서 호출되므로 그 시점 context를 캡처해야 — 즉 ask 자체를 감싸야 함 (콜백 종료 후 stream consumption은 컨텍스트 밖이지만 중요한 건 span CREATION 시점이라 무관).

### `messages.trace_id` 박제

`streamChat`이 `trace.getActiveSpan()?.spanContext().traceId`로 32-char hex를 받아 `recordChatTurn(args)`에 전달 → `messages.trace_id`에 박제. SDK 미부팅 환경에선 `null`로 graceful degrade.

### 서버리스 flush

Vercel function 종료 시 in-memory buffer가 유실되므로 응답 종료 후 명시 flush. `/api/chat/route.ts`:

```ts
import { after } from "next/server";
import { langfuseSpanProcessor } from "@/shared/lib/observability/server";

scheduleLangfuseFlush();
return createUIMessageStreamResponse({ stream });

function scheduleLangfuseFlush() {
  after(async () => {
    try { await langfuseSpanProcessor.forceFlush(); }
    catch (err) { console.error("[langfuse] forceFlush failed:", err); }
  });
}
```

## 4. Trace 스키마

```
trace (root: traceName='chat-message', sessionId=conversationId)
├─ generation: ai.streamText  ← AI SDK 자동
│    input: { system, messages }
│    output: { text }
│    usage: { input_tokens, output_tokens }
├─ span: ai.toolCall.calc_vat   (옵션)
├─ span: ai.toolCall.cite_chunk (옵션, N건)
└─ score: user-thumbs            (피드백 도착 시 별도 호출)
     value: 1 | -1
     traceId: messages.trace_id
```

`messages.trace_id`(OTEL trace_id 32-hex)가 score attach 키. SQL로 messages ↔ trace, traces ↔ scores join 가능.

## 5. User score 송출 (Feedback)

`apps/web/src/features/submit-feedback/server.ts`:

```ts
import { LangfuseClient } from "@langfuse/client";

const SCORE_NAME = "user-thumbs";
const globalForLangfuse = globalThis as { __vatLangfuseClient?: LangfuseClient };

function getLangfuseClient() {
  if (!globalForLangfuse.__vatLangfuseClient) {
    globalForLangfuse.__vatLangfuseClient = new LangfuseClient();
  }
  return globalForLangfuse.__vatLangfuseClient;
}

export async function recordFeedback({ traceId, value }: { traceId: string; value: 1 | -1 }) {
  const client = getLangfuseClient();
  client.score.create({
    traceId,
    name: SCORE_NAME,
    value,
    dataType: "NUMERIC",          // -1 보존 (boolean dataType은 0|1 강제)
  });
  await client.flush();           // Vercel function 종료 전 명시 flush
}
```

POST `/api/feedback` body: `{ traceId, value: 1 | -1 }` → 204 응답. 자세한 요청 contract은 [architecture.md §6](./architecture.md#6-network-api-contract-web--client).

클라이언트 측 `FeedbackBar`는 `data-trace` part가 부재(텔레메트리 미부팅 환경)면 미렌더 — 의미 없는 클릭 차단.

DB 미저장 결정: 모든 score는 Langfuse에만 존재. 코멘트·세부 feedback은 미수집.

## 6. 환경 변수

| 변수 | 사용처 | 미설정 시 |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | LangfuseSpanProcessor + LangfuseClient 자동 소비 | 인스턴스는 생성, export·송출만 drop |
| `LANGFUSE_SECRET_KEY` | 〃 | 〃 |
| `LANGFUSE_BASEURL` | 〃 (dev=docker-compose, prod=Langfuse Cloud) | 기본값 사용 |

dev: docker-compose self-host. prod: Langfuse Cloud(free) 또는 self-host. 패키지·코드 동일, `LANGFUSE_BASEURL`만 차이.

## 7. 핵심 메트릭 (Langfuse 대시보드)

- 응답 latency P50/P95
- 평균 비용/질문 (USD)
- 인용 포함률
- 사용자 satisfaction (user-thumbs)
- 검색 hit@k

환경 분리(dev/prod/eval-run)는 `release` 또는 `metadata.env` 필드로. 별도 프로젝트 키 분리는 v2.

## 8. 후속

- Prompt caching hit율 추적 — OpenAI prefix cache 효율 측정
- 상세 [TODO.md](./TODO.md)
