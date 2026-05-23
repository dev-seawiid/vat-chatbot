# Golden Set v2 — Reference 확장 + 30문항 재구성

ADR-0001 source migration에 맞춰 reference 풀을 확장하고 30문항을 재작성. 분포 원칙은 **full-scope coverage**(2025-2026 RAG eval 통설): 카테고리·난이도 다축으로 representative + 약점 영역 + edge case 를 함께 cover해 capability discrimination을 유지한다. "사용자 질문 빈도 ∝ 분포"는 production traffic monitoring의 역할이라 골든셋에서 채택하지 않는다.

## 1. Reference 출처

| | Before | After |
|---|---|---|
| PDF (매뉴얼/사례집) | 3건 | 동일 3건 |
| 상담센터 Q&A (`nts_counseling_qna.jsonl`) | — | 27건 (예정신고/예정고지 한정) |
| 본사이트 게시판 메타 (`nts_homepage.jsonl`) | — | 10건 (부가세 참고자료실, 사례·매뉴얼 PDF 링크) |
| 답변 톤 | 매뉴얼체만 | + 실제 사용자 질문체(상담센터) |

상담센터 사례 22,001건은 robots.txt `Disallow: /`로 자동 수집 비범위. mi=1329 단일 페이지(예정신고/예정고지)만 1회 fetch.

## 2. 30문항 카테고리 분포

| 카테고리 | Before | After | 주 reference | 변경 사유 |
|---|---|---|---|---|
| 기초 신고/마감 | 6 | 5 | 매뉴얼 | 예정신고 신설 분 균등 차감 |
| 영세율/면세 | 6 | 5 | 매뉴얼·사례집 표 | discrimination 보존 위해 거의 유지 (ADR-0001 §3 worst 영역) |
| 매입세액 공제 | 6 | 5 | 매뉴얼 | 균등 차감 |
| 의제매입 | 4 | 3 | 매뉴얼 | 균등 차감 |
| 간이과세 | 4 | 4 | 사례집(간이) | 유지 (worst 영역) |
| 가산세 | 4 | 3 | 매뉴얼 | 균등 차감 |
| 예정신고/예정고지 (신규) | 0 | 5 | counseling_qna | 신규 reference 충분, 신설 |
| **합계** | **30** | **30** | | |

각 카테고리 안에서 난이도 E/M/H 균형은 기존 디자인(2026-05-07) 비율을 따른다.

## 3. 스키마

`data/golden_set.csv` 4-컬럼 유지(`id, Input, Expected Output, Metadata`). Langfuse Dataset import 포맷. 신규 카테고리 슬러그 `vat-prelim-*` 추가, 나머지(`base/zero/input/presumed/simple/penalty`)는 기존과 동일.

## 4. 정답 작성 원칙

reference 근거에서 사용자 친화 톤으로 1~3문장 재작성. RAGAS metric 왜곡 방지를 위해 다음을 강제한다.

- **근거 추적**: 각 정답은 reference 구절을 직접 근거로 함 (매뉴얼 페이지·Q&A 항목·법령 조문). LLM 학습 데이터의 일반 지식 차단 — faithfulness 평가 왜곡 방지.
- **톤·길이**: 1~3문장, 숫자·기한·조문 명시. 매뉴얼 원문 복사 X.
- **헤지 표현 금지**: "대략·보통·것 같다" 등 — 일부 hallucination 검출 패턴과 충돌.

## 5. RAGAS metric 구성 — AnswerCorrectness → FactualCorrectness

- **문제점**: RAG retrieval source는 법령 조문(ADR-0001), ground_truth는 매뉴얼·상담 Q&A 톤(§1). 동일 사실이라도 표현 거리가 본질적으로 큼(예: "1천분의 5" vs "0.5%"). AnswerCorrectness는 factuality(LLM claim) + similarity(embedding cosine)의 가중평균(기본 0.75/0.25) — embedding 항이 표현 차이에 페널티를 주어 사실이 맞아도 점수가 깎인다.
- **Before**: `AnswerCorrectness(llm, embeddings)` — embedding similarity 항 0.25 가중.
- **After**: `FactualCorrectness(llm, mode="f1")` — claim-level precision/recall/F1. embedding 항 제거, LLM이 답변·정답을 claim으로 분해해 NLI로 사실 동등성만 판단.
- **정렬**: RAGAS v0.2+ 공식 Getting Started default 셋(LLMContextRecall + Faithfulness + FactualCorrectness)과 일치.
- **단절**: AC 누적 점수와 metric 의미가 달라 historical trend 비교 불가 — v2 첫 run부터 FC baseline 재구축.

## 6. Judge LLM — Claude CLI subprocess → OpenAI nano tier

- **문제점**: judge를 Claude CLI subprocess(`claude -p`)로 호출 → 매 call마다 cold start(~50s 추정) × 120 call(30문항 × 4 metric) × 직렬 = 1 사이클 약 2시간. 70% 진행 후 timeout 실측.
- **Before**: `claude_cli/claude-haiku-4-5` (LiteLLM custom provider + subprocess).
- **After**: `openai/<nano-tier>` (LiteLLM 표준). 1 call ~1-3초, 1 사이클 약 56원·2~6분 (직렬 기준). subprocess 폐지.
- **정책 정합**: judge layer LiteLLM 허용(2026-05-19) 기존 결정 안. chat layer는 Claude Code headless 유지(분리 원칙).
- **구체 model ID는 `llm.py` `DEFAULT_MODEL` 상수**에만 둔다(provider 수준 spec).

## 7. 한계

- **영세율 reference 부족**: 상담센터 영세율 사례가 robots 제약으로 미수집. 영세율 5문항은 기존 매뉴얼·사례집 표/사례에 의존 — 양질 hard 난이도 작성이 기존 대비 어려움.
- **예정신고 reference 편중**: 신규 5문항이 단일 페이지(mi=1329) 기반 → answer가 reference 톤·표현에 과적합 가능. RAGAS faithfulness/precision은 영향 적으나 answer_relevancy는 다음 run에서 모니터.
