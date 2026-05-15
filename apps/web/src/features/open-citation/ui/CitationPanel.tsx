"use client";

import type { Citation } from "@/entities/message";

import {
  ResponsiveSheet,
  ResponsiveSheetContent,
  ResponsiveSheetDescription,
  ResponsiveSheetHeader,
  ResponsiveSheetTitle,
} from "@/shared/ui/responsive-sheet";

import { CitationCard } from "./CitationCard";

type CitationPanelProps = {
  open: boolean;
  onClose: () => void;
  citations: Citation[];
  selected: number;
};

/**
 * 인용 근거 패널 — 데스크톱은 우측 Sheet, 모바일은 하단 Drawer (다크 글래스).
 * 본 컴포넌트는 패널 뼈대(open/close · empty state · 카드 리스트)만 소유.
 * 카드 1장의 표현은 CitationCard, 인용 구간 highlight는 HighlightedContent가 분담.
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
            답변 아래 참고 칩을 클릭한 출처가 강조됩니다.
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
            citations.map((citation, idx) => {
              const index = idx + 1;
              return (
                <CitationCard
                  key={citation.chunkId}
                  citation={citation}
                  index={index}
                  isSelected={index === selected}
                />
              );
            })
          )}
        </ol>
      </ResponsiveSheetContent>
    </ResponsiveSheet>
  );
}
