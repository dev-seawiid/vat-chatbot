import "dotenv/config";

import { createCore, parseEnv } from "../src";

// 사용:
//   pnpm core:ask "간이과세자 신고는 어떻게 해야 하나요?"
//   pnpm core:ask "..." --tax_type=vat-simplified --k=6
//   pnpm core:ask "..." --json   # stdout 마지막 줄에 {"answer","contexts"} 한 줄 (ragas-eval 브릿지)

type Args = {
  query: string;
  taxType?: string;
  k: number;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let taxType: string | undefined;
  let k = 8;
  let json = false;
  for (const a of argv) {
    if (a.startsWith("--tax_type=")) taxType = a.slice("--tax_type=".length);
    else if (a.startsWith("--k=")) k = parseInt(a.slice("--k=".length), 10);
    else if (a === "--json") json = true;
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error(
      'Usage: pnpm core:ask "<question>" [--tax_type=<value>] [--k=<n>] [--json]',
    );
    process.exit(1);
  }
  return { query: positional.join(" "), taxType, k, json };
}

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const core = createCore({
    databaseUrl: env.DATABASE_URL,
    embeddingApiKey: env.VOYAGE_API_KEY,
    generationApiKey: env.OPENAI_API_KEY,
  });

  try {
    const { query, taxType, k, json } = parseArgs(process.argv.slice(2));
    const filter = taxType ? { taxType } : undefined;

    // --json 모드: 인간용 출력은 전부 stderr로, stdout은 마지막 한 줄 JSON만.
    const log = json ? console.error : console.log;

    log(`\nQuery   : ${query}`);
    log(`k       : ${k}`);
    log(`filter  : ${JSON.stringify(filter ?? null)}\n`);

    const { textStream, citationStream, chunks, finish } = await core.chat.ask(
      query,
      { k, filter },
    );

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
          `[cite] ${c.sourceId} · ${c.docTitle}${c.page != null ? ` · p.${c.page}` : ""}`,
        );
      }
    })();

    await Promise.all([textPump, citationPump]);

    const meta = await finish;
    log(
      `tokens : in=${meta.inputTokens ?? "?"} out=${meta.outputTokens ?? "?"}  finish=${meta.finishReason}  model=${meta.model}\n`,
    );

    log("--- citations (verified) ---");
    for (let i = 0; i < meta.citations.length; i++) {
      const c = meta.citations[i];
      log(
        `[${i + 1}] ${c.docTitle}${c.docVersion ? ` · ${c.docVersion}` : ""}${
          c.page != null ? ` · p.${c.page}` : ""
        }`,
      );
      if (c.sectionPath) log(`    ${c.sectionPath}`);
    }

    if (json) {
      const payload = {
        answer: meta.text,
        contexts: chunks.map((c) => c.content),
      };
      process.stdout.write(JSON.stringify(payload) + "\n");
    }
  } finally {
    await core.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
