import { stepCountIs, streamText, type TelemetrySettings } from "ai";

import type { SearchResult } from "../db/gateway";
import type { Citation } from "../db/schema";
import { toCitations } from "./citation";
import type { GenerationModel } from "./generation-model";
import { buildSystemMessage } from "./prompt";
import type { RetrieveFn, RetrieveOptions } from "./retrieve";
import { tools } from "./tools";

export type AskOptions = RetrieveOptions;

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
    /** 이번 호출에서 실제로 사용한 모델 ID — messages.model 라벨로 그대로 기록 */
    model: string;
  }>;
};

export type AskFn = (query: string, opts?: AskOptions) => Promise<AskResult>;

/**
 * spec §3.3 — retrieve로 모은 청크를 [n] 번호로 system 메시지에 끼워넣고 streamText.
 * 사용자 query는 user role 그대로 — context 구분자 escape 없이도 prompt injection 차단.
 * tool-call 라운드트립을 허용하도록 stopWhen=stepCountIs(5) — calc_vat 후 답변 생성까지.
 * messages 영속화는 호출자(api/chat 또는 CLI) 책임 — 본 함수는 순수 합성만.
 */
export function createAsk({
  retrieve,
  generationModel,
  telemetry,
}: {
  retrieve: RetrieveFn;
  generationModel: GenerationModel;
  /** AI SDK telemetry settings — undefined면 spans 미발생. 켤지 여부와 functionId는 composition
   *  root가 결정한다(라이브러리는 OTEL 부팅 상태를 모르므로 enable 결정권 없음). */
  telemetry?: TelemetrySettings;
}): AskFn {
  const { model, modelId } = generationModel;

  return async (query, opts = {}) => {
    const chunks = await retrieve(query, { k: opts.k, filter: opts.filter });
    const citations = toCitations(chunks);

    const result = streamText({
      model,
      system: buildSystemMessage(chunks),
      prompt: query,
      tools,
      stopWhen: stepCountIs(5),
      experimental_telemetry: telemetry,
    });

    const finish = (async () => {
      const usage = await result.usage;
      return {
        text: await result.text,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        finishReason: await result.finishReason,
        model: modelId,
      };
    })();

    return { textStream: result.textStream, chunks, citations, finish };
  };
}
