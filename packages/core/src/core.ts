import type { TelemetrySettings } from "ai";

import { createDb } from "./db/client";
import { createGateway, type Gateway, type SavePairArgs } from "./db/gateway";
import { createEmbeddingModel } from "./providers/embedding";
import { createGenerationModel } from "./providers/generation";
import { type AskFn, createAsk } from "./rag/ask";
import { createRetrieve, type RetrieveFn } from "./rag/retrieve";

// composition root — 모든 외부 의존(DB, 임베딩 모델, 생성 모델)을 한 곳에서 묶는다.
// 라이브러리 모듈은 어떤 모듈도 process.env를 직접 읽지 않고, 본 factory의 인자로만
// config를 받는다. 소비자(consumer)는 자기 plane의 env에서 값을 추출해 createCore에
// 넘기는 것이 boundary 책임.
//
// 본 파일은 "wiring만" — provider/모델/스키마 결정은 각 모듈(providers/*, db/*) 책임.

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
  /** internal — eval CLI/runner가 직접 접근하기 위한 출구. web 진입점에서는 사용 금지(use case 경유). */
  gateway: Gateway;
  /** eval_runs 라벨링 등에서 사용 — 어느 임베딩 모델로 적재·검색했는지 박제. */
  embeddingModelId: string;
  /** 프로세스 종료 시 명시 호출 (CLI). web request lifecycle에선 미호출이 정상. */
  close: () => Promise<void>;
};

export function createCore(config: CoreConfig): Core {
  const { db, close } = createDb(config.databaseUrl);
  const gateway = createGateway(db);
  const embeddingModel = createEmbeddingModel({ apiKey: config.embeddingApiKey });
  const generationModel = createGenerationModel({ apiKey: config.generationApiKey });
  const retrieve = createRetrieve({ embed: embeddingModel.embed, gateway });
  const ask = createAsk({
    retrieve,
    generationModel,
    telemetry: config.telemetry,
  });
  return {
    ask,
    retrieve,
    recordChatTurn: (args) => gateway.messages.savePair(args),
    gateway,
    embeddingModelId: embeddingModel.modelId,
    close,
  };
}
