import "dotenv/config";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createCore, parseEnv } from "../src";
import { PROMPT_VERSION } from "../src/chat/prompt";
import {
  type GoldenSet,
  lintGoldenSet,
} from "../src/eval/eval.service";
import { THROTTLE_MS, withThrottle } from "./_throttle";

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
    else if (a.startsWith("--limit="))
      limit = parseInt(a.slice("--limit=".length), 10);
    else if (a.startsWith("--k=")) k = parseInt(a.slice("--k=".length), 10);
  }
  return { lintOnly, limit, k };
}

// __dirname 대용 — packages/core/scripts/ 기준으로 monorepo root 도출.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const GOLDEN_PATH = resolve(REPO_ROOT, "data/eval/golden.json");
const SOURCES_PATH = resolve(REPO_ROOT, "data/sources.json");

// golden.json은 spec §4.4 컨벤션상 snake_case 그대로(사람이 작성하는 외부 JSON).
// boundary loader가 도메인 표면 camelCase로 변환 — core 내부는 GoldenSet/GoldenItem만 보면 된다.
type RawGoldenSet = {
  version: string;
  items: Array<{
    id: string;
    question: string;
    expected_keywords: string[];
    expected_citation_doc: string;
    category: string;
    difficulty: "easy" | "medium" | "hard";
    tax_type: string;
  }>;
};

function loadGolden(): GoldenSet {
  const raw = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as RawGoldenSet;
  return {
    version: raw.version,
    items: raw.items.map((it) => ({
      id: it.id,
      question: it.question,
      expectedKeywords: it.expected_keywords,
      expectedCitationDoc: it.expected_citation_doc,
      category: it.category,
      difficulty: it.difficulty,
      taxType: it.tax_type,
    })),
  };
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
    embeddingApiKey: env.VOYAGE_API_KEY,
    generationApiKey: env.OPENAI_API_KEY,
  });
  const ask = withThrottle(core.chat.ask, THROTTLE_MS);

  const startedAt = Date.now();
  try {
    const total = args.limit ?? set.items.length;
    console.log(`\nrunning ${total} item(s)  k=${args.k}\n`);

    const { runId, summary } = await core.eval.runEval({
      ask,
      set,
      options: {
        k: args.k,
        embeddingModel: core.embeddingModelId,
        promptVersion: PROMPT_VERSION,
        goldensetVersion: set.version,
        limit: args.limit,
      },
      onItem: (entry, idx, n) => {
        const sym =
          entry.weighted >= 0.7 ? "✓" : entry.weighted >= 0.5 ? "·" : "✗";
        console.log(
          `  [${idx + 1}/${n}] ${sym} ${entry.id}  w=${entry.weighted.toFixed(3)}  kr=${fmtPct(entry.scores.keywordRecall)}  cp=${entry.scores.citationPresent}  cc=${entry.scores.citationCorrect}  nh=${entry.scores.noHallucination}  (${entry.latencyMs}ms)`,
        );
      },
    });

    console.log(`\n--- summary (run ${runId}) ---`);
    console.log(`weightedAvg      : ${fmtPct(summary.weightedAvg)}`);
    console.log(`keywordRecall    : ${fmtPct(summary.axes.keywordRecall)}`);
    console.log(`citationPresent  : ${fmtPct(summary.axes.citationPresent)}`);
    console.log(`citationCorrect  : ${fmtPct(summary.axes.citationCorrect)}`);
    console.log(`noHallucination  : ${fmtPct(summary.axes.noHallucination)}`);
    console.log(
      `latency p50/p95  : ${summary.totals.latencyMsP50}ms / ${summary.totals.latencyMsP95}ms`,
    );
    console.log(
      `tokens in/out    : ${summary.totals.inputTokensSum} / ${summary.totals.outputTokensSum}`,
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
