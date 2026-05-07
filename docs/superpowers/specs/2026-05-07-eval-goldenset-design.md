# 골든셋 평가 — W3 슬라이스 설계

작성일: 2026-05-07
상태: 설계 확정 (구현 진입 전)
저자: dev-seawiid
관련 문서: [2026-05-01-vat-rag-chatbot-design.md](./2026-05-01-vat-rag-chatbot-design.md) (마스터 spec §4.4–4.7)

## 0. 슬라이스 개요

### 0.1 목적
마스터 spec §4(LLMOps & 평가)의 자동 평가 파이프라인을 닫는다. 30문항 골든셋 JSON을 박제하고, `pnpm eval:run`으로 일괄 실행해 4축 자동 채점 결과를 `eval_runs`에 적재한다. 이후 슬라이스(Inngest cron, GHA smoke gate, admin 대시보드)가 본 슬라이스의 출력을 소비한다.

### 0.2 범위 (W3 eval)
- `data/eval/golden.json` — 30문항 정답 골든셋 (단일 진실)
- `packages/core/src/eval/{score,runner}.ts` — 4축 채점 + 실행 오케스트레이션
- `packages/core/scripts/eval-run.ts` + `pnpm eval:run` — CLI 진입점
- `eval_items` / `eval_runs` 테이블 추가 (Drizzle 마이그레이션)
- `Citation` 타입에 `source_id` 필드 추가, `retrieve` 결과 채움 변경
- 한 번 실행 = 30문항 전체 → `eval_runs` 1행 INSERT

### 0.3 비범위
- **Inngest cron** — 마스터 spec §4.6 weekly run은 별도 슬라이스
- **GHA `eval:smoke` (5문항 게이트)** — W4 CI 통합 슬라이스
- **Admin 대시보드 `/admin/evals`** — 마스터 spec §5.1, 별도 슬라이스
- **Langfuse score 송출** — W3 trace 슬라이스가 닫은 뒤 합류
- **LLM-as-a-judge** — 마스터 spec §4.5에서 v2로 명시
- **재랭커 비교, 멀티 모델 cross-verification** — 마스터 spec §1.2 비범위 그대로

### 0.4 핵심 결정 요약
| # | 결정 | 비고 |
|---|------|------|
| 1 | `expected_citation_doc` = `sources.json`의 `id` (예: `nts-vat-2025-2q-manual`) | uuid는 `defaultRandom`이라 ingest 재실행 시 깨짐 |
| 2 | `Citation`에 `source_id` 추가 | 채점기는 `c.source_id === item.expected_citation_doc` 비교 |
| 3 | 골든셋 분배: tax_type common 15 / general 10 / simplified 5 | 카테고리·난이도는 마스터 spec §4.4 그대로 |
| 4 | 2q 자료 우선, 1q 보조 사용 시 법령 개정 검증 절차 적용 | §3.3 |
| 5 | `golden.json`이 단일 진실, `eval_items`는 슬러그 id로 idempotent upsert | §4.2 |
| 6 | CLI는 in-process로 `@vat/core::ask` 직접 호출 | HTTP roundtrip 없음 |

---

## 1. 골든셋 분배

마스터 spec §4.4의 카테고리·난이도 분배는 고정. 본 슬라이스는 그 위에 **tax_type 균형**과 **출처(매뉴얼/사례) 혼합**을 추가 제약으로 둔다.

### 1.1 분배 표

| 카테고리 | 문항 | tax_type 분배 | 난이도(E/M/H) |
|---|---|---|---|
| 기초 신고/마감 | 6 | common 4 / general 1 / simplified 1 | 3 / 2 / 1 |
| 영세율/면세 | 6 | common 4 / general 2 | 2 / 3 / 1 |
| 매입세액 공제 | 6 | common 2 / general 4 | 2 / 3 / 1 |
| 의제매입 | 4 | common 1 / general 3 | 1 / 2 / 1 |
| 간이과세 | 4 | simplified 4 | 1 / 2 / 1 |
| 가산세 | 4 | common 4 | 1 / 2 / 1 |
| **합계** | **30** | **common 15 / general 10 / simplified 5** | **10 / 14 / 6** |

