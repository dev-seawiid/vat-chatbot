import { type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";

import type { Citation } from "#common/citation";
import type { SearchResult } from "#modules/retrieval/chunk.repository";

import { answer } from "./nodes/answer";
import * as R from "./nodes/retrieval";
import { type RagGraphDeps, RagState, toNodeDeps } from "./shared";

// 그래프 구조 (v16, ADR-0003 §2·§7): Follow-up Rewrite + HyDE + Claim Decomposition + RRF.
//   START → rewrite_query ─┬─ search_direct ──────────────────┐
//                          │                                  ├─ fuse(RRF) ─ END   (retrievalSubgraph)
//                          └─ generate_draft → claim_searches ┘
//
//   START → retrieve(subgraph) → generate_answer → END         (full graph)
//
// 노드 구현은 nodes/retrieval·answer 파일에 분리. 본 파일은 wiring + composition만.

export function createRagGraph(deps: RagGraphDeps) {
  const nodeDeps = toNodeDeps(deps);

  // retrieval subgraph — rewrite + direct + draft+claims + RRF fuse. answer 노드 없음.
  // 단일 진실 — full graph가 본 subgraph를 단일 node로 wrap, lbr-eval은 본 subgraph 직접 invoke.
  // node·edge 변경은 한 곳에서만, 양쪽 자동 반영(sync drift 차단).
  // rewrite_query는 history 빈 배열이면 LLM bypass — lbr-eval(단일 query) 환경에서 cost·latency 0.
  const retrievalSubgraph = new StateGraph(RagState)
    .addNode("rewrite_query", R.rewriteQuery(nodeDeps))
    .addNode("search_direct", R.searchDirect(nodeDeps))
    .addNode("generate_draft", R.generateDraft(nodeDeps))
    .addNode("claim_searches", R.claimSearches(nodeDeps))
    .addNode("fuse", R.fuse())
    .addEdge(START, "rewrite_query")
    .addEdge("rewrite_query", "search_direct")
    .addEdge("rewrite_query", "generate_draft")
    .addEdge("generate_draft", "claim_searches")
    .addEdge(["search_direct", "claim_searches"], "fuse")
    .addEdge("fuse", END)
    .compile();

  // full graph = retrieval subgraph + generate_answer. RagState 동일 schema → wrapper 함수 불요
  // (LangGraph TS 공식 패턴: 같은 channel 공유 시 compiled subgraph를 addNode 직접 전달).
  const answerNode = answer(nodeDeps);
  const graph = new StateGraph(RagState)
    .addNode("retrieve", retrievalSubgraph)
    .addNode("generate_answer", answerNode)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "generate_answer")
    .addEdge("generate_answer", END)
    .compile();

  const retrievalOnly = async (
    messages: BaseMessage[],
  ): Promise<{ chunks: SearchResult[] }> => {
    const final = await retrievalSubgraph.invoke(
      { messages },
      { recursionLimit: 10 },
    );
    return { chunks: final.toolChunks ?? [] };
  };

  // generation-only — retrieval·draft·claim 우회, 주입 chunks로 answer 노드만 실행.
  // ANSWER_SYSTEM의 <draft>/<claim_evidence> 슬롯은 serialize 헬퍼가 "(없음)" 처리.
  const generateOnly = async (
    messages: BaseMessage[],
    chunks: SearchResult[],
  ): Promise<{
    answer: string;
    citations: Citation[];
    chunks: SearchResult[];
  }> => {
    const partial = await answerNode({
      messages,
      rewrittenQuery: "",
      directChunks: [],
      draft: "",
      claims: [],
      claimChunks: [],
      toolChunks: chunks,
      answer: "",
      citations: [],
    });
    return {
      answer: partial.answer ?? "",
      citations: partial.citations ?? [],
      chunks,
    };
  };

  return { graph, retrievalOnly, generateOnly };
}

export type RagGraph = ReturnType<typeof createRagGraph>;
export type { AgentAnswer } from "./nodes/answer";
