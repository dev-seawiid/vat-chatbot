# Generation

retrieved chunks + 질문 → 스트리밍 답변 + 검증된 인용. 위치: `packages/core/src/chat/`.

## 1. 흐름

```
chat.service.ts::ask(query, opts)
  │
  ├─ retrieval.retrieve(query, { k, filter })    → chunks  (→ retrieval.md)
  │
  ├─ (opts.conversationId)
  │   messageRepo.recentTurns(id, 6)             → history (multi-turn §6)
  │
  ├─ streamText({
  │     model: gpt-4o-mini,
  │     system: buildSystemMessage(chunks),       — [chunkId=...] 라벨 + invariant
  │     messages: [...history, { role:"user", content: query }],
  │     tools,                                    — cite_chunk · calc_vat · lookup_law_article
  │     stopWhen: stepCountIs(5),                 — tool 라운드트립 최대 5회
  │     experimental_telemetry,                   — (→ observability.md)
  │   })
  │
  └─ fullStream 백그라운드 소비 → 두 채널로 fan-out
        ├─ text-delta  → textStream
        └─ tool-call cite_chunk → quote substring 검증 → citationStream
```

반환: `{ textStream, citationStream, chunks, finish }`. 자세한 시그니처는 [architecture.md §5 Core API contract](./architecture.md#5-core-api-contract-in-process).

## 2. 시스템 프롬프트

`packages/core/src/chat/prompt.ts`:

```
당신은 국세청 공식 자료를 기반으로 답하는 부가세 신고 어시스턴트다.
- 제공된 <context> 안의 내용만 근거로 답하라.
- 인용은 본문에 [n] 같은 마커를 박지 말고, 반드시 cite_chunk 도구로만 선언하라.
  - chunkId: <context>의 [chunkId=...] 라벨 값을 그대로 사용.
  - quote: 해당 chunk 본문에서 그대로 발췌한 30~120자 문장(요약·재작성 금지).
  - 새로운 주장을 할 때마다 즉시 호출하라. 답변 끝에 몰아서 호출 금지.
- context에 근거가 없으면 "공식 자료에서 확인되지 않습니다"라고 답하라. 추측 금지.
- 계산이 필요하면 calc_vat 도구를 사용하라. 직접 산수 금지.
```

**`buildSystemMessage(chunks)`**가 chunks 8개를 `<context>` 안에 직렬화:

```
[chunkId=abc-1234-...] 매뉴얼 · 버전 2025-2q · p.12 · II. 영세율
{chunk 본문}

[chunkId=def-5678-...] 사례집 · p.47
{chunk 본문}

... (8개)
```

`chunkId` 라벨이 도메인 키 — 모델이 `cite_chunk` 인자로 그대로 복사. retrieved chunks를 system role에 격리해 사용자 입력이 `</context>` 같은 구분자를 포함해도 prompt injection 차단.

**`PROMPT_VERSION = "v2"`** — 평가 run의 비교 키. v1=inline `[n]` 마커, v2=cite_chunk tool-call.

## 3. 모델 결정

`packages/core/src/adapters/generation.ts`:
- `GENERATION_MODEL_ID = "gpt-4o-mini"`
- Provider: `@ai-sdk/openai`의 `createOpenAI({ apiKey })`

`adapters/`에 단일 상수로 캡슐화. provider 교체 시 본 파일만 수정.

## 4. Tools

`packages/core/src/chat/tools.ts`:

### `cite_chunk({ chunkId, quote })` — 인용 선언 채널 (생성의 핵심)

```ts
inputSchema: z.object({
  chunkId: z.string(),
  quote: z.string().min(20).max(160),
})
execute: async () => ({ ok: true })  // ack만 — 인자 자체가 페이로드
```

- 모델이 본문 텍스트에 `[n]` 마커를 박지 않음. 인용 선언은 오직 본 tool 호출로.
- `ChatService.ask`의 fullStream 순회가 `tool-call` 이벤트를 가로채:
  1. `CiteChunkInputSchema.safeParse(part.input)` — schema 위반 시 drop
  2. `chunkById.get(chunkId)` — retrieved 8개 중 없으면 drop
  3. `chunk.content.indexOf(quote)` — strict substring 매칭. 실패 시 drop
  4. 통과 시 `toCitation(chunk, quote, quoteStart)` 생성 → `citationStream`에 emit + `finish.citations`에 누적
- 검증 통과 인용만 `messages.citations` jsonb에 영속 박제 — 환각 인용이 저장소에 새지 않도록.

### `calc_vat({ taxable_amount, rate })` — 정확한 계산

```ts
execute: async ({ taxable_amount, rate }) => {
  const vat = Math.round(taxable_amount * rate);
  return { taxable_amount, rate, vat, total: taxable_amount + vat };
}
```

native number 곱셈. `decimal.js` 교체는 후속.

### `lookup_law_article({ article_no })` — stub

국가법령정보센터 OpenAPI 어댑터 미연결 — [TODO.md](./TODO.md).

## 5. Citation 도메인 객체

`packages/core/src/shared/citation.ts`:

```ts
type Citation = {
  chunkId: string;
  docId: string;
  sourceId: string;            // sources.json 자연키 — citation 추적·UI 표시용
  docTitle: string;
  docVersion: string | null;
  sourceUrl: string | null;    // UI "원본 PDF 다운로드" 앵커
  page: number | null;
  sectionPath: string | null;
  content: string;             // chunk 본문 전체 — UI highlight 좌표 기준
  quote: string;               // 모델이 발췌한 문장
  quoteStart: number;          // content 내 시작 char index
  quoteEnd: number;            // 끝 char index (exclusive)
};
```

**Invariant**: `content.slice(quoteStart, quoteEnd) === quote`. Anthropic Citations API의 `(cited_text, start_char_index, end_char_index)`와 같은 형태로 자기 충족성·post-hoc 검증·UI highlight 정밀도를 동시 확보.

`toCitation(chunk, quote, quoteStart)`은 호출자가 좌표를 계산해 넘기는 형태 — 좌표 정확성 책임은 호출자(chat.service의 verify)에 있음.

## 6. Multi-turn

`opts.conversationId` 주입 시 multi-turn 활성화:

```ts
const history = opts.conversationId
  ? await messageRepo.recentTurns(opts.conversationId, HISTORY_WINDOW)  // = 6
  : [];

streamText({
  ...
  messages: [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: query },
  ],
});
```

- `HISTORY_WINDOW = 6` 메시지 = user+assistant 짝 3 round-trip.
- DB에선 `createdAt desc + LIMIT`로 끝만 잘라오고 도메인엔 시간순으로 펼침.
- 이전 turn의 `tool-call` 메타는 history에 미포함 — 텍스트 답변만 컨텍스트로.
- **retrieve는 multi-turn 비활성** — 현재 turn의 query 단독으로 검색. history-aware retrieval(query rewriting)은 후속.

## 7. SSE 스트리밍 (web)

`apps/web/src/pages/chat/server.ts::streamChat`이 `core.chat.ask` 결과를 AI SDK `createUIMessageStream`으로 직렬화. parts 형태는 [architecture.md §6](./architecture.md#6-network-api-contract-web--client).

text·citation 두 stream을 `Promise.all`로 병렬 drain — 어느 쪽도 다른 쪽을 막지 않음. 종료 후 `recordChatTurn`으로 conversations + messages 2건 transaction 기록.

## 8. 에러 처리 (시스템 경계만)

| 케이스 | 처리 |
|---|---|
| 모델 호출 실패 | throw → 응답 5xx (retry 미구현 — [TODO.md](./TODO.md)) |
| context 비어있음 | streamText 그대로 진행. 시스템 프롬프트의 거절 규칙으로 모델이 처리 |
| cite_chunk verify 실패 | citation drop. 모델 답변 흐름엔 영향 없음 |
| persist 실패 | 답변은 이미 보여진 상태 — 서버 로그만 |

내부 함수(repository, retrieve)는 방어 코드 없음.
