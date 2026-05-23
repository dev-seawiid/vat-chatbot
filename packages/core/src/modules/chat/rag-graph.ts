import type { Document } from "@langchain/core/documents";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { MultiQueryRetriever } from "@langchain/classic/retrievers/multi_query";
import { z } from "zod";

import { type Citation, findQuoteStart, toCitation } from "#common/citation";
import type { SearchResult } from "#modules/retrieval/chunk.repository";
import { VoyageRerankCompressor } from "#modules/retrieval/rerank.adapter";
import type { RetrieveFn } from "#modules/retrieval/retrieval.service";
import {
  type PgvectorDocMetadata,
  PgvectorRetriever,
} from "#modules/retrieval/retriever.adapter";

import type { GenerationModel } from "./generation.adapter";
import {
  buildGenerateSystem,
  GRADE_ANSWER_PROMPT,
  GRADE_DOCS_PROMPT,
  MULTI_QUERY_PROMPT_TEMPLATE,
  REGENERATE_INSTRUCTION,
  REPHRASE_PROMPT,
} from "./prompt";

// retrieve top-k는 rerank가 RERANK_K로 절단하므로 recall 우선 50. ADR-0003 §2 다이어그램 기준.
const RETRIEVE_K = 50;
const RERANK_K = 8;
const MULTI_QUERY_COUNT = 3;
// ADR-0003 §5 — 무한 루프 cap. 초과 시 fallback 노드로 분기.
const MAX_REWRITES = 2;
const MAX_REGENERATES = 1;
const FALLBACK_ANSWER = "공식 자료에서 확인되지 않습니다";

// === LLM 출력 스키마 ===
// AnswerSchema: quote 길이 제약은 prompt에서만 안내(strict json_schema는 zod string min/max 제한적).
// citation은 verify(findQuoteStart) 단계에서 substring 확인 후 통과분만 남긴다.
const AnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(
    z.object({
      chunkId: z.string(),
      quote: z.string(),
    }),
  ),
});

// CRAG/Self-RAG 정설 — 청크별 binary yes/no.
const GradeDocSchema = z.object({
  score: z.enum(["yes", "no"]),
});

// faithfulness=환각 없음, completeness=핵심 정보(숫자·조문·기한 등) 누락 없음. 둘 다 yes여야 pass.
const GradeAnswerSchema = z.object({
  faithfulness: z.enum(["yes", "no"]),
  completeness: z.enum(["yes", "no"]),
});

