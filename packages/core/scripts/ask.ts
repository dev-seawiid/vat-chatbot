import "dotenv/config";

import { createCore, parseEnv } from "../src";

// 검증 CLI — apps/web 진입 전에 retrieve+generate end-to-end를 눈으로 확인하는 thin entrypoint.
// 사용:
//   pnpm core:ask "간이과세자 신고는 어떻게 해야 하나요?"
//   pnpm core:ask "..." --tax_type=vat-simplified --k=6

type Args = {
  query: string;
  taxType?: string;
  k: number;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let taxType: string | undefined;
  let k = 8;
  for (const a of argv) {
    if (a.startsWith("--tax_type=")) taxType = a.slice("--tax_type=".length);
    else if (a.startsWith("--k=")) k = parseInt(a.slice("--k=".length), 10);
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error(
      'Usage: pnpm core:ask "<question>" [--tax_type=<value>] [--k=<n>]',
    );
    process.exit(1);
  }
  return { query: positional.join(" "), taxType, k };
}

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const core = createCore({
    databaseUrl: env.DATABASE_URL,
    embeddingApiKey: env.VOYAGE_API_KEY,
    generationApiKey: env.OPENAI_API_KEY,
  });

  try {
    const { query, taxType, k } = parseArgs(process.argv.slice(2));
    const filter = taxType ? { tax_type: taxType } : undefined;

    console.log(`\nQuery   : ${query}`);
    console.log(`k       : ${k}`);
    console.log(`filter  : ${JSON.stringify(filter ?? null)}\n`);

    const { textStream, citations, finish } = await core.ask(query, {
      k,
      filter,
    });

    console.log("--- answer ---");
    for await (const chunk of textStream) process.stdout.write(chunk);
    console.log("\n--------------\n");

    const meta = await finish;
    console.log(
      `tokens : in=${meta.inputTokens ?? "?"} out=${meta.outputTokens ?? "?"}  finish=${meta.finishReason}  model=${meta.model}\n`,
    );

    console.log("--- citations ---");
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      console.log(
        `[${i + 1}] ${c.doc_title}${c.doc_version ? ` · ${c.doc_version}` : ""}${
          c.page != null ? ` · p.${c.page}` : ""
        }`,
      );
      if (c.section_path) console.log(`    ${c.section_path}`);
    }
  } finally {
    await core.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
