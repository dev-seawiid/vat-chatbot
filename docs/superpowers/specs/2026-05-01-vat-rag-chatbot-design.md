# 부가세 신고 가이드 RAG 챗봇 — 설계 문서

작성: 2026-05-01 · 최종 갱신: 2026-05-14 (구현 정렬)
상태: 구현 진행 (W3)
저자: dev-seawiid

## 0. 개요

### 0.1 목적
국세청 공식 자료 기반 부가세(VAT) 신고 RAG 챗봇. 프로덕션 LLM 애플리케이션 핵심 요소(RAG · tool · evaluation · observability · HITL)를 토이 스케일로 학습·시연.

### 0.2 사용자
세무 실무자(직원·창업자) — 매입세액공제·영세율·간이과세 실무 케이스.

### 0.3 지식 베이스
국세청 PDF — 매뉴얼·사례집 (`data/sources.json` 레지스트리). HTML·법령은 어댑터 자리만 남기고 본 spec 범위 외(후속).

### 0.4 비범위
인증·RBAC · audit_log · PII 마스킹 · 다중 대화 이력 UI · feedback DB 저장 · LLM 호출/일반 CI 자동화 일체(cron · GHA · 머지 게이트 · admin 대시보드). 사유는 토이 운영 부담 vs 가치 비교 — 영구 범위 외.

**부분 적용**: 멀티턴 RAG는 §3.3에 옵션 A(generation-only multi-turn, window cap 6 messages) 적용. history-aware retrieval(query rewriting, 옵션 B)은 후속 슬라이스 TODO — 사용자 후속 질문이 직전 답변에 의존하는 케이스(예: "그건 어떻게 다른가요?")에서 retrieve 정확도 측정 후 도입 결정.

---

## 1. 전체 아키텍처

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
│  chat/          ChatService + MessageRepo    │
│  retrieval/     RetrievalService + ChunkRepo │
│  eval/          EvalService + EvalRepo       │
│  adapters/      embedding(voyage) · gen(oai) │
│  db/client.ts   drizzle + postgres-js        │
│  shared/        citation 도메인 타입         │
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

### 1.1 의존 방향
- `apps/web → packages/core` 단방향. core는 web 모름.
- `packages/core`는 `process.env`·외부 I/O 부팅 안 읽음. `createCore(config)`의 인자로만 주입. env 로딩은 consumer 책임(Next.js 자동 / CLI `tsx --env-file`).
- `jobs/ingest`는 process 경계로 완전 분리 — DB만 공유. web 번들에 Python 의존성 비유입.

### 1.2 적용 패턴
- **Composition root** — `packages/core/src/core.ts`가 모든 wiring 소유. service만 표면 노출, repository는 service deps로만 흐름.
- **Domain-sliced Repository** — `chat.message.repository` / `retrieval.chunk.repository` / `eval.eval.repository`. 트랜잭션 경계는 repository가 소유.
- **Adapters** — 외부 SDK(`@ai-sdk/openai`, Voyage fetch)는 `adapters/`에서만. 도메인 코드는 `EmbedFn`·`LanguageModel` 인터페이스만 본다.
- **Polyglot plane** — TS(응답·평가)와 Python(데이터 가공)이 process 경계로 분리. 단일 DB 스키마(Drizzle) 공유.

비채택: 멀티 모델 cross-verification(평가셋 일부만), 메시지 브로커·다중 게이트웨이·K8s, 별도 NoSQL — 토이 스케일에 과잉.

---

## 2. 데이터 모델

PostgreSQL + pgvector. Drizzle ORM이 스키마 단일 진실. 모든 컬럼은 ORM camelCase ↔ DB snake_case 자동 매핑(`casing: "snake_case"`).

