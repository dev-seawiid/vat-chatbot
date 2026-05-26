import {
  type BaseMessage,
  HumanMessage,
  isToolMessage,
} from "@langchain/core/messages";
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

import {
  type Citation,
  findQuote,
  toCitation,
  toCitationUnmatched,
} from "#common/citation";
import type { SearchResult } from "#modules/retrieval/chunk.repository";
import { VoyageRerankCompressor } from "#modules/retrieval/rerank.adapter";
import type { RetrieveFn } from "#modules/retrieval/retrieval.service";
import {
  type PgvectorDocMetadata,
  toDocument,
} from "#modules/retrieval/retriever.adapter";

import type { GenerationModel } from "./generation.adapter";
import { ANSWER_SYSTEM, DRAFT_WITH_CLAIMS_SYSTEM } from "./prompt";
import { createAnswerTools } from "./tools";

// 그래프 구조 (v15, ADR-0003 §3): HyDE + Claim Decomposition + RRF.
//   START ─┬─ search_direct ──────────────┐
//          │                              ├─ fuse(RRF) ─ answer ─ END
//          └─ generate_draft → claim_searches ┘
//
// search_direct: 원 query 1회 retrieve+rerank (k=8).
// generate_draft: LLM 1회 structured output {draft, claims[≤6]} — 사용자에게 안 보임, 검색 키.
// claim_searches: claims별 retrieve+rerank 병렬 (각 k=4).
// fuse: 모든 list를 RRF로 결합 (rank 기반 가중) → top 10.
// answer: createReactAgent + structured output. citation substring 검증.

// draft+claims structured output. draft는 디버그용, claims만 검색 키.
const DraftSchema = z.object({
  draft: z.string(),
  claims: z.array(z.string()).max(6),
});
type Draft = z.infer<typeof DraftSchema>;

const AnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(
    z.object({
      chunkId: z.string(),
      quote: z.string(),
    }),
  ),
});

export type AgentAnswer = z.infer<typeof AnswerSchema>;

const RAG_DEBUG = process.env.RAG_DEBUG === "1";
function dbg(node: string, payload: Record<string, unknown>): void {
  if (!RAG_DEBUG) return;
  console.error(`\n========== [rag:${node}] ==========`);
  console.error(JSON.stringify(payload, null, 2));
}
const PREVIEW = 250;
function preview(s: string, n = PREVIEW): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

// retrieval.service.retrieve는 embed+pgvector top-k만, rerank는 별도. 본 헬퍼가 50→k rerank를 묶음.
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

// Reciprocal Rank Fusion. 같은 chunk가 여러 list 상위에 등장하면 score 누적되어 위로 올라옴.
// k=60은 원논문(Cormack 2009) 표준값. list별 rank 0-base.
const RRF_K = 60;
function reciprocalRankFusion(
  lists: SearchResult[][],
  topN: number,
): SearchResult[] {
  const scoreById = new Map<string, number>();
  const chunkById = new Map<string, SearchResult>();
  for (const list of lists) {
    list.forEach((c, rank) => {
      scoreById.set(c.chunkId, (scoreById.get(c.chunkId) ?? 0) + 1 / (RRF_K + rank));
      if (!chunkById.has(c.chunkId)) chunkById.set(c.chunkId, c);
    });
  }
  return Array.from(scoreById.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([id]) => chunkById.get(id)!);
}

const RagState = Annotation.Root({
  ...MessagesAnnotation.spec,
  directChunks: Annotation<SearchResult[]>(),
  draft: Annotation<string>(),
  claims: Annotation<string[]>(),
  claimChunks: Annotation<SearchResult[][]>(),
  // fuse 결과 — answer 노드 입력 + chat.service의 retrievedChunkIds persist 키.
  // 이전 그래프와 동일 키명을 유지해 chat.service 인터페이스 변경 없음.
  toolChunks: Annotation<SearchResult[]>(),
  answer: Annotation<string>(),
  citations: Annotation<Citation[]>(),
});

const DIRECT_K = 8;
const CLAIM_K = 4;
const FUSE_TOP_N = 10;

