import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

import type { Citation } from "#common/citation";
import type { SearchResult } from "#modules/retrieval/chunk.repository";
import { VoyageRerankCompressor } from "#modules/retrieval/rerank.adapter";
import type { RetrieveFn } from "#modules/retrieval/retrieval.service";

import type { GenerationModel } from "../generation.adapter";

// 그래프 state — 모든 노드 공통 channel. retrieval/answer subgraph 둘 다 동일 schema 공유.
// LangGraph TS는 같은 schema끼리 subgraph wrap 시 channel 자동 read/write.
export const RagState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // rewrite_query 출력 — follow-up referring expression 해소된 standalone query.
  // search_direct·generate_draft 검색 키 입력. 단일 턴이면 last message 그대로 통과.
  rewrittenQuery: Annotation<string>(),
  directChunks: Annotation<SearchResult[]>(),
  draft: Annotation<string>(),
  claims: Annotation<string[]>(),
  claimChunks: Annotation<SearchResult[][]>(),
  // fuse 결과 — answer 노드 입력 + chat.service의 retrievedChunkIds persist 키.
  toolChunks: Annotation<SearchResult[]>(),
  answer: Annotation<string>(),
  citations: Annotation<Citation[]>(),
});

export type RagStateType = typeof RagState.State;

// composition root(createRagGraph)가 받는 외부 deps.
export type RagGraphDeps = {
  generationModel: GenerationModel;
  retrieve: RetrieveFn;
  voyageApiKey: string;
};

// 개별 노드 factory가 받는 deps — composition root에서 한 번 만들어 모든 노드에 공유.
export type NodeDeps = {
  model: GenerationModel["model"];
  retrieve: RetrieveFn;
  rerank: VoyageRerankCompressor;
};

export function toNodeDeps(deps: RagGraphDeps): NodeDeps {
  return {
    model: deps.generationModel.model,
    retrieve: deps.retrieve,
    rerank: new VoyageRerankCompressor({ apiKey: deps.voyageApiKey }),
  };
}

// 노드 단위 디버그 dump — RAG_DEBUG=1일 때만 stderr emit.
const RAG_DEBUG = process.env.RAG_DEBUG === "1";
export function dbg(node: string, payload: Record<string, unknown>): void {
  if (!RAG_DEBUG) return;
  console.error(`\n========== [rag:${node}] ==========`);
  console.error(JSON.stringify(payload, null, 2));
}

const PREVIEW_DEFAULT = 250;
export function preview(s: string, n = PREVIEW_DEFAULT): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}
