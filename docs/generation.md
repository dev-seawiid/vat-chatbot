# Generation

질문 + history → 두 갈래 병렬 검색(direct + draft+claims) → RRF fuse → answer. 위치: `packages/core/src/modules/chat/`. 구조는 ADR-0003 §2 v15 5-노드 parallel.

## 1. 흐름

```
chat.service.ts::ask(query, opts)
  │
  ├─ (opts.conversationId)
  │   messageRepo.recentTurns(id, 6)  → history (§5 multi-turn)
  │
  └─ rag-graph.invoke({ messages: [...history, HumanMessage(query)] })
        │
        ▼ LangGraph (rag-graph.ts) — v15 parallel DAG
        START ─┬─ search_direct ──────────────┐
               │                              ├─ fuse(RRF) → generate_answer → END
               └─ generate_draft → claim_searches ┘
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
| `search_direct`   | 원 query 1회 retrieve+rerank → top-8 (`DIRECT_K=8`) | 0 (embed 1, rerank 1) | `directChunks` |
| `generate_draft`  | `withStructuredOutput({draft, claims[≤6]})` — 자체지식 답 초안 + atomic claim. 사용자 미노출 | 1 | `draft`, `claims` |
| `claim_searches`  | claim별 retrieve+rerank 병렬 → 각 top-4 (`CLAIM_K=4`) | 0 (embed N, rerank N · `Promise.all`) | `claimChunks` |
| `fuse`            | RRF(`RRF_K=60`)로 directChunks + claimChunks 결합 → top-10 (`FUSE_TOP_N=10`) | 0 | `toolChunks` |
| `generate_answer` | `createReactAgent` + `responseFormat`. draft + claim_evidence + chunks 입력, chunk만 ground truth | 1 + tool steps | `answer`, `citations` (verify 통과) |

엣지: `START → {search_direct, generate_draft}`, `generate_draft → claim_searches`, `{search_direct, claim_searches} → fuse → generate_answer → END`. 분기·재시도 없는 결정론적 DAG (품질 게이트는 offline RAGAS로 위임 — ADR-0003 §5). `recursionLimit: 10`.

## 3. 모델 결정

`packages/core/src/modules/chat/generation.adapter.ts`:
- `GENERATION_MODEL_ID = "gpt-5-mini"` (ADR-0003 §1)
- Provider: `@langchain/openai`의 `ChatOpenAI` 직접 import (universal factory 비채택 — Turbopack이 변수 dynamic import를 정적 해결 못해 web bundle에서 500. provider 1개라 universal의 의미 없음)
- `reasoning.effort = "low"` + `verbosity = "low"` — 검색을 결정론적 그래프(direct + draft+claims + RRF)로 옮겼으므로 LLM 호출당 무거운 reasoning 불필요. draft·answer 둘 다 low

같은 `BaseChatModel` 인터페이스를 draft·answer 노드가 그대로 소비. provider 교체 시 본 파일만 수정.

## 4. Structured output — citation 1회 emit

ADR-0003 §3에 따라 cite_chunk tool-loop 폐기. `generate_answer` 노드가 `createReactAgent({ llm, tools, responseFormat: AnswerSchema })`로 한 번에 받는다:

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
1. `resolveChunk(chunkId, registry)` — fuse 통과 10개 중 strict 매칭 → 실패 시 UUID 8-prefix fallback → 둘 다 실패 시 drop
2. `findQuote(chunk.content, quote)` — 6-tier substring 매칭 (strict → outer 마커 제거 → ws 정규화 → 줄임표 segment → ws 완전 제거 → prefix-suffix span)
3. 매칭 통과 시 `toCitation(chunk, match)`로 `quoteStart`/`quoteEnd` 좌표 박제. 6-tier 다 실패 시 `toCitationUnmatched`로 highlight 없이 노출

→ 환각 인용이 영속 저장소(`messages.citations`)에 새지 않음. UI는 char index로 highlight.

answer agent에 노출되는 calc 도구는 ADR-0003 §4의 `date_after`/`vat_calc`. chunk 검색 도구는 없음 (검색은 결정론적 그래프 노드가 owns).

## 5. Multi-turn

```ts
const history = opts.conversationId
  ? await messageRepo.recentTurns(opts.conversationId, 6)  // HISTORY_WINDOW
  : [];
