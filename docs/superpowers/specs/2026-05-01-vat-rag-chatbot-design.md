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
국세청 공식 자료 세 종류 — 모두 ingest 대상이며 각각 별도 어댑터를 둔다(§3.1):
- **PDF**: 부가세 신고서 작성요령·환급/간이과세 안내 등 (디지털 텍스트 PDF, 표 다수)
- **HTML**: 국세청 홈택스 안내 페이지
- **법령**: 부가가치세법/시행령 (국가법령정보센터 OpenAPI로 조문 단위 수집)

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
                ┌────────────────────────────────────────────────────┐
                │  apps/web   (Next.js · TypeScript · Vercel)        │
                │   ├─ /api/chat        sync — RAG 응답 스트리밍      │
                │   └─ /api/feedback    sync — Langfuse score        │
                └──────────────────────┬─────────────────────────────┘
                                       │ packages/core (TS 공유 lib)
                                       │   ├─ db/schema.ts (Drizzle, 단일 스키마 소스)
                                       │   ├─ db/client.ts
                                       │   └─ db/gateway.ts (응답 plane 단일 진입)
                                       ▼
                            [Neon Postgres + pgvector]
                                       ▲
                                       │ psycopg + gateway.py (ingest plane 단일 진입)
                ┌──────────────────────┴─────────────────────────────┐
                │  services/ingest-py   (Python 3.12 · uv · CLI)     │
                │   data/sources.json → kind 분기 어댑터              │
                │     ├─ sources/pdf.py    (pdfplumber)              │
                │     ├─ sources/html.py   (httpx + trafilatura)     │
                │     └─ sources/law.py    (국가법령정보센터 OpenAPI) │
                │   → fetch → parse → chunk → embed → upsert + audit │
                └────────────────────────────────────────────────────┘

[Inngest]  (W3+ — cron only)
  └─ cron eval.golden.weekly  → 30문항 일괄 실행 → Langfuse
```

### 1.1 구성 요소
1. **Ingestion 파이프라인** (`services/ingest-py`, Python + uv) — `data/sources.json`의 항목을 kind(`pdf`/`html`/`law`) 어댑터로 분기 처리: fetch → 텍스트/구조 추출 → 청크 → 임베딩 → upsert + audit. 로컬은 `pnpm ingest:all` (uv를 위임 호출), CI는 GHA python job(W4).
2. **Retrieval** — 질문 임베딩 → pgvector cosine top-k=8
3. **Generation** — Claude(`claude-sonnet-4-6`) + Vercel AI SDK `streamText`, 인용 강제 + tool 2개
4. **HITL UI** — 인용 칩, 👍/👎/코멘트, 답변 이력
5. **LLMOps** — Langfuse trace + 사용자 score + 골든셋 자동 평가

### 1.2 적용 아키텍처 패턴
서버리스 LLM 애플리케이션에서 검증된 패턴을 토이 스케일로 적용한다:

- **Polyglot plane 분리** — `apps/web`(응답, TS) ↔ `packages/core`(공유 lib, TS) ↔ `services/ingest-py`(데이터 가공, Python). 세 plane이 **process 경계**로 분리되어 web 번들에 ingest 의존성(pdfplumber 등)이 섞이지 않고, 각 plane이 자기 도메인에 맞는 도구를 쓴다.
- **단일 스키마 소스 + 양 plane gateway** — Drizzle 스키마(`packages/core/src/db/schema.ts`)가 데이터 모델의 단일 진실. TS는 `gateway.ts`, Python은 `gateway.py`로 각자 plane의 모든 DB 접근을 통제하되, 양쪽 모두 동일한 invariant(append-only audit, `file_hash` UNIQUE, `app_user` role 강제)를 따른다.
- **오프라인 경로 분리** — `/api/chat`은 sync, ingest는 CLI 스크립트(로컬/CI), 평가는 Inngest cron(W3+). 응답 경로 바깥에서 수행.

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
-- 인덱스: HNSW(embedding vector_cosine_ops) — m=16, ef_construction=64 (pgvector 기본값)
--   ivfflat(lists=100)에서 변경 — toy 규모(수백~수천 chunks)에서 ivfflat 튜닝 의미가 없고,
--   HNSW는 데이터 추가에 robust하며 build·운영 모두 default로 충분.

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

### 2.1 Gateway 인터페이스 (양 plane)

**TS — `packages/core/src/db/gateway.ts`** (응답 plane: apps/web, Inngest cron worker)
```ts
export const gateway = {
  documents: { upsert, listByVersion },
  chunks:    { search, insertMany, byIds },
  messages:  { create, listByConversation },
  feedback:  { submit },
  audit:     { append },
  eval:      { saveRun, listRuns },
};
```

**Python — `services/ingest-py/src/ingest/gateway.py`** (ingest plane)
```python
class Gateway:
    documents: DocumentsRepo  # upsert(idempotent on file_hash), list_by_version
    chunks:    ChunksRepo     # insert_many (search은 TS plane에서)
    audit:     AuditRepo      # append (append-only)
