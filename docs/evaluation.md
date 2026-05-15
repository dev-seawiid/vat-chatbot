# Evaluation

골든셋 30문항 + 결정적 4축 채점. 수동 트리거로 `eval_runs`에 1행 적재. 위치: `packages/core/src/eval/`, CLI는 `packages/core/scripts/eval-run.ts`.

## 1. 흐름

```
pnpm eval:run [--lint-only] [--limit=N] [--k=8]
  │
  ├─ data/eval/golden.json 로드
  ├─ lintGoldenSet(set, validSourceIds)          — 분포·슬러그·source_id 정합성
  ├─ evalRepo.upsertItems(items)                 — golden.json → eval_items 동기화
  │
  └─ items 직렬 순회
        ├─ core.chat.ask(question, { k })        — single-turn (conversationId 미주입)
        ├─ textStream + citationStream 병렬 drain
        ├─ score(item, response)                 — 4축 (§3)
        ├─ weighted(scores)                      — 가중합
        └─ results[] 누적
              │
              └─ summarize(results, items)       — 가중평균, by_category, by_difficulty, by_tax_type
                    │
                    └─ evalRepo.saveRun(args)    — eval_runs 1행 INSERT
```

## 2. 골든셋 (`data/eval/golden.json`)

30문항. 카테고리/난이도/tax_type 분포는 `EXPECTED_DISTRIBUTION` 상수에 박제 — lint가 위반 시 exit 1.

| 카테고리 | 문항 | tax_type | 난이도(E/M/H) |
|---|---|---|---|
| 기초 신고/마감 | 6 | common 4 / general 1 / simplified 1 | 3/2/1 |
| 영세율/면세 | 6 | common 4 / general 2 | 2/3/1 |
| 매입세액 공제 | 6 | common 2 / general 4 | 2/3/1 |
| 의제매입 | 4 | common 1 / general 3 | 1/2/1 |
| 간이과세 | 4 | simplified 4 | 1/2/1 |
| 가산세 | 4 | common 4 | 1/2/1 |
| **합계** | **30** | **common 15 / general 10 / simplified 5** | **10/14/6** |

각 항목 스키마:
```jsonc
{
  "id": "vat-base-easy-1",                  // 슬러그: vat-<cat>-<diff>-<n>
  "category": "기초 신고/마감",
  "difficulty": "easy",
  "tax_type": "vat-common",
  "question": "...",
  "expected_keywords": ["...", "..."],      // 명사·수치 위주, 3~5개
  "expected_citation_doc": "nts-vat-...",   // sources.json id
  "_source_excerpt": "...",                 // 인간 검수용, 채점 미사용
  "_source_page": 12                        // 옵션
}
```

`golden.json`이 단일 진실. `eval_items` 테이블은 슬러그 PK로 idempotent upsert.

## 3. 4축 채점 (`packages/core/src/eval/scoring.ts`)

가중치는 모듈 상단 단일 정의 — 변경 시 `eval_runs.summary.weights`에 박제(이미 적재).

```ts
const WEIGHTS = {
  keywordRecall:   0.4,
  citationPresent: 0.2,
  citationCorrect: 0.3,
  noHallucination: 0.1,
};

const HALLUCINATION_PATTERN = /추측|아마|것 같|확실하지/;

function score(item, response) {
  const hits = item.expectedKeywords.filter(k => response.text.includes(k));
  return {
    keywordRecall:   item.expectedKeywords.length ? hits.length / item.expectedKeywords.length : 0,
    citationPresent: response.citations.length > 0 ? 1 : 0,
    citationCorrect: response.citations.some(c => c.sourceId === item.expectedCitationDoc) ? 1 : 0,
    noHallucination: HALLUCINATION_PATTERN.test(response.text) ? 0 : 1,
  };
}
```

