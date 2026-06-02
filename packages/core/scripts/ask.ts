import "dotenv/config";

import { createCore, parseEnv } from "../src";
import { buildPayload, emitJson, logCitations } from "./lib/output";

// 사용:
//   pnpm core:ask "간이과세자 신고는 어떻게 해야 하나요?"
//   pnpm core:ask "..." --k=6
//   pnpm core:ask "..." --json   # stdout 마지막 줄에 JSON (ragas-eval 브릿지)

type Args = {
  query: string;
  k: number;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let k = 8;
  let json = false;
  for (const a of argv) {
    if (a.startsWith("--k=")) k = parseInt(a.slice("--k=".length), 10);
    else if (a === "--json") json = true;
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error('Usage: pnpm core:ask "<question>" [--k=<n>] [--json]');
    process.exit(1);
  }
  return { query: positional.join(" "), k, json };
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
    const { query, k, json } = parseArgs(process.argv.slice(2));

    // --json 모드: 인간용 출력은 stderr, stdout 마지막 한 줄 JSON만.
    const log = json ? console.error : console.log;

    log(`\nQuery   : ${query}`);
    log(`k       : ${k}`);
    log(`mode    : full\n`);

    const { textStream, citationStream, finish } = await core.chat.ask(query, {
      k,
    });

    const textPump = (async () => {
      log("--- answer ---");
      for await (const chunk of textStream) {
        if (json) void chunk;
        else process.stdout.write(chunk);
      }
      log("\n--------------\n");
    })();

    const citationPump = (async () => {
      for await (const c of citationStream) {
        console.error(
          `[cite] ${c.docTitle}${c.page != null ? ` · p.${c.page}` : ""}`,
        );
      }
    })();

    await Promise.all([textPump, citationPump]);

    const meta = await finish;
    log(
      `tokens : in=${meta.inputTokens ?? "?"} out=${meta.outputTokens ?? "?"}  finish=${meta.finishReason}  model=${meta.model}\n`,
    );
    logCitations(log, meta.citations);

    if (json) {
      emitJson(
        buildPayload({
          answer: meta.text,
          chunks: meta.chunks,
          citations: meta.citations,
        }),
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