```

각 plane은 자기 gateway 객체로만 DB 접근. 두 gateway는 같은 Postgres 스키마를 공유하고 같은 invariant(`file_hash` UNIQUE, `(doc_id, content_hash)` UNIQUE, `app_user` role의 audit_log UPDATE/DELETE 권한 없음)를 SQL 수준에서 강제한다.

---

## 3. RAG 파이프라인

### 3.1 Ingestion (`services/ingest-py` — Python CLI)

진입점은 admin 업로드가 아니라 **Python CLI**다. `data/sources.json`에 국세청 자료의 메타데이터(URL/법령 식별자/버전)를 kind별로 선언하고, 어댑터가 kind에 맞춰 fetch·파싱한다. CI(GHA)도 동일 CLI를 실행한다.

**소스 종류와 어댑터** (spec §0.3의 세 카테고리를 모두 커버)

| kind | 어댑터 | 도구 | 청크 단위 |
|---|---|---|---|
| `pdf` | `sources/pdf.py` | `pdfplumber` (표 인식·레이아웃 보존) | 섹션 헤더 + fallback 500토큰/50중첩 |
| `html` | `sources/html.py` | `httpx` + `trafilatura`(본문 추출) / `selectolax`(selector) | DOM 헤더(h1~h3) + fallback |
| `law` | `sources/law.py` | 국가법령정보센터 OpenAPI(`law.go.kr`) | 조문 단위 1:1 |

**공통 단계**

| 단계 | 도구 | 결정 근거 |
|---|---|---|
| 소스 레지스트리 | `data/sources.json` (Pydantic discriminated union) | 수집 대상이 코드 리뷰 가능한 형태로 박제됨 |
| 다운로드 | `httpx` + content-type/size 검증, 30s 타임아웃, 1회 retry(지수 백오프) | 외부 의존 최소 |
| 정규화 | regex + `unicodedata` (페이지번호 제거, 전각/반각, 표 구분자 보존, 공백 압축) | 한국어 검색 노이즈 감소 |
| 메타데이터 | `{kind, tax_type, page?, section_path, doc_version, law_article?}` | 메타필터 검색 기반 |
| 임베딩 | Voyage-3 (`input_type='document'`) | 문서/쿼리 모드 분리 |
| 멱등성 | `documents.file_hash` UNIQUE + `chunks(doc_id, content_hash)` UNIQUE | 재실행/재크롤 안전 |

**라벨 컨벤션** (`tax_type`, `doc_version`)

| 필드 | kind | 형식 | 예시 |
|---|---|---|---|
| `tax_type` | 모든 kind | `<세목>-<카테고리>` | `vat-general`, `vat-simplified`, `vat-common` |
| `doc_version` | `pdf` (안내자료) | `YYYY` 또는 `YYYY-Nq` | `2025-1q`, `2026` |
| `doc_version` | `law` | `YYYY-MM-DD-법령번호` | `2025-07-01-법률34501호` |
| `doc_version` | `html` | `crawled-YYYY-MM-DD` | `crawled-2026-05-01` |

세목 prefix(`vat-`)는 향후 다세목 확장(`inc-`/`corp-` 등)에 자연스럽게 열어두려는 강제. `doc_version`은 자유 라벨이지만 kind별 컨벤션을 따르며 `documents.version` 컬럼에 저장된다 — 정렬·최신판정 로직은 v2(다버전 자료가 쌓일 때).

모듈: `services/ingest-py/src/ingest/{fetch, chunk, embed, orchestrate, gateway}.py` + `sources/{pdf,html,law,base}.py` — 각각 pytest. CLI는 `scripts/ingest.py`(단건) / `scripts/ingest_all.py`(레지스트리 순회) 두 개로 얇게.

### 3.2 Retrieval

```ts
// packages/core/src/rag/retrieve.ts
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
개발                                          배포
docker-compose.yml                            Vercel (apps/web만 빌드)
 ├─ postgres + pgvector                       Neon Postgres (pgvector)
 ├─ langfuse (W3+)                            Langfuse Cloud (free)
 └─ inngest dev server (W3+)                  Inngest Cloud (cron, W3+)

