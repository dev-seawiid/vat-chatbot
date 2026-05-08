"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

import { cn } from "@/shared/lib/utils";

import { useSubmitFeedback } from "../lib/use-submit-feedback";

type FeedbackBarProps = {
  traceId: string;
};

// assistant 버블 하단 좌측, 작은 ghost 아이콘 버튼 페어. 기존 CitationChip은 본문 인라인
// 옐로우 강조라서 시각적 충돌을 피하고자 여기는 채도 없는 outline 스타일로 분리한다.
export function FeedbackBar({ traceId }: FeedbackBarProps) {
  const { status, value, submit } = useSubmitFeedback(traceId);
  const locked = status !== "idle";

  return (
    <div className="mt-3 flex items-center gap-2">
      <FeedbackButton
        label="도움이 되었어요"
        Icon={ThumbsUp}
        active={status === "done" && value === 1}
        locked={locked}
        onClick={() => submit(1)}
      />
      <FeedbackButton
        label="도움이 안 되었어요"
        Icon={ThumbsDown}
        active={status === "done" && value === -1}
        locked={locked}
        onClick={() => submit(-1)}
      />
      {status === "done" && (
        <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-fg-soft">
          기록됨
        </span>
      )}
    </div>
  );
}

type FeedbackButtonProps = {
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  active: boolean;
  locked: boolean;
  onClick: () => void;
};

function FeedbackButton({
  label,
  Icon,
  active,
  locked,
  onClick,
}: FeedbackButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={locked}
      onClick={onClick}
      className={cn(
        "relative inline-flex h-7 w-7 items-center justify-center",
        "border border-white/15 bg-transparent text-fg-soft",
        "transition-colors duration-150",
        "focus-visible:outline-none focus-visible:border-yellow",
        active && "border-yellow text-yellow",
        !locked && "hover:border-white/30 hover:text-fg cursor-pointer",
        locked && !active && "opacity-50",
        locked && "cursor-default",
      )}
    >
      <Icon aria-hidden width={14} height={14} strokeWidth={1.75} />
    </button>
  );
}
