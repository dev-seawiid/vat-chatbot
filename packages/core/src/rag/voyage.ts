import { env } from "../env";

// Voyage TS SDK가 안정 배포되지 않아 raw fetch 사용 — 호출 1종(embedding)뿐이라 무리 없음.
// 모델·차원은 Python plane(ingest)의 voyage-3 / 1024-dim과 정확히 일치해야 한다 —
// 임베딩 모델이 다르면 cosine 유사도가 의미를 잃음.
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3";

export type InputType = "query" | "document";

export async function embed(
  text: string,
  opts: { input_type: InputType },
): Promise<number[]> {
  const res = await fetch(VOYAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [text],
      model: MODEL,
      // spec §3.1·§3.2 — ingest는 "document", retrieval은 "query".
      // Voyage가 두 모드를 다르게 학습해 모드를 섞으면 검색 품질이 떨어짐.
      input_type: opts.input_type,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage embed failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  if (!data.data?.[0]?.embedding) {
    throw new Error("Voyage embed returned empty data");
  }
  return data.data[0].embedding;
}
