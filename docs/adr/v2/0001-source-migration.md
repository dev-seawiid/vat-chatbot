# Source Migration

RAG source를 **국세청 가이드 PDF → 법·시행령·시행규칙**으로 교체. 가이드는 골든셋·답변 톤 레퍼런스로 강등. 이유는 단순: (1) 가이드는 법령의 2차 변형이라 정답 기준으로 더 적합, (2) PDF 추출에서 표·이미지 손실로 retrieval miss 발생.

## 1. Before / After

| | Before (현재 `data/sources.json`) | After |
|---|---|---|
| **retrieval source** | 신고안내매뉴얼 2건 + 사례집 3건 (PDF) | 부가가치세법 + 시행령 + 시행규칙 + 국세기본법 핵심 조문 |
| **소스 성격** | 법령의 요약·예시 (2차 가공) | 1차 규범 텍스트 |
| **포맷** | PDF (표·이미지 다수) | 조문 텍스트 (구조화 가능) |
| **가이드·사례집** | retrieval index에 포함 | **golden set 답변 작성 참고**로만 사용 |

## 2. 근거 1 — 2차 변형 문제

가이드 PDF는 법령을 **요약·재배열**한 매뉴얼이다. 신고 절차·사례 위주라 (a) 일부 예외 조항이 누락되거나 (b) 표현이 단순화돼 retrieval에서 인용해도 출처로서 무게가 낮다. 정답·신뢰성 기준은 법령이 맞고, 가이드는 "사람이 어떻게 설명하는가"의 reference라 **golden answer 작성 시 참고 자료**로 위치가 맞다.

## 3. 근거 2 — eval 정확도 패턴

`.tmp/eval/scores.jsonl` (30 샘플, 현 source):

| metric | avg | <0.5 |
|---|---|---|
| `llm_context_precision_no_ref` | **0.66** | **10/30 (33%)** |
| `faithfulness` | NaN 포함 | 3건 0점 |
| `answer_relevancy` | NaN 포함 | 3건 0점 |

worst: `vat-zero-medium-1`(영세율) precision=0.14·faithfulness=0, `vat-simple-medium-2`(간이) precision=0.29·faithfulness=0. **영세율·간이과세 = 표·도표 비중이 큰 영역**에 점수 하락이 몰림 → retrieval이 표 안 숫자·요건을 못 가져오는 정황과 일치.

## 4. 근거 3 — PDF 추출 손실

사례집(`cases-general`, `cases-simplified`)은 화면 캡처·신고서식 이미지·요건 표가 본문의 상당 부분을 차지. extract 단계(`jobs/ingest/src/ingest/extract`)에서 텍스트 추출 시 (a) 표 셀이 줄바꿈으로 깨지거나 (b) 이미지 안 텍스트는 OCR 없으면 0 byte. 매뉴얼도 동일 — 신고서·세액계산 흐름이 도식. 반면 **법령은 조문 = 순수 텍스트**, 항·호 단위로 끊겨 chunking·anchor도 자연스럽다.

## 5. 마이그레이션 후 역할

**retrieval source** — 1차 인덱스, `data/sources.json` `laws[]`
- 부가가치세법 / 시행령 / 시행규칙
- 국세기본법 (신고·납부·가산세 핵심 조문)

**golden answer 작성 참고** — `data/eval/reference_data/` (인덱싱 X)
- 신고안내매뉴얼 PDF — 답변 톤
- 사례집 PDF — 답변 톤 + 향후 보조 인덱스 후보

**golden set Q·A** — `data/eval/golden_set.csv`
- 국세청 홈택스 FAQ — 베이스
- 국세상담센터 상담사례 — 보강 (§3 약점 영역: 영세율·간이)

## 6. 후속

- `data/sources.json` `laws[]` 채우기 + law 어댑터 (현재 `kind: "pdf"`만 구현). 별도 spec 슬라이스로 끊는다.
- 골든셋 재구축: 홈택스 FAQ를 베이스로 수집, 약점 영역(영세율·간이)은 상담사례로 보강해 `data/eval/golden_set.csv` 재작성. 매뉴얼·사례집은 답변 톤 참고용으로만 사용.
- 사례집 OCR/표 추출 개선은 retrieval 보조 인덱스 단계에서 재평가 — 현 단계 비범위.
