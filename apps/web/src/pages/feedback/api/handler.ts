import { LangfuseClient } from "@langfuse/client";
import { z } from "zod";

// 마스터 spec §4.2 — score 한 종류만 송출. value는 1(👍) | -1(👎). dataType은 NUMERIC
// 으로 명시해 -1을 그대로 보존(boolean dataType은 0|1 강제라 음수 불가).
const FeedbackBodySchema = z.object({
  traceId: z.string().min(1),
  value: z.union([z.literal(1), z.literal(-1)]),
});

const SCORE_NAME = "user-thumbs";

// LangfuseClient는 LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY/LANGFUSE_BASEURL을 process.env
// 에서 자동으로 읽는다. dev 모듈 HMR로 인스턴스 누적을 막기 위해 globalThis 캐시.
const globalForLangfuse = globalThis as unknown as {
  __vatLangfuseClient?: LangfuseClient;
};

function getLangfuseClient(): LangfuseClient {
  if (!globalForLangfuse.__vatLangfuseClient) {
    globalForLangfuse.__vatLangfuseClient = new LangfuseClient();
  }
  return globalForLangfuse.__vatLangfuseClient;
}

export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const parsed = FeedbackBodySchema.safeParse(raw);
  if (!parsed.success) {
    return new Response("invalid request body", { status: 400 });
  }

  const client = getLangfuseClient();
  // score.create는 내부 큐에 enqueue만 하므로 Vercel function 종료 전 flush 필요.
  // await flush로 응답을 늦추되, 토이 트래픽이라 latency 영향 미미하고 신뢰도 우위.
  client.score.create({
    traceId: parsed.data.traceId,
    name: SCORE_NAME,
    value: parsed.data.value,
    dataType: "NUMERIC",
  });

  try {
    await client.flush();
  } catch (err) {
    console.error("[feedback] flush failed:", err);
    return new Response("score export failed", { status: 502 });
  }

  return new Response(null, { status: 204 });
}
