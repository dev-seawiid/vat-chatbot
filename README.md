# VAT 신고 RAG 챗봇

부가가치세 법령 RAG + structured citation + char-range highlight + Langfuse 관찰성 + RAGAS 평가.

설계 근거는 `spec` 대신 [`docs/`](./docs)와 [`docs/adr/v2/`](./docs/adr/v2)에 단일 책임 단위로 박제.

---

## Quick Start

```bash
pnpm install
pnpm compose:up && pnpm db:migrate
pnpm ingest:extract && pnpm ingest:parse && pnpm ingest:chunk && pnpm ingest:embed && pnpm ingest:load
pnpm web:dev                                # → http://localhost:3000
```

필수 env: `DATABASE_URL` · `OPENAI_API_KEY` · `VOYAGE_API_KEY`.
선택: `VOYAGE_MODEL`(default `voyage-4`) · `LANGFUSE_*` · `UPSTASH_REDIS_*` (미설정 시 graceful degrade).

---

## Architecture

```
apps/web (Next.js · AI SDK SSE)
   ↓ createCore(config)
packages/core (chat · retrieval · LangGraph)
   ↓ Drizzle + postgres-js
Postgres + pgvector (HNSW)
   ↑
   │ SQLAlchemy
jobs/ingest (Python ETL · uv)
```

자세한 모듈 경계 + API contract: [docs/architecture.md](./docs/architecture.md).

---

## Flows

### Ingestion (ADR-0001/0002)

| # | 단계 | 도구 | 핵심 | 깊이 |
|---|------|------|------|------|
| 1 | extract | Docling (DocLayNet + TableFormer) | `DoclingDocument` JSON 캐시 — 후속 단계 재실행 시 PDF 재변환 회피 | — |
| 2 | parse   | regex + NFKC                       | `제N조/항/호/별표` 메타 + 1-hop `refs[]` 추출 | — |
| 3 | chunk   | voyage `count_tokens`              | article-paragraph-item group, 512토큰 / 150중첩 | [chunking](./docs/chunking.md) |
| 4 | embed   | voyage-4                            | `content_hash` 캐시 — 동일 텍스트 재실행 시 API 0건 | [embedding](./docs/embedding.md) |
| 5 | load    | SQLAlchemy                          | reset + reload (모델·차원 교체 시 stale vector 잔류 방지) | [architecture](./docs/architecture.md) |

fetch 단계는 폐기 (law.go.kr가 안정 PDF URL을 노출하지 않음 — `data/rag_knowledge_base/`에 사전 배치).

### Chat (`POST /api/chat`) — LangGraph v15 parallel (ADR-0003)

| # | 노드 | 동작 |
|---|------|------|
| 1a | `search_direct`   | 원 query 1회 retrieve+rerank → top-8 |
| 1b | `generate_draft`  | LLM 1회 `withStructuredOutput({draft, claims[≤6]})` — 사용자 미노출, 검색 키 |
| 2  | `claim_searches`  | claim별 retrieve+rerank 병렬 → 각 top-4 |
| 3  | `fuse`            | RRF(`k=60`)로 directChunks + claimChunks 결합 → top-10 |
| 4  | `generate_answer` | `createReactAgent` + `responseFormat({answer, citations[]})` — chunk-grounded synthesis, draft는 가이드. 본문 token streaming 없이 1회 emit |

자세한 노드·라우터·재시도 정책: [generation](./docs/generation.md).

종료 후 `recordChatTurn`이 conversations + messages를 단일 transaction으로 기록.

---

## Documentation

단계 디테일은 위 Flows 표에서 직접 link. 단계 흐름 외 cross-cutting:

- [evaluation](./docs/evaluation.md) — Langfuse Dataset 30문항 + RAGAS 4 metric (ADR-0004)
- [observability](./docs/observability.md) — Langfuse OTEL trace + user-thumbs score
- [adr/v2/](./docs/adr/v2/) — 0001 source migration · 0002 ingestion · 0003 RAG chain · 0004 evaluation
- [TODO](./docs/TODO.md) — 후속 작업 한 줄씩

---

## CLI

```bash
pnpm core:ask "수출 매출의 영세율 적용 요건은?"     # full RAG (retrieval + generation)
pnpm core:retrieve "..." --json                      # retrieval pipeline만 (lbr-eval 호출)
pnpm core:generate "..." --chunks=<path>             # 외부 chunks 주입 generation
pnpm ragas-eval:eval                                 # generation 채점 + Langfuse push
pnpm lbr-eval:eval                                   # LegalBench-RAG retrieval 채점
pnpm db:studio                                       # Drizzle Studio
```

---

## Stack

Next.js 16 · TypeScript · pnpm workspaces · Python 3.12 (uv) · LangChain.js + LangGraph · OpenAI gpt-5-mini · Voyage-4 + rerank-2.5 · Postgres + pgvector · Drizzle · Langfuse · Vercel · Neon · Upstash Redis.
