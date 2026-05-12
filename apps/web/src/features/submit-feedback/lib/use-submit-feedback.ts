"use client";

import { useState } from "react";

import { submitFeedback } from "../api/api";

export type FeedbackValue = 1 | -1;

export type FeedbackStatus = "idle" | "submitting" | "done";

type UseSubmitFeedbackResult = {
  status: FeedbackStatus;
  value: FeedbackValue | null;
  submit: (next: FeedbackValue) => Promise<void>;
};

// 같은 traceId 한 메시지 단위로 점수가 한 번만 송출되도록 in-memory 상태머신을 둔다.
// 새로고침 시 의도적으로 reset(영속화는 §0.4 비범위 — 토이엔 과잉). 실패는 idle 복귀로
// 재시도 가능, 성공은 done에서 잠금.
export function useSubmitFeedback(traceId: string): UseSubmitFeedbackResult {
  const [status, setStatus] = useState<FeedbackStatus>("idle");
  const [value, setValue] = useState<FeedbackValue | null>(null);

  async function submit(next: FeedbackValue): Promise<void> {
    if (status !== "idle") return;
    setStatus("submitting");
    setValue(next);
    try {
      await submitFeedback({ traceId, value: next });
      setStatus("done");
    } catch (err) {
      console.warn("[feedback] submit failed:", err);
      setStatus("idle");
      setValue(null);
    }
  }

  return { status, value, submit };
}
