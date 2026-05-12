"use client";

import type { Citation } from "../types";

import { cn } from "@/shared/lib/utils";

import { CitationChip } from "./CitationChip";

const CITE_REGEX = /\[(\d+)\]/g;

type Token =
  | { kind: "text"; value: string }
  | { kind: "cite"; value: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CITE_REGEX)) {
    const idx = match.index ?? 0;
    if (idx > cursor) {
      tokens.push({ kind: "text", value: text.slice(cursor, idx) });
    }
    tokens.push({ kind: "cite", value: Number(match[1]) });
    cursor = idx + match[0].length;
  }
  if (cursor < text.length) {
    tokens.push({ kind: "text", value: text.slice(cursor) });
  }
  return tokens;
}

type MessageBubbleProps = {
  role: "user" | "assistant";
  text: string;
  citations: Citation[];
  isStreaming?: boolean;
  onCiteClick?: (n: number) => void;
};

/**
 * 다크 에디토리얼 메시지 — 버블 없음, 좌측 룰 + 흐르는 본문.
 * - 사용자: 좌측 옐로우 2px 룰 + mono "당신" 라벨.
 * - 어시스턴트: 좌측 white/10 2px 룰 + mono "ASSISTANT" 라벨.
 *   스트리밍 중엔 본문 텍스트만 text-shimmer (옐로우 sweep) + 끝에 옐로우 caret.
 * - 인용 [n] 토큰은 CitationChip으로 분해. 근거 0개일 땐 우측 미확인 배지.
 */
export function MessageBubble({
  role,
  text,
  citations,
  isStreaming = false,
  onCiteClick,
}: MessageBubbleProps) {
  const isUser = role === "user";
  const showRefusalBadge =
    role === "assistant" && citations.length === 0 && text.trim().length > 0;
  const tokens = tokenize(text);

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
          "whitespace-pre-wrap font-sans text-[14.5px] leading-[1.7] text-fg",
          isStreaming && !isUser && "text-shimmer",
        )}
      >
        {tokens.map((token, i) =>
          token.kind === "text" ? (
            <span key={i}>{token.value}</span>
          ) : (
            <CitationChip
              key={i}
              n={token.value}
              onClick={() => onCiteClick?.(token.value)}
            />
          ),
        )}
        {isStreaming && !isUser && (
          <span
            aria-hidden
            className="ml-[2px] inline-block h-[1em] w-[8px] -translate-y-[1px] animate-caret-blink bg-yellow align-middle"
          />
        )}
      </div>
    </article>
  );
}
