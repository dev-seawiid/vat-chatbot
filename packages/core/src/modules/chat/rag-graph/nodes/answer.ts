import {
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
// TODO(lc-v1 migration): createReactAgent deprecated → `langchain.createAgent` 권장.
// 마이그레이션 보류 사유: (1) zod 3.25 ZodType ↔ langchain InteropZodType 구조 매칭 실패,
// (2) `tool()` 결과(DynamicStructuredTool)가 createAgent의 ClientTool|ServerTool 타입과 불일치.
// 해결에는 zod 4 전환 또는 tool wrapper 재작성 필요 — 별도 작업으로 분리.
import { z } from "zod";

import {
  type Citation,
  findQuote,
  toCitation,
  toCitationUnmatched,
} from "#common/citation";
import type { SearchResult } from "#modules/retrieval/index";

import { ANSWER_SYSTEM } from "../../prompt";
import { createAnswerTools } from "../../tools";
import { dbg, type NodeDeps, preview, type RagStateType } from "../shared";

// === answer agent structured output ===
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

// === LLM-facing 직렬화 ===

// claim-evidence 매핑 직렬 포맷. claim[i] ↔ claimChunks[i] index-aligned.
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

// === citation 검증 ===
// LLM이 emit한 rawCitations를 chunk·quote 매칭으로 검증.
// 결과: { verified: Citation[], trace: 디버그용 }. answer 노드 본체에서 분리해 가독성 ↑.
type RawCitation = AgentAnswer["citations"][number];

function verifyCitations(
  rawCitations: RawCitation[],
  chunks: SearchResult[],
): { verified: Citation[]; trace: Array<Record<string, unknown>> } {
  const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));
  const verified: Citation[] = [];
  const trace: Array<Record<string, unknown>> = [];

  for (const c of rawCitations) {
    const chunk = resolveChunk(c.chunkId, chunkById);
    if (!chunk) {
      trace.push({
        chunkId: c.chunkId,
        quote: c.quote,
        result: "DROP — chunkId 미일치",
      });
      continue;
    }
    const match = findQuote(chunk.content, c.quote);
    if (!match) {
      // 6-tier 매칭 모두 실패 — chunk는 RRF가 적합하다 판단했으니 highlight 없이 노출.
      trace.push({
        chunkId: chunk.chunkId,
        quote: c.quote,
        chunkContent: preview(chunk.content, 400),
        result: "FALLBACK — quote substring 불일치, highlight 없이 노출",
      });
      verified.push(toCitationUnmatched(chunk, c.quote));
      continue;
    }
    trace.push({
      chunkId: chunk.chunkId,
      rawQuote: c.quote,
      matchRange: match,
      normalizedAdjusted: c.chunkId !== chunk.chunkId,
      result: "OK",
    });
    verified.push(toCitation(chunk, match));
  }
  return { verified, trace };
}

// === answer 노드 ===
// 검증 모드 — draft + claim-evidence 매핑을 같이 받아, chunk만 보고 처음부터 합성하지 않고
// draft의 각 claim을 evidence로 verify·reject (Verify-and-Edit / ALCE 패턴).
// chat.service의 generation-only 모드도 본 함수를 직접 호출(retrieval 우회, draft·claims 빈 입력).
export const answer = (deps: NodeDeps) =>
  async (state: RagStateType) => {
    const chunks = state.toolChunks ?? [];
    const draft = state.draft ?? "";
    const claims = state.claims ?? [];
    const claimChunks = state.claimChunks ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const tools = createAnswerTools();
    const agent = createReactAgent({
      llm: deps.model,
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

    // langchain v1+: `isToolMessage` deprecated → `ToolMessage.isInstance` static method.
    const answerToolMessages = (result.messages as BaseMessage[]).filter(
      (m): m is ToolMessage => ToolMessage.isInstance(m),
    );

    const { verified, trace } = verifyCitations(rawCitations, chunks);

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
      verify: trace,
      output: { answer: finalAnswer, verifiedCount: verified.length },
    });

    return { answer: finalAnswer, citations: verified };
  };
