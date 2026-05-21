# 골든셋 평가 — W3 슬라이스 설계 (SUPERSEDED)

작성: 2026-05-07 · 최종 갱신: 2026-05-14
상태: **2026-05-19에 [RAGAS Phase 1](./2026-05-19-rag-eval-ragas-phase1-design.md)로 대체.** 본 문서의 결정적 4축(`keywordRecall`/`citationPresent`/`citationCorrect`/`noHallucination`) + `expected_keywords`/`expected_citation_doc` + `EXPECTED_DISTRIBUTION`은 표준 정합성 부족으로 모두 폐기됨. 아래 내용은 history 보존용.
저자: dev-seawiid
관련: [2026-05-01-vat-rag-chatbot-design.md](./2026-05-01-vat-rag-chatbot-design.md) §4.4

## 0. 개요

마스터 spec §4 수동 평가 파이프라인 클로즈. `data/eval/golden.json`에 30문항을 박제하고, `pnpm eval:run`이 4축 결정적 채점을 `eval_runs`에 1행 적재한다.

산출물:
- `data/eval/golden.json` — 정답 단일 진실
- `packages/core/src/eval/{scoring, eval.service, eval.repository, schema}.ts`
- `packages/core/scripts/eval-run.ts` (`pnpm eval:run`)
- `eval_items` / `eval_runs` 테이블 (Drizzle)
- `Citation.sourceId` (마스터 §3.4 — 이미 적용)

비범위(영구): Inngest cron · GHA `eval:smoke` · admin 대시보드 · LLM-as-a-judge · 재랭커 비교 · 멀티 모델 cross-verification. 사유는 마스터 §0.4.

---

## 1. 골든셋 분배

마스터 §4.4의 카테고리·난이도 위에 **tax_type 균형**과 **매뉴얼/사례집 혼합**을 추가 제약.

| 카테고리 | 문항 | tax_type | 난이도(E/M/H) |
|---|---|---|---|
| 기초 신고/마감 | 6 | common 4 / general 1 / simplified 1 | 3 / 2 / 1 |
| 영세율/면세 | 6 | common 4 / general 2 | 2 / 3 / 1 |
| 매입세액 공제 | 6 | common 2 / general 4 | 2 / 3 / 1 |
| 의제매입 | 4 | common 1 / general 3 | 1 / 2 / 1 |
| 간이과세 | 4 | simplified 4 | 1 / 2 / 1 |
| 가산세 | 4 | common 4 | 1 / 2 / 1 |
| **합계** | **30** | **common 15 / general 10 / simplified 5** | **10 / 14 / 6** |

매뉴얼/사례 혼합 의도 — 매뉴얼만 채우면 톤 균질해 keyword recall 부풀려짐. 사례집의 절차·숫자가 섞여야 변별 의미.

`lintGoldenSet()`이 CLI 시작 시 위 분포 + 슬러그 유니크 + `expected_citation_doc` 존재 검사 → mismatch 시 exit 1.

---

## 2. JSON 스키마 (`data/eval/golden.json`)

```jsonc
{
  "version": "2026-05-07",                              // eval_runs.goldenset_version에 박제
  "items": [
    {
      "id": "vat-base-easy-1",                          // <cat-slug>-<diff>-<seq>
      "category": "기초 신고/마감",
      "difficulty": "easy",                             // easy | medium | hard
      "tax_type": "vat-common",                         // sources.json tax_type
      "question": "...",
      "expected_keywords": ["...", "..."],              // 3~5개, 명사·수치 위주
      "expected_citation_doc": "nts-vat-2025-2q-manual",// sources.json id
      "_source_excerpt": "...",                         // 인간 검수용, 채점 미사용
      "_source_page": 12                                // 옵션
    }
  ]
}
```

슬러그 cat-slug — `base` · `zero` · `input` · `presumed` · `simple` · `penalty`.

언더스코어 prefix는 채점 미사용(loader 무시).

---

## 3. 테이블 (`packages/core/src/eval/schema.ts`)

```ts
eval_items {
  id                    text PK,         // 자연키 슬러그 (uuid 아님)
  question              text NOT NULL,
  expected_keywords     text[] NOT NULL,
  expected_citation_doc text NOT NULL,
  category, difficulty, tax_type text NOT NULL,
  updated_at            timestamptz
}

eval_runs {
  id                uuid PK,
  ran_at            timestamptz,
  model             text NOT NULL,       // 실제 호출에 사용된 generation 모델 ID
  embedding_model   text NOT NULL,
  retrieval_k       int  NOT NULL,
  prompt_version    text,                // prompt.ts::PROMPT_VERSION
  goldenset_version text NOT NULL,       // golden.json.version
  results           jsonb NOT NULL,      // §4.1
  summary           jsonb NOT NULL       // §4.2
}
```

