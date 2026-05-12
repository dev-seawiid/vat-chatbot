"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { conversationStorage } from "@/entities/conversation";
import { CHAT_API, type ChatUIMessage } from "@/entities/message";
import { NewConversationButton } from "@/features/new-conversation";
import { MessageComposer } from "@/features/send-message";
import { RATE_LIMIT_ERROR_BODY } from "@/shared/lib/security";

import { EmptyState } from "./EmptyState";
import { type ChatMessage, MessageItem } from "./MessageItem";
import { SessionIndicator } from "./SessionIndicator";

const ERROR_MESSAGES = {
  rateLimit: "오늘의 요청 한도를 모두 사용했어요. 내일 다시 시도해 주세요",
  generic: "잠시 후 다시 시도해주세요",
} as const;
const STREAMING_STATES = new Set(["submitted", "streaming"]);

const STAGGER_DELAY = {
  header: "60ms",
  composer: "180ms",
} as const;

// AI SDK는 응답이 !ok일 때 응답 본문을 Error.message로 박아 throw한다. 본문에 서버
// 토큰이 들어있으면 한도 초과로 분기.
function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(RATE_LIMIT_ERROR_BODY);
}

function getSessionLabel({
  isStreaming,
  isEmpty,
}: {
  isStreaming: boolean;
  isEmpty: boolean;
}): string {
  if (isStreaming) return "응답 중…";
  if (isEmpty) return "준비 완료";
  return "대화 진행";
}

export function ChatWindow() {
  const [draft, setDraft] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // conversationId는 React state로 들고 있지 않는다 — localStorage가 단일 진실.
  // 매 요청 시 body()가 호출되며 그 시점의 localStorage를 읽으므로 reset 후 첫
  // 요청부터 새 ID가 자연스럽게 반영된다.
  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatUIMessage>({
        api: CHAT_API,
        body: () => ({ conversationId: conversationStorage.getOrCreateId() }),
      }),
    [],
  );

  const { messages, sendMessage, status, stop, setMessages } =
    useChat<ChatUIMessage>({
      transport,
      onError: (err) => {
        const message = isRateLimitError(err)
          ? ERROR_MESSAGES.rateLimit
          : ERROR_MESSAGES.generic;
        toast.error(message);
        console.error(err);
      },
    });

  // 새 메시지 도착 또는 스트리밍 중일 때 하단 자동 스크롤.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  function submitMessage(text: string): void {
    sendMessage({ text });
  }

  function resetConversation(): void {
    conversationStorage.reset();
    setMessages([]);
    setDraft("");
  }

  const isEmpty = messages.length === 0;
  const isStreaming = STREAMING_STATES.has(status);
  const lastMessageId = messages[messages.length - 1]?.id;
  const sessionLabel = getSessionLabel({ isStreaming, isEmpty });

  const visibleMessages = messages.filter(
    (m): m is ChatMessage => m.role === "user" || m.role === "assistant",
  );

  return (
    <main className="mx-auto flex h-[calc(100vh-4rem)] w-full max-w-[860px] flex-col px-6">
      <header
        className="stagger-enter flex items-center justify-between border-b border-white/10 py-5"
        style={{ animationDelay: STAGGER_DELAY.header }}
      >
        <SessionIndicator label={sessionLabel} />
        <NewConversationButton onReset={resetConversation} />
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto py-8 [scrollbar-width:thin]"
        role="log"
        aria-live="polite"
        aria-atomic="false"
        aria-relevant="additions text"
        aria-label="대화 내용"
        tabIndex={0}
      >
        {isEmpty ? (
          <EmptyState onSelectPrompt={setDraft} />
        ) : (
          <div className="space-y-7">
            {visibleMessages.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                isStreaming={isStreaming && m.id === lastMessageId}
              />
            ))}
          </div>
        )}
      </div>

      <div
        className="stagger-enter pb-6"
        style={{ animationDelay: STAGGER_DELAY.composer }}
      >
        <MessageComposer
          status={status}
          onSubmit={submitMessage}
          onStop={stop}
          draft={draft}
          onDraftChange={setDraft}
        />
      </div>
    </main>
  );
}