```sql
documents (
  id          uuid PK,
  title       text NOT NULL,
  source_url  text,
  version     text,
  file_hash   text UNIQUE NOT NULL,    -- ingest 멱등 키
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
  metadata      jsonb NOT NULL DEFAULT '{}',  -- {source_id, kind, tax_type, doc_version, ...}
  created_at    timestamptz NOT NULL,
  UNIQUE (doc_id, content_hash)
)
-- 인덱스: HNSW(embedding vector_cosine_ops) — pgvector 기본(m=16, ef_construction=64)

conversations (id uuid PK, title text, created_at timestamptz)

messages (
  id                   uuid PK,
  conversation_id      uuid FK→conversations ON DELETE CASCADE,
  role                 text NOT NULL,
  content              text NOT NULL,
  citations            jsonb NOT NULL DEFAULT '[]',  -- Citation[] (§3.4)
  retrieved_chunk_ids  uuid[],
  model                text,
  latency_ms           int,
  input_tokens         int,
  output_tokens        int,
  trace_id             text,                          -- OTEL trace_id, Langfuse score join 키
  created_at           timestamptz NOT NULL
)

eval_items (
  id                    text PK,                      -- 슬러그 (vat-<cat>-<diff>-<n>)
  question              text NOT NULL,
  expected_keywords     text[] NOT NULL,
  expected_citation_doc text NOT NULL,                -- sources.json id
  category              text NOT NULL,
  difficulty            text NOT NULL,
  tax_type              text NOT NULL,
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
  results           jsonb NOT NULL,                   -- 항목별 점수 배열 (§4.4)
  summary           jsonb NOT NULL                    -- 가중평균·축별 평균
)
```

`chunks.metadata` jsonb의 키는 ingest plane(Python)이 정한 snake. SQL 내부 키이므로 TS 도메인 표면(camel)과 격리.

---

## 3. RAG 파이프라인

### 3.1 Ingest (`jobs/ingest`, Python)

