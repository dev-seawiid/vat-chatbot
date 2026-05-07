"use client";

import { cn } from "@/shared/lib/utils";

type CitationChipProps = {
  n: number;
  active?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
};

/**
 * 인용 마커 [n] — 본문 baseline에 살짝 끼워지는 옐로우 정사각.
 * - 항상 미세 옐로우 글로우 + 1px 옐로우 ring shadow.
 * - hover/focus: scale 1.08 + 더 강한 글로우 + bg-yellow-soft.
 * - active(부모 강제): 활성 강조 유지 (선택된 인용 하이라이트).
 */
export function CitationChip({
  n,
  active = false,
  onClick,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
}: CitationChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      data-active={active}
      aria-label={`인용 ${n} 보기`}
      className={cn(
        "relative mx-[3px] inline-flex h-[18px] w-[18px] -translate-y-[1px] items-center justify-center align-baseline",
        // hit area 확장 — WCAG 2.5.8 24×24px 최소 타겟. 시각 18px 유지하면서
        // pseudo-element로 28×28px 클릭 가능 영역 확보.
        "after:absolute after:inset-[-5px] after:content-['']",
        "font-mono text-[10px] font-semibold leading-none",
        "transition-all duration-200 ease-out",
        "focus-visible:outline-none",
        "bg-yellow text-bg",
        active
          ? "scale-[1.08] bg-yellow-soft shadow-[0_0_0_1px_rgb(255_230_0/0.7),0_0_18px_-2px_rgb(255_230_0/0.7)]"
          : cn(
              "shadow-[0_0_0_1px_rgb(255_230_0/0.4),0_0_12px_-2px_rgb(255_230_0/0.4)]",
              "hover:scale-[1.08] hover:bg-yellow-soft hover:shadow-[0_0_0_1px_rgb(255_230_0/0.7),0_0_18px_-2px_rgb(255_230_0/0.7)]",
              "focus-visible:scale-[1.08] focus-visible:bg-yellow-soft focus-visible:shadow-[0_0_0_1px_rgb(255_230_0/0.7),0_0_18px_-2px_rgb(255_230_0/0.7)]",
            ),
      )}
    >
      {n}
    </button>
  );
}
