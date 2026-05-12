"use client";

import type { Citation } from "@vat/core";
import { overlay } from "overlay-kit";

import { CitationPanel } from "../ui/CitationPanel";

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
