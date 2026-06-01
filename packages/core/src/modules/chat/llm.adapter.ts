import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";

// ADR-0003 §1 — LLM tier 어댑터. rewrite·draft·answer 역할별 chat-completion 모델을 묶는다.
// provider 수준만 외부 노출(env OPENAI_API_KEY), 구체 ID·튜닝은 본 파일 default 상수.
// embedding(voyage)·rerank와 분리된 별도 어댑터 — 모델 역할이 섞이지 않도록 파일·타입·팩토리 격리.

// RAG 그래프에서 LLM을 호출하는 노드 역할. 새 노드가 LLM을 쓰면 여기에 role 추가 +
// MODEL_DEFAULTS 한 줄이면 끝 — plumbing(NodeDeps·core 배선)은 불변.
export type NodeModelRole = "rewrite" | "draft" | "answer";

type ReasoningEffort = "minimal" | "low" | "medium" | "high";
type Verbosity = "low" | "medium" | "high";
type ModelSpec = {
  modelId: string;
  effort: ReasoningEffort;
  verbosity?: Verbosity;
};

const MODEL_DEFAULTS: Record<NodeModelRole, ModelSpec> = {
  rewrite: { modelId: "gpt-5-mini", effort: "low" },
  draft: { modelId: "gpt-5", effort: "low" },
  answer: { modelId: "gpt-5", effort: "low" },
};

export type GenerationModel = {
  model: BaseChatModel;
  modelId: string;
};

// role → GenerationModel. 노드는 자기 role 키로 모델을 조회한다.
export type ModelRegistry = Record<NodeModelRole, GenerationModel>;

function createModel(apiKey: string, spec: ModelSpec): GenerationModel {
  const model = new ChatOpenAI({
    model: spec.modelId,
    apiKey,
    reasoning: { effort: spec.effort },
    verbosity: spec.verbosity,
  });
  return { model, modelId: spec.modelId };
}

// 모든 role 모델을 한 번에 생성. overrides는 role별 부분 spec을 default에 병합 —
// eval factorial design·실험에서 코드 수정 없이 모델/effort를 갈아끼우는 표면.
export function createModelRegistry(cfg: {
  apiKey: string;
  overrides?: Partial<Record<NodeModelRole, Partial<ModelSpec>>>;
}): ModelRegistry {
  const roles = Object.keys(MODEL_DEFAULTS) as NodeModelRole[];
  const registry = {} as ModelRegistry;
  for (const role of roles) {
    const spec = { ...MODEL_DEFAULTS[role], ...cfg.overrides?.[role] };
    registry[role] = createModel(cfg.apiKey, spec);
  }
  return registry;
}
