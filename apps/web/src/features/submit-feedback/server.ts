import "server-only";

import { LangfuseClient } from "@langfuse/client";

// 마스터 spec §4.2 — score 한 종류만 송출. value는 1(👍) | -1(👎). dataType은 NUMERIC으로
// 명시해 -1을 그대로 보존(boolean dataType은 0|1 강제라 음수 불가).
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

type RecordFeedbackInput = {
  traceId: string;
  value: 1 | -1;
};

// score.create는 내부 큐에 enqueue만 하므로 Vercel function 종료 전 flush 필요. await flush로
// 응답을 늦추되, 토이 트래픽이라 latency 영향 미미하고 신뢰도 우위.
export async function recordFeedback(input: RecordFeedbackInput): Promise<void> {
  const client = getLangfuseClient();
  client.score.create({
    traceId: input.traceId,
    name: SCORE_NAME,
    value: input.value,
    dataType: "NUMERIC",
  });
  await client.flush();
}
