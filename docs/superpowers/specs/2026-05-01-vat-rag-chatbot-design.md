# 부가세 신고 가이드 RAG 챗봇 — 설계 문서

작성일: 2026-05-01
상태: 설계 확정
저자: dev-seawiid

## 0. 프로젝트 개요

### 0.1 목적
국세청 공식 자료를 기반으로 부가세(VAT) 신고 실무 질문에 답하는 RAG 챗봇. 토이 프로젝트로, 프로덕션 LLM 애플리케이션의 핵심 구성요소(RAG · tool calling · evaluation · observability · HITL)를 한 번에 학습·구현하는 것을 목표로 한다.

### 0.2 사용자
세무 실무자(직원·창업자) — 매입세액공제, 영세율, 의제매입 등 실무 케이스 질문 위주.

### 0.3 지식 베이스
국세청 공식 자료 — 부가세 신고서 작성요령 PDF, 국세청 홈택스 안내, 부가가치세법/시행령.

### 0.4 범위 (MVP + LLMOps)
- 채팅 UI에 RAG 응답 + 인용 표시
- 사용자 피드백(👍/👎) 수집
- Langfuse trace
- 골든셋 30문항 자동 평가
- 인증/감사 로그 기본
- Vercel 배포 + GHA CI/CD

명시적 비범위: 멀티 에이전트, 본격 RBAC, fine-tuning, 자체 임베딩 학습.

---

## 1. 전체 아키텍처

```
[Browser]
  ▼
[Vercel Edge/Function] (Next.js Route Handler — serverless)
  ├─ /api/chat              sync — RAG 응답 스트리밍
  ├─ /api/feedback          sync — 짧은 쓰기 + Langfuse score
  └─ /api/admin/ingest      sync — admin 전용. PDF 업로드 → Inngest 이벤트 발행만 수행
  ▼
[Inngest] (event plane, background)
  ├─ event ingest.pdf.uploaded     → parse + chunk + embed + upsert
  └─ cron eval.golden.weekly       → 30문항 일괄 실행 → Langfuse
  ▼
[lib/db/gateway.ts] (mini persistence plane — 모든 DB 접근의 단일 진입)
  ▼
[Neon Postgres + pgvector]
```

### 1.1 구성 요소
1. **Ingestion 파이프라인** (Inngest 백그라운드) — PDF → 텍스트 → 청크 → 임베딩 → upsert
2. **Retrieval** — 질문 임베딩 → pgvector cosine top-k=8
3. **Generation** — Claude(`claude-sonnet-4-6`) + Vercel AI SDK `streamText`, 인용 강제 + tool 2개
4. **HITL UI** — 인용 칩, 👍/👎/코멘트, 답변 이력
5. **LLMOps** — Langfuse trace + 사용자 score + 골든셋 자동 평가

### 1.2 적용 아키텍처 패턴
서버리스 LLM 애플리케이션에서 검증된 두 가지 패턴을 토이 스케일로 적용한다:

- **Edge/Event plane vs Persistence plane 분리** — sync 응답 경로(`/api/chat`)와 백그라운드 경로(Inngest)를 분리. ingest/eval처럼 응답 경로가 아닌 작업은 백그라운드로.
- **Mini gateway** — 모든 DB 접근을 `lib/db/gateway.ts` 단일 진입점에서 수행. 트랜잭션 경계, optimistic locking, 감사 로그를 한 곳에서 강제.

의도적으로 적용하지 않는 패턴(토이 스케일에 과잉이라 판단):
- 멀티 모델 cross-verification — 평가셋 단계에서만 부분 적용
- 메시지 브로커, 다중 게이트웨이, Kubernetes — 토이 스케일에서 동기 부재
- Ephemeral state store(별도 NoSQL) — 토이엔 불필요

---

## 2. 데이터 모델

PostgreSQL + pgvector, Drizzle ORM.

