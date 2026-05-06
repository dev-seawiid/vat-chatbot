# apps/web — W3 슬라이스 설계

작성일: 2026-05-06
상태: 설계 확정 (구현 진입 전)
저자: dev-seawiid
관련 문서: [2026-05-01-vat-rag-chatbot-design.md](./2026-05-01-vat-rag-chatbot-design.md) (마스터 spec)

## 0. 슬라이스 개요

### 0.1 목적
W3 RAG 응답 plane의 사용자 진입점인 Next.js 앱을 스캐폴드한다. retrieve+generate end-to-end는 `pnpm core:ask`로 검증 완료(`packages/core/scripts/ask.ts`); 본 슬라이스는 그 결과를 브라우저로 끌어올려 **인용 검수 워크플로**(답변 본문 + 우측 사이드 패널)를 시각화하는 것이 핵심이다.

### 0.2 범위 (W3 apps/web)
- `apps/web` Next.js 15 App Router 스캐폴드, FSD(Feature-Sliced Design) 엄격 적용
- 홈 페이지(`/`) — 서비스 설명 + "채팅 시작" CTA
- 채팅 페이지(`/chat`) — RAG 답변 스트리밍, `[n]` 인용 chip, 우측 슬라이드 인용 패널
- `POST /api/chat` — `@vat/core::ask` 호출, AI SDK UIMessage stream으로 텍스트+인용 동시 송출
- 익명 영속화 — conversations/messages 단일 트랜잭션 INSERT
- 단일 롤링 대화 — 한 브라우저 = 한 conversation_id (localStorage)

### 0.3 비범위
- **인증** — 마스터 spec §0.4 비범위 그대로 (익명)
- **사이드바 히스토리 UI** — W4 (`/api/conversations`, `/api/conversations/[id]/messages`)
- **`tax_type` 필터 selector** — W4
- **conversations.title 자동 요약** — W4 (W3은 user query 앞 60자)
- **Langfuse trace 통합** — W3 별도 슬라이스 (messages.traceId는 nullable로 일단 비워둠)
- **모바일 최적화** — W3은 데스크톱 우선, 깨짐 방지만

### 0.4 핵심 결정 요약
| # | 결정 | 비고 |
|---|------|------|
| 1 | 영속화 ON (익명) | conversations/messages 저장, history는 W4 |
| 2 | AI SDK `useChat` + `createUIMessageStream` | citation은 `data-citations` 파트 사이드채널 |
| 3 | 단일 롤링 대화 | localStorage `vat:cid`, "새 대화" 버튼은 reset |
| 4 | 인용 chip → 우측 슬라이드 패널 | overlay-kit으로 imperatively open |
| 5 | FSD 엄격 (entities 포함) | 의존 방향 `app→widgets→features→entities→shared` |
| 6 | Tailwind + shadcn/ui + toss overlay-kit | shadcn은 `shared/ui/`에 copy-paste, modal/sheet은 overlay-kit |

## 1. 디렉토리 구조 (FSD)

```
apps/web/
├─ src/
│  ├─ app/                              # Next.js App Router (얇게)
│  │  ├─ layout.tsx                     # <SiteHeader /> + OverlayProvider + globals
│  │  ├─ page.tsx                       # 홈 → <ServiceIntro />
│  │  ├─ chat/
│  │  │  └─ page.tsx                    # 채팅 → <ChatWindow />
│  │  └─ api/
│  │     └─ chat/route.ts               # POST → @vat/core::ask → UIMessage stream
│  ├─ widgets/
│  │  ├─ site-header/                   # 로고 + nav (홈/채팅 시작)
│  │  ├─ service-intro/                 # 홈 본문 — 설명, 면책, 다루는 세목, CTA
│  │  ├─ chat-window/                   # 메시지 리스트 + 입력 + "새 대화" 합성
│  │  └─ citation-panel/                # 우측 슬라이드 (Sheet)로 띄우는 인용 본문
│  ├─ features/
│  │  ├─ send-message/                  # useChat 훅 + composer
│  │  ├─ open-citation/                 # chip onClick → overlay.open(<CitationPanel />)
│  │  └─ new-conversation/              # localStorage reset + 화면 클리어
│  ├─ entities/
│  │  ├─ message/
│  │  │  ├─ ui/MessageBubble.tsx        # role 분기 렌더 + [n] 정규식 → CitationChip
│  │  │  ├─ api/endpoints.ts            # CHAT_API = '/api/chat'
│  │  │  └─ types.ts
│  │  ├─ citation/
│  │  │  ├─ ui/CitationChip.tsx
│  │  │  └─ types.ts                    # @vat/core 의 Citation 재export
│  │  └─ conversation/
│  │     ├─ lib/storage.ts              # getOrCreateId(), reset()
│  │     ├─ api/                        # W3엔 비어있음
│  │     └─ types.ts
│  └─ shared/
│     ├─ ui/                            # shadcn 컴포넌트 (Button, Input, ScrollArea, Sheet…)
│     └─ lib/                           # cn(), uuid 등 도메인 무관
├─ next.config.ts
├─ tailwind.config.ts
├─ tsconfig.json                        # path alias: @/widgets/*, @/features/*, …
└─ package.json
```