동기화 정책 — `golden.json`이 단일 진실. CLI 시작 시 슬러그 id로 `eval_items` upsert(idempotent). DELETE는 수동 — 과거 `eval_runs.results`가 사라진 id를 참조하는 위험 회피.

---

## 4. results / summary JSON 구조

### 4.1 results[] (길이 = items 수)
```jsonc
{
  "id": "vat-input-medium-3",
  "question": "...",
  "responseText": "...",                                // 원문 박제 (LLM-judge 재채점 가능)
  "citations": [{ "sourceId": "...", "page": 47, "sectionPath": "...", "snippet": "..." }],
  "scores": {
    "keywordRecall": 0.66,                              // 0~1
    "citationPresent": 1,                               // 0 | 1
    "citationCorrect": 1,
    "noHallucination": 1
  },
  "weighted": 0.846,                                    // 0.4·kr + 0.2·cp + 0.3·cc + 0.1·nh
  "latencyMs": 1820,
  "tokens": { "input": 4120, "output": 380 },
  "expectedKeywordsHit": ["수출", "영세율"],
  "expectedKeywordsMiss": ["0%"],
  "finishReason": "stop",
  "model": "gpt-4o-mini"
}
```

### 4.2 summary
```jsonc
{
  "n": 30,
  "weightedAvg": 0.81,
  "axes": { "keywordRecall": 0.78, "citationPresent": 0.97, ... },
  "byCategory":   { "기초 신고/마감": { "n": 6, "weightedAvg": 0.84 }, ... },
  "byDifficulty": { "easy": { ... }, "medium": { ... }, "hard": { ... } },
  "byTaxType":    { "vat-common": { ... }, "vat-general": { ... }, "vat-simplified": { ... } },
  "failures":     ["vat-presumed-hard-1", ...],         // weighted < 0.5
  "totals": {
    "latencyMsP50": 1500, "latencyMsP95": 3800,
    "inputTokensSum": 123400, "outputTokensSum": 11200
  },
  "weights": { "keywordRecall": 0.4, "citationPresent": 0.2, "citationCorrect": 0.3, "noHallucination": 0.1 }
}
```

도메인 표면은 camelCase. golden.json만 사람 작성 외부 자료이므로 snake 유지, loader가 camel로 변환.

---

## 5. 4축 채점 (`eval/scoring.ts`)

결정적 순수 함수. 가중치는 모듈 상단 단일 정의.

```ts
const WEIGHTS = { keywordRecall: 0.4, citationPresent: 0.2, citationCorrect: 0.3, noHallucination: 0.1 };
const HALLUCINATION_PATTERN = /추측|아마|것 같|확실하지/;

function score(item, response) {
  const hits = item.expectedKeywords.filter(k => response.text.includes(k));
  return {
    keywordRecall:   item.expectedKeywords.length === 0 ? 0 : hits.length / item.expectedKeywords.length,
    citationPresent: response.citations.length > 0 ? 1 : 0,
    citationCorrect: response.citations.some(c => c.sourceId === item.expectedCitationDoc) ? 1 : 0,
    noHallucination: HALLUCINATION_PATTERN.test(response.text) ? 0 : 1,
  };
}
```

`expected_keywords` 매칭은 단순 `String#includes`. 형태소·동의어는 v2 — 키워드 작성 단계에서 명사·수치 위주로 두면 toy 정확도엔 충분.

가중치 변경 시 `eval_runs.summary.weights` 필드에 박제(이미 적재).

---

## 6. CLI 실행

진입점:
- root `package.json` → `"eval:run": "pnpm -F @vat/core eval:run"`
- `packages/core/scripts/eval-run.ts` 단일 진입

인자:
```
pnpm eval:run [--lint-only] [--limit=N] [--k=8]
```
- `--lint-only` — 분포·슬러그·source_id 정합성만 검사
- `--limit=N` — 처음 N문항 (스모크 디버깅)
- `--k` — retrieval top-k (eval_runs.retrieval_k에 박제)

흐름 — `eval.service.ts::runEval()`:
1. `golden.json` 로드 + `lintGoldenSet(set, validSourceIds)`
2. `evalRepo.upsertItems(items)` (idempotent)
3. 직렬로 각 item → `core.chat.ask(question, { k })` → stream drain → finish meta 수집
4. `score()` + `weighted()` → results entry
5. `summarize(results, items)` → summary
6. `evalRepo.saveRun({ model, embeddingModel, retrievalK, promptVersion, goldensetVersion, results, summary })`

직렬 실행 — 30문항 토이 규모 + rate limit/디버깅 우위. 병렬화는 v2. threshold 게이팅(`weightedAvg < 0.6` 차단)은 §0.4 비범위.

회귀 비교는 `eval_runs` 직접 SQL/Drizzle Studio — admin 대시보드 비범위.
