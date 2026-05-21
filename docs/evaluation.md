# Evaluation

RAGAS 표준 패턴. Langfuse Dataset이 source of truth, git CSV는 백업·diff용:
- **golden set 등록**: `data/eval/golden_set.csv`를 Langfuse UI에서 drag-drop 한 번 업로드 (헤더가 Langfuse 필드와 일치 → 자동 매핑)
- **scoring**: `jobs/ragas-eval/run_eval.py` (Python) — Langfuse Dataset iterate → RAG 실행 → RAGAS evaluate → `langfuse.score()`로 push back

결정: [Phase 1](./superpowers/specs/2026-05-19-rag-eval-ragas-phase1-design.md).

## 1. 흐름

```
data/eval/golden_set.csv                ← git 백업 (diff·rollback용)
  │
  └─ Langfuse UI: Dataset CSV upload (수동, 변경 시만)
        │
        Langfuse Dataset (single source)
          │
          └─ pnpm ragas-eval:eval        ← Python (jobs/ragas-eval)
                run_eval.py (2-phase)
                  Phase 1 [per-item, resumable]
                    for item in remaining:
                      rag_run(question)                   ← core subprocess
                      evaluate(1-row, metrics)            ← judge LLM call
                      jsonl.append({..., scores}) + flush ← atomic
                    중단 시 jsonl까지가 진실, 재실행 시 done set으로 skip
                  Phase 2 [batch]
                    load jsonl → for row:
                      with item.run(run_name=LANGFUSE_RELEASE) as span:
                        span.score_trace(...)
                    langfuse.flush()                      ← 1회
                    실패 시 재실행은 Phase 1 skip + Phase 2 재시도 (judge 비용 0)
```

### CSV 스키마 (Langfuse UI 명명 그대로)
| column | type | 설명 |
|---|---|---|
| `id` | string | upsert key |
| `Input` | string | 질문 |
| `Expected Output` | string | ground truth 답변 |
| `Metadata` | JSON string | `{"category","difficulty","tax_type"}` |

버전: git commit SHA가 release 라벨(`LANGFUSE_RELEASE`). breaking 스키마 변경 시만 dataset 이름 suffix bump(`-v1` → `-v2`). Langfuse 자체 item-level versioning(2025-12-15~)은 UI diff용 보너스.

## 2. 메트릭 (RAGAS Triad + AnswerCorrectness)

| RAGAS | 측정 | reference 필요 |
|---|---|---|
| `Faithfulness` | 답을 statement로 분해 → context와 NLI | — |
| `AnswerRelevancy` | 답에서 질문 역생성 → 원본과 cosine | — |
| `LLMContextPrecisionWithoutReference` | retrieved chunk별 relevance binary 판정 | — |
| `AnswerCorrectness` | factuality(LLM, F1) + semantic similarity(cosine) 0.75/0.25 가중 | ✓ |

reference는 `data/eval/golden.json::items[].reference`. scorer가 `sample_id`로 join (분리 패턴 — asks.jsonl에 reference 박지 않음).

## 3. Judge / Embedding

- judge: `claude-sonnet-4-5` (응답 `gpt-4o-mini`와 family 분리)
- embedding: Voyage `voyage-3` (core retrieval과 동일 공급자)
- LLM/embedding 호출은 **litellm**로 통일 — `--judge openai/gpt-4o` 식으로 provider swap 가능
- `ANTHROPIC_API_KEY` 미설정 시 **Claude Code CLI(headless) fallback** (로컬 dev 기본 경로)
- env (각 plane 자체 .env):
  - `packages/core/.env` — `DATABASE_URL`, `VOYAGE_API_KEY`, `OPENAI_API_KEY`
  - `jobs/eval/.env` — `ANTHROPIC_API_KEY`(선택), `VOYAGE_API_KEY`

## 4. 골든셋 (`data/eval/golden.json`)

```jsonc
{ "id": "vat-base-easy-1", "category": "...", "difficulty": "easy", "tax_type": "vat-common", "question": "..." }
```

golden answer(`reference`)는 Phase 2.

## 5. 입출력

`asks.jsonl` (core가 작성):
```jsonc
{
  "sample_id": "vat-base-easy-1",
  "user_input": "...",
  "retrieved_contexts": ["chunk content", ...],
  "response": "...",
  "meta": { "category": "...", "latencyMs": 1820, ... }
}
```

`retrieved_contexts`는 verify 통과 citations가 아닌 raw top-k chunks (RAGAS 정확도 위해).

`scores.jsonl` (evaluation이 작성) — 한 줄 = 한 (sample, metric) 점수. resume 키 = `(sample_id, metric)` 쌍:
```jsonc
{"sample_id":"vat-base-easy-1","metric":"faithfulness","value":1.0}
{"sample_id":"vat-base-easy-1","metric":"answer_relevancy","value":0.91}
```

## 6. CLI

```bash
pnpm eval:sync          # 1회 (deps)
pnpm eval:ask           # 응답 생성만 → .tmp/eval/asks.jsonl
pnpm eval:score         # 채점만 → .tmp/eval/scores.jsonl
pnpm eval:full          # ask → score chain
```

raw 인자 호출(judge·embed-model 교체 등)은 `python scripts/score.py` 직접 사용.

## 7. 한계 (Phase 2/3로)

- reference-based 메트릭 6종: golden answer 추가 후
- Langfuse score push·Datasets·Experiments: Phase 2
- Cohen's κ: Phase 2
- production trace sample 평가, AspectCritic, multi-turn: Phase 3
