import { z } from "zod";

import { setEmbeddingUsage, traceEmbedding } from "#common/telemetry";

// 임베딩 모델 어댑터. 생성 모델(adapters/generation.ts)과 별개 — RAG의 두 모델 역할이
// 섞이지 않도록 파일·타입·팩토리를 분리한다.
//
// 모델 ID는 본 파일에 박지 않고 consumer가 env(VOYAGE_MODEL)에서 읽어 주입한다 —
// ingest plane(jobs/ingest)이 적재한 벡터와 차원·학습이 정확히 일치해야 cosine 유사도가
// 의미를 가지므로, 양 plane이 같은 값을 가리키는지를 env 한 군데에서 통제.
//
// Voyage TS SDK가 안정 배포되지 않아 raw fetch 사용 — 호출 1종(embedding)뿐이라 무리 없음.

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";

// usage는 응답에 항상 포함되지만 SDK 보장 없이 fetch 직접 호출이라 optional로 방어.
const VoyageResponseSchema = z.object({
  data: z
    .array(z.object({ embedding: z.array(z.number()) }))
    .min(1),
  usage: z
    .object({ total_tokens: z.number().int().nonnegative() })
    .optional(),
});

export type InputType = "query" | "document";

export type EmbedFn = (
  text: string,
  opts: { input_type: InputType },
) => Promise<number[]>;

export type EmbeddingModel = {
  embed: EmbedFn;
  modelId: string;
};

export function createEmbeddingModel({
  apiKey,
  modelId,
}: {
  apiKey: string;
  modelId: string;
}): EmbeddingModel {
  const embed: EmbedFn = traceEmbedding(
    {
      name: "voyage.embed",
      attrs: ([text, opts]) => ({
        input: text,
        model: modelId,
        metadata: { input_type: opts.input_type },
      }),
      // embedding vector는 길고 trace UI에 가치 없음 — 길이만 남김.
      output: (embedding) => ({ dim: embedding.length }),
    },
    async (text, opts) => {
      const res = await fetch(VOYAGE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: [text],
          model: modelId,
          // spec §3.1·§3.2 — ingest는 "document", retrieval은 "query".
          // Voyage가 두 모드를 다르게 학습해 모드를 섞으면 검색 품질이 떨어짐.
          input_type: opts.input_type,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`embed failed: ${res.status} ${body}`);
      }
      const parsed = VoyageResponseSchema.parse(await res.json());
      if (parsed.usage) setEmbeddingUsage(parsed.usage.total_tokens);
      return parsed.data[0]!.embedding;
    },
  );

  return { embed, modelId };
}
