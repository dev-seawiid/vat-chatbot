# Golden Set v2 — Reference 확장 + 30문항 재구성

ADR-0001 source migration에 맞춰 reference 풀을 확장하고 30문항을 재작성. 분포 원칙은 **full-scope coverage**(2025-2026 RAG eval 통설): 카테고리·난이도 다축으로 representative + 약점 영역 + edge case 를 함께 cover해 capability discrimination을 유지한다. "사용자 질문 빈도 ∝ 분포"는 production traffic monitoring의 역할이라 골든셋에서 채택하지 않는다.

## 1. Reference 출처

|                                             | Before     | After                                          |
| ------------------------------------------- | ---------- | ---------------------------------------------- |
| PDF (매뉴얼/사례집)                         | 3건        | 동일 3건                                       |
| 상담센터 Q&A (`nts_counseling_qna.jsonl`)   | —          | 27건 (예정신고/예정고지 한정)                  |
| 본사이트 게시판 메타 (`nts_homepage.jsonl`) | —          | 10건 (부가세 참고자료실, 사례·매뉴얼 PDF 링크) |
| 답변 톤                                     | 매뉴얼체만 | + 실제 사용자 질문체(상담센터)                 |

상담센터 사례 22,001건은 robots.txt `Disallow: /`로 자동 수집 비범위. mi=1329 단일 페이지(예정신고/예정고지)만 1회 fetch.

## 2. 30문항 카테고리 분포

| 카테고리                 | Before | After  | 주 reference     | 변경 사유                                                   |
| ------------------------ | ------ | ------ | ---------------- | ----------------------------------------------------------- |
| 기초 신고/마감           | 6      | 5      | 매뉴얼           | 예정신고 신설 분 균등 차감                                  |
| 영세율/면세              | 6      | 5      | 매뉴얼·사례집 표 | discrimination 보존 위해 거의 유지 (ADR-0001 §3 worst 영역) |
| 매입세액 공제            | 6      | 5      | 매뉴얼           | 균등 차감                                                   |
| 의제매입                 | 4      | 3      | 매뉴얼           | 균등 차감                                                   |
| 간이과세                 | 4      | 4      | 사례집(간이)     | 유지 (worst 영역)                                           |
| 가산세                   | 4      | 3      | 매뉴얼           | 균등 차감                                                   |
| 예정신고/예정고지 (신규) | 0      | 5      | counseling_qna   | 신규 reference 충분, 신설                                   |
| **합계**                 | **30** | **30** |                  |                                                             |

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

## 8. lbr-eval — LegalBench-RAG 추가, ragas-eval과 보완 관계

- **문제점**: ragas-eval은 generation 평가 위주(faithfulness/answer_correctness 등 LLM judge). retrieval 단독 시그널이 약함 — retrieval 회귀가 generation 점수 안에 섞여 분리 불가.
- **추가**: `jobs/lbr-eval` (LegalBench-RAG, Pipitone 2024 arxiv 2408.10343) — retrieval-only 결정적 메트릭.
  - 메트릭: `Precision@k`, `Recall@k` on 조문 ID set (원본 snippet 단위는 우리 조 단위 chunking에 맞춰 조문 단위로 변형).
  - LLM judge 0회. core `chat.retrieve()` (또는 CLI `--retrieval-only`)로 answer 노드 우회 → generation LLM은 draft 1회만(HyDE+claims 필수).
- **보완 관계**: ragas-eval(generation, LLM judge) + lbr-eval(retrieval, deterministic) — 같은 골든셋 단일 소스 공유.
  - lbr-eval은 `must_include_articles` 컬럼만 사용. 나머지 컬럼은 ragas-eval 영역.
- **운영**: lbr-eval은 결정적·빠름 → 매 PR 회귀 게이트. ragas-eval은 LLM judge 비용 있음 → 릴리스 게이트.
- **메트릭 해석**: `Recall@k`가 주 시그널 — 누락된 정답은 LLM이 복구 불가. `P@k`는 비용·k튜닝 보조 (R@k 동등할 때 토큰 절약 여지). 논문(LBR §4.2)은 두 메트릭 동등 가중이나, 누락 위험 우선. `must_include`도 sparse label이라 P@k 절대값은 한 자릿수 % 수준이 정상(논문 §5.1 결과와 일치).
- **ChatService 메서드 분리**: `ask`(full), `retrieve`(retrieval-only), `answer`(generation-only with injected chunks) — boolean flag 누적 회피, discriminated mode (Toss coupling §3 / predictability §1). CLI도 `--retrieval-only` / `--generation-only --chunks=<path>` 두 flag로 대응.

## 9. ragas metric 축소 — 2종 + smoke test 강등

- **제거**: `ContextPrecisionWithReference`(§8 lbr-eval `P@k`와 retrieval 시그널 중복), `AnswerRelevancy`(verbose 보상 → 1~3문장 골든셋과 충돌, legal RAG 벤치마크 어디서도 미채택).
- **Before → After**: 4종 → 2종 (`Faithfulness` + `FactualCorrectness(mode="f1")`, 옵션 기본값). retrieval = lbr-eval, generation = ragas.
- **역할 강등**: legal/세법 RAG에서 두 metric 사용 사례 0건(KoBLEX·LRAGE·Isaacus·Trautmann·Magesh·Austrian VAT). 아래 cover 매핑 기준 dominant 실패를 구조적으로 못 잡음 → primary quality gate 아닌 **catastrophic regression smoke test**.

  | 검증 axis                                       | Faithfulness |  FactualCorrectness   |
  | ----------------------------------------------- | :----------: | :-------------------: |
  | 외부지식 hallucination (context 없는 사실)      |      ✅      |           △           |
  | 자체 오답 (답 ≠ reference)                      |      ❌      |          ✅           |
  | 완전성 (예외·한정 누락)                         |      ❌      |          ✅           |
  | retrieval 회귀 (context-답 단절)                |      ✅      |          ❌           |
  | 빈 응답 / 거대 회귀                             |      ✅      |          ✅           |
  | **misgrounded** (옳은 조문, 틀린 항·호)         |      ❌      |          ❌           |
  | **부정·단서** ("~할 수 있다" vs "~하여야 한다") |      ❌      |          ❌           |
  | **refusal correctness**                         |      △       |          ❌           |
  | **수치 precision** (1천분의 5 ↔ 5% swap)        |      △       |           △           |
  | citation `quote` 정합                           |      ❌      | ❌ (별도 code verify) |
  | format/tone                                     |      ❌      |  ❌ (metric 영역 외)  |

- **수치·조문 hallucination 보강**: deterministic NumericEM/CitationEM은 답변 자유 표기와 충돌. metric 대신 **system prompt에서 "수치·조문은 chunk 원문 인용" 제약**으로 처리.
- **Follow-up**: primary quality gate는 KoBLEX **LF-Eval**(`Context Fidelity`) 스타일 자체 rubric judge 도입.
