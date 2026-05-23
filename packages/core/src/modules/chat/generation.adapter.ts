import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { initChatModel } from "langchain/chat_models/universal";

// ADR-0003 §1 — Generation tier LLM 어댑터.
// initChatModel은 LangChain 공식 universal factory — provider 교체 시 dynamic import로 패키지 dispatch.
// provider 수준만 외부 노출(env OPENAI_API_KEY), 구체 ID는 본 파일 default 상수.
// embedding(voyage)과 분리된 별도 어댑터 — 두 모델 역할이 섞이지 않도록 파일·타입·팩토리 격리.

const GENERATION_MODEL_ID = "gpt-5-nano";
const GENERATION_PROVIDER = "openai";
// gpt-5 reasoning tier 파라미터 — OpenAI cookbook 권장. default(medium)는 nano가 reasoning 토큰을
// 출력 예산에서 다 소진하는 사고가 흔함. citation 추출에는 약간의 deliberation이 필요해 "minimal"
// 대신 "low". verbosity도 "low" — 답변 길이는 prompt format 블록이 제어.
const REASONING_EFFORT = "low";
const VERBOSITY = "low";

export type GenerationModel = {
  model: BaseChatModel;
  modelId: string;
};

export async function createGenerationModel({
  apiKey,
}: {
  apiKey: string;
}): Promise<GenerationModel> {
  const model = await initChatModel(GENERATION_MODEL_ID, {
    modelProvider: GENERATION_PROVIDER,
    apiKey,
    modelKwargs: {
      reasoning_effort: REASONING_EFFORT,
      verbosity: VERBOSITY,
    },
  });
  return { model: model as unknown as BaseChatModel, modelId: GENERATION_MODEL_ID };
}
