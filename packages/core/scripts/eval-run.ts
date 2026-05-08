import "dotenv/config";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createCore, parseEnv } from "../src";
import {
  type GoldenSet,
  lintGoldenSet,
  runEval,
} from "../src/eval/runner";
import { PROMPT_VERSION } from "../src/rag/prompt";

// 2026-05-07 eval 슬라이스 §7 — `pnpm eval:run` CLI 진입.
// 사용:
//   pnpm eval:run                 # 30문항 전체
//   pnpm eval:run --lint-only     # 분배·슬러그·source_id 정합성만 확인 후 종료
//   pnpm eval:run --limit=5       # 처음 5문항만(스모크)
//   pnpm eval:run --k=6

type Args = {
  lintOnly: boolean;
  limit: number | undefined;
  k: number;
};

function parseArgs(argv: string[]): Args {
  let lintOnly = false;
  let limit: number | undefined;
  let k = 8;
  for (const a of argv) {
    if (a === "--lint-only") lintOnly = true;
    else if (a.startsWith("--limit=")) limit = parseInt(a.slice("--limit=".length), 10);
    else if (a.startsWith("--k=")) k = parseInt(a.slice("--k=".length), 10);
  }
  return { lintOnly, limit, k };
}

// __dirname 대용 — packages/core/scripts/ 기준으로 monorepo root 도출.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const GOLDEN_PATH = resolve(REPO_ROOT, "data/eval/golden.json");
const SOURCES_PATH = resolve(REPO_ROOT, "data/sources.json");

function loadGolden(): GoldenSet {
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenSet;
}

function loadValidSourceIds(): Set<string> {
  const parsed = JSON.parse(readFileSync(SOURCES_PATH, "utf8")) as {
    pdfs: { id: string }[];
  };
  return new Set(parsed.pdfs.map((p) => p.id));
}

const fmtPct = (x: number) => (x * 100).toFixed(1) + "%";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const set = loadGolden();
  const validIds = loadValidSourceIds();

  const lint = lintGoldenSet(set, validIds);
  if (!lint.ok) {
    console.error("✗ goldenset lint failed:");
    for (const err of lint.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  console.log(
    `✓ lint passed: ${set.items.length} items, version=${set.version}`,
  );

  if (args.lintOnly) return;

  const env = parseEnv(process.env);
  const core = createCore({
    databaseUrl: env.DATABASE_URL,
    voyageApiKey: env.VOYAGE_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
  });

  const startedAt = Date.now();
  try {
    const total = args.limit ?? set.items.length;
    console.log(`\nrunning ${total} item(s)  k=${args.k}\n`);

    const { runId, summary } = await runEval({
      ask: core.ask,
      gateway: core.gateway,
      set,
      options: {
        k: args.k,
        // Voyage 임베딩 라벨 — voyage.ts와 동기. 변경 시 한곳 더 만지지 않도록 v2에서 상수화.
        embeddingModel: "voyage-3",
        promptVersion: PROMPT_VERSION,
        goldensetVersion: set.version,
        limit: args.limit,
      },
      onItem: (entry, idx, n) => {
        const sym =
          entry.weighted >= 0.7 ? "✓" : entry.weighted >= 0.5 ? "·" : "✗";
        console.log(
          `  [${idx + 1}/${n}] ${sym} ${entry.id}  w=${entry.weighted.toFixed(3)}  kr=${fmtPct(entry.scores.keyword_recall)}  cp=${entry.scores.citation_present}  cc=${entry.scores.citation_correct}  nh=${entry.scores.no_hallucination}  (${entry.latency_ms}ms)`,
        );
      },
    });

    console.log(`\n--- summary (run ${runId}) ---`);
    console.log(`weighted_avg     : ${fmtPct(summary.weighted_avg)}`);
    console.log(`keyword_recall   : ${fmtPct(summary.axes.keyword_recall)}`);
    console.log(`citation_present : ${fmtPct(summary.axes.citation_present)}`);
    console.log(`citation_correct : ${fmtPct(summary.axes.citation_correct)}`);
    console.log(`no_hallucination : ${fmtPct(summary.axes.no_hallucination)}`);
    console.log(
      `latency p50/p95  : ${summary.totals.latency_ms_p50}ms / ${summary.totals.latency_ms_p95}ms`,
    );
    console.log(
      `tokens in/out    : ${summary.totals.input_tokens_sum} / ${summary.totals.output_tokens_sum}`,
    );
    console.log(
      `failures (<0.5)  : ${summary.failures.length === 0 ? "none" : summary.failures.join(", ")}`,
    );
    console.log(
      `elapsed          : ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
    );
  } finally {
    await core.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
