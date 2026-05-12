"use client";

import { http } from "@/shared/api";

type SubmitFeedbackInput = {
  traceId: string;
  value: 1 | -1;
};

export async function submitFeedback(
  input: SubmitFeedbackInput,
): Promise<void> {
  await http.post("/api/feedback", { json: input });
}
