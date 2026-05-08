import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

const GENERATION_MODEL_ID = "gpt-4o-mini";

export type GenerationModel = {
  model: LanguageModel;
  modelId: string;
};

export function createGenerationModel({
  apiKey,
}: {
  apiKey: string;
}): GenerationModel {
  const provider = createOpenAI({ apiKey });
  return {
    model: provider(GENERATION_MODEL_ID),
    modelId: GENERATION_MODEL_ID,
  };
}