### 1.2 출처 혼합 의도
각 카테고리 내부에서 **매뉴얼**(`nts-vat-2025-2q-manual`)과 **사례집**(`nts-vat-2025-2q-cases-general` / `…-simplified` / `…-1q-cases-general-rental`)을 가능한 섞는다. 이유: 매뉴얼만으로 채우면 텍스트 톤이 균질해 keyword recall이 부풀려진다(toy 결정적 채점기의 약점). 사례집의 절차/숫자가 섞여야 채점이 의미 있는 변별을 만든다.

### 1.3 검증용 lint
`scripts/eval-run.ts` 시작 시 `golden.json`을 읽어 다음 invariant를 검사하고, 어긋나면 exit 1:
- 총 문항수 == 30
- 카테고리별 카운트 == 분배표와 일치
- `tax_type` 합계 == 분배표와 일치
- 난이도 합계 == E10/M14/H6
- 모든 `expected_citation_doc`이 `data/sources.json`의 `id`에 존재
- `id`(슬러그) 유니크

---

## 2. 골든셋 JSON 스키마

`data/eval/golden.json` — 외부 자료로 취급해 git 관리. `data/sources.json`과 동일 레벨.

```jsonc
{
  "version": "2026-05-07",
  "items": [
    {
      "id": "vat-base-easy-1",                       // 슬러그: vat-<cat>-<diff>-<n>, eval_items.id로 사용
      "category": "기초 신고/마감",                    // §1.1 표 카테고리 6개 중 하나
      "difficulty": "easy",                          // easy | medium | hard
      "tax_type": "vat-common",                      // sources.json의 tax_type 값
      "question": "수출 매출의 영세율 적용 요건은?",
      "expected_keywords": ["수출", "영세율", "0%"],   // 3~5개 권장, 검색 매칭 대상
      "expected_citation_doc": "nts-vat-2025-2q-manual",  // sources.json의 id
      "_source_excerpt": "...",                      // 작성 시 근거 발췌(채점에 사용 안 함, 인간 검수용)
      "_source_page": 12                             // 옵션, 검수용
    }
    // ... 29 more
  ]
}
```

언더스코어 prefix 필드(`_source_excerpt`, `_source_page`)는 채점에 사용하지 않고 인간 검수·디버깅용. CLI는 이들을 무시한다.

### 2.1 슬러그 컨벤션
`vat-<cat-slug>-<difficulty>-<seq>`

| 카테고리 | cat-slug |
|---|---|
| 기초 신고/마감 | `base` |
| 영세율/면세 | `zero` |
| 매입세액 공제 | `input` |
| 의제매입 | `presumed` |
| 간이과세 | `simple` |
| 가산세 | `penalty` |

`seq`는 1부터 카테고리 내 통산. 예: `vat-input-medium-3` = 매입세액 공제 medium 난이도 3번째.

---

## 3. 골든셋 컨텐츠 작성 절차

본 슬라이스의 산출물 중 하나가 30문항 자체. 작성 시 다음 순서를 따른다.

### 3.1 후보 섹션 스캔
`.cache/extracted/*.json`을 카테고리별로 스캔해 각 문항의 근거 섹션을 1~2개 선정. 우선순위: **2q 자료 > 1q 자료**, **사례집(절차·구체 숫자) > 매뉴얼(추상 규칙)** — 단 §1.2 분배 제약을 만족시키도록.

### 3.2 문항 작성
각 후보에 대해:
1. 실무자가 던질 만한 자연 질문으로 변환
2. `expected_keywords` 3~5개 — 정답 표현에 반드시 등장하되 답변 톤에 종속되지 않는 명사·수치 위주(동사·형용사 회피, 채점 노이즈)
3. `expected_citation_doc` — 가장 권위 있는 단일 source_id 선정(매뉴얼·사례 둘 다 다루면 매뉴얼)
4. 난이도 — easy(단답·단일 사실), medium(2~3개 조건 결합), hard(예외·경계 케이스)
5. `_source_excerpt`에 근거 텍스트 1~3줄 발췌

### 3.3 1q 보조 사용 검증 절차
2q 자료에서 후보를 못 찾고 1q에만 있는 사안일 때, 다음을 모두 거친 뒤에만 골든셋에 채택:

1. **2q 매뉴얼·사례집에서 동일 키워드로 재검색** — 다른 표현·다른 섹션에 있는지 확인
2. (1)에서 못 찾으면 **2025년 부가가치세법/시행령 개정 이력 교차 확인**:
   - WebSearch — `"부가가치세법 개정 2025"`, `"부가세 시행령 개정 2025"`, 해당 사안 키워드 조합
   - 법제처 국가법령정보센터(`law.go.kr`) WebFetch — 부가가치세법·시행령 본문, 부칙 시행일
   - 국세청 보도자료(`nts.go.kr`) WebFetch — 1기→2기 사이 변경 안내
3. **분기 처리**:
   - 개정으로 폐지·변경됨 → **골든셋 제외**, 다른 카테고리 후보로 대체
   - 단순 편집·재배치, 규정은 유지 → **1q를 `expected_citation_doc`으로 채택**, `_source_excerpt`에 검증 근거 URL 1개 추가 기록

이 절차는 골든셋 작성 시점에 1q 보조 후보 모두에 적용. 검증 결과(채택/제외/근거 URL)는 별도 메모 파일이 아니라 해당 항목의 `_source_excerpt` 안에 한 줄로 기록 — 골든셋 자체가 감사 단위가 되도록.

### 3.4 lint 통과 확인
`scripts/eval-run.ts --lint-only` 모드로 분배·슬러그·source_id 정합성 확인. 통과 후 commit.

---

## 4. eval_items / eval_runs 테이블 + Drizzle

마스터 spec §2의 두 테이블을 본 슬라이스에서 추가한다.

### 4.1 스키마 (`packages/core/src/db/schema.ts` 추가)

```ts
// 골든셋 항목 — golden.json이 단일 진실이고, 이 테이블은 join/리포팅용 보조 인덱스.
// id는 슬러그(자연키)이므로 uuid 아님.
export const evalItems = pgTable("eval_items", {
  id: text("id").primaryKey(),                      // 슬러그 vat-<cat>-<diff>-<n>
  question: text("question").notNull(),
  expectedKeywords: text("expected_keywords").array().notNull(),
  expectedCitationDoc: text("expected_citation_doc").notNull(),  // sources.json id
  category: text("category").notNull(),
  difficulty: text("difficulty").notNull(),
  taxType: text("tax_type").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// 1회 실행 = 1행. results/summary는 §5의 JSON 구조.
export const evalRuns = pgTable("eval_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  model: text("model").notNull(),
  embeddingModel: text("embedding_model").notNull(),
  retrievalK: integer("retrieval_k").notNull(),
  promptVersion: text("prompt_version"),            // 마스터 spec §4.7 비교 키
  goldensetVersion: text("goldenset_version").notNull(),  // golden.json.version 값
  results: jsonb("results").notNull(),              // §5 results 배열
  summary: jsonb("summary").notNull(),              // §5 summary 객체
});
```

### 4.2 동기화 정책
- `golden.json`이 **유일한 정답 보관소**. `eval_items` 테이블은 정답을 보관하되 그 값은 항상 JSON에서 파생.
- CLI 시작 시 `golden.json` 로드 → 슬러그 id로 `eval_items` upsert(idempotent). 마이너 변경(키워드 한 단어 추가)도 안전.
- DELETE는 자동 X — 골든셋에서 항목을 빼는 경우는 사람이 수동으로(과거 `eval_runs.results`가 사라진 id를 참조하는 위험 회피).

---

## 5. eval_runs.results / summary JSON 구조

### 5.1 results (배열, 길이 30)
```jsonc
{
  "id": "vat-input-medium-3",
  "question": "...",
  "response_text": "...",                            // 원문 그대로 박제(추후 LLM-judge 재채점 가능)
  "citations": [
    { "source_id": "nts-vat-2025-2q-manual", "page": 47, "section_path": "...", "snippet": "..." }
  ],
  "scores": {
    "keyword_recall": 0.66,                          // 0~1, hit/total
    "citation_present": 1,                           // 0 | 1
    "citation_correct": 1,                           // 0 | 1
    "no_hallucination": 1                            // 0 | 1
  },
  "weighted": 0.846,                                 // 0.4·kr + 0.2·cp + 0.3·cc + 0.1·nh
  "latency_ms": 1820,
  "tokens": { "input": 4120, "output": 380 },
  "expected_keywords_hit": ["수출", "영세율"],         // 디버깅 편의
  "expected_keywords_miss": ["0%"]
}
```

