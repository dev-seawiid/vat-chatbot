"use client";

type NewConversationButtonProps = {
  onReset: () => void;
};

/**
 * 절제된 ghost 링크 — mono caps "새 대화", 좌측 1px 룰이 hover 시 길어진다.
 * 옐로우는 의도적으로 사용하지 않음.
 */
export function NewConversationButton({ onReset }: NewConversationButtonProps) {
  return (
    <button
      type="button"
      onClick={onReset}
      className="group inline-flex items-center gap-2 font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-fg-soft transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
    >
      <span
        aria-hidden
        className="block h-[1px] w-4 bg-fg-soft transition-[width,background-color] duration-300 group-hover:w-7 group-hover:bg-fg"
      />
      새 대화
    </button>
  );
}
