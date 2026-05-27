"use client";

import type { Citation } from "@/entities/message";

import { cn } from "@/shared/lib/utils";

import { HighlightedQuote } from "./HighlightedQuote";

type CitationCardProps = {
  citation: Citation;
  /** 1-based 표시 인덱스 */
  index: number;
};

export function CitationCard({ citation, index }: CitationCardProps) {
  const meta = [
    citation.docVersion,
    citation.page != null ? `p.${citation.page}` : null,
    citation.sectionPath,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      className={cn(
        "stagger-enter relative border border-white/10 bg-surface-1 p-5",
        "transition-[border-color] duration-200 hover:border-white/20",
      )}
      style={{ animationDelay: `${80 + (index - 1) * 70}ms` }}
    >
      <header className="flex items-start gap-4">
        <span
          aria-label={`인용 ${index}`}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center",
            "bg-surface-3 font-mono text-[12px] font-semibold leading-none text-yellow",
          )}
        >
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-[17px] leading-[1.3] tracking-[-0.005em] text-fg">
            {citation.docTitle}
          </h3>
          {meta && (
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
              {meta}
            </p>
          )}
        </div>
      </header>

      <HighlightedQuote
        content={citation.content}
        quoteStart={citation.quoteStart}
        quoteEnd={citation.quoteEnd}
        className="mt-4 border-t border-white/10 pt-4"
      />

      {citation.sourceUrl && (
        <a
          href={citation.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "mt-4 inline-flex items-center gap-1.5",
            "font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted",
            "transition-colors duration-150 hover:text-yellow focus-visible:text-yellow focus-visible:outline-none",
          )}
          aria-label="원본 PDF 다운로드 (새 창)"
        >
          원본 PDF 다운로드
          <span aria-hidden>↗</span>
        </a>
      )}
    </li>
  );
}
