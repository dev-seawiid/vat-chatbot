# Observability

LLM 호출·검색 자동 추적(trace) + 사용자 만족도 수집(score). 둘 다 Langfuse를 단일 destination으로 사용하고 `messages.trace_id`를 join 키로 공유.

## 1. 스택

```
@opentelemetry/sdk-node (NodeSDK) ──┐
                                    ▼
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

ADR-0003에서 chain이 AI SDK `streamText` → LangChain.js + LangGraph로 교체된 후, **LangChain의 Langfuse `CallbackHandler` 통합은 미연결** — 즉 LangGraph 노드(search_direct, generate_draft, claim_searches, fuse, generate_answer)의 LCEL spans은 현재 trace에 자동으로 박히지 않는다. 직접 wrap한 retrieval·embedding·rerank·pgvector 4개 span + root trace IO만 송출. 후속 — [TODO.md](./TODO.md).

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

`/api/chat` 라우트는 NodeSDK 의존이라 nodejs runtime에서 실행.

## 3. 호출측 통합

### Layering 원칙 (where to instrument)

외부 I/O와 가장 가까운 함수가 그 호출의 span을 만든다. LangChain/LangGraph callback handler 미통합 결정과 무관하게 직접 instrument한 곳은 다음 4개:

| 위치 | 무엇이 박나 | 근거 |
|---|---|---|
| `modules/retrieval/retrieval.service.ts` | `traceRetriever('retrieval', ...)` | 도메인 의미 단위(RAG retrieve) |
| `modules/retrieval/embedding.adapter.ts` | `traceEmbedding('voyage.embed', ...)` | Voyage TS instrumentor 부재 |
| `modules/retrieval/chunk.repository.ts` | `traceSpan('pgvector.search', ...)` | postgres-js OTel auto-instrumentation 미지원 |
| `modules/retrieval/rerank.adapter.ts` | `traceSpan('voyage.rerank', ...)` | Voyage rerank REST 직접 호출 |
| `apps/web/.../pages/chat/server.ts` | `propagateAttributes` + `setActiveTraceIO` | trace-level attribute는 호출자 책임 |

**Always-emit + helper 격리** — core는 plane이 SpanProcessor를 부팅했는지로 활성이 결정되며 활성화 인자를 prop drill하지 않는다(Langfuse 공식 권장). `@langfuse/tracing` SDK는 `packages/core/src/common/telemetry.ts` 한 모듈에서만 import — 도메인 코드는 `traceEmbedding` · `traceRetriever` · `traceSpan` · `setEmbeddingUsage`만 사용한다.

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
    metadata: { promptVersion: PROMPT_VERSION },   // v4 — ADR-0003
  },
  () => {
    setActiveTraceIO({ input: input.query });
    return core.chat.ask(input.query, { conversationId: input.conversationId });
  },
);

// stream 종료 후 finish 콜백 안에서:
setActiveTraceIO({ output: meta.text });
```

`propagateAttributes`는 호출 시점의 active span + 콜백 안에서 생성되는 모든 child span에 `sessionId`/`traceName`/`metadata`를 박는다. `metadata.promptVersion`은 프롬프트 변경 cohort 비교용(Langfuse 대시보드 metadata filter — v1/v2/v3 분리). `setActiveTraceIO`는 v5에서 deprecated 마크지만 trace-level input/output을 박는 표면이 이것뿐 — input은 시작 시점, output은 stream 종료 후 동일 trace의 root span context에서 호출(같은 trace_id면 trace IO로 박힘).

### core 내부 helper — `packages/core/src/common/telemetry.ts`

도메인 함수를 **wrap**(decorator 스타일)하는 HOF — 비즈니스 본문 indent +0, 시그니처 보존.

```ts
// modules/retrieval/embedding.adapter.ts
const embed: EmbedFn = traceEmbedding(
  {
    name: "voyage.embed",
    attrs: ([text, opts]) => ({
      input: text,
      model: modelId,
      metadata: { input_type: opts.input_type },
    }),
    output: (embedding) => ({ dim: embedding.length }),
  },
  async (text, opts) => {
    const res = await fetch(VOYAGE_URL, ...);
    const parsed = VoyageResponseSchema.parse(await res.json());
    if (parsed.usage) setEmbeddingUsage(parsed.usage.total_tokens);  // 응답 파싱 dynamic
    return parsed.data[0]!.embedding;
  },
);
```

공개 표면 — `traceEmbedding` · `traceRetriever` · `traceSpan` · `setEmbeddingUsage`. type별 함수 분리는 Langfuse SDK가 asType별 overload(`LangfuseEmbeddingAttributes` 등)로 attribute 스키마를 강제하기 때문 — 하나의 generic HOF로 묶으면 `as` 단언이 필요해져 TS strictness 위반.

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
       metadata.promptVersion=v3, environment, input=query, output=text)
├─ retriever: retrieval                          ← core (traceRetriever)
│   input: { query, k, filter }
│   output: { count, topSimilarity, contexts:[{ chunkId, docTitle, page, similarity, content }] }
│   ├─ embedding: voyage.embed                   ← core (traceEmbedding)
│   │   model=$VOYAGE_MODEL, usageDetails:{ input, total }, metadata.input_type
│   └─ span: pgvector.search                     ← core (traceSpan)
│       input:{ k, filter, dim }, output:{ hitCount, topSimilarity }
├─ span: voyage.rerank                           ← core (traceSpan, rerank.adapter)
│   input:{ query, candidateCount, topK, model }, output:{ hitCount }
└─ score: user-thumbs            (피드백 도착 시 별도 호출)
     value: 1 | -1
     traceId: messages.trace_id
```

미박제(후속):
- LangGraph 노드 spans — `search_direct`, `generate_draft`, `claim_searches`, `fuse`, `generate_answer`
- ChatOpenAI/structured output LLM call usage (input/output tokens) — `chat.service.ts`의 `finish.inputTokens`/`outputTokens`는 항상 undefined

`@langfuse/langchain`의 `CallbackHandler`를 `graph.invoke({...}, { callbacks: [handler] })`로 주입하면 LCEL spans + LLM usage가 한 번에 박힌다 — 후속 슬라이스.

Voyage 단가는 Langfuse default pricing에 없음 — 대시보드 Models에서 1회 등록(input USD/token).

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

- 응답 latency P50/P95 (root trace duration)
- retrieve top similarity 분포
- 사용자 satisfaction (user-thumbs)

환경 분리(dev/prod/eval-run)는 `release` 또는 `metadata.env` 필드로. 별도 프로젝트 키 분리는 v2.

## 8. 후속

- **LangChain Langfuse CallbackHandler 통합** — LangGraph 노드 spans + LLM usage 자동 박제
- ChatOpenAI usage_metadata 콜백으로 `inputTokens`/`outputTokens` finish 채널 채우기
- 상세 [TODO.md](./TODO.md)