```sql
-- 원천 문서
documents (
  id            uuid PK
  title         text
  source_url    text
  version       text
  file_hash     text UNIQUE
  created_at    timestamptz
)

-- 청크 + 임베딩
chunks (
  id            uuid PK
  doc_id        uuid FK → documents
  page          int
  section_path  text
  content       text
  embedding     vector(1024)
  metadata      jsonb
  created_at    timestamptz
)
-- 인덱스: ivfflat(embedding vector_cosine_ops) lists=100

-- 대화/메시지
conversations (
  id            uuid PK
  user_id       uuid FK → users
  title         text
  created_at    timestamptz
)

messages (
  id            uuid PK
  conversation_id uuid FK
  role          text
  content       text
  citations     jsonb
  retrieved_chunk_ids uuid[]
  model         text
  latency_ms    int
  input_tokens  int
  output_tokens int
  trace_id      text
  created_at    timestamptz
)

-- HITL 피드백
feedback (
  id            uuid PK
  message_id    uuid FK
  user_id       uuid FK
  rating        smallint     -- 1=👍, -1=👎
  comment       text
  created_at    timestamptz
)

-- 감사 로그 (append-only)
audit_log (
  id            uuid PK
  actor_id      uuid
  action        text
  target        text
  payload       jsonb
  ip            inet
  created_at    timestamptz
)
-- REVOKE UPDATE/DELETE TO app_user

-- 평가
eval_items (
  id            uuid PK
  question      text
  expected_keywords text[]
  expected_citation_doc text
  difficulty    text
)

eval_runs (
  id            uuid PK
  ran_at        timestamptz
  model         text
  embedding_model text
  retrieval_k   int
  results       jsonb
  summary       jsonb
)

-- 사용자
users (
  id            uuid PK
  email         text UNIQUE
  role          text         -- "admin" | "user"
  created_at    timestamptz
)
```

### 2.1 Gateway 인터페이스

```ts
// lib/db/gateway.ts
export const gateway = {
  documents: { upsert, listByVersion },
  chunks:    { search, insertMany, byIds },
  messages:  { create, listByConversation },
  feedback:  { submit },
  audit:     { append },
  eval:      { saveRun, listRuns },
};
```

API route, Inngest worker 모두 이 객체로만 DB 접근. 다른 경로 금지.

---

## 3. RAG 파이프라인

### 3.1 Ingestion (Inngest event: `ingest.pdf.uploaded`)

| 단계 | 도구 | 결정 근거 |
|---|---|---|
| 텍스트 추출 | `pdf-parse` (Node) | 국세청 PDF는 디지털 텍스트 |
| 정규화 | 정규식: 페이지번호 제거, 표 구분자 보존, 공백 압축 | 검색 노이즈 감소 |
| 청킹 | 섹션 헤더 기반 의미 청킹 + fallback 500토큰/50중첩 | 작성요령은 섹션 구조가 명확 |
| 메타데이터 | `{tax_type, page, section_path, doc_version}` | 메타필터 검색 기반 |
| 임베딩 | Voyage-3 (`input_type:"document"`) | 문서/쿼리 모드 분리 |
| 멱등성 | `documents.file_hash` UNIQUE + `chunks(doc_id, content_hash)` | 재실행 안전 |

모듈: `lib/rag/ingest/{parse, chunk, embed, upsert}.ts` — 각각 단위 테스트.

### 3.2 Retrieval

```ts
// lib/rag/retrieve.ts
async function retrieve(query: string, opts?: { k?: number; filter?: Filter }) {
  const queryEmbedding = await voyage.embed(query, { input_type: "query" });
  return gateway.chunks.search({
    embedding: queryEmbedding,
    k: opts?.k ?? 8,
    filter: opts?.filter,
  });
}
```

```sql
SELECT id, content, page, section_path, doc_id,
       1 - (embedding <=> $1) AS similarity
FROM chunks
WHERE ($2::text IS NULL OR metadata->>'tax_type' = $2)
ORDER BY embedding <=> $1
LIMIT $3;
```

재랭커는 v2 — 평가셋 baseline 측정 후 도입 결정.

### 3.3 Generation

**시스템 프롬프트 (요지)**
```
당신은 국세청 공식 자료를 기반으로 답하는 부가세 신고 어시스턴트다.
- 제공된 <context> 안의 내용만 근거로 답하라.
- 모든 주장에 [n] 형태로 인용을 붙여라. n은 context의 chunk 번호.
- context에 근거가 없으면 "공식 자료에서 확인되지 않습니다"라고 답하라. 추측 금지.
- 계산이 필요하면 calc_vat 도구를 사용하라. 직접 산수 금지.
```

**메시지 구조**
```
system: <위 프롬프트>
user:   <context>{retrieved chunks 8개를 [1]~[8] 번호로}</context>
        질문: <user query>
```

**모델/호출**
- `claude-sonnet-4-6` 기본, 어려운 케이스만 `claude-opus-4-7` toggle
- Vercel AI SDK `streamText` + `tools`
- prompt caching: 시스템 프롬프트 + tool 정의에 `cache_control: ephemeral`

