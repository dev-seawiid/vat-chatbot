// 진행 상태 스트리밍 — RAG 그래프 노드 완료를 사용자向 stage 이벤트로 변환 (ADR-0003 §8).
// retrieval 직렬 LLM 지연 동안 빈 화면을 단계 표시로 메워 체감 지연 완화. 실제 지연 단축 아님.

export type ProgressStage =
  | "analyzing"
  | "searching"
  | "expanding"
  | "compiling"
  | "answering";

export type ProgressEvent = { stage: ProgressStage };

// 진행 순서 — pushStage는 단조 증가만 허용. 병렬 노드(search_direct ∥ generate_draft)가
// 역순 완료해도 인디케이터가 후퇴하지 않게.
const STAGE_ORDER: ProgressStage[] = [
  "analyzing",
  "searching",
  "expanding",
  "compiling",
  "answering",
];

// 그래프 노드 완료 → 그 직후 "현재 진행" stage. streamMode "updates"는 노드 *완료* 시점에
// 발화하므로 각 노드의 다음 활동을 가리킨다. retrieve(subgraph wrapper) 완료 = answer 노드
// 직전 → "answering"으로 매핑해 가장 긴 generation 대기에 라벨이 걸리도록.
export const NODE_STAGE: Record<string, ProgressStage> = {
  rewrite_query: "searching",
  search_direct: "searching",
  generate_draft: "expanding",
  claim_searches: "compiling",
  fuse: "compiling",
  retrieve: "answering",
  generate_answer: "answering",
};

// 단조 증가 stage 발행기 — 이미 지난 단계나 동일 단계 재발행은 무시.
export function makeStagePusher(push: (event: ProgressEvent) => void) {
  let rank = -1;
  return (stage: ProgressStage) => {
    const next = STAGE_ORDER.indexOf(stage);
    if (next <= rank) return;
    rank = next;
    push({ stage });
  };
}