**의존 방향 강제** — eslint `boundaries` 또는 `@feature-sliced/eslint-config`로 역방향·동일 레이어 cross-import 차단(구현 단계에서 도입).

## 2. 데이터 플로우

```
1) /chat 마운트
   conversation/lib.getOrCreateId()  → localStorage 'vat:cid' (없으면 uuid v4)
   useChat({ api: '/api/chat', body: { conversationId } })

2) 메시지 전송 (composer → useChat.sendMessage)
   POST /api/chat { messages, conversationId }
   ──────────────────────────────────────────────
   서버 route.ts:
     ① ask(query)               // @vat/core: retrieve + streamText + tools
     ② createUIMessageStream:
        - data-citations part   ← citations            (스트림 시작 직후 1회)
        - text parts            ← result.textStream    (델타)
     ③ result.finish 후         // 영속화 — 단일 트랜잭션
        upsert conversations(id=conversationId, title=query.slice(0,60))
        insert messages × 2  (user / assistant + citations + retrievedChunkIds
                              + model + latencyMs + tokens + traceId=null)
     ④ return createUIMessageStreamResponse({ stream })

3) 클라 렌더
   useChat.messages[].parts → 본문 text + Citation[] 수령
   MessageBubble: 본문의 [n] 정규식 → <CitationChip n={n} citation={...} />

4) chip 클릭
   open-citation: overlay.open(({ close }) =>
     <CitationPanel citations={...} selected={n} onClose={close} />)
   Sheet(우측 슬라이드)로 동일 메시지 인용 리스트 + 선택 [n] 강조

5) 새 대화
   new-conversation: conversation.lib.reset() + useChat.setMessages([])
```

## 3. API 인터페이스

### 3.1 `POST /api/chat`

```
Request  { messages: UIMessage[], conversationId: string }
         (useChat이 messages 자동 포함, body 옵션으로 conversationId 추가)

Response AI SDK UIMessage stream (text/event-stream)
  ├─ part: data-citations    Citation[]            (스트림 시작 직후 1회)
  ├─ part: text              델타 토큰              (n회)
  ├─ part: finish            usage, finishReason    (종료)
  └─ part: error             (실패 시) → 클라 useChat.onError → toast
```

route handler 의사코드 — DB 접근은 `@vat/core` gateway에만 위임(직접 `db.transaction`/`tx.insert` 호출 금지, 마스터 spec §1.2 "양 plane gateway" 패턴):
```ts
// src/app/api/chat/route.ts
import { ask, gateway } from '@vat/core';

export async function POST(req: Request) {
  const t0 = Date.now();
  const { messages, conversationId } = await req.json();
  const query = lastUserText(messages);

  const { textStream, citations, chunks, finish } = await ask(query);

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({ type: 'data-citations', data: citations });
      writer.merge(textStream);
      const meta = await finish;
      await gateway.messages.savePair({
        conversationId, query,
        text: meta.text, citations,
        retrievedChunkIds: chunks.map(c => c.chunk_id),
        model: 'gemini-2.5-flash',
        latencyMs: Date.now() - t0,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        traceId: null,
      });
    },
  });
  return createUIMessageStreamResponse({ stream });
}
```

> **Note**: AI SDK v6 정확한 메서드명(`createUIMessageStream` / `createUIMessageStreamResponse` / `writer.merge` 등)은 구현 단계에서 SDK 문서·타입으로 재확인. 본 spec은 프로토콜 의도만 기술.

## 4. 영속화

DB 접근은 **`packages/core/src/db/gateway.ts`에만 추가**한다 — `apps/web` route handler는 gateway만 호출(마스터 spec §1.2 패턴 준수). 현재 gateway는 `gateway.chunks.search`만 갖고 있고, 이 슬라이스에서 **`gateway.messages` 도메인 신설**.

스트림 종료 후 **단일 트랜잭션**에서 user/assistant 두 메시지를 함께 기록 → invariant 유지(둘 다 남거나 둘 다 없거나).

