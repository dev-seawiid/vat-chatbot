"use client";

import { cn } from "@/shared/lib/utils";

type HighlightedQuoteProps = {
  content: string;
  quoteStart: number;
  quoteEnd: number;
  className?: string;
};

// 좌표는 core의 cite_chunk verify가 보장한 invariant 그대로 신뢰 → 단순 3-slice 렌더.
export function HighlightedQuote({
  content,
  quoteStart,
  quoteEnd,
  className,
}: HighlightedQuoteProps) {
  return (
    <p
      className={cn(
        "whitespace-pre-wrap text-[14px] leading-[1.65] text-fg/80",
        className,
      )}
    >
      {content.slice(0, quoteStart)}
      <mark className="bg-yellow/25 text-fg shadow-[inset_0_-1px_0_0_rgb(255_230_0/0.6)]">
        {content.slice(quoteStart, quoteEnd)}
      </mark>
      {content.slice(quoteEnd)}
    </p>
  );
}