### 5.2 summary
```jsonc
{
  "n": 30,
  "weighted_avg": 0.81,
  "axes": {
    "keyword_recall": 0.78,
    "citation_present": 0.97,
    "citation_correct": 0.85,
    "no_hallucination": 0.93
  },
  "by_category": {
    "기초 신고/마감":   { "n": 6, "weighted_avg": 0.84 },
    "영세율/면세":     { "n": 6, "weighted_avg": 0.79 }
    // ...
  },
  "by_difficulty": {
    "easy":   { "n": 10, "weighted_avg": 0.91 },
    "medium": { "n": 14, "weighted_avg": 0.78 },
    "hard":   { "n": 6,  "weighted_avg": 0.66 }
  },
  "by_tax_type": {
    "vat-common":     { "n": 15, "weighted_avg": 0.83 },
    "vat-general":    { "n": 10, "weighted_avg": 0.80 },
    "vat-simplified": { "n": 5,  "weighted_avg": 0.76 }
  },
  "failures": ["vat-presumed-hard-1", "vat-zero-medium-4"],  // weighted < 0.5
  "totals": {
    "latency_ms_p50": 1500,
    "latency_ms_p95": 3800,
    "input_tokens_sum": 123400,
    "output_tokens_sum": 11200
  }
}
```

---

## 6. 4축 채점 함수

`packages/core/src/eval/score.ts` — 결정적 함수, 부수효과 없음. 마스터 spec §4.5의 식 그대로.

```ts
export type GoldenItem = {
  id: string;
  question: string;
  expected_keywords: string[];
  expected_citation_doc: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  tax_type: string;
};

export type RagResponse = {
  text: string;
  citations: { source_id: string; page: number | null; ... }[];
};

export type AxisScores = {
  keyword_recall: number;
  citation_present: 0 | 1;
  citation_correct: 0 | 1;
  no_hallucination: 0 | 1;
};

const WEIGHTS = { keyword_recall: 0.4, citation_present: 0.2, citation_correct: 0.3, no_hallucination: 0.1 };
const HALLUCINATION_PATTERN = /추측|아마|것 같|확실하지/;  // 마스터 spec §4.5

export function score(item: GoldenItem, response: RagResponse): AxisScores {
  const hits = item.expected_keywords.filter(k => response.text.includes(k));
  return {
    keyword_recall: hits.length / item.expected_keywords.length,
    citation_present: response.citations.length > 0 ? 1 : 0,
    citation_correct: response.citations.some(c => c.source_id === item.expected_citation_doc) ? 1 : 0,
    no_hallucination: HALLUCINATION_PATTERN.test(response.text) ? 0 : 1,
  };
}

export function weighted(s: AxisScores): number {
  return s.keyword_recall * WEIGHTS.keyword_recall
       + s.citation_present * WEIGHTS.citation_present
       + s.citation_correct * WEIGHTS.citation_correct
       + s.no_hallucination * WEIGHTS.no_hallucination;
}
```

가중치 상수는 모듈 상단 1곳에서만 정의. 변경 시 `eval_runs.summary`에 `weights` 필드를 추가해 박제 — 본 슬라이스에서는 미적용(단일 가중치 가정).

`expected_keywords` 매칭은 단순 substring(`String#includes`). 형태소·동의어 처리는 v2. 키워드 작성 단계에서 명사·수치 위주로 두면 toy 정확도엔 충분.

---

## 7. CLI 실행 (`pnpm eval:run`)

### 7.1 진입점
- root `package.json`: `"eval:run": "pnpm --filter @vat/core eval:run"`
- `packages/core/package.json`: `"eval:run": "tsx scripts/eval-run.ts"`
- `packages/core/scripts/eval-run.ts` — 본 슬라이스 단일 진입.

### 7.2 인자
```
pnpm eval:run [--lint-only] [--limit=N] [--model=…] [--k=8]
```
- `--lint-only` — §1.3 lint만 돌리고 종료(commit 전 확인용)
- `--limit=N` — 처음 N문항만 (스모크 디버깅용, eval_runs.summary.n에 박제)
- `--model`, `--k` — 마스터 spec §4.7 실험 비교 축

