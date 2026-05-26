# RAG Chain Decisions

코어 런타임은 **LangChain.js** (`packages/core` TS 유지).

## 1. Generation 모델 — OpenAI gpt-5-mini

- **문제점**: 4o-mini는 reasoning 벤치(AIME·GPQA) 약점 + 128K context 제약. 도메인 분기 답변에서 instruction 누락 잦음.
- **Before**: `gpt-4o-mini` (input $0.150 · output $0.600 /MTok, 128K).
- **After**: `gpt-5-mini` + `reasoning.effort="low"` + `verbosity="low"` (400K). 검색을 결정론적 그래프로 옮겼으므로(§2) LLM 호출당 무거운 reasoning 불필요 → low로 운용.

## 2. Chain 구조 — 9노드 CRAG → v15 5-노드 parallel (HyDE + Claim Decomposition + RRF)

- **문제점**: 단일 ReAct agent는 검색(recall 우선)·답 작성(precision 우선)이 동일 system prompt + 동일 tool context에 묶여, 예외·조건부 chunk를 검색에선 잡고 답엔 합치면 안 되는 모순 instruction이 한 호출에 공존. mini급 모델은 단계별 instruction을 안정 적용 못 함 → §66류 조건부 조항을 일반 규정과 합성. 또한 단일 query 임베딩은 추상 질문에서 핵심 조문 누락.
- **Before**: 9노드 LangGraph CRAG pipeline (rephrase · multi-query · decompose · grade · regenerate · fallback 등).
- **After**: **v15 — 5 결정론적 노드의 parallel 그래프**. 검색을 LLM tool-call에서 떼어내 두 갈래로 분기, RRF로 융합. 답은 chunk-grounded synthesis 1회.
  - 갈래 A `search_direct`: 원 query 1회 retrieve+rerank (k=8).
  - 갈래 B `generate_draft` → `claim_searches`: LLM 1회로 `{draft, claims[≤6]}` structured output(자체지식 답 초안 + atomic claim 분해, **사용자에 안 보임 — 검색 키 전용**). claim별 retrieve+rerank 병렬 (k=4).
  - `fuse`: RRF(`k=60`)로 모든 list 결합 → top 10.
  - `generate_answer`: createReactAgent + responseFormat. draft + claim-evidence 매핑 + chunks 입력. chunk 본문이 유일한 ground truth, draft는 선택·범위 가이드로만 (Verify-and-Edit / ALCE 패턴).

### After

```
                  query (+ history)
                      │
       ┌──────────────┼──────────────┐
       ▼                             ▼
 search_direct           generate_draft (LLM 1회, structured)
 (retrieve+rerank, k=8)        │ {draft, claims[≤6]}
       │                       ▼
       │                  claim_searches
       │                  (claim별 retrieve+rerank 병렬, 각 k=4)
       │                       │
       └──────────┬────────────┘
                  ▼
              fuse (RRF, top 10) → state.toolChunks
                  ▼
       generate_answer (createReactAgent + responseFormat)
         · 입력: draft + claim_evidence + chunks + question
         · 도구: date_after / vat_calc (chunk 검색 도구 없음 — 추가 검색 격리)
         · 출력: {answer, citations[{chunkId, quote}]}
                  ▼
              substring 검증 통과 citation만 emit
```

## 3. 인용 메커니즘 — structured output (1회 호출)

- **문제점**: cite_chunk tool-loop는 인용 N개당 LLM 호출 N+1회 + `stepCountIs` cap 관리. LangChain 정설은 structured output(`qa_citations`).
- **Before**: cite_chunk tool-loop, 호출 N+1회, streaming 중 substring 검증.
- **After**: answer 노드를 `createReactAgent` + `responseFormat: { answer, citations: [{ chunkId, quote }] }`로 단일 호출. calc 도구는 ReAct loop으로 허용, chunk 검색 도구는 없음. 수신 후 substring 검증으로 좌표 박제·일괄 emit.
- **이점**: 호출 1회, step cap 코드 없음, 검증·UI 좌표 메커니즘 보존.
- **수용 trade-off**: 본문 token streaming + 인용 점진 emit 포기 → 완료 시 일괄 emit.

## 4. Tools (answer agent 노출)

| tool        | 입력                       | 동작                                                       |
| ----------- | -------------------------- | ---------------------------------------------------------- |
| `date_after`| `base_date`, `days`        | 상대 기한("끝난 후 25일") → 절대 날짜 환산. 머릿속 산수 차단.     |
| `vat_calc`  | `taxable_amount`, `rate`   | 공급가액 × 세율 → 부가세액. 직접 산수 차단.                       |

검색 도구(`vector_search`·`article_lookup`)는 v15에서 폐기 — 결정론적 그래프 노드(`search_direct`·`claim_searches`)로 흡수. BM25 hybrid는 후속 슬라이스에서 retrieve 어댑터 내부에 추가 예정(LLM 표면 변화 없음, ADR-0002 §1.6 결정 뒤집기 필요).

## 5. 품질 게이트

- inline grading 노드(grade_docs·grade_answer·regenerate·fallback) 폐기 — 같은 mini로 self-judge라 정보 비대칭 없어 redundant (Anthropic Agent SDK 권고 + Harvey production 사례).
- 품질 게이트는 **offline RAGAS eval** (jobs/ragas-eval)로 위임 — faithfulness·factual_correctness·context_precision metric.
- citation 환각 차단은 후처리 substring 검증 유지 (`findQuote` 6-tier: strict → outer 마커 제거 → ws 정규화 → 줄임표 segment → ws 완전 제거 → prefix-suffix span). chunkId 미일치 citation은 DROP, quote 매칭 실패는 highlight 없이 fallback 노출.

## 6. Generation prompt — v3 (pipeline) → v4 (draft + answer)

- **v3 (이전)**: pipeline용 system 6+개 분리 (REPHRASE · GENERATE_SYSTEM · GRADE_DOCS · GRADE_ANSWER · MULTI_QUERY · QUERY_DECOMPOSE).
- **v4 (현재)**: 두 system prompt만.
  - `DRAFT_WITH_CLAIMS_SYSTEM`: 자체지식 draft + atomic claim 배열 생성. 출력은 검색 키로만 — hallucination은 fuse·answer의 chunk-grounding이 차단. 수치·임계는 일반 표현 우선(stale 안전장치).
  - `ANSWER_SYSTEM`: chunk-grounded synthesis with draft as guide. draft는 chunk 선택·범위 가이드, 답 본문은 chunk 문구·동사·수치로. claim별 evidence 매핑을 verify → 뒷받침되면 채택, 안 되면 reject. verified 모든 사실(기본 케이스·예외·위임 시행령·사후 수정·폐업 특례)을 별도 문장으로 답에 포함(압축 금지). "신고하여야 한다(의무)" vs "신고할 수 있다(선택)" 구분 + 부정 추론 가이드. 톤 "~한다" 체.
- 사실 규칙(말 바꾸기 금지·라벨드 다항·chunk 충돌 시 시행일 우선)은 v3에서 그대로 승계. REPHRASE 폐기는 ReAct/그래프가 messages 배열로 coreference·분해를 직접 처리하므로 별도 LLM 호출 불필요.