export type RagGraphDeps = {
  generationModel: GenerationModel;
  retrieve: RetrieveFn;
  voyageApiKey: string;
};

export function createRagGraph({
  generationModel,
  retrieve,
  voyageApiKey,
}: RagGraphDeps) {
  const { model } = generationModel;
  const rerank = new VoyageRerankCompressor({ apiKey: voyageApiKey });

  // === 갈래 A: 원 query 직접 검색 ===
  const searchDirectNode = async (state: typeof RagState.State) => {
    const last = state.messages[state.messages.length - 1];
    const query = last?.text ?? "";
    const chunks = await searchWithRerank(retrieve, rerank, query, DIRECT_K);
    dbg("search_direct", {
      query: preview(query, 200),
      chunkCount: chunks.length,
      chunkIds: chunks.map((c) => c.chunkId),
    });
    return { directChunks: chunks };
  };

  // === 갈래 B-1: LLM 자체지식 draft + atomic claims 생성 ===
  // 출력은 사용자에게 안 보임, 검색 키로만. hallucination은 fuse + answer의 chunk-grounding에서 차단.
  const generateDraftNode = async (state: typeof RagState.State) => {
    const last = state.messages[state.messages.length - 1];
    const query = last?.text ?? "";
    const draftModel = model.withStructuredOutput(DraftSchema);
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

  // === 갈래 B-2: claim별 retrieve+rerank 병렬 ===
  const claimSearchesNode = async (state: typeof RagState.State) => {
    const claims = state.claims ?? [];
    const results = await Promise.all(
      claims.map((c) => searchWithRerank(retrieve, rerank, c, CLAIM_K)),
    );
    dbg("claim_searches", {
      perClaim: results.map((r, i) => ({
        claim: preview(claims[i] ?? "", 120),
        chunkIds: r.map((c) => c.chunkId),
      })),
    });
    return { claimChunks: results };
  };

  // === fuse: 두 갈래 ranked list를 RRF로 결합 → top N ===
  const fuseNode = async (state: typeof RagState.State) => {
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

  // === answer: createReactAgent + calc 도구 + structured output. citation substring 검증. ===
  // 검증 모드 — draft + claim-evidence 매핑을 같이 받아, chunk만 보고 처음부터 합성하지 않고
  // draft의 각 claim을 evidence로 verify·reject (Verify-and-Edit / ALCE 패턴).
  const answerNode = async (state: typeof RagState.State) => {
    const chunks = state.toolChunks ?? [];
    const draft = state.draft ?? "";
    const claims = state.claims ?? [];
    const claimChunks = state.claimChunks ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const tools = createAnswerTools();
    const agent = createReactAgent({
      llm: model,
      tools,
      prompt: `<today>${today}</today>\n\n${ANSWER_SYSTEM}`,
      responseFormat: AnswerSchema,
    });

    const history = state.messages.slice(0, -1);
    const last = state.messages[state.messages.length - 1];
    const lastUserText = last?.text ?? "";
    const combined = new HumanMessage(
      [
        `<draft>\n${draft || "(없음)"}\n</draft>`,
        `<claim_evidence>\n${serializeClaimEvidence(claims, claimChunks)}\n</claim_evidence>`,
        `<chunks>\n${serializeChunks(chunks)}\n</chunks>`,
        `<question>\n${lastUserText}\n</question>`,
      ].join("\n\n"),
    );

    const result = await agent.invoke({ messages: [...history, combined] });
    const structured = (
      result as unknown as { structuredResponse?: AgentAnswer }
    ).structuredResponse;
    const finalAnswer = structured?.answer ?? "";
    const rawCitations = structured?.citations ?? [];

    const answerToolMessages = (result.messages as BaseMessage[]).filter(
      isToolMessage,
    );

    const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));
    const verified: Citation[] = [];
    const verifyTrace: Array<Record<string, unknown>> = [];
    for (const c of rawCitations) {
      const chunk = resolveChunk(c.chunkId, chunkById);
      if (!chunk) {
        verifyTrace.push({
          chunkId: c.chunkId,
          quote: c.quote,
          result: "DROP — chunkId 미일치",
        });
        continue;
      }
      const match = findQuote(chunk.content, c.quote);
      if (!match) {
        // 6-tier 매칭 모두 실패 — chunk는 RRF가 적합하다 판단했으니 highlight 없이 노출.
        verifyTrace.push({
          chunkId: chunk.chunkId,
          quote: c.quote,
          chunkContent: preview(chunk.content, 400),
          result: "FALLBACK — quote substring 불일치, highlight 없이 노출",
        });
        verified.push(toCitationUnmatched(chunk, c.quote));
        continue;
      }
      verifyTrace.push({
        chunkId: chunk.chunkId,
        rawQuote: c.quote,
        matchRange: match,
        normalizedAdjusted: c.chunkId !== chunk.chunkId,
        result: "OK",
      });
      verified.push(toCitation(chunk, match));
    }

    dbg("answer", {
      chunkInput: chunks.length,
      lastUser: preview(lastUserText, 200),
      toolCalls: answerToolMessages.map((m) => ({
        name: m.name,
        contentPreview: preview(
          typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          200,
        ),
      })),
      llmRaw: { answer: finalAnswer, citations: rawCitations },
      verify: verifyTrace,
      output: { answer: finalAnswer, verifiedCount: verified.length },
    });

    return { answer: finalAnswer, citations: verified };
  };

  return new StateGraph(RagState)
    .addNode("search_direct", searchDirectNode)
    .addNode("generate_draft", generateDraftNode)
    .addNode("claim_searches", claimSearchesNode)
    .addNode("fuse", fuseNode)
    .addNode("generate_answer", answerNode)
    .addEdge(START, "search_direct")
    .addEdge(START, "generate_draft")
    .addEdge("generate_draft", "claim_searches")
    .addEdge(["search_direct", "claim_searches"], "fuse")
    .addEdge("fuse", "generate_answer")
    .addEdge("generate_answer", END)
    .compile();
}

