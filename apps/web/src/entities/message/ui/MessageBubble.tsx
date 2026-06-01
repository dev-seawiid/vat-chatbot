"use client";

import type { Citation } from "../types";
import { joinCitationLabels } from "../lib/citation-label";

import { cn } from "@/shared/lib/utils";

import { CitationChip } from "./CitationChip";

type MessageBubbleProps = {
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  isStreaming?: boolean;
  // ADR-0003 §8 — text 도착 전 스트리밍 중 표시할 진행 단계 문구.
  statusLabel?: string | null;
  onCiteClick?: () => void;
};

export function MessageBubble({
  role,
  text,
  citations,
  isStreaming = false,
  statusLabel = null,
  onCiteClick,
}: MessageBubbleProps) {
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const showRefusalBadge =
    isAssistant && citations.length === 0 && text.trim().length > 0;
  const visibleCitations = isAssistant ? citations : [];
  // 본문 없으면 진행 단계 문구로 대체 — retrieval 동안 빈 화면 방지.
  const showStatus =
    isAssistant && isStreaming && text.length === 0 && statusLabel !== null;

  return (
    <article
      aria-label={isUser ? "사용자 메시지" : "AI 답변"}
      className={cn(
        "group relative blur-in py-1 pl-5",
        isUser ? "border-l-2 border-yellow" : "border-l-2 border-white/10",
      )}
    >
      <header className="mb-2 flex items-baseline justify-between gap-3">
        <span
          className={cn(
            "font-mono text-[10px] font-medium uppercase tracking-[0.22em]",
            isUser ? "text-fg-soft" : "text-fg-soft",
          )}
        >
          {isUser ? "당신 · YOU" : "AI · ASSISTANT"}
        </span>

        {showRefusalBadge && (
          <span
            className={cn(
              "border-l-2 border-vermilion bg-vermilion/[0.06] pl-2 pr-2 py-[2px]",
              "font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-vermilion",
            )}
          >
            근거 미확인 · NO SOURCE
          </span>
        )}
      </header>

      <div
        className={cn(
          "whitespace-pre-wrap font-sans text-[14.5px] leading-[1.7]",
          showStatus ? "text-fg-soft" : "text-fg",
          isStreaming && !isUser && "text-shimmer",
        )}
      >
        {showStatus ? statusLabel : text}
        {isStreaming && !isUser && (
          <span
            aria-hidden
            className="ml-[2px] inline-block h-[1em] w-[8px] -translate-y-[1px] animate-caret-blink bg-yellow align-middle"
          />
        )}
      </div>

      {visibleCitations.length > 0 && (
        <footer
          aria-label="인용 근거"
          className="mt-4 flex flex-wrap items-center gap-2"
        >
          <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-fg-muted">
            참고 · REFS
          </span>
          <CitationChip
            label={joinCitationLabels(visibleCitations)}
            onClick={() => onCiteClick?.()}
          />
        </footer>
      )}
    </article>
  );
}
