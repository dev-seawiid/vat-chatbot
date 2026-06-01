// retrieval 모듈 public API. 다른 모듈(chat)과 composition root(core)는 이 barrel만 import한다.
// 내부 파일(chunk.repository·*.adapter) 직접 참조 금지 — retrieval 내부 구조를 자유롭게
// 재배치할 수 있도록 표면을 한 곳에 고정한다.

export {
  createChunkRepository,
  type ChunkRepository,
  type SearchFilter,
  type SearchOptions,
  type SearchResult,
} from "./chunk.repository";
export { createEmbeddingModel } from "./embedding.adapter";
export {
  createRetrievalService,
  type LookupArticleFn,
  type RetrievalService,
  type RetrieveFn,
  type RetrieveOptions,
} from "./retrieval.service";
export {
  VoyageRerankCompressor,
  type VoyageRerankCompressorFields,
} from "./rerank.adapter";
export {
  type PgvectorDocMetadata,
  toDocument,
} from "./retriever.adapter";
