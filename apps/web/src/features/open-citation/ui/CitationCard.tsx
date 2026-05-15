"use client";

import type { Citation } from "@/entities/message";

import { cn } from "@/shared/lib/utils";

import { HighlightedQuote } from "./HighlightedQuote";

type CitationCardProps = {
  citation: Citation;
  /** 1-based 인덱스 — CitationPanel의 selected와 비교해 강조 여부 결정 */
  index: number;
  isSelected: boolean;
};

/**
 * 인용 근거 한 건을 표시하는 카드. 좌측 룰(선택 시 옐로우) + 번호 배지 + docTitle/meta header,
 * chunk 본문 + quote 구간 highlight body, 원본 PDF 다운로드 링크.
 * 표현 전용 — 상호작용(선택 전환·열기·닫기)은 상위(CitationPanel)가 prop으로 결정.
 */
export function CitationCard({ citation, index, isSelected }: CitationCardProps) {
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
        "stagger-enter relative border bg-surface-1 p-5",
        "transition-[border-color,transform,box-shadow] duration-300",
        isSelected
          ? "-translate-y-[2px] border-yellow/40 shadow-[0_0_24px_-8px_rgb(255_230_0/0.3)]"
          : "border-white/10 hover:border-white/20",
      )}
      style={{ animationDelay: `${80 + (index - 1) * 70}ms` }}
    >
      {isSelected && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px] bg-yellow"
        />
      )}

      <header className="flex items-start gap-4">
        <span
          aria-label={`인용 ${index}`}
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center",
            "font-mono text-[12px] font-semibold leading-none",
            "transition-colors duration-200",
            isSelected
              ? "bg-yellow text-bg shadow-[0_0_0_1px_rgb(255_230_0/0.6)]"
              : "bg-surface-3 text-yellow",
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
