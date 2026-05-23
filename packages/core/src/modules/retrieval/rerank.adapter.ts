import { Document, type DocumentInterface } from "@langchain/core/documents";
import { BaseDocumentCompressor } from "@langchain/core/retrievers/document_compressors";
import { z } from "zod";

import { traceSpan } from "#common/telemetry";

// Voyage rerank-2.5 REST 호출을 BaseDocumentCompressor로 감싸 ContextualCompressionRetriever와
// 합성 가능하게 만든다. JS용 공식 LangChain 통합이 없어 자체 어댑터.
//
// 모델 ID는 본 파일 default 상수(rerank-2.5) — provider만 env로 주입.

const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
const DEFAULT_MODEL_ID = "rerank-2.5";

const VoyageRerankResponseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      relevance_score: z.number(),
    }),
  ),
  usage: z
    .object({ total_tokens: z.number().int().nonnegative() })
    .optional(),
});

export type VoyageRerankCompressorFields = {
  apiKey: string;
  modelId?: string;
  topK?: number;
};

export class VoyageRerankCompressor extends BaseDocumentCompressor {
  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly topK?: number;

  constructor(fields: VoyageRerankCompressorFields) {
    super();
    this.apiKey = fields.apiKey;
    this.modelId = fields.modelId ?? DEFAULT_MODEL_ID;
    this.topK = fields.topK;
  }

  async compressDocuments(
    documents: DocumentInterface[],
    query: string,
  ): Promise<DocumentInterface[]> {
    if (documents.length === 0) return documents;

    return traceSpan(
      {
        name: "voyage.rerank",
        attrs: () => ({
          input: {
            query,
            candidateCount: documents.length,
            topK: this.topK ?? null,
            model: this.modelId,
          },
        }),
        output: (out: DocumentInterface[]) => ({ hitCount: out.length }),
      },
      async () => {
        const res = await fetch(VOYAGE_RERANK_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.modelId,
            query,
            documents: documents.map((d) => d.pageContent),
            top_k: this.topK,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`rerank failed: ${res.status} ${body}`);
        }
        const parsed = VoyageRerankResponseSchema.parse(await res.json());
        return parsed.data.map((item) => {
          const original = documents[item.index]!;
          return new Document({
            pageContent: original.pageContent,
            metadata: {
              ...original.metadata,
              relevanceScore: item.relevance_score,
            },
          });
        });
      },
    )();
  }
}