const messages = [
  ...history.map(m => m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content)),
  new HumanMessage(query),
];
graph.invoke({ messages }, { recursionLimit: 10 });
```

- `HISTORY_WINDOW = 6` 메시지 = user+assistant 짝 3 round-trip.
- DB에선 `createdAt desc + LIMIT`로 끝만 잘라오고 도메인엔 시간순으로 펼침.
- 이전 turn의 citation 메타는 history에 미포함 — 텍스트 답변만 컨텍스트로.
- 별도 rewrite 노드 없음 — `search_direct`는 마지막 user message text를 query로, `generate_draft`·`generate_answer`는 messages 배열을 그대로 받아 coreference·분해를 LLM이 직접 처리.

## 6. Prompt v4

`packages/core/src/modules/chat/prompt.ts`. `PROMPT_VERSION = "v4"` — 평가 cohort 비교 키. ADR-0003 §6.

- v1: inline `[n]` 마커
- v2: cite_chunk tool-call
- v3: 9노드 self-correcting graph + structured output (pipeline용 6+ system)
- v4: v15 parallel + structured output. 두 system prompt만 owns:
  - `DRAFT_WITH_CLAIMS_SYSTEM` — `generate_draft`. 자체지식 draft + atomic claim 배열. 출력은 검색 키 전용. 수치·임계는 일반 표현 우선(stale 안전장치)
  - `ANSWER_SYSTEM` — `generate_answer`. chunk-grounded synthesis with draft as guide. claim별 evidence verify → 뒷받침되면 채택, 안 되면 reject. verified 모든 사실(기본·예외·위임 시행령·사후 수정·폐업 특례)을 별도 문장으로 답에 포함 (Verify-and-Edit / ALCE 패턴)

`rag-graph.ts::answerNode` 안의 `<draft>` / `<claim_evidence>` / `<chunks>` / `<question>` XML 블록은 prompt가 아닌 노드가 직렬화.

## 7. SSE 스트리밍 (web)

`apps/web/src/pages/chat/server.ts::streamChat`이 `core.chat.ask` 결과를 AI SDK `createUIMessageStream`으로 직렬화. parts 형태는 [architecture.md §6](./architecture.md#6-network-api-contract-web--client).

text·citation 두 channel을 `Promise.all`로 병렬 drain. 단 ADR-0003 §3로 본문 token streaming이 폐기되어 실질적으로 `text-delta`는 1회 burst, `data-citation`은 N건 burst. ChatWindow UI는 graph가 완료될 때까지 typing indicator를 띄움.

종료 후 `recordChatTurn`으로 conversations + messages 2건 transaction 기록.

## 8. 에러 처리 (시스템 경계만)

| 케이스 | 처리 |
|---|---|
| 모델 호출 실패 | throw → 응답 5xx (retry 미구현 — [TODO.md](./TODO.md)) |
| context 비어있음 | fuse 결과 0건이어도 `generate_answer`는 호출됨. ANSWER_SYSTEM fallback 정책으로 "공식 자료에서 확인되지 않습니다" emit |
| structured output schema 위반 | LangChain이 throw — 상위로 propagate |
| citation verify 실패 | strict 매칭 실패 후 6-tier fallback. 다 실패 시 highlight 없이 노출(`toCitationUnmatched`) 또는 chunkId 미일치면 drop |
| persist 실패 | 답변은 이미 전달 — 서버 로그만 |

내부 함수(repository, retrieve)는 방어 코드 없음.