```ts
// packages/core/src/db/gateway.ts (추가분)
export type SavePairArgs = {
  conversationId: string;
  query: string;
  text: string;
  citations: Citation[];
  retrievedChunkIds: string[];
  model: string;
  latencyMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  traceId: string | null;
};

export const gateway = {
  chunks: { /* ...기존 search */ },
  messages: {
    async savePair(args: SavePairArgs): Promise<void> {
      const db = getDb();
      await db.transaction(async (tx) => {
        await tx.insert(conversations).values({
          id: args.conversationId,
          title: args.query.slice(0, 60),
        }).onConflictDoNothing();   // 첫 turn에만 생성

        await tx.insert(messages).values([
          { conversationId: args.conversationId, role: 'user',
            content: args.query, citations: [], retrievedChunkIds: null },
          { conversationId: args.conversationId, role: 'assistant',
            content: args.text, citations: args.citations,
            retrievedChunkIds: args.retrievedChunkIds,
            model: args.model, latencyMs: args.latencyMs,
            inputTokens: args.inputTokens, outputTokens: args.outputTokens,
            traceId: args.traceId },
        ]);
      });
    },
  },
};
```

- **invariant**: route handler는 `db`/`tx`/스키마 테이블 객체를 import하지 않는다. eslint `no-restricted-imports`로 `apps/web` 내 `drizzle-orm` 직접 import 차단(구현 단계에서 도입).
- **failure 정책**: persist 실패는 서버 로그만 남기고 사용자에겐 영향 없음 (답변은 이미 보여진 상태). W3은 retry/queue 없음.
- **deferred**: traceId(Langfuse 슬라이스), title 자동 요약(W4), conversations.userId 컬럼 드랍(인증 없는 익명 운영 — 마스터 spec §2 정합 정리 W4 진입 시).

## 5. UX 디테일

### 5.1 `useChat.status` 기준 분기
| status | 동작 |
|---|---|
| `submitted` / `streaming` | composer disable, send 버튼 → stop 버튼(useChat.stop), assistant 버블 caret skeleton |
| `error` | sonner toast `"잠시 후 다시 시도해주세요"` + 입력값 유지 + retry 버튼(useChat.regenerate) |
| `ready` | 평상 |

### 5.2 거절 UX
- 시스템 프롬프트(`packages/core/src/rag/prompt.ts`)가 `"공식 자료에서 확인되지 않습니다"`로 응답 강제.
- `data-citations.length === 0`이면 메시지 하단에 작은 배지 `근거 미확인` 표시 + 본문 [n] 정규식 매치 0 → CitationChip 안 그림.

### 5.3 빈 상태 (chat 첫 진입)
example prompt 3개 클릭 시 composer 채움:
- "간이과세자 부가세 신고는 어떻게 해야 하나요?"
- "매입세액 공제 요건이 뭐예요?"
- "전자세금계산서 발급 의무 대상은?"

### 5.4 모바일
W3 범위에선 데스크톱 우선, 깨짐만 방지. CitationPanel은 모바일에서 bottom sheet (`shadcn Sheet side="bottom"`) — frontend-design 단계에서 다듬음.

## 6. 테스트 전략 (W3 범위)

| 종류 | 도구 | 대상 |
|---|---|---|
| 단위 | vitest | `lastUserText`, `conversation/lib.storage`, `[n]` 파서, `savePair` (실제 테스트 DB, 모킹 X — 마스터 spec §5.1) |
| 컴포넌트 | vitest + @testing-library/react | MessageBubble / CitationChip / CitationPanel |
| 통합 | vitest | `/api/chat` POST → ask mock → stream parts 순서 검증 |
| E2E | Playwright | 1개 happy path: 채팅 진입 → 메시지 전송 → 답변 → chip 클릭 → 패널 |

골든셋 평가는 별도 슬라이스(W3 eval).

## 7. 구현 순서 (참고)

writing-plans 스킬을 생략한 만큼 거친 가이드만 남긴다 — 실제 진입 시 구현자가 자유롭게 조정.

1. Next.js 15 + Tailwind + shadcn init, FSD 디렉토리 골조
2. `entities/conversation/lib.storage` + `entities/message`/`citation` 타입·UI
3. `app/api/chat/route.ts` (스트림 + 영속화)
4. `features/send-message` (useChat) + `widgets/chat-window`
5. `features/open-citation` + `widgets/citation-panel` (overlay-kit)
6. `widgets/service-intro` + `widgets/site-header`, 라우팅 와이어업
7. 테스트 + Playwright 1 path

## 8. 마스터 spec 정합

본 슬라이스 완료 시 마스터 spec(`2026-05-01-vat-rag-chatbot-design.md`)에 반영할 변경:
- §6 W3 row의 apps/web 항목 ✅
- §2 conversations.userId, users 테이블 드랍(스키마 정리 — 본 슬라이스 영속화 와이어업 시 함께)
