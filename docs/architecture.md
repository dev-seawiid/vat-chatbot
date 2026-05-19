# Architecture

VAT RAG 챗봇의 모듈 경계, 의존 방향, 데이터 모델, plane 간 contract를 한 자리에 정리.

## 1. 모듈 구조

```
┌──────────────────────────────────────────────┐
│ apps/web   (Next.js · TypeScript · Vercel)   │
│  app/api/chat        SSE streaming           │
│  app/api/feedback    Langfuse score          │
│  src/pages/chat/server.ts  composition 경계  │
└──────────────────┬───────────────────────────┘
                   │ createCore(config)
                   ▼
┌──────────────────────────────────────────────┐
│ packages/core  (도메인 lib, TS)              │
│  core.ts        composition root             │
│  common/        citation, telemetry          │
│  modules/                                    │
│    chat/        ChatService+Repo+gen.adapter │
│    retrieval/   RetrievalSvc+Repo+embed.adp  │
│    eval/        EvalService + EvalRepo       │
│  database/      drizzle + postgres-js        │
│  (alias: #common/* · #modules/* · #database/*)│
└──────────────────┬───────────────────────────┘
                   │ Neon Postgres + pgvector (HNSW)
                   ▲
                   │ SQLAlchemy + psycopg
┌──────────────────┴───────────────────────────┐
│ jobs/ingest  (Python 3.12 · uv · CLI)        │
│  scripts/{fetch, extract, chunk, embed, load}│
│  src/ingest/{extract, chunking, embedding,   │
│              load}                           │
│  .cache/* 단계별 산출물 (idempotent)         │
└──────────────────────────────────────────────┘
```

## 2. 의존 방향

- `apps/web → packages/core` **단방향**. core는 web 모름.
- `packages/core`는 `process.env` 직접 읽지 않음 — `createCore(config)`의 인자로만 외부 의존 주입. env 로딩은 consumer 책임(Next.js 자동, CLI는 `tsx --env-file`).
- `jobs/ingest`는 process 경계로 완전 분리 — DB만 공유. web 번들에 Python 의존성 비유입 (Vercel은 `apps/web`만 빌드).

## 3. Composition root

`packages/core/src/core.ts::createCore(config)`가 모든 wiring을 단일 자리에서 소유:

```ts
type CoreConfig = {
  databaseUrl: string;
  embeddingApiKey: string;
  generationApiKey: string;
};
// telemetry는 인자가 아니다 — core는 always-emit이고 SpanProcessor 부팅 여부로만 활성/no-op.
// 자세한 layering 원칙은 docs/observability.md 참고.

type Core = {
  chat: ChatService;
  retrieval: RetrievalService;
  eval: EvalService;
  embeddingModelId: string;
  close: () => Promise<void>;
};
```

service만 표면 노출, repository는 service deps로만 흐름. controller(web route, eval CLI)는 `core.<service>.<usecase>()` 형태로만 호출.

## 4. 데이터 모델

PostgreSQL + pgvector. Drizzle ORM이 스키마 단일 진실 (`packages/core/src/{chat,retrieval,eval}/schema.ts`). Python plane은 `jobs/ingest/src/ingest/load/db/models.py`에 같은 스키마를 SQLAlchemy로 mirror하되 `create_all` 호출하지 않음 (마이그레이션 진실은 Drizzle).

```sql
documents (
  id          uuid PK,
  title       text NOT NULL,
  source_url  text,
  version     text,
  file_hash   text UNIQUE NOT NULL,
  created_at  timestamptz NOT NULL
)

chunks (
  id            uuid PK,
  doc_id        uuid FK→documents ON DELETE CASCADE,
  page          int,
  section_path  text,
  content       text NOT NULL,
  content_hash  text NOT NULL,
  embedding     vector(1024) NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL,
  UNIQUE (doc_id, content_hash)
)
-- HNSW(embedding vector_cosine_ops)

conversations (id uuid PK, title text, created_at timestamptz)

messages (
  id                   uuid PK,
  conversation_id      uuid FK→conversations ON DELETE CASCADE,
  role                 text NOT NULL,
  content              text NOT NULL,
  citations            jsonb NOT NULL DEFAULT '[]',
  retrieved_chunk_ids  uuid[],
  model                text,
  latency_ms           int,
  input_tokens         int,
  output_tokens        int,
  trace_id             text,
  created_at           timestamptz NOT NULL
)

eval_items (
  id                    text PK,  -- 슬러그 자연키
  question              text NOT NULL,
  expected_keywords     text[] NOT NULL,
  expected_citation_doc text NOT NULL,
  category, difficulty, tax_type  text NOT NULL,
  updated_at            timestamptz NOT NULL
)

eval_runs (
  id                uuid PK,
  ran_at            timestamptz NOT NULL,
  model             text NOT NULL,
  embedding_model   text NOT NULL,
  retrieval_k       int  NOT NULL,
  prompt_version    text,
  goldenset_version text NOT NULL,
  results           jsonb NOT NULL,
  summary           jsonb NOT NULL
)
```