**Tool calling**
| 도구 | 역할 |
|---|---|
| `lookup_law_article(article_no)` | 부가가치세법 조문 원문 가져오기 |
| `calc_vat({taxable_amount, rate})` | decimal.js 기반 정밀 계산 |

### 3.4 인용 객체화

```ts
{
  citations: [
    { chunk_id, page: 12, doc_title: "2026년 부가세 신고서 작성요령", snippet: "..." }
  ]
}
```

UI에서 `[1]` 클릭 시 모달.

### 3.5 에러 처리 (시스템 경계만)

| 케이스 | 처리 |
|---|---|
| Voyage / Claude 호출 실패 | 1회 retry(지수 백오프), 실패 시 명시적 에러 + Langfuse error span |
| context 비어있음 (k=0) | LLM 호출 전 단계컷 → "관련 자료를 찾지 못했습니다" |
| 인용 누락 응답 | 응답 검사 후 재요청 1회 |
| tool 호출 실패 | tool result에 `{error}` 전달, 모델이 사용자에게 안내 |

내부 함수(gateway, retrieve)는 방어 코드 X — 시스템 경계에서만.

### 3.6 Streaming

```
client SSE ← Vercel Function
  ├─ retrieve()             [non-streaming, ~200ms]
  ├─ streamText() 시작       [first token ~600ms]
  ├─ token 스트림 forward
  ├─ tool call 발생 시 inline 처리 후 재개
  └─ done → messages 저장 + audit + Langfuse trace flush
```

---

## 4. LLMOps & 평가

### 4.1 Langfuse 셋업
- 호스팅: Docker Compose self-host (로컬), 데모 시 Langfuse Cloud 전환
- 통합: Vercel AI SDK + `@langfuse/sdk`
- 환경 분리: `tags: ["env:dev"]` / `["env:prod"]` / `["eval-run"]`

### 4.2 Trace 스키마

```
trace: chat-{conversation_id}-{message_id}
├─ span: retrieve
│    input: { query, filter }
│    output: { chunk_ids, similarities }
├─ generation: claude-sonnet-4-6
│    input: { system, context, query }
│    output: { text, citations }
│    usage: { input_tokens, output_tokens, cost_usd }
├─ span: tool.calc_vat (옵션)
└─ score (피드백 도착 시 비동기)
     name: "user-thumbs", value: 1 | -1
```

### 4.3 핵심 메트릭
- 응답 latency P50/P95
- 평균 비용/질문 (USD)
- 인용 포함률
- 사용자 satisfaction
- 검색 hit@k

### 4.4 골든 평가셋 (30문항)

| 카테고리 | 문항수 |
|---|---|
| 기초 신고/마감 | 6 |
| 영세율/면세 | 6 |
| 매입세액 공제 | 6 |
| 의제매입 | 4 |
| 간이과세 | 4 |
| 가산세 | 4 |

난이도: easy 10 / medium 14 / hard 6

스키마:
```jsonc
{
  "question": "수출 매출의 영세율 적용 요건은?",
  "expected_keywords": ["수출", "영세율", "0%"],
  "expected_citation_doc": "vat-form-guide-2026",
  "difficulty": "medium"
}
```

### 4.5 자동 채점 (4축)

```ts
function score(item, response) {
  return {
    keyword_recall:   item.expected_keywords.filter(k => response.text.includes(k)).length / item.expected_keywords.length,
    citation_present: response.citations.length > 0 ? 1 : 0,
    citation_correct: response.citations.some(c => c.doc_id === item.expected_citation_doc) ? 1 : 0,
    no_hallucination: !/추측|아마|것 같|확실하지/.test(response.text) ? 1 : 0,
  };
}
// 가중 평균: 0.4/0.2/0.3/0.1
```

LLM-as-a-judge는 v2 — 토이 단계엔 결정적 채점이 비용/재현성 우위.

### 4.6 평가 실행

| 트리거 | 방식 |
|---|---|
| 수동 | `pnpm eval:run` → 30문항 |
| 자동(주간) | Inngest cron `eval.golden.weekly` (금요일 03:00) |
| PR 기준 | GHA `eval:smoke` (easy 5문항) — fail이면 머지 블록 |

리그레션 가드: 직전 run 대비 종합 점수 -10%↓이면 GHA exit 1.

### 4.7 실험 비교
`eval_runs` 테이블에 (model, embedding_model, retrieval_k, prompt_version) 키로 누적 → 단순 SELECT로 비교.

---

## 5. HITL UI · 보안 · 인프라

### 5.1 UI 구성

