import { Document } from "@langchain/core/documents";
import {
  BaseRetriever,
  type BaseRetrieverInput,
} from "@langchain/core/retrievers";

import type { SearchResult } from "./chunk.repository";
import type { RetrieveFn, RetrieveOptions } from "./retrieval.service";

// LangChain BaseRetriever 어댑터 — retrieval.service.retrieve를 Runnable로 감싼다.
// graph 노드(history_aware_retriever 등)가 string query를 invoke하면 본 클래스가 위임.
//
// SearchResult 전체를 metadata.searchResult에 보존 — rerank·grade·generate 노드가 chunkId
// 외 필드(docTitle, content 전문 등)에 직접 접근. chunkId는 매핑 빈도가 높아 별도 노출.

export type PgvectorRetrieverFields = BaseRetrieverInput & {
  retrieve: RetrieveFn;
  options?: RetrieveOptions;
};

export type PgvectorDocMetadata = {
  chunkId: string;
  searchResult: SearchResult;
};

export class PgvectorRetriever extends BaseRetriever<PgvectorDocMetadata> {
  lc_namespace = ["vat", "retrievers", "pgvector"];

  private readonly retrieveFn: RetrieveFn;
  private readonly options?: RetrieveOptions;

  constructor(fields: PgvectorRetrieverFields) {
    const { retrieve, options, ...rest } = fields;
    super(rest);
    this.retrieveFn = retrieve;
    this.options = options;
  }

  async _getRelevantDocuments(
    query: string,
  ): Promise<Document<PgvectorDocMetadata>[]> {
    const results = await this.retrieveFn(query, this.options);
    return results.map(toDocument);
  }
}

export function toDocument(r: SearchResult): Document<PgvectorDocMetadata> {
  return new Document<PgvectorDocMetadata>({
    pageContent: r.content,
    metadata: {
      chunkId: r.chunkId,
      searchResult: r,
    },
  });
}
