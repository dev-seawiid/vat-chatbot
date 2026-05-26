import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";

// ADR-0003 §1 — Generation tier LLM 어댑터.
// provider 수준만 외부 노출(env OPENAI_API_KEY), 구체 ID는 본 파일 default 상수.
// embedding(voyage)과 분리된 별도 어댑터 — 두 모델 역할이 섞이지 않도록 파일·타입·팩토리 격리.

const GENERATION_MODEL_ID = "gpt-5-mini";
// reasoning effort "low" — v15 그래프는 검색을 결정론적 파이프라인(direct + draft+claims + RRF)으로
// 처리하므로 단일 LLM 호출당 무거운 reasoning이 불필요. draft 생성·answer 합성 둘 다 low로 운용.
// verbosity는 "low" — 답변 길이는 prompt format 블록이 제어.
const REASONING_EFFORT = "low";
const VERBOSITY = "low";

export type GenerationModel = {
  model: BaseChatModel;
  modelId: string;
};

export function createGenerationModel({
  apiKey,
}: {
  apiKey: string;
}): GenerationModel {
  const model = new ChatOpenAI({
    model: GENERATION_MODEL_ID,
    apiKey,
    reasoning: { effort: REASONING_EFFORT },
    verbosity: VERBOSITY,
  });
  return { model, modelId: GENERATION_MODEL_ID };
}
