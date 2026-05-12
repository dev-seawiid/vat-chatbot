import type { TelemetrySettings } from "ai";

import { createDb } from "./db/client";
import { createGateway, type Gateway } from "./db/gateway";
import { createEmbeddingModel } from "./providers/embedding";
import { createGenerationModel } from "./providers/generation";
import { createChunkRepository } from "./repositories/chunk.repository";
import { createEvalRepository } from "./repositories/eval.repository";
import {
  createMessageRepository,
  type SavePairArgs,
} from "./repositories/message.repository";
import { type AskFn, createChatService } from "./services/chat.service";
import { createEvalService, type EvalService } from "./services/eval.service";
import {
  createRetrievalService,
  type RetrieveFn,
} from "./services/retrieval.service";

// composition root — 모든 외부 의존(DB, 임베딩 모델, 생성 모델)을 한 곳에서 묶는다.
// 라이브러리 모듈은 어떤 모듈도 process.env를 직접 읽지 않고, 본 factory의 인자로만
// config를 받는다. 소비자(consumer)는 자기 plane의 env에서 값을 추출해 createCore에
// 넘기는 것이 boundary 책임.
//
// 본 파일은 "wiring만" — provider/모델/스키마 결정은 각 모듈(providers/*, db/*) 책임.
// repository 인스턴스는 service에만 주입하고 외부 표면(Core)에는 service 산출 함수만 노출한다.

export type CoreConfig = {
  databaseUrl: string;
  embeddingApiKey: string;
  generationApiKey: string;
  /** AI SDK telemetry — OTEL SpanProcessor를 부팅한 plane만 활성화. 미전달 시 spans 미발생.
   *  apps/web은 `{ isEnabled: true, functionId: 'rag.ask' }` 주입, CLI는 기본 미주입. */
  telemetry?: TelemetrySettings;
};

export type Core = {
  ask: AskFn;
  retrieve: RetrieveFn;
  /** chat turn(user 질문 + assistant 답변) 영속화 use case. web 진입점은 본 메서드 사용. */
  recordChatTurn: (args: SavePairArgs) => Promise<void>;
  /** S3 임시 노출 — eval CLI가 호출. S4에서 core.eval로 표면 통합 예정. */
  evalService: EvalService;
  /** S2 임시 facade — 외부 사용처 없음. S4에서 제거 예정. */
  gateway: Gateway;
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
    ask: chat.ask,
    retrieve: retrieval.retrieve,
    recordChatTurn: chat.recordChatTurn,
    evalService,
    gateway: createGateway(db),
    embeddingModelId: embeddingModel.modelId,
    close,
  };
}
