# RAG Chain Decisions

코어 런타임은 **LangChain.js** (`packages/core` TS 유지).

## 1. Generation 모델 — OpenAI mini → nano tier

- **문제점**: mini 단가가 nano 대비 input 3x · output 1.5x 비싸고 컨텍스트 128K로 좁음. reasoning 벤치(AIME·GPQA 등)에서도 nano 우위.
- **Before**: `gpt-4o-mini` (input $0.150 · output $0.600 /MTok, 128K context).
- **After**: `gpt-5-nano` (input $0.050 · output $0.400 /MTok, 400K context).

## 2. Chain 구조 — linear retrieve → LangGraph self-correcting loop

- **문제점**: run-02 ctx_precision 0.36, 검색 실패 A 16/31(52%) 중 11건이 ctx_p=0 (top-8에 정답 청크 부재). 단일 retrieve linear chain은 검색·생성 실패 시 fallback 경로 없음.
- **Before**: `query → embed → dense top-8 → streamText`. 단일 pass, grading·재시도 없음.
- **After**: LangGraph 노드 그래프. **happy path 6스텝**(rewrite → retrieve → rerank → grade_docs → generate → grade_answer), grade fail 시에만 rewrite/regenerate 분기(각 max 2회·1회).

### Before

```
query ─► embed ─► dense top-8 ─► generate ─► answer
```

### After

happy path 굵게, fail 분기는 조건부(점선).

```
query
  │
  ▼
┌─ history_aware_rewrite           │
│  (history → standalone question) │
└──────────────┬───────────────────┘
               ▼
┌─ dense retrieve  k=50            │
│  + 1-hop refs expand             │
└──────────────┬───────────────────┘
               ▼
┌─ rerank (cross-encoder)  k=8 ────┐
└──────────────┬───────────────────┘
               ▼
       ┌─ grade_docs ─┐
       │   pass       │ ┄fail┄► multi-query rewrite ┄► retrieve  (max 2회)
       └──────┬───────┘
              ▼
┌─ generate (structured output)    │
│  → { answer, citations[] }       │
└──────────────┬───────────────────┘
               ▼
      ┌─ grade_answer ─┐
      │    pass        │ ┄fail┄► regenerate w/ feedback  (max 1회)
      └───────┬────────┘
              ▼
            emit

happy path : rewrite → retrieve → rerank → grade_docs → generate → grade_answer  (6 step)
fail path  : + multi-query rewrite/re-retrieve  또는  + regenerate                  (조건부)
```

## 3. 인용 메커니즘 — cite_chunk tool-loop → structured output

- **문제점**: tool-call 방식은 인용 N개당 LLM 호출 N+1회 + `stepCountIs` 등 loop cap 관리. LangChain 이관 시 정설은 structured output(`qa_citations`).
- **Before**: cite_chunk tool-loop + `stopWhen: stepCountIs(5)`. streaming 중 substring 검증해 citation 채널 즉시 emit. LLM 호출 N+1회.
- **After**: `model.withStructuredOutput({ answer, citations: [{ chunkId, quote }] })` **1회 호출**. 수신 후 동일 substring 검증으로 좌표 박제·일괄 emit.
- **이점**: 호출 N+1→**1회**(인용 5개 ≈ 5x↓), step cap 코드 폐지, 검증·UI 좌표 메커니즘 보존(신뢰도 동등).
- **수용 trade-off**: 본문 token streaming + 인용 점진 emit 모두 포기 → 답변 전체(본문 + citations) 완료 시 일괄 emit (LangChain 공식 `qa_citations` 패턴).

## 4. Tools 정리

| tool                 | Before                         | After                                                                          |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `cite_chunk`         | tool-call N회 + substring 검증 | **폐지**. 데이터는 §3 structured output `citations[]` 스키마로 흡수            |
| `lookup_law_article` | stub (미구현)                  | **폐지**. 법령은 ADR-0001/0002로 retrieval 인덱스 포함 → dense retrieve가 흡수 |
| `calc_vat`           | tool-call 산수                 | **유지**. LangGraph 별도 노드 분리는 후속 업데이트                             |

## 5. Grade·재시도 정책

- **history_aware_rewrite** (항상): multi-turn history + 현 질문 → standalone question (LangChain `createHistoryAwareRetriever`). 도메인 용어 단정은 안 함.
- **grade_docs**: 청크별 binary `yes`/`no` (LangGraph CRAG/Self-RAG 정설). yes ≥ 1 → generate, 모두 no → fail.
- **multi-query rewrite** (fail시): LLM이 3개 변형 → 각 retrieve → 합치기. max **2회**.
- **grade_answer**: faithfulness AND completeness 둘 다 binary. 한쪽이라도 no → regenerate. max **1회**.
- **regenerate 입력**: 이전 답변 + grade 피드백을 system에 prepend.
- **소진 시**: "공식 자료에서 확인되지 않습니다" 강제.
- **무한루프 방지**: 위 cap + LangGraph `recursionLimit`.

## 6. Generation prompt — v2 → v3

- **문제점 (run-02 31문항)**: 본문에 인용 표시 새어 들어옴 17/31(`[chunkId=…]` 10·`[n]` 4·잘린 UUID 3), 숫자를 말 바꾸다 사실 일그러뜨림 3/31, 1기/2기 시점 오답·단계 누락·자료 있는데 모른다고 답함 각 1~2건.
- **Before**: cite_chunk 도구 지시 + "context만 근거" 일반 문구.
- **After**: 본문 인용 표시 어떤 형태도 금지 · 숫자·기간·조문·서식 글자 그대로 옮기기 · context가 N단계면 답변도 N단계 모두 · 다항 정보는 라벨로 묶어 나열(대상/기한/내용) · chunk 충돌 시 시행일·개정일·법령 우선 · 자료에 직접 답 없을 때만 모른다고 답함. 형식은 gpt-5 cookbook 권장 XML 태그·절차 블록·긍정 표현으로 재구성. API는 `reasoning_effort: "low"` + `verbosity: "low"` (gpt-5-nano default medium은 출력 예산 소진 위험).
