# Generation

질문 + history → standalone query → 검색 → 답변 + 검증된 인용. 위치: `packages/core/src/modules/chat/`. 구조는 ADR-0003에 따라 LangGraph self-correcting loop.

## 1. 흐름

```
chat.service.ts::ask(query, opts)
  │
  ├─ (opts.conversationId)
  │   messageRepo.recentTurns(id, 6)  → history (§5 multi-turn)
  │
  └─ rag-graph.invoke({ messages: [...history, HumanMessage(query)] })
        │
        ▼ LangGraph (rag-graph.ts)
        history_aware_rewrite → retrieve → rerank → grade_docs
                                                    │
                                                    ├─ pass  → generate → grade_answer
                                                    │                       │
                                                    │                       ├─ pass → END
                                                    │                       ├─ fail → regenerate (max 1) → grade_answer
                                                    │                       └─ 소진 → fallback
                                                    └─ fail  → multi_query_retrieve (max 2) → rerank
                                                              소진 → fallback
        │
        ▼
        { answer, citations[] }
        │
        ▼ chat.service가 stream wrapper로 1회 emit
        { textStream(1 chunk), citationStream(N burst), chunks, finish }
```

반환 타입은 [architecture.md §5](./architecture.md#5-core-api-contract-in-process).

## 2. LangGraph 노드

`packages/core/src/modules/chat/rag-graph.ts`. State는 LangChain `Annotation`(`MessagesAnnotation` 확장).

| 노드 | 책임 | LLM call | 출력 채널 |
|---|---|---|---|
| `history_aware_rewrite` | history가 있을 때만 standalone query 1줄 생성 | 1 (skip if first turn) | `standaloneQuery` |
| `retrieve`               | dense top-50 (RETRIEVE_K=50) | 0 (embed 1) | `documents` |
| `rerank`                 | Voyage `rerank-2.5` → top-8 (RERANK_K=8) | 0 (rerank API 1) | `documents` |
| `grade_docs`             | 청크별 binary yes/no 병렬 | N(=8) | `docGrades` |
| `multi_query_retrieve`   | grade fail 분기 — 3 변형 → 각 retrieve → union(MultiQueryRetriever) | 1 + embed 3 | `documents`, `rewriteCount++` |
| `generate`               | `withStructuredOutput({answer, citations[]})` 1회 호출 | 1 | `answer`, `citations` (verify 통과) |
| `grade_answer`           | faithfulness ∧ completeness | 1 | `regenerateFeedback` |
| `regenerate`             | grade fail 분기 — 피드백을 system에 prepend 후 재생성 | 1 | `answer`, `citations`, `regenerateCount++` |
| `fallback`               | 모든 재시도 소진 — 답변 강제 교체 | 0 | "공식 자료에서 확인되지 않습니다" |

라우터:
- `routeAfterGradeDocs`: anyYes → `generate` / rewriteCount<2 → `multi_query_retrieve` / else → `fallback`
- `routeAfterGradeAnswer`: pass(feedback="") → END / regenerateCount<1 → `regenerate` / else → `fallback`

graph는 `recursionLimit: 15`로 invoke (최악 경로 14노드 + 안전 마진 1).

## 3. 모델 결정

`packages/core/src/modules/chat/generation.adapter.ts`:
- `GENERATION_MODEL_ID = "gpt-5-nano"` (ADR-0003 §1)
- Provider: `@langchain/openai`의 `ChatOpenAI` 직접 import (universal factory 비채택 — Turbopack이 변수 dynamic import를 정적 해결 못해 web bundle에서 500. provider 1개라 universal의 의미 없음)
- `reasoning.effort = "low"` + `verbosity = "low"` — gpt-5-nano default(medium)는 reasoning 토큰을 출력 예산에서 다 소진하는 사고가 흔함. citation 추출에는 약간의 deliberation 필요해 "minimal" 대신 "low"

같은 BaseChatModel 인터페이스를 rag-graph가 그대로 소비. provider 교체 시 본 파일만 수정.

## 4. Structured output — citation 1회 emit

ADR-0003 §3에 따라 cite_chunk tool-loop 폐기. `generate` 노드가 `model.withStructuredOutput(AnswerSchema, { method: "jsonSchema", strict: true })`로 한 번에 받는다:

```ts
const AnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(z.object({
    chunkId: z.string(),
    quote: z.string(),       // 길이 제약은 prompt에서만 안내
  })),
});
```

수신 후 verify 루프:
1. `chunkById.get(chunkId)` — rerank 통과 8개 중 없으면 drop
2. `findQuoteStart(chunk.content, quote)` — strict substring 매칭. 실패 시 drop
3. 통과분만 `toCitation(chunk, quote, start)`로 `quoteStart`/`quoteEnd` 좌표 박제

→ 환각 인용이 영속 저장소(`messages.citations`)에 새지 않음. UI는 char index로 highlight.

**호출 비용**: cite_chunk tool-loop 시절 N+1회 → 1회 (인용 5개 ≈ 5x↓). 단 grade_docs는 청크별로 병렬 N회 호출 — 전체 latency는 LLM call 수보다 그래프 라운드 수에 더 민감.

## 5. Multi-turn

```ts
const history = opts.conversationId
  ? await messageRepo.recentTurns(opts.conversationId, 6)  // HISTORY_WINDOW
  : [];
const messages = [
  ...history.map(m => m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)),
  new HumanMessage(query),
];
graph.invoke({ messages }, { recursionLimit: 15 });
```

- `HISTORY_WINDOW = 6` 메시지 = user+assistant 짝 3 round-trip.
- DB에선 `createdAt desc + LIMIT`로 끝만 잘라오고 도메인엔 시간순으로 펼침.
- 이전 turn의 citation 메타는 history에 미포함 — 텍스트 답변만 컨텍스트로.
- `history_aware_rewrite` 노드가 history를 standalone query로 압축 — retrieve도 multi-turn aware.

## 6. Prompt v3

`packages/core/src/modules/chat/prompt.ts`. `PROMPT_VERSION = "v3"` — 평가 cohort 비교 키. ADR-0003 §6 (run-02 환각 패턴 대응 + gpt-5 cookbook 권장 XML 형식).

- v1: inline `[n]` 마커
- v2: cite_chunk tool-call
- v3: LangGraph + structured output. XML 태그(`<role>`, `<procedure>`, `<grounding>`, `<citation_rules>`, `<facts>`, `<conflict>`, `<format>`, `<unknown>`) + 절차 명시 + 긍정 표현 + 충돌 해소 규칙

prompt 모듈은 generate system 외에 노드별 prompt도 owns:
- `REPHRASE_PROMPT` — history_aware_rewrite
- `GRADE_DOCS_PROMPT` — 청크별 binary 판정
- `GRADE_ANSWER_PROMPT` — faithfulness ∧ completeness
- `MULTI_QUERY_PROMPT_TEMPLATE` — MultiQueryRetriever용 PromptTemplate
- `REGENERATE_INSTRUCTION` — grade fail 피드백 prepend
- `buildGenerateSystem(chunks)` — `<context>` 직렬화 + chunkId 라벨 박제 (prompt injection 차단을 위해 system role에 격리)

## 7. SSE 스트리밍 (web)

`apps/web/src/pages/chat/server.ts::streamChat`이 `core.chat.ask` 결과를 AI SDK `createUIMessageStream`으로 직렬화. parts 형태는 [architecture.md §6](./architecture.md#6-network-api-contract-web--client).

text·citation 두 channel을 `Promise.all`로 병렬 drain. 단 ADR-0003 §3로 본문 token streaming이 폐기되어 실질적으로 `text-delta`는 1회 burst, `data-citation`은 N건 burst. ChatWindow UI는 graph가 완료될 때까지(평균 ~18s) typing indicator를 띄움.

종료 후 `recordChatTurn`으로 conversations + messages 2건 transaction 기록.

## 8. 에러 처리 (시스템 경계만)

| 케이스 | 처리 |
|---|---|
| 모델 호출 실패 | throw → 응답 5xx (retry 미구현 — [TODO.md](./TODO.md)) |
| context 비어있음 | grade_docs all-no → multi_query_retrieve → 소진 시 fallback 노드가 "확인되지 않습니다" emit |
| structured output schema 위반 | LangChain이 throw — 상위로 propagate |
| citation verify 실패 | 해당 citation drop. answer 흐름엔 영향 없음 |
| persist 실패 | 답변은 이미 전달 — 서버 로그만 |

내부 함수(repository, retrieve)는 방어 코드 없음.