`chunks.metadata` jsonb의 키는 ingest plane(Python)이 정한 snake. SQL 내부 키이므로 TS 도메인 표면(camel)과 격리.

## 5. Core API contract (in-process)

`apps/web`이 `packages/core`를 호출할 때 보는 표면. 자세한 동작은 각 단계 문서.

```ts
// composition
createCore(config: CoreConfig): Core
core.close(): Promise<void>

// chat (→ generation.md)
core.chat.ask(query: string, opts?: {
  k?: number;
  filter?: { taxType?: string };
  conversationId?: string;  // 주입 시 multi-turn
}): Promise<{
  textStream: AsyncIterable<string>;
  citationStream: AsyncIterable<Citation>;
  chunks: SearchResult[];
  finish: Promise<{
    text: string;
    citations: Citation[];
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    finishReason: string;
    model: string;
  }>;
}>

core.chat.recordChatTurn(args: {
  conversationId, query, text, citations,
  retrievedChunkIds, model, latencyMs,
  inputTokens, outputTokens, traceId,
}): Promise<void>

// env (→ env.ts)
parseEnv(input: Record<string, unknown>): {
  DATABASE_URL, VOYAGE_API_KEY, OPENAI_API_KEY
}

// citation 도메인 타입 (→ generation.md §Citation)
type Citation = {
  chunkId, docId, sourceId, docTitle, docVersion, sourceUrl,
  page, sectionPath, content, quote, quoteStart, quoteEnd
};
```

`@vat/core`의 public 표면은 `packages/core/src/index.ts`에서 의도적으로 좁게 export: `createCore`, `Core`, `parseEnv`, `Citation`만.

## 6. Network API contract (web ↔ client)

### POST `/api/chat`

요청 body (`apps/web/app/api/chat/route.ts`):
```jsonc
{
  "message": { /* AI SDK UIMessage 형태, 마지막 user 메시지 한 건 */ },
  "conversationId": "uuid"
}
```

응답: AI SDK `createUIMessageStream` SSE. 클라가 받는 parts:
- `data-trace` — `{ id: string }` OTEL trace_id (피드백 score 송출 키)
- `data-citation` — `Citation` 1건. cite_chunk verify 통과 시점마다 emit
- `text-start` / `text-delta` / `text-end` — 답변 본문 토큰. `[n]` 마커 없음

종료 후 서버가 messages.savePair로 conversations + messages 2건 transaction 기록.

`withRateLimit` wrapper로 3-단 sliding window 적용 (per-IP 5/min + per-IP 10/day + 전역 20/day).

### POST `/api/feedback`

요청 body (`apps/web/app/api/feedback/route.ts`):
```ts
{ traceId: string, value: 1 | -1 }
```

응답: 204. `@langfuse/client::score.create`로 trace에 score attach (이름 `user-thumbs`, dataType `NUMERIC`).

## 7. Security

- **인증·RBAC·audit·PII**: 비범위. 익명 접근.
- **Rate limit**: `/api/chat` 3-단 sliding window. `apps/web/src/shared/lib/security/{ratelimit,with-rate-limit}.ts`. Upstash Redis (`UPSTASH_REDIS_REST_URL/TOKEN`). env 미설정 시 graceful 통과(dev 마찰 0). 초과 시 429 + `Retry-After`.
- **Env 검증**: `packages/core/src/env.ts::parseEnv` (zod). `DATABASE_URL` · `VOYAGE_API_KEY` · `OPENAI_API_KEY`. 라이브러리는 검증만, 로딩은 consumer 책임.

## 8. 인프라

```
dev                              prod
docker-compose.yml               Vercel (apps/web만 빌드)
  postgres + pgvector            Neon Postgres + pgvector
                                 Langfuse Cloud / self-host
ingest 실행: pnpm ingest:all (로컬 수동, → ingestion 흐름)
```

## 9. Embedding 모델 결정 (cross-plane invariant)

ingest plane과 retrieval plane이 **동일 모델·차원**을 박제해야 cosine 유사도가 의미를 가짐. 모델 변경 = 전체 재적재.

- 모델: `voyage-3` (1024-dim)
- 차원: `chunks.embedding vector(1024)`
- ingest: `input_type="document"` (jobs/ingest/src/ingest/embedding/embedder.py)
- retrieval: `input_type="query"` (packages/core/src/adapters/embedding.ts)

상세는 [embedding.md](./embedding.md).

## 10. 후속 결정

전체 후속 TODO는 [TODO.md](./TODO.md).