const RagState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // history_aware_rewrite 결과 — retrieve/multi_query_retrieve에 들어가는 standalone query.
  standaloneQuery: Annotation<string>(),
  // rerank 통과한 top-k documents — generate가 context로 사용. multi_query_retrieve도 같은 채널.
  documents: Annotation<Document<PgvectorDocMetadata>[]>(),
  // 검증 통과 citations.
  citations: Annotation<Citation[]>(),
  // 최종 답변 텍스트.
  answer: Annotation<string>(),
  // 재시도 카운터(기본 0). 노드가 절대값을 반환해 갱신.
  rewriteCount: Annotation<number>(),
  regenerateCount: Annotation<number>(),
  // grade_docs 청크별 점수 — router가 anyYes 판정.
  docGrades: Annotation<("yes" | "no")[]>(),
  // grade_answer 실패 시 regenerate가 system에 prepend할 피드백 문구. 빈 문자열 = pass.
  regenerateFeedback: Annotation<string>(),
});

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
  const baseRetriever = new PgvectorRetriever({
    retrieve,
    options: { k: RETRIEVE_K },
  });
  const rerank = new VoyageRerankCompressor({
    apiKey: voyageApiKey,
    topK: RERANK_K,
  });
  const multiQueryRetriever = MultiQueryRetriever.fromLLM({
    llm: generationModel.model,
    retriever: baseRetriever,
    queryCount: MULTI_QUERY_COUNT,
    prompt: MULTI_QUERY_PROMPT_TEMPLATE,
  });
  const { model } = generationModel;
  const answerStructured = model.withStructuredOutput(AnswerSchema, {
    method: "jsonSchema",
    strict: true,
    name: "Answer",
  });
  const gradeDocStructured = model.withStructuredOutput(GradeDocSchema, {
    method: "jsonSchema",
    strict: true,
    name: "GradeDoc",
  });
  const gradeAnswerStructured = model.withStructuredOutput(GradeAnswerSchema, {
    method: "jsonSchema",
    strict: true,
    name: "GradeAnswer",
  });

  // === Nodes ===

  const historyAwareRewrite = async (state: typeof RagState.State) => {
    const last = state.messages[state.messages.length - 1];
    if (!last) throw new Error("rag-graph: empty messages");
    const lastUser = last.text;
    const prior = state.messages.slice(0, -1);
    if (prior.length === 0) {
      return { standaloneQuery: lastUser };
    }
    const res = await model.invoke([
      new SystemMessage(REPHRASE_PROMPT),
      ...prior,
      new HumanMessage(`현 질문: ${lastUser}`),
    ]);
    return { standaloneQuery: res.text };
  };

  const retrieveNode = async (state: typeof RagState.State) => {
    const docs = await baseRetriever.invoke(state.standaloneQuery);
    return { documents: docs };
  };

  const rerankNode = async (state: typeof RagState.State) => {
    const ranked = (await rerank.compressDocuments(
      state.documents,
      state.standaloneQuery,
    )) as Document<PgvectorDocMetadata>[];
    return { documents: ranked };
  };

  // 청크별 병렬 binary 판정. 하나라도 yes면 pass — documents는 필터링 없이 그대로 generate로.
  const gradeDocs = async (state: typeof RagState.State) => {
    const results = await Promise.all(
      state.documents.map((doc) =>
        gradeDocStructured.invoke([
          new SystemMessage(GRADE_DOCS_PROMPT),
          new HumanMessage(
            `질의: ${state.standaloneQuery}\n\n청크:\n${doc.pageContent}`,
          ),
        ]),
      ),
    );
    return { docGrades: results.map((r) => r.score) };
  };

  // MultiQueryRetriever가 변형 생성·각 retrieve·dedupe까지 수행. 본 노드는 counter만 증분.
  const multiQueryRetrieve = async (state: typeof RagState.State) => {
    const docs = (await multiQueryRetriever.invoke(
      state.standaloneQuery,
    )) as Document<PgvectorDocMetadata>[];
    return {
      documents: docs,
      rewriteCount: (state.rewriteCount ?? 0) + 1,
    };
  };

  const runGenerate = async (
    state: typeof RagState.State,
    feedback: string | undefined,
  ) => {
    const chunks: SearchResult[] = state.documents.map(
      (d) => d.metadata.searchResult,
    );
    const chunkById = new Map(chunks.map((c) => [c.chunkId, c]));
    const last = state.messages[state.messages.length - 1];
    if (!last) throw new Error("rag-graph: empty messages");
    const lastUser = last.text;
    const prior = state.messages.slice(0, -1);

    const systemMessages = [new SystemMessage(buildGenerateSystem(chunks))];
    if (feedback) {
      systemMessages.push(
        new SystemMessage(`${REGENERATE_INSTRUCTION}\n${feedback}`),
      );
    }

    const result = await answerStructured.invoke([
      ...systemMessages,
      ...prior,
      new HumanMessage(lastUser),
    ]);

    const verified: Citation[] = [];
    for (const c of result.citations) {
      const chunk = chunkById.get(c.chunkId);
      if (!chunk) continue;
      const start = findQuoteStart(chunk.content, c.quote);
      if (start < 0) continue;
      verified.push(toCitation(chunk, c.quote, start));
    }
    return { answer: result.answer, citations: verified };
  };

  const generate = async (state: typeof RagState.State) =>
    runGenerate(state, undefined);

  const regenerate = async (state: typeof RagState.State) => {
    const result = await runGenerate(state, state.regenerateFeedback);
    return {
      ...result,
      regenerateCount: (state.regenerateCount ?? 0) + 1,
    };
  };

  // faithfulness/completeness 둘 다 yes여야 pass. 한쪽 no면 그 사실을 regenerate 피드백으로 박제.
  const gradeAnswer = async (state: typeof RagState.State) => {
    const last = state.messages[state.messages.length - 1];
    if (!last) throw new Error("rag-graph: empty messages");
    const ctx = state.documents
      .map((d) => `[chunkId=${d.metadata.chunkId}] ${d.pageContent}`)
      .join("\n\n");
    const grade = await gradeAnswerStructured.invoke([
      new SystemMessage(GRADE_ANSWER_PROMPT),
      new HumanMessage(
        `질문: ${last.text}\n\n답변:\n${state.answer}\n\ncontext:\n${ctx}`,
      ),
    ]);
    const issues: string[] = [];
    if (grade.faithfulness === "no")
      issues.push("환각·근거 부족이 지적됨 — context에 없는 내용을 단정하지 말 것.");
    if (grade.completeness === "no")
      issues.push(
        "핵심 정보 누락이 지적됨 — 숫자·조문·서식·기한 등을 빠짐없이 인용할 것.",
      );
    return { regenerateFeedback: issues.join(" ") };
  };

  // ADR-0003 §5 — 모든 재시도 소진 시 호출. 답변 강제 교체, citations 비움.
  const fallback = async () => {
    return { answer: FALLBACK_ANSWER, citations: [] };
  };

  // === Routers ===

  const routeAfterGradeDocs = (
    state: typeof RagState.State,
  ): "generate" | "multi_query_retrieve" | "fallback" => {
    const anyYes = (state.docGrades ?? []).some((s) => s === "yes");
    if (anyYes) return "generate";
    if ((state.rewriteCount ?? 0) < MAX_REWRITES) return "multi_query_retrieve";
    return "fallback";
  };

  const routeAfterGradeAnswer = (
    state: typeof RagState.State,
  ): "end" | "regenerate" | "fallback" => {
    const pass = !state.regenerateFeedback;
    if (pass) return "end";
    if ((state.regenerateCount ?? 0) < MAX_REGENERATES) return "regenerate";
    return "fallback";
  };

  // === 노드 등록 — 각 노드는 위 정의된 클로저, 외부 의존(LLM·retriever·rerank)을 캡처 ===
  return new StateGraph(RagState)
    .addNode("history_aware_rewrite", historyAwareRewrite) // history → standalone query
    .addNode("retrieve", retrieveNode) // dense vector top-50
    .addNode("rerank", rerankNode) // Voyage rerank-2.5 → top-8
    .addNode("grade_docs", gradeDocs) // 청크별 binary yes/no 병렬 판정
    .addNode("multi_query_retrieve", multiQueryRetrieve) // grade_docs fail 분기 — 3 변형 + union
    .addNode("generate", generate) // structured output {answer, citations[]}
    .addNode("grade_answer", gradeAnswer) // faithfulness AND completeness 평가
    .addNode("regenerate", regenerate) // grade_answer fail 분기 — 피드백 박제 후 재생성
    .addNode("fallback", fallback) // 모든 재시도 소진 — 답변 강제 교체

    // === Happy path 무조건부 엣지 ===
    .addEdge(START, "history_aware_rewrite")
    .addEdge("history_aware_rewrite", "retrieve")
    .addEdge("retrieve", "rerank")
    .addEdge("rerank", "grade_docs") // 첫 진입 + multi_query 재진입 모두 본 엣지로 합류

    // === 분기 1: grade_docs 라우터 (routeAfterGradeDocs 참조) ===
    //   anyYes=true              → generate            (pass)
    //   anyYes=false, rc<2       → multi_query_retrieve(재시도)
    //   anyYes=false, rc>=2      → fallback            (소진)
    .addConditionalEdges("grade_docs", routeAfterGradeDocs, {
      generate: "generate",
      multi_query_retrieve: "multi_query_retrieve",
      fallback: "fallback",
    })
    .addEdge("multi_query_retrieve", "rerank") // ← 재진입 루프: rerank → grade_docs 다시 평가

    .addEdge("generate", "grade_answer") // generate 직후 항상 평가

    // === 분기 2: grade_answer 라우터 (routeAfterGradeAnswer 참조) ===
    //   feedback==""             → END                 (pass: 둘 다 yes)
    //   feedback!="", regen<1    → regenerate          (재시도 1회)
    //   feedback!="", regen>=1   → fallback            (소진)
    .addConditionalEdges("grade_answer", routeAfterGradeAnswer, {
      end: END,
      regenerate: "regenerate",
      fallback: "fallback",
    })
    .addEdge("regenerate", "grade_answer") // ← 재진입 루프: 1회 재평가 후 위 라우터에서 fallback 또는 END

    .addEdge("fallback", END) // fallback 노드는 단일 출구
    .compile();
}

export type RagGraph = ReturnType<typeof createRagGraph>;
