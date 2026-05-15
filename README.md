# VAT 신고 RAG 챗봇

국세청 부가세 자료 RAG + tool-call citation + char-range highlight + Langfuse 관찰성 + 결정적 4축 평가.

설계 근거는 `spec` 대신 [`docs/`](./docs)에 단일 책임 단위로 박제.

---

## Quick Start

```bash
pnpm install
pnpm compose:up && pnpm db:migrate
pnpm ingest:sync && pnpm ingest:all
pnpm web:dev                                # → http://localhost:3000
```

필수 env: `DATABASE_URL` · `OPENAI_API_KEY` · `VOYAGE_API_KEY`.
선택: `LANGFUSE_*` · `UPSTASH_REDIS_*` (미설정 시 graceful degrade).

---

## Architecture

```
apps/web (Next.js · AI SDK SSE)
   ↓ createCore(config)
packages/core (chat / retrieval / eval services)
   ↓ Drizzle + postgres-js
Postgres + pgvector (HNSW)
   ↑
   │ SQLAlchemy
jobs/ingest (Python ETL · uv)
```

자세한 모듈 경계 + API contract: [docs/architecture.md](./docs/architecture.md).

---

## Flows

### Ingestion (`pnpm ingest:all`)

| # | 단계 | 도구 | 핵심 | 깊이 |
|---|------|------|------|------|
| 1 | fetch   | httpx        | ETag/304로 변경 없으면 skip | — |
| 2 | extract | pdfplumber   | TOC·러닝 헤더/푸터 제거 | — |
| 3 | chunk   | tiktoken     | 500토큰 / 50중첩, heading prepend | [chunking](./docs/chunking.md) |
| 4 | embed   | voyage-3     | `content_hash` 캐시 — 동일 텍스트 재실행 시 API 0건 | [embedding](./docs/embedding.md) |
| 5 | load    | SQLAlchemy   | `ON CONFLICT (doc_id, content_hash) DO NOTHING` | [architecture](./docs/architecture.md) |

단계별 `.cache/*` 산출물로 분리 → 부분 재실행 자연.

### Chat (`POST /api/chat`)

| # | 단계 | 산출 | 깊이 |
|---|------|------|------|
| 1 | `retrieve(query, k=8)`                        | `chunks[8]` | [retrieval](./docs/retrieval.md) |
| 2 | `recentTurns(conversationId, 6)`              | multi-turn history | [generation §6](./docs/generation.md) |
| 3 | `streamText(system + history + tools)`        | `text-delta` → `textStream` | [generation §1](./docs/generation.md) |
| 4 | `cite_chunk` tool-call + `quote ⊂ chunk` verify | `citationStream` | [generation §4](./docs/generation.md) |
| 5 | `recordChatTurn`                              | conversations + messages 단일 transaction | [architecture](./docs/architecture.md) |

---

## Documentation

단계 디테일은 위 Flows 표에서 직접 link. 단계 흐름 외 cross-cutting:

- [evaluation](./docs/evaluation.md) — 골든셋 30문항, 결정적 4축 채점
- [observability](./docs/observability.md) — Langfuse OTEL trace + user thumbs score
- [TODO](./docs/TODO.md) — 후속 작업 한 줄씩

---



## CLI

```bash
pnpm core:ask "수출 매출의 영세율 적용 요건은?"     # 단발 검증
pnpm eval:run --limit=3                              # 골든셋 채점
pnpm db:studio                                       # Drizzle Studio
```

---

## Stack

Next.js 16 · TypeScript · pnpm workspaces · Python 3.12 (uv) · OpenAI gpt-4o-mini · Voyage-3 · Postgres + pgvector · Drizzle · Langfuse · Vercel · Neon · Upstash Redis.
