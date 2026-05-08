import type { TelemetrySettings } from "ai";

import { createDb } from "./db/client";
import { createGateway, type Gateway } from "./db/gateway";
import { type AskFn, createAsk } from "./rag/generate";
import { createGenerationModel } from "./rag/generation-model";
import { createRetrieve, type RetrieveFn } from "./rag/retrieve";
import { createEmbed } from "./rag/voyage";

// composition root — 모든 외부 의존(DB, 임베딩 모델, 생성 모델)을 한 곳에서 묶는다.
// 라이브러리 모듈은 어떤 모듈도 process.env를 직접 읽지 않고, 본 factory의 인자로만
// config를 받는다. 소비자(consumer)는 자기 plane의 env에서 값을 추출해 createCore에
// 넘기는 것이 boundary 책임.
//
// 본 파일은 "wiring만" — provider/모델/스키마 결정은 각 모듈(rag/generation-model.ts,
// rag/voyage.ts, db/*) 책임.

export type CoreConfig = {
  databaseUrl: string;
  voyageApiKey: string;
  openaiApiKey: string;
  /** AI SDK telemetry — OTEL SpanProcessor를 부팅한 plane만 활성화. 미전달 시 spans 미발생.
   *  apps/web은 `{ isEnabled: true, functionId: 'rag.ask' }` 주입, CLI는 기본 미주입. */
  telemetry?: TelemetrySettings;
};

export type Core = {
  ask: AskFn;
  retrieve: RetrieveFn;
  gateway: Gateway;
  /** 프로세스 종료 시 명시 호출 (CLI). web request lifecycle에선 미호출이 정상. */
  close: () => Promise<void>;
};

export function createCore(config: CoreConfig): Core {
  const { db, close } = createDb(config.databaseUrl);
  const gateway = createGateway(db);
  const embed = createEmbed(config.voyageApiKey);
  const generationModel = createGenerationModel({ apiKey: config.openaiApiKey });
  const retrieve = createRetrieve({ embed, gateway });
  const ask = createAsk({ retrieve, generationModel, telemetry: config.telemetry });
  return { ask, retrieve, gateway, close };
}