5단계 CLI를 분리해 각 단계가 idempotent하게 .cache/* 산출물을 만든다 — 부분 재실행·디버깅이 자연스럽다.

| 단계 | 스크립트 | 입력 | 출력 |
|---|---|---|---|
| fetch   | `fetch_pdfs.py`   | `data/sources.json` | `.cache/raw/*.pdf` + `manifest.json (sha256)` |
| extract | `extract_pdfs.py` | 위 PDF | `.cache/extracted/*.json` (pdfplumber) |
| chunk   | `chunk_pdfs.py`   | 위 JSON | `.cache/chunks/*.json` (heading + 500토큰/50중첩 fallback) |
| embed   | `embed_chunks.py` | 위 chunks | `.cache/embeddings/*.json` (Voyage `input_type=document`) |
| load    | `load_to_db.py`   | chunks + embeddings | Postgres `documents` / `chunks` 적재 |

DB 접근: `src/ingest/load/{document_repository,chunk_repository}.py` (SQLAlchemy 2.x + psycopg). 멱등성:
- `documents.file_hash` UNIQUE — 같은 PDF 재적재 → 동일 행 재사용
- `chunks(doc_id, content_hash)` UNIQUE + `INSERT … ON CONFLICT DO NOTHING`

진입점: `pnpm ingest:all` (= 5단계 순차). 단일 단계 실행도 가능. CI 자동화는 §0.4 비범위.

### 3.2 Retrieval

`packages/core/src/retrieval/` — `RetrievalService.retrieve()` = Voyage query embedding + `ChunkRepository.search()`.

```sql
SELECT id, content, page, section_path,
       metadata->>'source_id' AS source_id,
       1 - (embedding <=> $query_emb) AS similarity,
       documents.title, documents.version, documents.source_url
FROM chunks
INNER JOIN documents ON documents.id = chunks.doc_id
WHERE ($tax_type::text IS NULL OR metadata->>'tax_type' = $tax_type)
ORDER BY embedding <=> $query_emb
LIMIT $k;       -- 기본 k=8
```

재랭커·하이브리드는 v2 — 평가셋 baseline 확보 후 결정.

### 3.3 Generation

`packages/core/src/chat/chat.service.ts::ask(query, opts)` = `retrieval.retrieve()` → `streamText({ model, system, messages, tools, stopWhen: stepCountIs(5), experimental_telemetry })`. 두 stream(`textStream`, `citationStream`)과 `finish` promise를 묶은 객체를 반환 — 텍스트와 인용이 시간 순으로 별도 채널로 흐른다.

**프롬프트** — `chat/prompt.ts`
```
당신은 국세청 공식 자료를 기반으로 답하는 부가세 신고 어시스턴트다.
- 제공된 <context> 안의 내용만 근거로 답하라.
- 인용은 본문에 [n] 같은 마커를 박지 말고, 반드시 cite_chunk 도구로만 선언하라.
  - chunkId: <context>의 [chunkId=...] 라벨 값을 그대로 사용.
  - quote: 해당 chunk 본문에서 그대로 발췌한 30~120자 문장(요약·재작성 금지).
  - 새로운 주장을 할 때마다 즉시 호출하라. 답변 끝에 몰아서 호출 금지.
- context에 근거가 없으면 "공식 자료에서 확인되지 않습니다"라고 답하라. 추측 금지.
- 계산이 필요하면 calc_vat 도구를 사용하라. 직접 산수 금지.
```
`buildSystemMessage(chunks)`이 retrieved chunk 8개를 `[chunkId=...]` 라벨과 함께 `<context>…</context>`로 포장 → system role로 격리(prompt injection 방어). chunkId는 모델이 cite_chunk 인자로 그대로 복사하는 도메인 키.

`PROMPT_VERSION = "v2"` 상수 — eval_runs.prompt_version 비교 키 (v1=inline marker, v2=cite_chunk tool-call).

**Multi-turn context** — `ask`가 `opts.conversationId`를 받으면 `messageRepo.recentTurns(conversationId, 6)`으로 직전 6 messages를 fetch해 `streamText`의 `messages` 배열에 history로 펼친다(`HISTORY_WINDOW`). 옵션 A: generation-only multi-turn — retrieve는 현재 turn의 query만 사용. history-aware retrieval(query rewriting)은 후속(§0.4). eval CLI / `core:ask` CLI는 conversationId 미주입으로 single-turn 동작.

**모델 결정** — adapter 파일 안 단일 상수.
- `adapters/generation.ts`: `GENERATION_MODEL_ID = "gpt-4o-mini"` (OpenAI provider via `@ai-sdk/openai`)
- `adapters/embedding.ts`: `EMBEDDING_MODEL_ID = "voyage-3"` (Voyage REST, 1024-dim). ingest plane도 동일 ID 박제 — cosine 정합성 invariant.

**Tools** — `chat/tools.ts`
| 도구 | 구현 |
|---|---|
| `cite_chunk({chunkId, quote})` | 인용 선언 채널. execute는 ack만, 인자(chunkId/quote)가 페이로드. chat.service가 fullStream에서 가로채 `quote ⊂ chunk.content` strict 검증 후 `citationStream`으로 emit. 실패 시 drop(환각 차단). |
| `calc_vat({taxable_amount, rate})` | native number 곱셈(toy). decimal.js 교체는 v2. |
| `lookup_law_article({article_no})` | **stub** — 국가법령정보센터 어댑터 도입 후 동작 (후속) |

### 3.4 Citation 도메인 객체

`packages/core/src/shared/citation.ts` — camelCase 단일 형태로 도메인·UI·jsonb 영속화 모두 동일.

```ts
type Citation = {
  chunkId: string; docId: string; sourceId: string;     // sourceId = sources.json 자연키
  docTitle: string; docVersion: string | null;
  sourceUrl: string | null;                              // 원본 PDF 다운로드 앵커
  page: number | null; sectionPath: string | null;
  content: string;                                       // chunk 본문 전체 (highlight 좌표 기준)
  quote: string;                                         // 모델이 발췌한 문장(invariant: content.slice(quoteStart, quoteEnd) === quote)
  quoteStart: number;                                    // content 내 시작 char index
  quoteEnd: number;                                      // 끝 char index (exclusive)
};
```
`toCitation(searchResult, quote, quoteStart)`로 변환 — chat.service의 verify가 `quoteStart`를 계산해 넘기므로 좌표 정합성은 호출자가 보장. quote 3필드는 Anthropic Citations API의 (cited_text, start_char_index, end_char_index) 형태로 자기 충족성·post-hoc 검증 가능성·UI highlight 정밀도를 동시에 확보. UI는 본문 아래 참고 칩 클릭 → 모달에서 `content` + quote 구간 `<mark>` highlight.

### 3.5 SSE 스트리밍 (apps/web)

`apps/web/app/api/chat/route.ts` → `streamChat()` (`src/pages/chat/server.ts`) → AI SDK `createUIMessageStream`. 클라가 받는 parts:
- `data-trace` — OTEL trace_id (피드백 score 송출 키)
- `data-citation` — Citation 1건 (모델이 cite_chunk를 호출하고 verify 통과할 때마다 emit, N건 누적)
- `text-start / text-delta / text-end` — 답변 본문 토큰 (마커 없음, plain text)

`streamChat`이 core의 `textStream`/`citationStream`을 `Promise.all`로 병렬 drain. 클라(`entities/message/lib/parts.ts::getCitations`)는 parts에서 `data-citation`들을 모아 chunkId dedup 후 본문 아래 참고 칩으로 렌더 — `[n]` 정규식 파서 없음.

스트림 종료 시 `chat.recordChatTurn()`이 conversations + messages 2건을 단일 transaction에 기록(`MessageRepository.savePair`). `messages.citations` jsonb엔 verify 통과한 누적 list만 박제(환각 차단). persist 실패는 사용자에게 보여진 답변이 이미 있으므로 서버 로그만.

### 3.6 에러 처리 (시스템 경계만)

| 케이스 | 처리 |
|---|---|
| Voyage / 생성 모델 실패 | throw → 응답 단계에서 5xx (retry는 미구현, 도입 시 1회 지수 백오프) |
| context 비어있음 | streamText는 진행 — 시스템 프롬프트의 거절 규칙으로 모델이 처리 |
| persist 실패 | 답변은 이미 전달, 서버 로그만(`console.error`) |
| feedback 송출 실패 | 502 + 클라에게 에러 표시 |

내부 함수(repository, retrieve)는 방어 코드 없음.

---

## 4. LLMOps & 평가

### 4.1 Langfuse (OTEL 기반)

스택 — `@langfuse/tracing` + `@langfuse/otel` + `@opentelemetry/sdk-node` + `@opentelemetry/api`. AI SDK가 emit하는 OTEL spans를 `LangfuseSpanProcessor`가 받아 export.

부트스트랩 — `apps/web/instrumentation.ts` → `instrumentation.node.ts`에서 `NodeSDK({ spanProcessors: [langfuseSpanProcessor] }).start()`. Edge runtime 비호환이므로 `/api/chat` 라우트는 nodejs runtime.

호출측 — `chat.service.ts`가 `experimental_telemetry: { isEnabled: true, functionId: 'rag.ask' }` 주입(`CoreConfig.telemetry`로 web plane만 활성, CLI는 미주입). `streamChat`이 `propagateAttributes({ sessionId: conversationId, traceName: 'chat-message' })`로 ask 전체 감싸 메타 전파.

서버리스 flush — `app/api/chat/route.ts`의 `after(() => langfuseSpanProcessor.forceFlush())`로 응답 종료 후 명시 export.

env — `LANGFUSE_PUBLIC_KEY` · `LANGFUSE_SECRET_KEY` · `LANGFUSE_BASEURL`. `LangfuseClient`(feedback)가 자동 소비. 미설정 시 spans drop, 동작 무영향(graceful).

### 4.2 Trace 스키마
```
trace (root: traceName='chat-message', sessionId=conversation_id)
├─ generation: ai.streamText (functionId='rag.ask')   — AI SDK 자동
│    input: { system, context, query }
│    output: { text }
│    usage: { input_tokens, output_tokens }
├─ span: ai.toolCall.calc_vat (옵션)                  — AI SDK 자동
└─ score (피드백 도착 시 별도 호출 — @langfuse/client REST)
     name="user-thumbs", value=1|-1, traceId=messages.trace_id
```
`messages.trace_id`(OTEL trace_id 32-hex)가 score attach 키.

### 4.3 핵심 메트릭
응답 latency P50/P95 · 평균 비용/질문 · 인용 포함률 · 사용자 satisfaction · 검색 hit@k.

### 4.4 골든셋 평가
30문항 골든셋 + 4축 결정적 채점(`keyword_recall` 0.4 · `citation_present` 0.2 · `citation_correct` 0.3 · `no_hallucination` 0.1). 수동 트리거 `pnpm eval:run` → `eval_runs` 1행 INSERT. 자동화·머지 게이트·admin 대시보드 비범위(§0.4).

상세 설계: [2026-05-07-eval-goldenset-design.md](./2026-05-07-eval-goldenset-design.md)

---

## 5. UI · 보안 · 인프라

### 5.1 UI
- 인용 칩 `[n]` 클릭 → 원문 chunk + 페이지 + sourceUrl 모달 (`features/open-citation`)
- 👍/👎 → `/api/feedback` → Langfuse score (DB 미저장)
- 단일 롤링 대화 — `localStorage` `vat:cid`로 conversationId 복원

### 5.2 보안
- **인증·RBAC·audit·PII** — 비범위(§0.4)
- **Rate limit** — `/api/chat`만 3-단 sliding window: per-IP 5/min + per-IP 10/day + 전역 20/day. Upstash Redis (`UPSTASH_REDIS_REST_URL/TOKEN`) 미설정 시 graceful 통과. 초과 시 429 + `Retry-After`. 구현: `apps/web/src/shared/lib/security/{ratelimit, with-rate-limit}.ts`.
- **Env 검증** — `packages/core/src/env.ts::parseEnv()` (zod). `DATABASE_URL` · `VOYAGE_API_KEY` · `OPENAI_API_KEY`. 로딩은 consumer 책임(Next.js 자동, CLI는 `tsx --env-file`).

### 5.3 인프라
```
개발                              배포
docker-compose.yml                Vercel (apps/web만 빌드)
  postgres + pgvector             Neon Postgres + pgvector
                                  Langfuse Cloud (free) / self-host
ingest 실행: pnpm ingest:all (로컬 수동만)
```
런타임 분리로 Vercel은 `apps/web`만 빌드 — ingest의 Python 의존성 비유입.

### 5.4 배포 / 검증
GHA CI/CD 비범위. 로컬 pre-commit: `pnpm -r exec tsc --noEmit` + `pnpm web:lint`. Vitest/pytest는 필요 시 수동. 배포는 Vercel push-to-deploy.

---

## 6. 기술 스택

- **apps/web** — Next.js 16 (App Router) · TypeScript · AI SDK v5 · FSD(features/entities/widgets/pages/shared) · Tailwind · shadcn
- **packages/core** — Drizzle ORM · postgres-js · zod · `@ai-sdk/openai`
- **jobs/ingest** — Python 3.12 · uv · SQLAlchemy 2 · psycopg · pgvector-python · pdfplumber · tiktoken · voyageai · pydantic
- **Observability** — `@langfuse/tracing` · `@langfuse/otel` · `@langfuse/client` · `@opentelemetry/sdk-node`
- **보안** — `@upstash/ratelimit` · `@upstash/redis`
- **Infra** — Neon · Vercel (push-to-deploy) · Upstash Redis · Docker Compose (dev)
- **모노레포** — pnpm workspaces (`apps/web` · `packages/core` · `jobs/ingest`)