### 7.3 실행 흐름
1. `data/eval/golden.json` 로드 + lint
2. `eval_items` upsert (idempotent)
3. 각 item 순회 — `@vat/core::ask({ query: item.question, k })` 호출
   - 직렬 실행(toy 규모 30문항, rate limit/디버깅 우위). 병렬화는 v2.
4. 각 응답에 `score()` + `weighted()` 적용 → §5.1 results 항목 1개
5. summary 집계 (§5.2)
6. `eval_runs` 1행 INSERT (`gateway.eval.saveRun`)
7. stdout에 요약 표 + failures 목록 출력 + 종료 코드 0
   - `weighted_avg < 0.6` 등 threshold 게이팅은 W4 GHA 슬라이스로 미룸

### 7.4 의존성
- `@vat/core::ask` (이미 존재, `packages/core/scripts/ask.ts`와 동일 호출 경로)
- `gateway.eval.{saveRun, listRuns}` (마스터 spec §2.1 — 본 슬라이스에서 구현 추가)
- `gateway.evalItems.upsert` (본 슬라이스에서 추가)

---

## 8. Citation source_id 노출 변경

마스터 spec §3.4의 `Citation` 객체에 `source_id` 1개 필드를 더한다. 채점기·미래 admin 대시보드가 이 값을 키로 join한다.

### 8.1 타입 변경
```ts
// packages/core/src/db/schema.ts
export type Citation = {
  chunk_id: string;
  doc_id: string;
  source_id: string;     // ← 추가. sources.json id (예: "nts-vat-2025-2q-manual")
  doc_title: string;
  doc_version: string | null;
  page: number | null;
  section_path: string | null;
  snippet: string;
};
```

### 8.2 채움 위치
`retrieve.ts`가 SQL 결과를 `Citation`으로 변환할 때 `chunks.metadata->>'source_id'`에서 읽어 채움. ingest 시점에 이미 박제됨을 가정 — 만약 누락됐으면 본 슬라이스의 첫 작업이 ingest 메타 백필(이상치 lint로 확인).

### 8.3 영향 범위
- `apps/web` 채팅 UI는 `source_id`를 무시해도 OK (인용 패널 표시는 `doc_title`/`page` 기반 그대로). 변경은 타입 확장만이라 호환.
- `messages.citations` jsonb는 스키마 변경 없음(Citation 타입 jsonb이라 필드 추가 자유).

---

## 9. 단계별 구현 순서

본 슬라이스는 plan 작성 없이 구현 진입. 실행 순서:

1. ingest 메타 `source_id` 누락 lint → 필요 시 백필(가장 작은 위험 단위)
2. `Citation` 타입 + `retrieve.ts` source_id 채움
3. Drizzle: `eval_items` / `eval_runs` 추가 + 마이그레이션
4. `gateway.evalItems.upsert` + `gateway.eval.{saveRun, listRuns}` 구현
5. `score.ts` (결정적 함수, 단위 테스트 가능)
6. **`golden.json` 30문항 작성** (§3 절차) — 가장 큰 인지 작업
7. `runner.ts` + `scripts/eval-run.ts` (lint → upsert → ask 순회 → score → save)
8. 한 번 실행 — eval_runs 1행 적재 확인, summary 표 점검
9. 결과를 보고 keyword·검증 절차 보정(필요 시)

리스크 컷라인: §3.3 1q 검증으로 채택 후보가 부족해 30문항을 채우지 못하면, 마스터 spec §4.4 `리스크 컷라인` 규정대로 20문항으로 축소(분배는 비례 축소).

---

## 10. 본 슬라이스가 닫는 마스터 spec 요건

| 마스터 spec 항목 | 본 슬라이스 |
|---|---|
| §4.4 골든 평가셋 30문항 + 카테고리/난이도 | §1, §2, §3 |
| §4.5 자동 채점 4축 + 가중치 0.4/0.2/0.3/0.1 | §6 |
| §4.6 `pnpm eval:run` 트리거 | §7 |
| §4.7 `eval_runs` 누적(model/embedding/k/prompt_version 키) | §4, §5 |
| §2 eval_items / eval_runs 테이블 | §4 |
| §2.1 `gateway.eval.{saveRun, listRuns}` | §7.4 |

본 슬라이스가 닫지 않는 §4 항목(Inngest cron, GHA smoke, Langfuse score, admin 대시보드)은 §0.3 비범위로 명시.
