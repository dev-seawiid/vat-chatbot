import type { Citation } from "../rag/citation";

/**
 * 2026-05-07 eval 슬라이스 §6 — 결정적 4축 채점. 부수효과 없는 순수 함수라 단위 테스트가 쉽고
 * 같은 (item, response) 쌍은 항상 같은 점수를 낸다(LLM-judge는 v2). 마스터 spec §4.5 식 그대로.
 *
 * 가중치는 마스터 spec §4.5 결정값(0.4/0.2/0.3/0.1). 변경 시 eval_runs.summary에 별도 필드로
 * 박제해야 비교 가능 — 본 모듈에서는 단일 가중치 가정.
 */

// golden.json 한 항목. snake_case는 마스터 spec §4.4 스키마 예시·국세청 자료 톤과 일치.
// DB 영속화는 gateway.evalItems(camelCase)에서 변환 — 본 모듈은 JSON 형태를 그대로 받는다.
export type GoldenItem = {
  id: string;
  question: string;
  expected_keywords: string[];
  expected_citation_doc: string; // sources.json id (예: "nts-vat-2025-2q-manual")
  category: string;
  difficulty: "easy" | "medium" | "hard";
  tax_type: string;
};

// 채점 입력 — generate가 만들어낸 답변 텍스트와 인용 배열. Citation은 source_id를 갖는다(§8).
export type RagResponse = {
  text: string;
  citations: Citation[];
};

// 4축 점수 — keyword_recall만 0~1 실수, 나머지는 0/1 이진.
export type AxisScores = {
  keyword_recall: number;
  citation_present: 0 | 1;
  citation_correct: 0 | 1;
  no_hallucination: 0 | 1;
};

export const WEIGHTS = {
  keyword_recall: 0.4,
  citation_present: 0.2,
  citation_correct: 0.3,
  no_hallucination: 0.1,
} as const;

// 마스터 spec §4.5 결정 — toy 단계는 정규식 기반 헷지 표현 탐지로 충분.
// 모델 출력의 헷지가 늘면(예: "아마", "추측", "확실하지 않다") 0점.
const HALLUCINATION_PATTERN = /추측|아마|것 같|확실하지/;

export function score(item: GoldenItem, response: RagResponse): AxisScores {
  const hits = item.expected_keywords.filter((k) => response.text.includes(k));
  return {
    keyword_recall:
      item.expected_keywords.length === 0
        ? 0
        : hits.length / item.expected_keywords.length,
    citation_present: response.citations.length > 0 ? 1 : 0,
    citation_correct: response.citations.some(
      (c) => c.source_id === item.expected_citation_doc,
    )
      ? 1
      : 0,
    no_hallucination: HALLUCINATION_PATTERN.test(response.text) ? 0 : 1,
  };
}

export function weighted(s: AxisScores): number {
  return (
    s.keyword_recall * WEIGHTS.keyword_recall +
    s.citation_present * WEIGHTS.citation_present +
    s.citation_correct * WEIGHTS.citation_correct +
    s.no_hallucination * WEIGHTS.no_hallucination
  );
}

// 디버깅·summary 분해용 — 어떤 키워드가 hit/miss 됐는지 그대로 박제(eval_runs.results §5.1).
export function partitionKeywords(
  item: GoldenItem,
  response: RagResponse,
): { hit: string[]; miss: string[] } {
  const hit: string[] = [];
  const miss: string[] = [];
  for (const k of item.expected_keywords) {
    (response.text.includes(k) ? hit : miss).push(k);
  }
  return { hit, miss };
}