| 요소 | 동작 | 위치 |
|---|---|---|
| 인용 칩 `[n]` | 클릭 → 원문 chunk + 페이지 모달 | `components/chat/CitationChip.tsx` |
| 👍/👎 + 코멘트 | `/api/feedback` POST → DB + Langfuse score | `components/chat/FeedbackBar.tsx` |
| 답변 이력 페이지 | 과거 메시지 + 인용 + 피드백 통합 뷰 | `app/history/page.tsx` |
| Admin 평가 대시보드 | `eval_runs` 시각화 | `app/admin/evals/page.tsx` |

### 5.2 인증/권한/감사

| 영역 | 결정 |
|---|---|
| 인증 | NextAuth(Auth.js) + Google OAuth |
| 세션 | DB 세션 (NextAuth `DrizzleAdapter`) |
| RBAC | `users.role` 단일 차원, middleware로 `/admin/*` 가드 |
| Audit | 모든 mutation은 `gateway.audit.append()` 강제 |
| Audit 무결성 | `REVOKE UPDATE/DELETE FROM app_user` (append-only) |
| PII | 사용자 입력에서 회사명·주민번호 자동 마스킹(정규식) |
| Secret | `lib/env.ts`에서 `zod` 스키마로 검증 |

### 5.3 인프라

```
개발                                  배포
docker-compose.yml                    Vercel (Next.js + Functions)
 ├─ postgres + pgvector                Neon Postgres (pgvector)
 ├─ langfuse                           Inngest Cloud
 └─ inngest dev server                 Langfuse Cloud (free)
```

### 5.4 CI/CD (GitHub Actions)

1. `lint` (ESLint + Prettier)
2. `typecheck` (`tsc --noEmit`)
3. `test` (Vitest — gateway / retrieve / score 단위 테스트)
4. `eval:smoke` (5문항, ~30초)
5. `vercel deploy` (preview / production 분기)

---

## 6. 단계별 구현 순서

총 3~4주 (야간/주말 기준).

| 주차 | 마일스톤 | DoD |
|---|---|---|
| W1 | 프로젝트 골격 + ingest | Next.js 스캐폴드, Drizzle 마이그레이션, PDF 1개 ingest 끝까지 동작 |
| W2 | RAG MVP | `/api/chat` 스트리밍 + 인용 표시, gateway/retrieve 단위 테스트, 시스템 프롬프트 1차 |
| W3 | LLMOps + 평가셋 | Langfuse 연결, 골든셋 30문항 작성, `pnpm eval:run` 동작, eval 대시보드 |
| W4 | HITL + 보안 + 배포 | 피드백 UI, NextAuth, audit_log, RBAC 가드, Vercel/Neon 배포, GHA |
| (여유) | 정리 | README + 데모 영상 + 기술 스택 정리표 |

리스크 컷라인: W3까지 못 끝나면 W4 NextAuth는 매직링크로 다운그레이드, 평가셋은 20문항으로 축소.

---

## 7. 최종 기술 스택

> Next.js (App Router) + TypeScript / Vercel Functions / Inngest / Drizzle + Neon Postgres + pgvector / Anthropic Claude (Sonnet 4.6) + Voyage-3 / Vercel AI SDK / Langfuse / NextAuth + Google OAuth / GitHub Actions + Docker Compose

---

## 8. 프로젝트가 다루는 기술 영역

본 토이가 학습·시연 목적으로 의도적으로 포함한 기술 영역과 구현 위치.

| 영역 | 본 설계 매칭 |
|---|---|
| Full-stack TypeScript | Next.js App Router + TS 전체 |
| REST API | `/api/chat`, `/api/feedback`, `/api/admin/ingest` |
| RDBMS 스키마/마이그레이션 | Drizzle + PostgreSQL(Neon), 9개 테이블 |
| 인증/권한 | NextAuth(Auth.js) + Google OAuth + 단일 RBAC |
| 비동기/이벤트 | Inngest event + cron |
| 감사 로그 / observability | append-only `audit_log` + Langfuse trace |
| 컨테이너 / CI/CD | docker-compose + GitHub Actions |
| LLM 애플리케이션 | Anthropic Claude + Vercel AI SDK + tool calling |
| Vector retrieval | pgvector + Voyage-3 임베딩 |
| Evaluation / LLMOps | 골든셋 30문항 + 자동 채점 + GHA smoke gate + Langfuse |
| 프롬프트 자산화 | `prompts/` 디렉토리 + version 필드 + eval 비교 |
| 도메인 / 파일 처리 | 부가세 도메인 + PDF ingest 파이프라인 |
