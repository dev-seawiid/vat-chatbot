import { google } from "@ai-sdk/google";
import { stepCountIs, streamText } from "ai";

import type { SearchResult } from "../db/gateway";
import type { Citation } from "../db/schema";
import { toCitations } from "./citation";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { retrieve, type RetrieveOptions } from "./retrieve";
import { tools } from "./tools";

// spec §3.3는 claude-sonnet-4-6을 default로 명시하지만, 토이 학습 단계에서는 무료 티어인
// Gemini 2.5 Flash로 운영해 비용을 0으로 둔다(spec deviation, §3.3 하단 메모 참조).
// 더 큰 모델이 필요하면 호출자가 opts.model로 "gemini-2.5-pro" 등을 명시.
const DEFAULT_MODEL = "gemini-2.5-flash";

export type AskOptions = RetrieveOptions & {
  model?: string;
};

export type AskResult = {
  textStream: AsyncIterable<string>;
  /** retrieve가 고른 청크 — 인용 객체로 변환 후 messages.citations에 저장 */
  chunks: SearchResult[];
  citations: Citation[];
  /** stream 종료 시점에 resolve되는 메타데이터 — Langfuse trace 기록용 */
  finish: Promise<{
    text: string;
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    finishReason: string;
  }>;
};

/**
 * spec §3.3 — retrieve로 모은 청크를 [n] 번호로 system+user 메시지에 끼워넣고 streamText.
 * tool-call 라운드트립을 허용하도록 stopWhen=stepCountIs(5) — calc_vat 후 답변 생성까지.
 * messages 영속화는 호출자(api/chat 또는 CLI) 책임 — 본 함수는 순수 합성만.
 */
export async function ask(
  query: string,
  opts: AskOptions = {},
): Promise<AskResult> {
  const chunks = await retrieve(query, { k: opts.k, filter: opts.filter });
  const citations = toCitations(chunks);

  const result = streamText({
    model: google(opts.model ?? DEFAULT_MODEL),
    system: SYSTEM_PROMPT,
    prompt: buildUserMessage(query, chunks),
    tools,
    stopWhen: stepCountIs(5),
  });

  const finish = (async () => {
    const usage = await result.usage;
    return {
      text: await result.text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      finishReason: await result.finishReason,
    };
  })();

  return { textStream: result.textStream, chunks, citations, finish };
}