ingest 실행
 - 로컬:  pnpm ingest:all   (내부적으로 uv run python -m scripts.ingest_all)
 - CI:    GHA python job (W4) — actions/setup-python + uv sync + 동일 명령
```

런타임 분리: Vercel은 `apps/web`만 빌드하므로 ingest 의존성(pdfplumber 등 Python lib)이 web 번들에 들어가지 않음.

### 5.4 CI/CD (GitHub Actions — 두 단계 잡)

**TS 잡** (apps/web + packages/core)
1. `lint` (ESLint + Prettier)
2. `typecheck` (`pnpm -r exec tsc --noEmit`)
3. `test:ts` (Vitest — gateway / retrieve / score)
4. `eval:smoke` (5문항, ~30초)
5. `vercel deploy` (preview / production 분기, `apps/web`만)

**Python 잡** (services/ingest-py)
1. `uv sync`
2. `pytest` (gateway · 어댑터 3종 · chunker · orchestrate)
3. (W4) `pnpm ingest:all` smoke run on staging DB

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

**모노레포** (pnpm workspaces): `apps/web` · `packages/core` · `services/ingest-py`

- **apps/web** — Next.js 15 (App Router) / TypeScript / Vercel AI SDK / NextAuth + Google OAuth
- **packages/core** — Drizzle ORM (스키마 단일 소스) / postgres.js / zod
- **services/ingest-py** — Python 3.12 / uv / psycopg + pgvector / pdfplumber / trafilatura · selectolax / httpx / pydantic + pydantic-settings / voyageai
- **Infra** — Neon Postgres + pgvector / Anthropic Claude (Sonnet 4.6) + Voyage-3 / Langfuse / Inngest cron(W3+) / GitHub Actions / Docker Compose

---

## 8. 프로젝트가 다루는 기술 영역

본 토이가 학습·시연 목적으로 의도적으로 포함한 기술 영역과 구현 위치.

| 영역 | 본 설계 매칭 |
|---|---|
| 모노레포 / 폴리글랏 plane 분리 | pnpm workspaces (apps/web, packages/core, services/ingest-py) — TS↔Python process 경계 |
| Full-stack TypeScript | apps/web + packages/core (Next.js App Router + 공유 lib) |
| REST API | `/api/chat`, `/api/feedback` |
| CLI / 데이터 수집 | `services/ingest-py` Python CLI + `data/sources.json` 레지스트리 |
| 데이터 가공 (Python) | pdfplumber(PDF) · trafilatura/selectolax(HTML) · 국가법령정보센터 OpenAPI(법령) |
| RDBMS 스키마/마이그레이션 | Drizzle + PostgreSQL(Neon), 9개 테이블 (스키마 단일 소스) |
| 인증/권한 | NextAuth(Auth.js) + Google OAuth + 단일 RBAC |
| 비동기/이벤트 | Inngest cron (`eval.golden.weekly`, W3) — ingest는 의도적으로 Python CLI로 단순화 |
| 감사 로그 / observability | append-only `audit_log` + `app_user` REVOKE + Langfuse trace |
| 컨테이너 / CI/CD | docker-compose + GitHub Actions (Node + Python 두 단계) |
| LLM 애플리케이션 | Anthropic Claude + Vercel AI SDK + tool calling |
| Vector retrieval | pgvector + Voyage-3 임베딩 (양 plane에서 호출) |
| Evaluation / LLMOps | 골든셋 30문항 + 자동 채점 + GHA smoke gate + Langfuse |
| 프롬프트 자산화 | `prompts/` 디렉토리 + version 필드 + eval 비교 |
| 도메인 / 파일 처리 | 부가세 도메인 + PDF/HTML/법령 ingest 파이프라인 |
