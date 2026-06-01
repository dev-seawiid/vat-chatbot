import type { ProgressStage } from "@vat/core";

// stage enum → 사용자向 문구. core는 그래프 구조(stage)만 노출, 표현은 UI 책임(ADR-0003 §8).
const STAGE_LABEL: Record<ProgressStage, string> = {
  analyzing: "질문 분석 중",
  searching: "법령 검색 중",
  expanding: "세부 쟁점 검색 중",
  compiling: "근거 정리 중",
  answering: "답변 작성 중",
};

export function getProgressLabel(stage: ProgressStage): string {
  return STAGE_LABEL[stage];
}
