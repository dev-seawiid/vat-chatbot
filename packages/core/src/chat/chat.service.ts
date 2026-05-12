import { stepCountIs, streamText, type TelemetrySettings } from "ai";

import { type Citation, toCitations } from "../shared/citation";
import type { GenerationModel } from "../adapters/generation";
import type { SearchResult } from "../retrieval/chunk.repository";
import type { RetrievalService, RetrieveOptions } from "../retrieval/retrieval.service";
import type {
  MessageRepository,
  SavePairArgs,
} from "./message.repository";
import { buildSystemMessage } from "./prompt";
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

export type ChatService = ReturnType<typeof createChatService>;

/**
 * spec §3.3 — chat 도메인 use case. ask(질문 → stream + citations)와 recordChatTurn(영속화)을
 * 묶는다. controller(apps/web route handler, eval CLI)는 본 service만 호출하고 repository를
 * 직접 보지 않는다.
 *
 * ask는 retrieval service로 청크를 모은 뒤 [n] 번호로 system 메시지에 끼워 streamText.
 * tool-call 라운드트립을 허용하도록 stopWhen=stepCountIs(5) — calc_vat 후 답변 생성까지.
 */
export function createChatService(deps: {
  retrieval: RetrievalService;
  generationModel: GenerationModel;
  messageRepo: MessageRepository;
  /** AI SDK telemetry settings — undefined면 spans 미발생. 켤지 여부와 functionId는 composition
   *  root가 결정한다(라이브러리는 OTEL 부팅 상태를 모르므로 enable 결정권 없음). */
  telemetry?: TelemetrySettings;
}) {
  const { retrieval, generationModel, messageRepo, telemetry } = deps;
  const { model, modelId } = generationModel;

  const ask: AskFn = async (query, opts = {}) => {
    const chunks = await retrieval.retrieve(query, {
      k: opts.k,
      filter: opts.filter,
    });
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

  return {
    ask,
    async recordChatTurn(args: SavePairArgs): Promise<void> {
      await messageRepo.savePair(args);
    },
  };
}
