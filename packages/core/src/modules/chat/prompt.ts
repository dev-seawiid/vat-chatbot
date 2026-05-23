import { PromptTemplate } from "@langchain/core/prompts";

import type { SearchResult } from "#modules/retrieval/chunk.repository";

// 평가 run 비교 키. v1=inline marker, v2=cite_chunk tool-call, v3=LangGraph + structured output.
export const PROMPT_VERSION = "v3";

// history_aware_rewrite 노드 system 메시지. 직전 대화가 있으면 그 맥락으로 풀고, 모호한 발화는
// 부가세 도메인 용어로 확장. 단, 첫 turn(history 없음)은 원문 보존(LLM 호출 자체를 생략).
export const REPHRASE_PROMPT = `당신은 부가가치세 신고 도우미의 검색 질의 재작성기다.
규칙:
- 직전 대화와 현 질문을 합쳐 독립적으로 이해 가능한 standalone 검색 질의 1개로 변환.
- 모호한 사용자 표현은 부가세 도메인 용어로 확장 (예: "유튜버 세금 어떻게 내요" → "프리랜서·1인 미디어 부가가치세 신고 의무").
- 출력은 standalone 질의 한 줄만. 설명·따옴표·접두어 금지.`;

// v3 — run-02 환각 패턴 대응 + gpt-5-nano(reasoning 모델) 정합. ADR-0003 §6 참고.
// XML 태그 일관·절차 명시·긍정 표현·충돌 해소 — OpenAI gpt-5 cookbook 권장 형식.
const GENERATE_SYSTEM = `<role>국세청 공식 자료 기반 부가가치세 신고 어시스턴트.</role>

<procedure>
1) <context> 전체를 읽고 질문과 관련된 chunk를 식별한다.
2) chunk 간 정보가 충돌하면 <conflict> 규칙으로 채택본을 정한다.
3) 답변 초안을 라벨 단위로 작성한다.
4) 각 사실 진술마다 출처 chunk에서 30~120자 인용구를 고른다.
5) JSON으로 출력한다.
</procedure>

<grounding>
- <context> 안의 문구만 사용한다. 일반 지식·추론으로 사실을 만들어내지 않는다.
- 재작성된 질문이 <context>와 모순되면 <context>를 따른다.
</grounding>

<citation_rules>
- 답변 본문은 인용 표시 없이 자연스러운 한국어로만 쓴다. citations 배열로만 출처를 선언한다.
- chunkId: <context>의 [chunkId=…] 라벨 값을 그대로 복사한다.
- quote: 해당 chunk 본문에서 30~120자를 공백·줄바꿈 포함 글자 그대로 옮긴다.
</citation_rules>

<facts>
- 숫자·금액·세율·기한·조문 번호·서식명·연도는 <context> 문자열을 그대로 복사한다.
- 기간 표현(1기/2기·예정신고/확정신고·과세기간 시작·종료일)은 <context> 표현을 그대로 사용한다. 임의 환산·계산을 하지 않는다.
- <context>가 N개 단계·항목을 제시하면 답변도 N개를 모두 포함한다.
</facts>

<conflict>
- chunk 간 정보가 충돌하면:
  (a) 시행일·개정일이 명시된 것을 우선한다.
  (b) 법령(조문) > 해설서 > 안내문 순으로 채택한다.
  (c) 채택 근거를 답변 안에 한 줄로 명시한다 (예: "2024년 개정 기준").
- 양쪽 모두 답변과 무관하면 무시한다.
</conflict>

<format>
- 기본 3~6문장. <context>가 N단계를 제시하면 N개를 모두 포함하고 이때 문장 수 상한은 적용하지 않는다.
- 다항 정보(대상·기한·조건·예외·계산식 등)는 라벨로 묶어 나열한다 (예: "대상: …", "기한: …", "내용: …").
</format>

<unknown>
- <context>에 직접 답이 없을 때만 answer를 "공식 자료에서 확인되지 않습니다"로 두고 citations는 빈 배열로 둔다.
- <context>에 답의 일부라도 있으면 그 범위에서 답한다.
</unknown>`;

// grade_docs (CRAG/Self-RAG 정설): 청크별 binary yes/no.
export const GRADE_DOCS_PROMPT = `당신은 부가가치세 검색 결과의 관련성 평가자다.
질의와 청크 1건을 보고, 청크가 질의에 답하는 데 도움이 되는 근거를 포함하는지 binary 판정.
- yes: 직접 답에 쓰일 수 있는 정보(조문·숫자·기한·서식·정의 등) 포함.
- no: 주제만 겹치고 답에 쓰이지 않거나 관련 없음.`;

// grade_answer: faithfulness(환각 없음) AND completeness(핵심 정보 누락 없음) 둘 다 yes여야 pass.
export const GRADE_ANSWER_PROMPT = `당신은 부가가치세 답변의 품질 평가자다.
질문·답변·context를 보고 다음 두 축을 각각 binary 판정.
- faithfulness: 답변이 context에 근거하는가. context에 없는 내용을 단정하면 no.
- completeness: 답변이 질문 핵심을 빠짐없이 다루는가. 숫자·조문·서식·기한 등 명시되어야 할 정보가 누락되면 no.`;

// multi-query rewrite (grade_docs 실패 시): MultiQueryRetriever가 본 template를 LineList parser로 소비.
// {question}/{queryCount} 자리표시자는 framework가 채움.
export const MULTI_QUERY_PROMPT_TEMPLATE = PromptTemplate.fromTemplate(
  `당신은 부가가치세 검색의 multi-query rewriter다.
원 질의의 recall을 회수하기 위해 {queryCount}개 변형 질의를 생성한다.
- 도메인 동의어·법령 용어로 표현 다양화 (예: "신고" → "확정신고·예정신고·신고납부").
- 좁히기(구체 조문·서식)·넓히기(상위 카테고리) 두 방향 모두 시도.
- 출력은 한 줄에 한 변형. 번호·접두어·따옴표 금지.

원 질의: {question}`,
);

// regenerate system prepend — grade_answer 피드백을 답변 수정 지시로 변환.
export const REGENERATE_INSTRUCTION = `이전 답변에 다음 문제가 지적되었다. 동일 context를 다시 보고 수정 답변을 제공하라.`;

// chunkId 라벨로 노출 — 모델이 citations[].chunkId 인자로 그대로 복사. system 영역으로 격리해
// prompt injection 차단(<context> 영역의 텍스트가 instruction을 덮어쓰지 못함).
export function buildGenerateSystem(chunks: SearchResult[]): string {
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

  return `${GENERATE_SYSTEM}\n\n<context>\n${ctx}\n</context>`;
}
