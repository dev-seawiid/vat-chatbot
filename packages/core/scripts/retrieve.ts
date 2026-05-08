import "dotenv/config";

import { createCore, parseEnv } from "../src";

// 검증 CLI — apps/web 진입 전에 retrieval 결과를 눈으로 확인하는 thin entrypoint.
// 사용:
//   pnpm core:query "간이과세자 신고는 어떻게 해야 하나요?"
//   pnpm core:query "..." --tax_type=vat-simplified --k=5

type Args = { query: string; taxType?: string; k: number };

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
      'Usage: pnpm core:query "<question>" [--tax_type=<value>] [--k=<n>]',
    );
    process.exit(1);
  }
  return { query: positional.join(" "), taxType, k };
}

function preview(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
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

    const results = await core.retrieve(query, { k, filter });
    if (results.length === 0) {
      console.log("(no results)");
      return;
    }
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(
        `[${i + 1}] sim=${r.similarity.toFixed(3)}  ver=${r.doc_version ?? "-"}  page=${r.page ?? "-"}`,
      );
      console.log(`    ${r.doc_title}`);
      console.log(`    ${r.section_path ?? "-"}`);
      console.log(`    ${preview(r.content)}\n`);
    }
  } finally {
    await core.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
