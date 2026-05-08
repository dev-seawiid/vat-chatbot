"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { conversationStorage } from "@/entities/conversation";
import {
  CHAT_API,
  type ChatUIMessage,
  getCitations,
  getText,
  getTraceId,
  MessageBubble,
} from "@/entities/message";
import { NewConversationButton } from "@/features/new-conversation";
import { openCitationPanel } from "@/features/open-citation";
import { Composer, ExamplePromptList } from "@/features/send-message";
import { FeedbackBar } from "@/features/submit-feedback";
import { AuroraText } from "@/shared/ui/aurora-text";
import { TextAnimate } from "@/shared/ui/text-animate";

const EXAMPLE_PROMPTS = [
  "간이과세자 부가세 신고는 어떻게 해야 하나요?",
  "매입세액 공제 요건이 뭐예요?",
  "전자세금계산서 발급 의무 대상은?",
  "영세율과 면세는 어떻게 다른가요?",
] as const;

const ERROR_MESSAGE = "잠시 후 다시 시도해주세요";
const STREAMING_STATES = new Set(["submitted", "streaming"]);

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
        toast.error(ERROR_MESSAGE);
        console.error(err);
      },
    });

  // 새 메시지 도착 또는 스트리밍 중일 때 하단 자동 스크롤.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  function submit(text: string): void {
    sendMessage({ text });
  }

  function reset(): void {
    conversationStorage.reset();
    setMessages([]);
    setDraft("");
  }

  const isEmpty = messages.length === 0;
  const isStreaming = STREAMING_STATES.has(status);
  const lastMessageId = messages[messages.length - 1]?.id;

  const sessionLabel = isStreaming
    ? "응답 중…"
    : isEmpty
      ? "준비 완료"
      : "대화 진행";

  return (
    <main className="mx-auto flex h-[calc(100vh-4rem)] w-full max-w-[860px] flex-col px-6">
      <header
        className="stagger-enter flex items-center justify-between border-b border-white/10 py-5"
        style={{ animationDelay: "60ms" }}
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="block h-[8px] w-[8px] animate-pulse-yellow bg-yellow"
          />
          <span
            className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-soft"
            aria-live="polite"
            aria-atomic="true"
          >
            SESSION · <span className="text-fg">{sessionLabel}</span>
          </span>
        </div>
        <NewConversationButton onReset={reset} />
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
            {messages
              .filter(
                (m): m is ChatUIMessage & { role: "user" | "assistant" } =>
                  m.role === "user" || m.role === "assistant",
              )
              .map((m) => {
                const text = getText(m);
                const citations = getCitations(m);
                const isLast = m.id === lastMessageId;
                const messageStreaming =
                  isStreaming && isLast && m.role === "assistant";
                const traceId =
                  m.role === "assistant" ? getTraceId(m) : null;
                const showFeedback =
                  m.role === "assistant" && !messageStreaming && !!traceId;
                return (
                  <div key={m.id}>
                    <MessageBubble
                      role={m.role}
                      text={text}
                      citations={citations}
                      isStreaming={messageStreaming}
                      onCiteClick={(n) =>
                        openCitationPanel({ citations, selected: n })
                      }
                    />
                    {showFeedback && (
                      <div className="pl-5">
                        <FeedbackBar traceId={traceId} />
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <div
        className="stagger-enter pb-6"
        style={{ animationDelay: "180ms" }}
      >
        <Composer
          status={status}
          onSubmit={submit}
          onStop={stop}
          draft={draft}
          onDraftChange={setDraft}
        />
      </div>
    </main>
  );
}

type EmptyStateProps = {
  onSelectPrompt: (text: string) => void;
};

function EmptyState({ onSelectPrompt }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-start gap-10 pt-10">
      <div
        className="stagger-enter w-full"
        style={{ animationDelay: "120ms" }}
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-fg-soft">
          QUICK START
        </span>
        <h2 className="mt-3 max-w-[20ch] text-[clamp(26px,3.5vw,40px)] font-medium leading-[1.1] tracking-[-0.02em] text-fg">
          무엇이{" "}
          <AuroraText colors={["#ffe600", "#fff7b0", "#ffe600"]} speed={0.9}>
            궁금
          </AuroraText>
          하신가요
          <span className="text-yellow">?</span>
        </h2>
        <TextAnimate
          as="p"
          animation="blurInUp"
          by="word"
          delay={0.25}
          className="mt-3 max-w-[44ch] text-[13.5px] leading-[1.6] text-fg-soft"
        >
          국세청 공식 자료를 검색해 답변과 함께 인용 [n]을 표시합니다. 아래 예시를 누르거나 직접 질문을 입력해 보세요.
        </TextAnimate>
      </div>

      <ExamplePromptList prompts={EXAMPLE_PROMPTS} onSelect={onSelectPrompt} />
    </div>
  );
}
