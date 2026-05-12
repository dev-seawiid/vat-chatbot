"use client";

import { useState } from "react";

import { cn } from "@/shared/lib/utils";
import { BorderBeam } from "@/shared/ui/border-beam";
import { Textarea } from "@/shared/ui/textarea";

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

const STREAMING_STATES = new Set<ChatStatus>(["submitted", "streaming"]);
const MAX_LENGTH = 1000;
const COUNTER_WARN_THRESHOLD = 100;

type MessageComposerProps = {
  status: ChatStatus;
  onSubmit: (text: string) => void;
  onStop: () => void;
  draft: string;
  onDraftChange: (next: string) => void;
};

/**
 * 다크 입력 컴포저.
 * - bg-surface-1 + 헤어라인. focus-within 시 옐로우 BorderBeam 회전 (Magic UI).
 * - 푸터: mono kbd 힌트 좌측, 카운터 + ASK/STOP 액션 우측.
 * - Enter 전송, Shift+Enter 줄바꿈, 1000자 한도.
 */
export function MessageComposer({
  status,
  onSubmit,
  onStop,
  draft,
  onDraftChange,
}: MessageComposerProps) {
  const [focused, setFocused] = useState(false);

  const isStreaming = STREAMING_STATES.has(status);
  const trimmed = draft.trim();
  const canSubmit = trimmed.length > 0 && !isStreaming;
  const remaining = MAX_LENGTH - draft.length;

  function submit(): void {
    if (!canSubmit) return;
    onSubmit(trimmed);
    onDraftChange("");
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden border bg-surface-1 transition-[border-color] duration-200",
        focused ? "border-yellow/30" : "border-white/10 hover:border-white/15",
      )}
    >
      {focused && (
        <BorderBeam
          size={120}
          duration={5}
          colorFrom="#ffe600"
          colorTo="#a1a1aa"
          borderWidth={1}
        />
      )}

      <div className="relative p-5">
        <Textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value.slice(0, MAX_LENGTH))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="부가세에 대해 물어보세요 — 예: 간이과세자 신고는 어떻게 하나요?"
          aria-label="질문 입력"
          disabled={isStreaming}
          maxLength={MAX_LENGTH}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="px-0 py-0 text-[14.5px] leading-[1.6]"
        />

        <div className="mt-3 flex items-end justify-between gap-3 border-t border-white/10 pt-3">
          <span className="hidden font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted sm:inline-block">
            <kbd className="border border-white/10 bg-surface-2 px-[6px] py-[1px] text-fg-soft">
              Enter
            </kbd>{" "}
            전송 ·{" "}
            <kbd className="border border-white/10 bg-surface-2 px-[6px] py-[1px] text-fg-soft">
              Shift+Enter
            </kbd>{" "}
            줄바꿈
          </span>

          <div className="flex w-full items-center justify-between gap-3 sm:w-auto">
            <span
              className={cn(
                "font-mono text-[10px] tabular-nums tracking-[0.06em]",
                remaining < COUNTER_WARN_THRESHOLD
                  ? "text-vermilion"
                  : "text-fg-muted",
              )}
            >
              {draft.length}/{MAX_LENGTH}
            </span>

            {isStreaming ? (
              <StopButton onStop={onStop} />
            ) : (
              <AskButton canSubmit={canSubmit} onSubmit={submit} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type AskButtonProps = {
  canSubmit: boolean;
  onSubmit: () => void;
};

function AskButton({ canSubmit, onSubmit }: AskButtonProps) {
  return (
    <button
      type="button"
      onClick={onSubmit}
      disabled={!canSubmit}
      className={cn(
        "group inline-flex h-10 items-center gap-2 px-5",
        "border font-mono text-[11px] font-medium uppercase tracking-[0.18em]",
        "transition-all duration-200",
        canSubmit
          ? cn(
              "border-yellow bg-yellow text-bg",
              "shadow-[0_0_0_1px_var(--yellow),0_0_24px_-4px_rgb(255_230_0/0.55)]",
              "hover:bg-yellow-soft hover:shadow-[0_0_0_1px_var(--yellow),0_0_36px_0_rgb(255_230_0/0.7)]",
              "active:translate-y-[1px]",
            )
          : "border-white/10 bg-surface-2 text-fg-muted disabled:cursor-not-allowed",
      )}
    >
      질문
      <span
        aria-hidden
        className={cn(
          "inline-block transition-transform duration-200",
          canSubmit && "group-hover:translate-x-[3px]",
        )}
      >
        →
      </span>
    </button>
  );
}

type StopButtonProps = {
  onStop: () => void;
};

function StopButton({ onStop }: StopButtonProps) {
  return (
    <button
      type="button"
      onClick={onStop}
      className={cn(
        "group inline-flex h-10 items-center gap-2 border border-white/10 bg-surface-2 px-5",
        "font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-fg",
        "transition-[background-color,border-color,color] duration-200",
        "hover:border-vermilion hover:bg-vermilion hover:text-fg",
      )}
    >
      <span
        aria-hidden
        className="block h-[8px] w-[8px] bg-vermilion transition-colors group-hover:bg-fg"
      />
      중지
    </button>
  );
}
