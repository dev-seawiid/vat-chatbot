// 모드별 CLI(scripts/ask.ts / retrieve.ts / generate.ts) 공용 출력 헬퍼.
// eval 브릿지(ragas-eval contexts·answer + lbr-eval chunks·citations)가 한 contract로 받게 통합.

import type { Citation } from "../../src/common/citation";
import type { SearchResult } from "../../src/modules/retrieval/chunk.repository";

export type JsonPayload = {
  answer: string;
  contexts: string[];
  chunks: Array<{
    chunkId: string;
    docTitle: string;
    page: number | null;
    sectionPath: string | null;
    metadata: Record<string, unknown>;
  }>;
  citations: Array<{
    chunkId: string;
    quote: string;
    docTitle: string;
    page: number | null;
    sectionPath: string | null;
  }>;
};

export function buildPayload(args: {
  answer: string;
  chunks: SearchResult[];
  citations: Citation[];
}): JsonPayload {
  return {
    answer: args.answer,
    contexts: args.chunks.map((c) => c.content),
    chunks: args.chunks.map((c) => ({
      chunkId: c.chunkId,
      docTitle: c.docTitle,
      page: c.page,
      sectionPath: c.sectionPath,
      metadata: c.metadata,
    })),
    citations: args.citations.map((c) => ({
      chunkId: c.chunkId,
      quote: c.quote,
      docTitle: c.docTitle,
      page: c.page,
      sectionPath: c.sectionPath,
    })),
  };
}

export function emitJson(payload: JsonPayload): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

export function logCitations(
  log: (s: string) => void,
  citations: Citation[],
): void {
  log("--- citations (verified) ---");
  for (let i = 0; i < citations.length; i++) {
    const c = citations[i];
    log(
      `[${i + 1}] ${c.docTitle}${c.docVersion ? ` · ${c.docVersion}` : ""}${
        c.page != null ? ` · p.${c.page}` : ""
      }`,
    );
    if (c.sectionPath) log(`    ${c.sectionPath}`);
  }
}
