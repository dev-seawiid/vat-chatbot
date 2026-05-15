import type { SearchResult } from "../retrieval/chunk.repository";

// spec §3.3 시스템 프롬프트. 인용 메커니즘은 본문 텍스트의 [n] 마커가 아니라 cite_chunk
// tool 호출로 선언 — 본 invariant가 모델 동작의 핵심. 변경 시 spec 동시 갱신.

// 마스터 spec §4.7 실험 비교 키. v2 — 인용 메커니즘이 inline [n]에서 tool-call로 전환됨.
export const PROMPT_VERSION = "v2";

export const SYSTEM_PROMPT = `당신은 국세청 공식 자료를 기반으로 답하는 부가세 신고 어시스턴트다.
- 제공된 <context> 안의 내용만 근거로 답하라.
- 인용은 본문에 [n] 같은 마커를 박지 말고, 반드시 cite_chunk 도구로만 선언하라.
  - chunkId: <context>의 [chunkId=...] 라벨 값을 그대로 사용.
  - quote: 해당 chunk 본문에서 그대로 발췌한 30~120자 문장(요약·재작성 금지).
  - 새로운 주장을 할 때마다 즉시 호출하라. 답변 끝에 몰아서 호출 금지.
- context에 근거가 없으면 "공식 자료에서 확인되지 않습니다"라고 답하라. 추측 금지.
- 계산이 필요하면 calc_vat 도구를 사용하라. 직접 산수 금지.`;

// chunkId를 라벨로 노출해 모델이 cite_chunk 호출 시 인자로 쓸 수 있게 한다.
// 인용 선언이 tool 호출로 분리되었으므로 본문 텍스트엔 [n] 번호를 박지 않는다 — 따라서
// 청크 순번도 라벨에 포함하지 않는다(모델이 번호로 인용하는 잘못된 패턴을 막기 위함).
// retrieved context는 system 영역으로 격리해 user role 분리 — prompt injection 방어.
export function buildSystemMessage(chunks: SearchResult[]): string {
  const ctx = chunks
    .map((c) => {
      const meta = [
        c.docTitle,
        c.docVersion ? `버전 ${c.docVersion}` : null,
        c.page != null ? `p.${c.page}` : null,
        c.sectionPath,
      ]
        .filter(Boolean)
        .join(" · ");
      return `[chunkId=${c.chunkId}] ${meta}\n${c.content}`;
    })
    .join("\n\n");

  return `${SYSTEM_PROMPT}\n\n<context>\n${ctx}\n</context>`;
}
