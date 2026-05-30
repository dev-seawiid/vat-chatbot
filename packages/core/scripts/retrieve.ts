import "dotenv/config";

import { createCore, parseEnv } from "../src";
import { buildPayload, emitJson } from "./lib/output";

// retrieval-only — production retrieval pipeline(HyDE+claims+RRF) 실행, generate_answer 우회.
// lbr-eval(LegalBench-RAG)이 LLM 호출 없이 retrieval만 측정하기 위함.
//
// 사용:
//   pnpm core:retrieve "..." --json   # stdout 마지막 줄에 JSON (chunks·answer="")

type Args = { query: string; json: boolean };

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error('Usage: pnpm core:retrieve "<question>" [--json]');
    process.exit(1);
  }
  return { query: positional.join(" "), json };
}

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const core = await createCore({
    databaseUrl: env.DATABASE_URL,
    embeddingApiKey: env.VOYAGE_API_KEY,
    embeddingModelId: env.VOYAGE_MODEL,
    generationApiKey: env.OPENAI_API_KEY,
  });

  try {
    const { query, json } = parseArgs(process.argv.slice(2));
    const log = json ? console.error : console.log;

    log(`\nQuery   : ${query}`);
    log(`mode    : retrieval-only\n`);

    const { chunks } = await core.chat.retrieve(query);
    log(`retrieved ${chunks.length} chunks`);

    if (json) {
      emitJson(buildPayload({ answer: "", chunks, citations: [] }));
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      log(
        `[${i + 1}] ${c.docTitle}${c.page != null ? ` · p.${c.page}` : ""} (${c.chunkId.slice(0, 8)})`,
      );
    }
  } finally {
    await core.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
