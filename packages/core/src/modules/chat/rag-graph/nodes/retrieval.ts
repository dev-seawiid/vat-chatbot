import { z } from "zod";

import type { SearchResult } from "#modules/retrieval/chunk.repository";
import { VoyageRerankCompressor } from "#modules/retrieval/rerank.adapter";
import type { RetrieveFn } from "#modules/retrieval/retrieval.service";
import {
  type PgvectorDocMetadata,
  toDocument,
} from "#modules/retrieval/retriever.adapter";

import { DRAFT_WITH_CLAIMS_SYSTEM } from "../../prompt";
import { dbg, type NodeDeps, preview, type RagStateType } from "../shared";

// === draft+claims structured output ===
// draft는 디버그용, claims만 검색 키.
const DraftSchema = z.object({
  draft: z.string(),
  claims: z.array(z.string()).max(6),
});
type Draft = z.infer<typeof DraftSchema>;

// === RRF ===
// 같은 chunk가 여러 list 상위에 등장하면 score 누적. k=60 = Cormack 2009 원논문 표준값.
const RRF_K = 60;
function reciprocalRankFusion(
  lists: SearchResult[][],
  topN: number,
): SearchResult[] {
  const scoreById = new Map<string, number>();
  const chunkById = new Map<string, SearchResult>();
  for (const list of lists) {
    list.forEach((c, rank) => {
      scoreById.set(
        c.chunkId,
        (scoreById.get(c.chunkId) ?? 0) + 1 / (RRF_K + rank),
      );
      if (!chunkById.has(c.chunkId)) chunkById.set(c.chunkId, c);
    });
  }
  return Array.from(scoreById.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([id]) => chunkById.get(id)!);
}

// retrieve(=embed+pgvector top-k)는 rerank 안 함 — 본 헬퍼가 prefilter→rerank→slice 묶음.
const PREFILTER_K = 50;
async function searchWithRerank(
  retrieve: RetrieveFn,
  rerank: VoyageRerankCompressor,
  query: string,
  k: number,
): Promise<SearchResult[]> {
  const prefilter = await retrieve(query, { k: PREFILTER_K });
  const docs = prefilter.map(toDocument);
  const ranked = (await rerank.compressDocuments(docs, query)) as ReturnType<
    typeof toDocument
  >[];
  return ranked
    .slice(0, k)
    .map((d) => (d.metadata as PgvectorDocMetadata).searchResult);
}

const DIRECT_K = 8;
const CLAIM_K = 4;
const FUSE_TOP_N = 10;

// === 노드 factory — curried (deps) => async (state) => partial state ===

// 갈래 A: 원 query 직접 검색.
export const searchDirect = (deps: NodeDeps) =>
  async (state: RagStateType) => {
    const last = state.messages[state.messages.length - 1];
    const query = last?.text ?? "";
    const chunks = await searchWithRerank(
      deps.retrieve,
      deps.rerank,
      query,
      DIRECT_K,
    );
    dbg("search_direct", {
      query: preview(query, 200),
      chunkCount: chunks.length,
      chunkIds: chunks.map((c) => c.chunkId),
    });
    return { directChunks: chunks };
  };

// 갈래 B-1: LLM 자체지식 draft + atomic claims 생성. 출력은 사용자 비노출, 검색 키 전용.
export const generateDraft = (deps: NodeDeps) =>
  async (state: RagStateType) => {
    const last = state.messages[state.messages.length - 1];
    const query = last?.text ?? "";
    const draftModel = deps.model.withStructuredOutput(DraftSchema);
    const result = (await draftModel.invoke([
      { role: "system", content: DRAFT_WITH_CLAIMS_SYSTEM },
      { role: "user", content: query },
    ])) as Draft;
    dbg("generate_draft", {
      query: preview(query, 200),
      draft: preview(result.draft, 400),
      claims: result.claims,
    });
    return { draft: result.draft, claims: result.claims };
  };

// 갈래 B-2: claim별 retrieve+rerank 병렬.
export const claimSearches = (deps: NodeDeps) =>
  async (state: RagStateType) => {
    const claims = state.claims ?? [];
    const results = await Promise.all(
      claims.map((c) =>
        searchWithRerank(deps.retrieve, deps.rerank, c, CLAIM_K),
      ),
    );
    dbg("claim_searches", {
      perClaim: results.map((r, i) => ({
        claim: preview(claims[i] ?? "", 120),
        chunkIds: r.map((c) => c.chunkId),
      })),
    });
    return { claimChunks: results };
  };

// fuse: 두 갈래 ranked list를 RRF로 결합 → top N. deps 불요.
export const fuse = () =>
  async (state: RagStateType) => {
    const lists: SearchResult[][] = [];
    if (state.directChunks?.length) lists.push(state.directChunks);
    if (state.claimChunks?.length) lists.push(...state.claimChunks);
    const fused = reciprocalRankFusion(lists, FUSE_TOP_N);
    dbg("fuse", {
      listCount: lists.length,
      perListCount: lists.map((l) => l.length),
      fusedCount: fused.length,
      fusedIds: fused.map((c) => c.chunkId),
    });
    return { toolChunks: fused };
  };
