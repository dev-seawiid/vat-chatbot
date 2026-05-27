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
};

export function CitationPanel({ open, onClose, citations }: CitationPanelProps) {
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
            답변에 사용된 출처 목록입니다.
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
            citations.map((citation, idx) => (
              <CitationCard
                key={citation.chunkId}
                citation={citation}
                index={idx + 1}
              />
            ))
          )}
        </ol>
      </ResponsiveSheetContent>
    </ResponsiveSheet>
  );
}