export type RagGraph = ReturnType<typeof createRagGraph>;

// claim-evidence 매핑을 LLM-facing 직렬 포맷으로. claim[i] ↔ claimChunks[i] index-aligned.
// chunkId만 노출 — chunk 본문은 <chunks> 블록에 한 번만 직렬화해 중복 토큰 방지.
function serializeClaimEvidence(
  claims: string[],
  claimChunks: SearchResult[][],
): string {
  if (claims.length === 0) return "(없음)";
  return claims
    .map((claim, i) => {
      const ids = (claimChunks[i] ?? []).map((c) => c.chunkId).join(", ");
      return `claim ${i + 1}: ${claim}\n  evidence chunkIds: [${ids || "없음"}]`;
    })
    .join("\n\n");
}

// chunk를 answer agent의 LLM-facing 직렬 포맷으로. citation chunkId 라벨이 ANSWER_SYSTEM 규칙과 동일.
function serializeChunks(chunks: SearchResult[]): string {
  if (chunks.length === 0) return "검색 결과 없음.";
  return chunks
    .map((c) => {
      const meta = [
        c.docTitle,
        c.docVersion ? `버전 ${c.docVersion}` : null,
        c.page != null ? `p.${c.page}` : null,
        c.sectionPath,
      ]
        .filter(Boolean)
        .join(" · ");
      return `[chunkId=${c.chunkId}] ${meta}\n${c.content}`;
    })
    .join("\n\n");
}

// 모델이 chunkId 끝자리 1글자를 흔히 hallucinate함 (UUID 36자 중 1자 차이). strict 매칭 실패 시
// UUID 8자 prefix로 매칭. fuse 결과가 turn당 ~10개라 충돌 위험 미미.
function resolveChunk(
  modelChunkId: string,
  registry: Map<string, SearchResult>,
): SearchResult | null {
  const strict = registry.get(modelChunkId);
  if (strict) return strict;
  const prefix = modelChunkId.slice(0, 8);
  if (prefix.length < 8) return null;
  const candidates: SearchResult[] = [];
  for (const c of registry.values()) {
    if (c.chunkId.slice(0, 8) === prefix) candidates.push(c);
  }
  return candidates.length === 1 ? candidates[0]! : null;
}
