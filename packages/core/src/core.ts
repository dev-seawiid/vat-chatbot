import { createDb } from "#database/client";
import {
  type ChatService,
  createChatService,
} from "#modules/chat/chat.service";
import { createModelRegistry } from "#modules/chat/llm.adapter";
import { createMessageRepository } from "#modules/chat/message.repository";
import { createRagGraph } from "#modules/chat/rag-graph/index";
import {
  createChunkRepository,
  createEmbeddingModel,
  createRetrievalService,
  type RetrievalService,
} from "#modules/retrieval/index";

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

  // role별 모델 레지스트리 — 노드마다 독립 모델(draft=상위 모델 등). default는 adapter,
  // overrides는 eval/실험용 표면.
  const models = createModelRegistry({ apiKey: config.generationApiKey });

  // 그래프 조립은 composition root 책임 — chat.service는 invoke만.
  // VoyageRerankCompressor가 embedding과 동일 키(VOYAGE_API_KEY)로 rerank-2.5 호출.
  // createRagGraph는 full graph + retrieval-only path 둘 다 반환(lbr-eval용).
  const rag = createRagGraph({
    models,
    retrieve: retrieval.retrieve,
    voyageApiKey: config.embeddingApiKey,
  });

  const chat = createChatService({
    rag,
    messageRepo,
    // persist 라벨은 최종 답변 생성 모델 기준.
    modelId: models.answer.modelId,
  });

  return {
    chat,
    retrieval,
    embeddingModelId: embeddingModel.modelId,
    close,
  };
}
