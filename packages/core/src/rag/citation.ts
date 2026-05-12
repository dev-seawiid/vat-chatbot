import type { SearchResult } from "../db/gateway";

// spec §3.4 인용 객체 — 도메인 타입. retrieve 결과 → UI 표시 + jsonb 영속화 둘 다에 쓰인다.
// 필드명은 snake_case 유지(spec §3.4 + DB jsonb 호환). db/schema의 messages.citations 컬럼이
// 본 타입을 거꾸로 import해 jsonb<Citation[]>로 타이핑한다.
export type Citation = {
  chunk_id: string;
  doc_id: string;
  // sources.json의 자연키(예: "nts-vat-2025-2q-manual"). eval 채점에서 expected_citation_doc과
  // 직접 비교하는 휴먼 가독 식별자(2026-05-07 eval 슬라이스 §0.4 #1·#2).
  // ingest 시 chunks.metadata.source_id에 박제, retrieve가 SELECT해 채운다.
  source_id: string;
  doc_title: string;
  doc_version: string | null;
  // documents.source_url — UI 인용 패널의 "원본 PDF 다운로드" 앵커 대상. nullable.
  source_url: string | null;
  page: number | null;
  section_path: string | null;
  snippet: string;
};

// snippet은 모달 미리보기용으로 짧게 자른다(전체 content는 chunks 테이블에 이미 있음).
const SNIPPET_MAX = 240;

export function toCitation(chunk: SearchResult): Citation {
  const snippet = chunk.content.replace(/\s+/g, " ").trim();
  return {
    chunk_id: chunk.chunk_id,
    doc_id: chunk.doc_id,
    source_id: chunk.source_id,
    doc_title: chunk.doc_title,
    doc_version: chunk.doc_version,
    source_url: chunk.source_url,
    page: chunk.page,
    section_path: chunk.section_path,
    snippet:
      snippet.length > SNIPPET_MAX ? snippet.slice(0, SNIPPET_MAX) + "…" : snippet,
  };
}

export function toCitations(chunks: SearchResult[]): Citation[] {
  return chunks.map(toCitation);
}
