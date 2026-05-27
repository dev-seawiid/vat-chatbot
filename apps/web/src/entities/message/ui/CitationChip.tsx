"use client";

import { cn } from "@/shared/lib/utils";

type CitationChipProps = {
  label: string;
  onClick?: () => void;
};

export function CitationChip({ label, onClick }: CitationChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`인용 ${label} 보기`}
      className={cn(
        "relative mx-[3px] inline-flex h-[18px] -translate-y-[1px] items-center justify-center px-[5px] align-baseline",
        "after:absolute after:inset-[-5px] after:content-['']",
        "font-mono text-[10px] font-semibold leading-none tracking-[0.02em]",
        "transition-all duration-200 ease-out",
        "focus-visible:outline-none",
        "bg-yellow text-bg",
        "shadow-[0_0_0_1px_rgb(255_230_0/0.4),0_0_12px_-2px_rgb(255_230_0/0.4)]",
        "hover:scale-[1.06] hover:bg-yellow-soft hover:shadow-[0_0_0_1px_rgb(255_230_0/0.7),0_0_18px_-2px_rgb(255_230_0/0.7)]",
        "focus-visible:scale-[1.06] focus-visible:bg-yellow-soft focus-visible:shadow-[0_0_0_1px_rgb(255_230_0/0.7),0_0_18px_-2px_rgb(255_230_0/0.7)]",
      )}
    >
      {label}
    </button>
  );
}
