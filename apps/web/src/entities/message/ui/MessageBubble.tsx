"use client";

import type { Citation } from "../types";

import { cn } from "@/shared/lib/utils";

import { CitationChip } from "./CitationChip";

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
 *
 * 인용 표시 — cite_chunk tool 기반 응답으로 전환되며 본문에는 [n] 마커가 박히지 않는다.
 * 따라서 인라인 토큰 분해 대신 본문 아래에 1-based 번호 칩 리스트로 보여준다. 칩 클릭은
 * onCiteClick(n)으로 CitationPanel을 동일 인덱스에 highlight한 채 연다.
 */
export function MessageBubble({
  role,
  text,
  citations,
  isStreaming = false,
  onCiteClick,
}: MessageBubbleProps) {
  const isUser = role === "user";
  const isAssistant = role === "assistant";
  const showRefusalBadge =
    isAssistant && citations.length === 0 && text.trim().length > 0;
  // accessor(getCitations)가 이미 chunkId dedup을 적용한 list를 넘긴다.
  const visibleCitations = isAssistant ? citations : [];

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
        {text}
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
          {visibleCitations.map((c, idx) => {
            const n = idx + 1;
            return (
              <CitationChip
                key={c.chunkId}
                n={n}
                onClick={() => onCiteClick?.(n)}
              />
            );
          })}
        </footer>
      )}
    </article>
  );
}
