"use client";

import type { Citation } from "@/entities/message";
import { overlay } from "overlay-kit";

import { CitationPanel } from "../ui/CitationPanel";

type OpenCitationPanelArgs = {
  citations: Citation[];
};

export function openCitationPanel({ citations }: OpenCitationPanelArgs): void {
  overlay.open(({ isOpen, close }) => (
    <CitationPanel open={isOpen} citations={citations} onClose={close} />
  ));
}
