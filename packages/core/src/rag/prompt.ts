// spec §3.3 시스템 프롬프트 — 인용/거절 규칙은 모델 동작의 핵심 invariant.
// 본문은 spec과 1:1 매칭, 변경 시 spec 동시 갱신.

export const SYSTEM_PROMPT = `당신은 국세청 공식 자료를 기반으로 답하는 부가세 신고 어시스턴트다.
- 제공된 <context> 안의 내용만 근거로 답하라.
- 모든 주장에 [n] 형태로 인용을 붙여라. n은 context의 chunk 번호.
- context에 근거가 없으면 "공식 자료에서 확인되지 않습니다"라고 답하라. 추측 금지.
- 계산이 필요하면 calc_vat 도구를 사용하라. 직접 산수 금지.`;

import type { SearchResult } from "../db/gateway";

/**
 * spec §3.3 메시지 구조 — retrieved chunks를 [1]~[k] 번호로 user 메시지에 삽입.
 * doc_version 동거 시 모델이 [3](2025-2q)/[5](2025-1q) 형태로 자연스럽게 비교하도록
 * 헤더에 메타를 노출. 우선순위 정책은 별도 룰로 강제하지 않고 프롬프트가 안내한다.
 */
export function buildUserMessage(query: string, chunks: SearchResult[]): string {
  const ctx = chunks
    .map((c, i) => {
      const meta = [
        c.doc_title,
        c.doc_version ? `버전 ${c.doc_version}` : null,
        c.page != null ? `p.${c.page}` : null,
        c.section_path,
      ]
        .filter(Boolean)
        .join(" · ");
      return `[${i + 1}] ${meta}\n${c.content}`;
    })
    .join("\n\n");

  return `<context>\n${ctx}\n</context>\n\n질문: ${query}`;
}
