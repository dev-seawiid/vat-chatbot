"use client";

import { cn } from "@/shared/lib/utils";

type HighlightedQuoteProps = {
  /** quote가 속한 chunk 본문 — 좌표(quoteStart/quoteEnd)의 기준이 되는 원본 텍스트 */
  content: string;
  quoteStart: number;
  quoteEnd: number;
  className?: string;
};

/**
 * chunk 본문을 그대로 보여주되 quote 구간만 `<mark>`로 강조하는 표시 전용 컴포넌트.
 * 좌표(quoteStart, quoteEnd)는 core의 cite_chunk verify가 보장한 invariant 그대로 사용 —
 * `content.slice(quoteStart, quoteEnd) === quote`. UI는 좌표를 신뢰하고 단순 3-slice만 수행.
 *
 * 명명: 본질은 "quote를 강조"하는 것이고 "어떤 텍스트 안에서"는 content prop이 알려준다.
 * Anthropic Citations API의 (cited_text, start_char_index, end_char_index)와 동일한 형태로
 * 박제된 좌표를 표시에 활용 — 좌표 계산·검증 책임은 core가 소유, 본 컴포넌트는 렌더만.
 */
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
