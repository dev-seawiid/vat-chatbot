import "dotenv/config";
import { readFileSync } from "node:fs";

import type { SearchResult } from "../src/modules/retrieval/chunk.repository";
import { createCore, parseEnv } from "../src";
import { buildPayload, emitJson, logCitations } from "./lib/output";

// generation-only — 외부 주입 chunks로 answer 노드만 실행. retrieval·draft·claim 우회.
// eval factorial design(reasoning 상한 측정) · 디버깅 · 재현 테스트용. production 사용 금지.
//
// 사용:
//   pnpm core:generate "..." --chunks=<path.json> --json
//
// chunks JSON 포맷: [{chunkId, content, metadata, docTitle?, ...}, ...]

type Args = { query: string; chunksPath: string; json: boolean };

type InjectedChunkInput = {
  chunkId: string;
  content: string;
  metadata: Record<string, unknown>;
  docId?: string;
  docTitle?: string;
  docVersion?: string | null;
  sourceUrl?: string | null;
  page?: number | null;
  sectionPath?: string | null;
};

function loadChunks(path: string): SearchResult[] {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as InjectedChunkInput[];
  return raw.map((c) => ({
    chunkId: c.chunkId,
    docId: c.docId ?? "",
    docTitle: c.docTitle ?? "(injected)",
    docVersion: c.docVersion ?? null,
    sourceUrl: c.sourceUrl ?? null,
    page: c.page ?? null,
    sectionPath: c.sectionPath ?? null,
    content: c.content,
    similarity: 0,
    metadata: c.metadata,
  }));
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let chunksPath: string | undefined;
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a.startsWith("--chunks=")) chunksPath = a.slice("--chunks=".length);
    else positional.push(a);
  }
  if (positional.length === 0 || !chunksPath) {
    console.error(
      'Usage: pnpm core:generate "<question>" --chunks=<path.json> [--json]',
    );
    process.exit(1);
  }
  return { query: positional.join(" "), chunksPath, json };
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
    const { query, chunksPath, json } = parseArgs(process.argv.slice(2));
    const chunks = loadChunks(chunksPath);
    const log = json ? console.error : console.log;

    log(`\nQuery   : ${query}`);
    log(`chunks  : ${chunks.length} from ${chunksPath}`);
    log(`mode    : generation-only\n`);

    const r = await core.chat.generate(query, chunks);
    const meta = await r.finish;

    log("--- answer ---");
    if (!json) process.stdout.write(meta.text + "\n");
    log("\n--------------\n");
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
