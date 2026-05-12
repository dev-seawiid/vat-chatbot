import type { Citation } from "../rag/citation";

/**
 * 2026-05-07 eval 슬라이스 §6 — 결정적 4축 채점. 부수효과 없는 순수 함수라 단위 테스트가 쉽고
 * 같은 (item, response) 쌍은 항상 같은 점수를 낸다(LLM-judge는 v2). 마스터 spec §4.5 식 그대로.
 *
 * 가중치는 마스터 spec §4.5 결정값(0.4/0.2/0.3/0.1). 변경 시 eval_runs.summary에 별도 필드로
 * 박제해야 비교 가능 — 본 모듈에서는 단일 가중치 가정.
 */

// golden.json 한 항목의 도메인 표현 — 도메인 표면은 camelCase. golden.json은 사람이 작성하는
// 외부 JSON으로 spec §4.4 컨벤션상 snake 유지하며, scripts/eval-run.ts의 loader가 변환한다.
export type GoldenItem = {
  id: string;
  question: string;
  expectedKeywords: string[];
  expectedCitationDoc: string; // sources.json id (예: "nts-vat-2025-2q-manual")
  category: string;
  difficulty: "easy" | "medium" | "hard";
  taxType: string;
};

// 채점 입력 — generate가 만들어낸 답변 텍스트와 인용 배열. Citation은 sourceId를 갖는다.
export type RagResponse = {
  text: string;
  citations: Citation[];
};

// 4축 점수 — keywordRecall만 0~1 실수, 나머지는 0/1 이진.
export type AxisScores = {
  keywordRecall: number;
  citationPresent: 0 | 1;
  citationCorrect: 0 | 1;
  noHallucination: 0 | 1;
};

export const WEIGHTS = {
  keywordRecall: 0.4,
  citationPresent: 0.2,
  citationCorrect: 0.3,
  noHallucination: 0.1,
} as const;

// 마스터 spec §4.5 결정 — toy 단계는 정규식 기반 헷지 표현 탐지로 충분.
// 모델 출력의 헷지가 늘면(예: "아마", "추측", "확실하지 않다") 0점.
const HALLUCINATION_PATTERN = /추측|아마|것 같|확실하지/;

export function score(item: GoldenItem, response: RagResponse): AxisScores {
  const hits = item.expectedKeywords.filter((k) => response.text.includes(k));
  return {
    keywordRecall:
      item.expectedKeywords.length === 0
        ? 0
        : hits.length / item.expectedKeywords.length,
    citationPresent: response.citations.length > 0 ? 1 : 0,
    citationCorrect: response.citations.some(
      (c) => c.sourceId === item.expectedCitationDoc,
    )
      ? 1
      : 0,
    noHallucination: HALLUCINATION_PATTERN.test(response.text) ? 0 : 1,
  };
}

export function weighted(s: AxisScores): number {
  return (
    s.keywordRecall * WEIGHTS.keywordRecall +
    s.citationPresent * WEIGHTS.citationPresent +
    s.citationCorrect * WEIGHTS.citationCorrect +
    s.noHallucination * WEIGHTS.noHallucination
  );
}

// 디버깅·summary 분해용 — 어떤 키워드가 hit/miss 됐는지 그대로 박제(eval_runs.results §5.1).
export function partitionKeywords(
  item: GoldenItem,
  response: RagResponse,
): { hit: string[]; miss: string[] } {
  const hit: string[] = [];
  const miss: string[] = [];
  for (const k of item.expectedKeywords) {
    (response.text.includes(k) ? hit : miss).push(k);
  }
  return { hit, miss };
}
