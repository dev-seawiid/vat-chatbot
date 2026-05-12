"use client";

import {
  type ChatUIMessage,
  getCitations,
  getText,
  getTraceId,
  MessageBubble,
} from "@/entities/message";
import { openCitationPanel } from "@/features/open-citation";
import { FeedbackBar } from "@/features/submit-feedback";

export type ChatMessage = ChatUIMessage & { role: "user" | "assistant" };

type MessageItemProps = {
  message: ChatMessage;
  isStreaming: boolean;
};

export function MessageItem({ message, isStreaming }: MessageItemProps) {
  const text = getText(message);
  const citations = getCitations(message);
  const isAssistant = message.role === "assistant";
  const bubbleStreaming = isStreaming && isAssistant;
  const traceId = isAssistant ? getTraceId(message) : null;
  const showFeedback = isAssistant && !bubbleStreaming && traceId !== null;

  return (
    <div>
      <MessageBubble
        role={message.role}
        text={text}
        citations={citations}
        isStreaming={bubbleStreaming}
        onCiteClick={(n) => openCitationPanel({ citations, selected: n })}
      />
      {showFeedback && (
        <div className="pl-5">
          <FeedbackBar traceId={traceId} />
        </div>
      )}
    </div>
  );
}
