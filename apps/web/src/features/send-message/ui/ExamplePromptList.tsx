"use client";

import { MagicCard } from "@/shared/ui/magic-card";

type ExamplePromptListProps = {
  prompts: readonly string[];
  onSelect: (text: string) => void;
};

/**
 * 빈 상태 추천 카드 — Magic UI MagicCard 옐로우 글로우 호버.
 * 좌측 옐로우 nudge 룰, 우측 화살표 nudge, stagger 진입.
 */
export function ExamplePromptList({
  prompts,
  onSelect,
}: ExamplePromptListProps) {
  return (
    <ul role="list" className="grid w-full gap-3 sm:grid-cols-2">
      {prompts.map((p, i) => (
        <li
          key={p}
          className="stagger-enter"
          style={{ animationDelay: `${300 + i * 100}ms` }}
        >
          <MagicCard
            mode="gradient"
            gradientFrom="#ffe600"
            gradientTo="#fff7b0"
            gradientColor="#1a1a1f"
            gradientOpacity={0.45}
            gradientSize={220}
            className="rounded-none"
          >
            <button
              type="button"
              onClick={() => onSelect(p)}
              className="group relative flex w-full items-start gap-4 px-5 py-5 text-left"
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[2px] bg-yellow opacity-60 transition-all duration-300 group-hover:w-[4px] group-hover:opacity-100"
              />
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-fg-muted transition-colors group-hover:text-fg">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="flex-1 font-sans text-[14px] font-medium leading-[1.45] text-fg">
                {p}
              </span>
              <span
                aria-hidden
                className="font-mono text-[14px] text-fg-muted transition-all duration-300 group-hover:translate-x-1 group-hover:text-yellow"
              >
                →
              </span>
            </button>
          </MagicCard>
        </li>
      ))}
    </ul>
  );
}
