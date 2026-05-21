import { createDb } from "#database/client";
import { type ChatService, createChatService } from "#modules/chat/chat.service";
import { createGenerationModel } from "#modules/chat/generation.adapter";
import { createMessageRepository } from "#modules/chat/message.repository";
import { createChunkRepository } from "#modules/retrieval/chunk.repository";
import { createEmbeddingModel } from "#modules/retrieval/embedding.adapter";
import {
  createRetrievalService,
  type RetrievalService,
} from "#modules/retrieval/retrieval.service";

// composition root — chat·retrieval 두 도메인의 외부 의존을 묶는다. evaluation은 jobs/ragas-eval
// consumer plane이 owns — core는 ask·retrieve library만 제공.

export type CoreConfig = {
  databaseUrl: string;
  embeddingApiKey: string;
  generationApiKey: string;
};

export type Core = {
  chat: ChatService;
  retrieval: RetrievalService;
  embeddingModelId: string;
  close: () => Promise<void>;
};

export function createCore(config: CoreConfig): Core {
  const { db, close } = createDb(config.databaseUrl);

  const chunkRepo = createChunkRepository(db);
  const messageRepo = createMessageRepository(db);

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
  });

  return {
    chat,
    retrieval,
    embeddingModelId: embeddingModel.modelId,
    close,
  };
}
