"use client";

import { overlay } from "overlay-kit";

import type { Citation } from "@/entities/citation/types";
import { CitationPanel } from "@/widgets/citation-panel";

type OpenCitationPanelArgs = {
  citations: Citation[];
  selected: number;
};

export function openCitationPanel({
  citations,
  selected,
}: OpenCitationPanelArgs): void {
  overlay.open(({ isOpen, close }) => (
    <CitationPanel
      open={isOpen}
      citations={citations}
      selected={selected}
      onClose={close}
    />
  ));
}
