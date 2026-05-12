"use client";

import type { Citation } from "@vat/core";

import { cn } from "@/shared/lib/utils";
import {
  ResponsiveSheet,
  ResponsiveSheetContent,
  ResponsiveSheetDescription,
  ResponsiveSheetHeader,
  ResponsiveSheetTitle,
} from "@/shared/ui/responsive-sheet";

type CitationPanelProps = {
  open: boolean;
  onClose: () => void;
  citations: Citation[];
  selected: number;
};

/**
 * 인용 근거 패널 — 데스크톱은 우측 Sheet, 모바일은 하단 Drawer (다크 글래스).
 * 카드: dark surface · serif docTitle · mono 메타 · snippet.
 * 선택된 인용: 좌측 3px 옐로우 룰 + 옐로우 글로우 + lift.
 */
export function CitationPanel({
  open,
  onClose,
  citations,
  selected,
}: CitationPanelProps) {
  const isEmpty = citations.length === 0;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ResponsiveSheetContent>
        <ResponsiveSheetHeader>
          <ResponsiveSheetTitle>References · 인용 근거</ResponsiveSheetTitle>
          <ResponsiveSheetDescription>
            답변 본문 [n]을 클릭한 출처가 강조됩니다.
          </ResponsiveSheetDescription>
        </ResponsiveSheetHeader>

        <ol className="flex-1 space-y-4 overflow-y-auto px-7 py-6">
          {isEmpty ? (
            <li className="border border-dashed border-white/15 px-5 py-12 text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-muted">
                근거 미확인 · NO SOURCE
              </p>
            </li>
          ) : (
            citations.map((c, idx) => {
              const n = idx + 1;
              const isSelected = n === selected;
              const meta = [
                c.docVersion,
                c.page != null ? `p.${c.page}` : null,
                c.sectionPath,
              ]
                .filter(Boolean)
                .join(" · ");

              return (
                <li
                  key={c.chunkId}
                  className={cn(
                    "stagger-enter relative border bg-surface-1 p-5",
                    "transition-[border-color,transform,box-shadow] duration-300",
                    isSelected
                      ? "-translate-y-[2px] border-yellow/40 shadow-[0_0_24px_-8px_rgb(255_230_0/0.3)]"
                      : "border-white/10 hover:border-white/20",
                  )}
                  style={{ animationDelay: `${80 + idx * 70}ms` }}
                >
                  {isSelected && (
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 w-[3px] bg-yellow"
                    />
                  )}

                  <header className="flex items-start gap-4">
                    <span
                      aria-label={`인용 ${n}`}
                      className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center",
                        "font-mono text-[12px] font-semibold leading-none",
                        "transition-colors duration-200",
                        isSelected
                          ? "bg-yellow text-bg shadow-[0_0_0_1px_rgb(255_230_0/0.6)]"
                          : "bg-surface-3 text-yellow",
                      )}
                    >
                      {n}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-display text-[17px] leading-[1.3] tracking-[-0.005em] text-fg">
                        {c.docTitle}
                      </h3>
                      {meta && (
                        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
                          {meta}
                        </p>
                      )}
                    </div>
                  </header>

                  <p className="mt-4 whitespace-pre-wrap border-t border-white/10 pt-4 text-[14px] leading-[1.65] text-fg/80">
                    {c.snippet}
                  </p>

                  {c.sourceUrl && (
                    <a
                      href={c.sourceUrl}
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
            })
          )}
        </ol>
      </ResponsiveSheetContent>
    </ResponsiveSheet>
  );
}
