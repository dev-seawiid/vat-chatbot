// strict substring — UI highlight 좌표 정확성을 위해 normalize 없이 그대로.
// graph generate 노드가 LLM 출력 citations[i].quote를 chunk 본문에서 검색해 좌표를 박제.
export function findQuoteStart(content: string, quote: string): number {
  return content.indexOf(quote);
}

// invariant: content.slice(quoteStart, quoteEnd) === quote.
// 좌표 박제로 UI는 정확한 highlight, 디버깅은 객체만으로 자기 충족.
export type Citation = {
  chunkId: string;
  docId: string;
  sourceId: string;
  docTitle: string;
  docVersion: string | null;
  sourceUrl: string | null;
  page: number | null;
  sectionPath: string | null;
  content: string;
  quote: string;
  quoteStart: number;
  quoteEnd: number;
};

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

// quoteStart는 호출자(chat.service의 verify 단계)가 indexOf로 계산해 넘긴다.
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
