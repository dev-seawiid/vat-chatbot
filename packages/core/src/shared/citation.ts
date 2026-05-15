// spec §3.4 인용 객체 — 도메인 타입. retrieve 결과 → UI 표시 + jsonb 영속화 둘 다에 쓰인다.
// 필드명은 도메인 표준인 camelCase. messages.citations jsonb 컬럼도 같은 형태로 저장돼
// write/read 변환 layer 없이 도메인 객체가 곧 저장 형태(단일 진실 소스).
// db/schema.ts의 messages.citations 컬럼이 본 타입을 거꾸로 import해 jsonb<Citation[]>로 타이핑.
//
// quote 메커니즘 — cite_chunk tool 호출 시 모델이 발췌한 문장(quote)을 chunk.content 안에서
// strict substring으로 찾아 char range(quoteStart, quoteEnd)와 함께 박제한다. UI는 이 range로
// content 안의 인용 문장만 highlight, eval은 quote 자체를 다음 회 LLM-judge 재채점에 활용.
// 세 필드(quote/start/end)는 Anthropic Citations API의 (cited_text, start_char_index,
// end_char_index)와 같은 의도 — 약간의 redundancy를 감수하고 자기 충족성·정합성 검증을 얻는다.
export type Citation = {
  chunkId: string;
  docId: string;
  // sources.json의 자연키(예: "nts-vat-2025-2q-manual"). eval 채점에서 expectedCitationDoc과
  // 직접 비교하는 휴먼 가독 식별자. ingest 시 chunks.metadata.source_id(snake)에 박제되고
  // retrieve가 SELECT 단계에서 camel(sourceId)로 매핑해 가져온다.
  sourceId: string;
  docTitle: string;
  docVersion: string | null;
  // documents.source_url — UI 인용 패널의 "원본 PDF 다운로드" 앵커 대상. nullable.
  sourceUrl: string | null;
  page: number | null;
  sectionPath: string | null;
  // chunk 본문 전체. quote highlight를 위해 자르지 않고 그대로 박제 — 모달이 본문 + 인용
  // 문장 강조를 동시에 보여줄 수 있도록. snippet(240자 cap)에서 확장된 결과.
  content: string;
  // 모델이 cite_chunk tool로 발췌한 문장 그대로(invariant: content.slice(quoteStart, quoteEnd) === quote).
  quote: string;
  // content 안에서 quote의 시작·끝 char 위치(end exclusive). UI는 0..start / start..end /
  // end..length 세 조각으로 분할 후 가운데에 highlight 마크업을 적용한다.
  quoteStart: number;
  quoteEnd: number;
};

// 변환 input은 structural type — repository의 SearchResult가 본 모양을 만족하므로
// domain → repositories 역방향 의존을 만들지 않는다.
type ChunkLike = {
  chunkId: string;
  docId: string;
  sourceId: string;
  docTitle: string;
  docVersion: string | null;
  sourceUrl: string | null;
  page: number | null;
  sectionPath: string | null;
  content: string;
};

/**
 * SearchResult + 검증된 quote/위치를 Citation으로 변환. quoteStart는 호출자(chat.service의
 * verify 단계)가 content.indexOf로 미리 계산해 넘긴다 — 본 함수는 좌표가 정확하다고 신뢰만
 * 한다(좌표 계산을 호출자에 위임함으로써 verify 실패 시 변환을 시도조차 하지 않는 invariant).
 */
export function toCitation(
  chunk: ChunkLike,
  quote: string,
  quoteStart: number,
): Citation {
  return {
    chunkId: chunk.chunkId,
    docId: chunk.docId,
    sourceId: chunk.sourceId,
    docTitle: chunk.docTitle,
    docVersion: chunk.docVersion,
    sourceUrl: chunk.sourceUrl,
    page: chunk.page,
    sectionPath: chunk.sectionPath,
    content: chunk.content,
    quote,
    quoteStart,
    quoteEnd: quoteStart + quote.length,
  };
}
