import { createDb } from "#database/client";
import {
  type ChatService,
  createChatService,
} from "#modules/chat/chat.service";
import { createGenerationModel } from "#modules/chat/generation.adapter";
import { createMessageRepository } from "#modules/chat/message.repository";
import { createRagGraph } from "#modules/chat/rag-graph";
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
  embeddingModelId: string;
  generationApiKey: string;
};

export type Core = {
  chat: ChatService;
  retrieval: RetrievalService;
  embeddingModelId: string;
  close: () => Promise<void>;
};

export async function createCore(config: CoreConfig): Promise<Core> {
  const { db, close } = createDb(config.databaseUrl);

  const chunkRepo = createChunkRepository(db);
  const messageRepo = createMessageRepository(db);

  const embeddingModel = createEmbeddingModel({
    apiKey: config.embeddingApiKey,
    modelId: config.embeddingModelId,
  });
  const retrieval = createRetrievalService({
    embed: embeddingModel.embed,
    chunkRepo,
  });

  // initChatModel 기반(provider dynamic import) — async 팩토리.
  const generationModel = await createGenerationModel({
    apiKey: config.generationApiKey,
  });

  // 그래프 조립은 composition root 책임 — chat.service는 invoke만.
  // VoyageRerankCompressor가 embedding과 동일 키(VOYAGE_API_KEY)로 rerank-2.5 호출.
  const graph = createRagGraph({
    generationModel,
    retrieve: retrieval.retrieve,
    voyageApiKey: config.embeddingApiKey,
  });

  const chat = createChatService({
    graph,
    messageRepo,
    modelId: generationModel.modelId,
  });

  return {
    chat,
    retrieval,
    embeddingModelId: embeddingModel.modelId,
    close,
  };
}
