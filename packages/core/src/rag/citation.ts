import type { SearchResult } from "../db/gateway";

// spec §3.4 인용 객체 — 도메인 타입. retrieve 결과 → UI 표시 + jsonb 영속화 둘 다에 쓰인다.
// 필드명은 도메인 표준인 camelCase. messages.citations jsonb 컬럼도 같은 형태로 저장돼
// write/read 변환 layer 없이 도메인 객체가 곧 저장 형태(단일 진실 소스).
// db/schema.ts의 messages.citations 컬럼이 본 타입을 거꾸로 import해 jsonb<Citation[]>로 타이핑.
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
  snippet: string;
};

// snippet은 모달 미리보기용으로 짧게 자른다(전체 content는 chunks 테이블에 이미 있음).
const SNIPPET_MAX = 240;

export function toCitation(chunk: SearchResult): Citation {
  const snippet = chunk.content.replace(/\s+/g, " ").trim();
  return {
    chunkId: chunk.chunkId,
    docId: chunk.docId,
    sourceId: chunk.sourceId,
    docTitle: chunk.docTitle,
    docVersion: chunk.docVersion,
    sourceUrl: chunk.sourceUrl,
    page: chunk.page,
    sectionPath: chunk.sectionPath,
    snippet:
      snippet.length > SNIPPET_MAX ? snippet.slice(0, SNIPPET_MAX) + "…" : snippet,
  };
}

export function toCitations(chunks: SearchResult[]): Citation[] {
  return chunks.map(toCitation);
}
