# Evaluation

Langfuse Dataset 기반 RAGAS 평가. ADR-0004의 결정 — golden set 재구성 + judge LLM nano tier + AnswerCorrectness → FactualCorrectness 교체.

- **golden set 등록**: `data/eval/golden_set.csv`를 Langfuse UI에서 drag-drop 한 번 업로드 (헤더가 Langfuse 필드와 일치 → 자동 매핑)
- **scoring**: `jobs/ragas-eval/scripts/run_eval.py` — Langfuse Dataset iterate → RAG 실행 → RAGAS metric 산출 → `span.score_trace`로 push back

ADR 추적: [adr/v2/0004-evaluation.md](./adr/v2/0004-evaluation.md). Phase 1 결정: [superpowers/specs/2026-05-19-rag-eval-ragas-phase1-design.md](./superpowers/specs/2026-05-19-rag-eval-ragas-phase1-design.md).

## 1. 흐름

```
data/eval/golden_set.csv                ← git 백업 (diff·rollback용)
  │
  └─ Langfuse UI: Dataset CSV upload (수동, 변경 시만)
        │
        Langfuse Dataset (single source of truth)
          │
          └─ pnpm ragas-eval:eval        ← Python (jobs/ragas-eval)
                run_eval.py (2-phase)
                  Phase 1 [per-item, resumable]
                    for item in remaining:
                      answer, contexts = rag_run(question)        ← core CLI subprocess
                      scores = score_all(metrics, sample)         ← judge LLM call 4종 병렬
                      jsonl row append + fsync                    ← 비싼 judge 결과 영구화
                    중단 시 jsonl까지가 진실, 재실행 시 done set으로 skip
                  Phase 2 [batch]
                    for row in jsonl:
                      with item.run(run_name=...) as span:        ← Langfuse trace 생성·link
                        span.score_trace(name, value) per metric
                    langfuse.flush()                              ← 1회
                    실패 시 재실행은 Phase 1 skip + Phase 2 재시도 (judge 비용 0)
```

### CSV 스키마 (Langfuse UI 명명 그대로)

| column | type | 설명 |
|---|---|---|
| `id` | string | upsert key |
| `Input` | string | 질문 |
| `Expected Output` | string | ground truth 답변 |
| `Metadata` | JSON string | `{"category","difficulty","tax_type"}` |

run_name = `{dataset}-{timestamp}` — 매 실행이 별도 run. `LANGFUSE_RELEASE`는 git commit SHA로 cohort 라벨링.

## 2. 메트릭 (RAGAS v0.4+ collections OOP API)

`jobs/ragas-eval/scripts/run_eval.py::build_metrics`:

| RAGAS | 측정 | reference 필요 |
|---|---|---|
| `Faithfulness` | 답을 statement로 분해 → context와 NLI | — |
| `AnswerRelevancy` | 답에서 질문 역생성 → 원본과 cosine | — |
| `ContextPrecisionWithReference` | retrieved chunk별 reference-aware relevance | ✓ |
| `FactualCorrectness(mode="f1")` | claim-level precision/recall/F1 — embedding 항 제거 | ✓ |

ADR-0004 §5에 따라 `AnswerCorrectness` → `FactualCorrectness` 교체. 사유: 법령 톤 retrieval vs 매뉴얼 톤 ground_truth의 표현 거리가 커서 embedding similarity 항이 사실 정답에 페널티. RAGAS v0.2+ 공식 Getting Started default와 정렬.

**호출 방식**: `asyncio.gather`로 metric 4종 동시 호출 — wall clock ≈ max(metric) (≈ 4배 단축). 빈 응답이면 response-사용 metric은 0점 skip(judge 호출 X).

## 3. Judge / Embedding

ADR-0004 §6에 따라 Claude CLI subprocess → OpenAI nano tier로 교체:

- judge: `openai/gpt-5-nano` (LiteLLM + instructor JSON mode). cold start ~50s × 120 call이 ~1-3s × 120 call로 단축 → 1 사이클 ≈ 56원·2~6분
- embedding: Voyage `voyage/voyage-3` (LiteLLMEmbeddings) — `AnswerRelevancy`의 역생성-cosine용. core retrieval(`voyage-4`)과 별도 모델 고정 — RAGAS metric의 historical baseline 정합성 우선
- 정책 정합: judge layer LiteLLM 허용(2026-05-19 결정). chat layer는 Claude/OpenAI 직접 사용
- 구체 model ID는 `llm.py::DEFAULT_MODEL` 상수 (provider 수준만 spec)

env (`jobs/ragas-eval/.env`):
- `OPENAI_API_KEY` (judge)
- `VOYAGE_API_KEY` (embeddings)
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` (dataset + trace push)
- `LANGFUSE_DATASET_NAME` (필수)

## 4. 골든셋 v2 (ADR-0004 §1-3)

30문항 재구성. reference 풀:

| 출처 | 건수 | 용도 |
|---|---|---|
| 매뉴얼·사례집 PDF | 3건 | 답변 톤 reference (인덱싱 X) |
| 상담센터 Q&A (`nts_counseling_qna.jsonl`) | 27건 | 예정신고/예정고지 답변 reference |
| 본사이트 게시판 메타 (`nts_homepage.jsonl`) | 10건 | 부가세 참고자료실 메타 |

카테고리 분포(7 cat × E/M/H = 30): 기초신고 5 · 영세율/면세 5 · 매입세액공제 5 · 의제매입 3 · 간이과세 4 · 가산세 3 · 예정신고(신규) 5. 약점 영역(영세율·간이)은 유지로 capability discrimination 보존.

신규 카테고리 슬러그 `vat-prelim-*` 추가. 나머지(`base/zero/input/presumed/simple/penalty`)는 기존과 동일.

## 5. 입출력

`.tmp/ragas-eval/results.jsonl` (Phase 1 산출, Phase 2 입력):
```jsonc
{
  "sample_id": "vat-base-easy-1",
  "user_input": "...",
  "retrieved_contexts": ["chunk content", ...],   // raw top-k (verify 통과 citation X — RAGAS 정확도용)
  "response": "...",
  "reference": "...",
  "scores": { "faithfulness": 1.0, "answer_relevancy": 0.91, ... },
  "meta": { "category": "...", "latencyMs": 1820, ... }
}
```

## 6. CLI

```bash
pnpm ragas-eval:sync          # uv sync (deps)
pnpm ragas-eval:eval          # Phase 1 + Phase 2 chain
```

## 7. 한계 (ADR-0004 §7)

- **영세율 reference 부족**: 상담센터 영세율 사례가 robots 제약으로 미수집. 영세율 5문항은 매뉴얼·사례집 표/사례에 의존
- **예정신고 reference 편중**: 신규 5문항이 단일 페이지(mi=1329) 기반 — `answer_relevancy`는 다음 run 모니터
- **historical trend 단절**: AC → FC 교체로 점수 의미 달라짐 — v2 첫 run부터 baseline 재구축