`response.citations`는 [generation.md §4 cite_chunk](./generation.md#4-tools)의 verify를 통과한 누적 list — 환각 인용이 `citationCorrect` 점수를 왜곡하지 않도록 chat.service가 미리 거른다.

- `keywordRecall`: 답변 텍스트에 expected 키워드가 포함된 비율. substring 매칭 — 형태소·동의어 처리는 v2.
- `citationCorrect`: 정답 `expectedCitationDoc`이 retrieved + cited 안에 1건이라도 있으면 1. retrieval 정확도 직접 반영.
- `noHallucination`: 헷지 표현 정규식. toy 결정적 채점.

## 4. 테이블 (`packages/core/src/eval/schema.ts`)

```ts
eval_items {
  id                    text PK,    // 자연키 슬러그 (uuid 아님)
  question              text NOT NULL,
  expected_keywords     text[] NOT NULL,
  expected_citation_doc text NOT NULL,
  category, difficulty, tax_type text NOT NULL,
  updated_at            timestamptz
}

eval_runs {
  id                uuid PK,
  ran_at            timestamptz,
  model             text NOT NULL,    // 실제 호출에 쓰인 generation 모델 ID
  embedding_model   text NOT NULL,
  retrieval_k       int  NOT NULL,
  prompt_version    text,             // prompt.ts::PROMPT_VERSION
  goldenset_version text NOT NULL,    // golden.json.version
  results           jsonb NOT NULL,
  summary           jsonb NOT NULL
}
```

`eval_runs`의 비교 키는 `(model, embedding_model, retrieval_k, prompt_version, goldenset_version)`. 같은 키 안에서만 회귀 비교 의미.

## 5. `eval_runs.results` JSON 구조

`results[]` (`EvalResultEntry`, 길이 = items 수):

```jsonc
{
  "id": "vat-input-medium-3",
  "question": "...",
  "responseText": "...",                                    // 원문 박제 (LLM-judge 재채점용)
  "citations": [
    {
      "sourceId": "nts-vat-...", "page": 47,
      "sectionPath": "...",
      "content": "...", "quote": "...",
      "quoteStart": 95, "quoteEnd": 125
    }
  ],
  "scores": { "keywordRecall": 0.66, "citationPresent": 1, "citationCorrect": 1, "noHallucination": 1 },
  "weighted": 0.846,
  "latencyMs": 1820,
  "tokens": { "input": 4120, "output": 380 },
  "expectedKeywordsHit": ["수출", "영세율"],
  "expectedKeywordsMiss": ["0%"],
  "finishReason": "stop",
  "model": "gpt-4o-mini"
}
```

`citations.content` + `quote` + `quoteStart/End`까지 박제하는 이유 — eval_runs 한 행으로 답·인용·근거 텍스트가 다 보여 회귀 분석 시 청크 join 불필요. jsonb 사이즈 손해보다 디버깅·LLM-judge 재실행 가치 우위.

`summary`는 `weightedAvg` + `byCategory`/`byDifficulty`/`byTaxType` + `latencyMsP50/P95` + `inputTokensSum`/`outputTokensSum` + `failures` (weighted < 0.5인 id들) + `weights` 박제.

## 6. CLI 인자

```
pnpm eval:run [--lint-only] [--limit=N] [--k=8]
```
- `--lint-only`: 분포·슬러그·source_id 정합성만 검사하고 종료 (commit 전 확인)
- `--limit=N`: 처음 N문항만 (스모크 디버깅. `summary.n`에 박제)
- `--k`: retrieval top-k

직렬 실행 — 30문항 토이 규모 + rate limit/디버깅 우위. 병렬화는 v2.

## 7. 회귀 비교

`eval_runs`에 누적된 row를 직접 SQL/Drizzle Studio로 조회. admin 대시보드 비범위.

비교 예시:
```sql
SELECT prompt_version, goldenset_version, summary->>'weightedAvg' AS avg
FROM eval_runs
WHERE model = 'gpt-4o-mini' AND embedding_model = 'voyage-3' AND retrieval_k = 8
ORDER BY ran_at DESC
LIMIT 10;
```

## 8. 측정 범위 한계

골든셋은 **retrieval-only가 아니라 end-to-end 측정**:
- `citationCorrect`만 retrieval 정확도와 거의 직접 매핑
- 다른 3축은 generation·tone 영향 큼
- retrieval 단독 metric(hit@k, MRR)은 미도입 — 필요 시 후속

또한 **모든 항목이 single-turn 질문**. multi-turn 시나리오(직전 답변에 의존하는 후속 질문)는 골든셋으로 측정 불가 — 슬라이스 도입 시 수동 스폿 체크.

## 9. 후속

- `citationVerified` 1축 추가 (verify 통과율 직접 측정)
- LLM-as-a-judge — `responseText`를 박제한 이유 중 하나
- 머지 게이트·자동 트리거: 비범위 (LLM 호출 비용 통제)
- 자세한 후속은 [TODO.md](./TODO.md).
