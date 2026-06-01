# Golden Set

평가에 쓰는 시험 문제 셋 설계. 채점 지표·실행은 [evaluation.md](./evaluation.md).

`data/golden_set.csv` 한 파일이 답 품질(RAGAS)과 검색 품질(lbr-eval) 채점에 모두 쓰인다.

## 구성 (30문항)

7 카테고리 × 난이도(쉬움/중간/어려움). 약점 영역(영세율·간이)을 일부러 남겨 실력 차이가 드러나게 한다.

| 카테고리 | 건수 |
|---|---|
| 기초신고 / 영세율·면세 / 매입세액공제 | 각 5 |
| 의제매입 / 가산세 | 각 3 |
| 간이과세 | 4 |
| 예정신고 | 5 |

## CSV 컬럼

`id · Input · Expected Output · Metadata · must_include_articles`

- 앞 4개는 Langfuse Dataset 필드명과 일치(업로드 시 자동 매핑).
- `Input` 질문, `Expected Output` 모범답안, `Metadata`는 카테고리·난이도.
- `must_include_articles` — 검색 채점용 정답 조문(이 문항에 반드시 회수돼야 할 조문 id).

## reference 분리 (점수 부풀림 차단)

모범답안은 국세청 매뉴얼·상담 자료(`data/golden_set_reference/`)를 보고 작성하되, 이 자료는 **챗봇 검색에 넣지 않는다**. 넣으면 정답이 나온 출처를 그대로 회수해 점수가 실제보다 높게 나오기 때문.

| 출처 | 건수 | 용도 |
|---|---|---|
| 매뉴얼·사례집 PDF | 3 | 답변 톤 reference |
| 상담센터 Q&A (`nts_counseling_qna.jsonl`) | 27 | 예정신고 답변 reference |
| 홈페이지 게시판 (`nts_homepage.jsonl`) | 10 | 참고자료실 메타 |

## 한계

- 영세율 상담사례 미수집 → 영세율 문항은 매뉴얼 의존.
- 예정신고 reference가 단일 페이지에 편중.
