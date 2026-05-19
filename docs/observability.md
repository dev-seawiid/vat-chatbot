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
export const langfuseSpanProcessor = new LangfuseSpanProcessor({
  environment:
    process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
});
```

`environment`로 dev/preview/production trace를 Langfuse 대시보드에서 분리 필터링 — 같은 프로젝트 키로 들어와도 메트릭 오염 X. Vercel 자동주입 `VERCEL_ENV`(`'production'|'preview'|'development'`)를 1차로, 로컬은 `NODE_ENV`.

instrumentation.node.ts(등록)와 route handler(forceFlush)가 같은 인스턴스를 공유 — Node 모듈 캐시가 process-global이라 import 경로만 같으면 보장. env(`LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASEURL`)는 SpanProcessor가 직접 읽음. 미설정 시에도 인스턴스 생성은 성공하고 export 시점에 키 부재로 spans drop — dev 마찰 0(graceful).

`/api/chat` 라우트는 `export const runtime = 'nodejs'` 강제 (NodeSDK 의존).

## 3. 호출측 통합

### Layering 원칙 (where to instrument)

외부 I/O와 가장 가까운 함수가 그 호출의 span을 만든다. 자동 instrumentor가 있으면 위임, 없으면 직접.

| 위치 | 무엇이 박나 | 근거 |
|---|---|---|
| `chat.service.ts` | AI SDK `experimental_telemetry`에 always-on 상수 통과 → generation/tool-call span 자동 | AI SDK가 instrumentor 역할 |
| `adapters/embedding.ts` | `withEmbeddingSpan` 직접 emit | Voyage TS instrumentor 부재 |
| `retrieval/chunk.repository.ts` | `withSpan('pgvector.search', ...)` 직접 emit | postgres-js OTel auto-instrumentation 미지원 |
| `retrieval/retrieval.service.ts` | `withRetrieverSpan` 직접 emit | 도메인 의미 단위(RAG) |
| `apps/web/.../pages/chat/server.ts` | `propagateAttributes` + `setActiveTraceIO` | trace-level attribute는 호출자 책임 |

**Always-emit + helper 격리** — core는 plane이 SpanProcessor를 부팅했는지로 활성이 결정되며 활성화 인자를 prop drill하지 않는다(Langfuse 공식 권장). `@langfuse/tracing` SDK는 `packages/core/src/shared/telemetry/` 한 모듈에서만 import — 도메인 코드는 `withEmbeddingSpan` · `withRetrieverSpan` · `withSpan` · `AI_SDK_TELEMETRY`만 사용한다.

CLI(`scripts/ask.ts` 등)는 SpanProcessor 미부팅 → 모든 helper가 OTEL no-op tracer로 자동 무동작.

### propagateAttributes로 trace 메타 + trace IO

`apps/web/src/pages/chat/server.ts`:

```ts
import { propagateAttributes, setActiveTraceIO } from "@langfuse/tracing";
import { PROMPT_VERSION } from "@vat/core";

const { ... } = await propagateAttributes(
  {
    sessionId: input.conversationId,
    traceName: "chat-message",
    metadata: { promptVersion: PROMPT_VERSION },
  },
  () => {
    setActiveTraceIO({ input: input.query });
    return core.chat.ask(input.query, { conversationId: input.conversationId });
  },
);

// stream 종료 후 finish 콜백 안에서:
setActiveTraceIO({ output: meta.text });
```

`propagateAttributes`는 호출 시점의 active span + 콜백 안에서 생성되는 모든 child span에 `sessionId`/`traceName`/`metadata`를 박는다. `metadata.promptVersion`은 프롬프트 변경 cohort 비교용 (Langfuse 대시보드 metadata filter). `setActiveTraceIO`는 v5에서 deprecated 마크지만 trace-level input/output을 박는 표면이 이것뿐 — input은 시작 시점, output은 stream 종료 후 동일 trace의 root span context에서 호출(같은 trace_id면 trace IO로 박힘).

### core 내부 helper — `packages/core/src/shared/telemetry/`

도메인 함수를 **wrap**(decorator 스타일)하는 HOF — 비즈니스 본문 indent +0, 시그니처 보존.

```ts
// adapters/embedding.ts
const embed: EmbedFn = traceEmbedding(
  {
    name: "voyage.embed",
    attrs: ([text, opts]) => ({
      input: text,
      model: EMBEDDING_MODEL_ID,
      metadata: { input_type: opts.input_type },
    }),
    output: (embedding) => ({ dim: embedding.length }),
  },
  async (text, opts) => {                       // ← 본문은 비즈니스 로직만
    const res = await fetch(VOYAGE_URL, ...);
    const parsed = VoyageResponseSchema.parse(await res.json());
    if (parsed.usage) setEmbeddingUsage(parsed.usage.total_tokens);  // 응답 파싱 dynamic
    return parsed.data[0]!.embedding;
  },
);

// retrieval.service.ts — traceRetriever (본문 setSpanAttr 호출 0줄)
// chunk.repository.ts — traceSpan("pgvector.search", ...)
// chat.service.ts    — streamText({ experimental_telemetry: AI_SDK_TELEMETRY })
```

공개 표면 — `traceEmbedding` · `traceRetriever` · `traceSpan` · `setEmbeddingUsage` · `AI_SDK_TELEMETRY`. type별 함수 분리는 SDK가 type별 overload(`LangfuseEmbeddingAttributes` 등)로 attribute 스키마를 강제하기 때문 — 하나의 generic HOF로 묶으면 `as` 단언이 필요해져 TS strictness 위반.

`meta.attrs`는 wrap 시점에 args에서 추출 가능한 정적/입력 attribute, `meta.output`은 return value를 trace UI용으로 가공(embedding vector → dim, chunks → contexts 등), `setEmbeddingUsage`는 응답 body 파싱 후에만 알 수 있는 token 수만을 위한 ambient update.

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
trace (root: traceName='chat-message', sessionId=conversationId,
       metadata.promptVersion, environment, input=query, output=text)
├─ retriever: retrieval                          ← core
│   input: { query, k, filter }
│   output: { count, topSimilarity, contexts:[{ chunkId, docTitle, page, similarity, content }] }
│   ├─ embedding: voyage.embed                   ← core
│   │   model='voyage-3', usageDetails:{ input, total }, metadata.input_type
│   └─ span: pgvector.search                     ← core
│       input:{ k, filter, dim }, output:{ hitCount, topSimilarity }
├─ generation: ai.streamText                     ← AI SDK 자동
│    input: { system, messages }
│    output: { text }
│    usage: { input_tokens, output_tokens }
├─ span: ai.toolCall.calc_vat   (옵션)            ← AI SDK 자동
├─ span: ai.toolCall.cite_chunk (옵션, N건)      ← AI SDK 자동
└─ score: user-thumbs            (피드백 도착 시 별도 호출)
     value: 1 | -1
     traceId: messages.trace_id
```

Voyage-3 단가는 Langfuse default pricing에 없음 — 대시보드 Models에서 1회 등록(input USD/token).

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
