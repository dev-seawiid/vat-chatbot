import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

import {
  type PgvectorDocMetadata,
  type RetrieveFn,
  type SearchResult,
  toDocument,
  VoyageRerankCompressor,
} from "#modules/retrieval/index";

import { DRAFT_WITH_CLAIMS_SYSTEM, REWRITE_QUERY_SYSTEM } from "../../prompt";
import { dbg, type NodeDeps, preview, type RagStateType } from "../shared";

// === draft+claims structured output ===
// draft는 디버그용, claims만 검색 키.
const DraftSchema = z.object({
  draft: z.string(),
  claims: z.array(z.string()).max(6),
});
type Draft = z.infer<typeof DraftSchema>;

// === rewrite_query structured output ===
const RewriteSchema = z.object({
  rewrittenQuery: z.string(),
});

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

// 그래프 진입점: history + last user message → standalone query.
// 단일 턴(history 없음)이면 last 그대로 통과 — LLM bypass로 latency·cost 절감.
// 갈래 A·B 모두 본 노드 출력(state.rewrittenQuery)을 검색 키로 사용.
export const rewriteQuery = (deps: NodeDeps) =>
  async (state: RagStateType) => {
    const t0 = Date.now();
    const messages = state.messages ?? [];
    const last = messages[messages.length - 1];
    const lastText = last?.text ?? "";
    const history = messages.slice(0, -1);

    if (history.length === 0) {
      dbg("rewrite_query", {
        ms: Date.now() - t0,
        bypass: true,
        query: preview(lastText, 200),
      });
      return { rewrittenQuery: lastText };
    }

    const historyLines = history
      .map((m) => {
        const role = m instanceof HumanMessage
          ? "user"
          : m instanceof AIMessage
            ? "assistant"
            : "other";
        return `${role}: ${m.text ?? ""}`;
      })
      .join("\n");
    const userContent = `대화:\n${historyLines}\nuser: ${lastText}`;

    const rewriteModel = deps.models.rewrite.model.withStructuredOutput(
      RewriteSchema,
    );
    const result = (await rewriteModel.invoke([
      { role: "system", content: REWRITE_QUERY_SYSTEM },
      { role: "user", content: userContent },
    ])) as z.infer<typeof RewriteSchema>;

    const rewritten = result.rewrittenQuery?.trim() || lastText;
    dbg("rewrite_query", {
      ms: Date.now() - t0,
      bypass: false,
      original: preview(lastText, 200),
      rewritten: preview(rewritten, 200),
      historyLen: history.length,
    });
    return { rewrittenQuery: rewritten };
  };

// rewrite_query 미실행(직접 호출 등) fallback 포함 — state.rewrittenQuery 비면 last text.
function pickQuery(state: RagStateType): string {
  const rw = state.rewrittenQuery?.trim();
  if (rw) return rw;
  const last = state.messages[state.messages.length - 1];
  return last?.text ?? "";
}

// 갈래 A: rewritten query 직접 검색.
export const searchDirect = (deps: NodeDeps) =>
  async (state: RagStateType) => {
    const t0 = Date.now();
    const query = pickQuery(state);
    const chunks = await searchWithRerank(
      deps.retrieve,
      deps.rerank,
      query,
      DIRECT_K,
    );
    dbg("search_direct", {
      ms: Date.now() - t0,
      query: preview(query, 200),
      chunkCount: chunks.length,
      chunkIds: chunks.map((c) => c.chunkId),
    });
    return { directChunks: chunks };
  };

// 갈래 B-1: LLM 자체지식 draft + atomic claims 생성. 출력은 사용자 비노출, 검색 키 전용.
export const generateDraft = (deps: NodeDeps) =>
  async (state: RagStateType) => {
    const t0 = Date.now();
    const query = pickQuery(state);
    // today 주입 — draft가 자기 지식 중 "현재 시행 중" 버전(최근 개정 반영)으로 초안을 쓰게
    // anchor. 검색 키를 현행 어휘에 가깝게 만드는 목적(컷오프 이내 개정에 한해 효과).
    const today = new Date().toISOString().slice(0, 10);
    const draftModel = deps.models.draft.model.withStructuredOutput(DraftSchema);
    const result = (await draftModel.invoke([
      { role: "system", content: `<today>${today}</today>\n\n${DRAFT_WITH_CLAIMS_SYSTEM}` },
      { role: "user", content: query },
    ])) as Draft;
    dbg("generate_draft", {
      ms: Date.now() - t0,
      query: preview(query, 200),
      draft: preview(result.draft, 400),
      claims: result.claims,
    });
    return { draft: result.draft, claims: result.claims };
  };

// 갈래 B-2: claim별 retrieve+rerank 병렬.
export const claimSearches = (deps: NodeDeps) =>
  async (state: RagStateType) => {
    const t0 = Date.now();
    const claims = state.claims ?? [];
    const results = await Promise.all(
      claims.map((c) =>
        searchWithRerank(deps.retrieve, deps.rerank, c, CLAIM_K),
      ),
    );
    dbg("claim_searches", {
      ms: Date.now() - t0,
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
    const t0 = Date.now();
    const lists: SearchResult[][] = [];
    if (state.directChunks?.length) lists.push(state.directChunks);
    if (state.claimChunks?.length) lists.push(...state.claimChunks);
    const fused = reciprocalRankFusion(lists, FUSE_TOP_N);
    dbg("fuse", {
      ms: Date.now() - t0,
      listCount: lists.length,
      perListCount: lists.map((l) => l.length),
      fusedCount: fused.length,
      fusedIds: fused.map((c) => c.chunkId),
    });
    return { toolChunks: fused };
  };
