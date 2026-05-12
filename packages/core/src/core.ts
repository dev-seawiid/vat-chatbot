import type { TelemetrySettings } from "ai";

import { createDb } from "./db/client";
import { createEmbeddingModel } from "./adapters/embedding";
import { createGenerationModel } from "./adapters/generation";
import { type ChatService, createChatService } from "./chat/chat.service";
import { createMessageRepository } from "./chat/message.repository";
import { createEvalRepository } from "./eval/eval.repository";
import { createEvalService, type EvalService } from "./eval/eval.service";
import { createChunkRepository } from "./retrieval/chunk.repository";
import {
  createRetrievalService,
  type RetrievalService,
} from "./retrieval/retrieval.service";

// composition root — 모든 외부 의존(DB, 임베딩 모델, 생성 모델)을 한 곳에서 묶는다.
// 라이브러리 모듈은 어떤 모듈도 process.env를 직접 읽지 않고, 본 factory의 인자로만
// config를 받는다. 소비자(consumer)는 자기 plane의 env에서 값을 추출해 createCore에
// 넘기는 것이 boundary 책임.
//
// 본 파일은 "wiring만" — provider/모델/스키마 결정은 각 모듈(providers/*, db/*) 책임.
// 외부 표면(Core)에는 service만 노출하고 repository는 service deps로만 흘려보낸다.
// controller(apps/web route handler, eval CLI)는 core.<service>.<usecase>() 형태로만 호출.

export type CoreConfig = {
  databaseUrl: string;
  embeddingApiKey: string;
  generationApiKey: string;
  /** AI SDK telemetry — OTEL SpanProcessor를 부팅한 plane만 활성화. 미전달 시 spans 미발생.
   *  apps/web은 `{ isEnabled: true, functionId: 'rag.ask' }` 주입, CLI는 기본 미주입. */
  telemetry?: TelemetrySettings;
};

export type Core = {
  chat: ChatService;
  retrieval: RetrievalService;
  eval: EvalService;
  /** eval_runs 라벨링 등에서 사용 — 어느 임베딩 모델로 적재·검색했는지 박제. */
  embeddingModelId: string;
  /** 프로세스 종료 시 명시 호출 (CLI). web request lifecycle에선 미호출이 정상. */
  close: () => Promise<void>;
};

export function createCore(config: CoreConfig): Core {
  const { db, close } = createDb(config.databaseUrl);

  const chunkRepo = createChunkRepository(db);
  const messageRepo = createMessageRepository(db);
  const evalRepo = createEvalRepository(db);

  const embeddingModel = createEmbeddingModel({ apiKey: config.embeddingApiKey });
  const generationModel = createGenerationModel({ apiKey: config.generationApiKey });

  const retrieval = createRetrievalService({
    embed: embeddingModel.embed,
    chunkRepo,
  });
  const chat = createChatService({
    retrieval,
    generationModel,
    messageRepo,
    telemetry: config.telemetry,
  });
  const evalService = createEvalService({ evalRepo });

  return {
    chat,
    retrieval,
    eval: evalService,
    embeddingModelId: embeddingModel.modelId,
    close,
  };
}
