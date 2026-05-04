import type { SearchResult } from "../db/gateway";
import type { Citation } from "../db/schema";

/**
 * spec §3.4 — retrieve가 반환한 chunk를 UI/DB jsonb에 저장할 인용 객체로 정규화.
 * snippet은 모달 미리보기용으로 짧게 자른다(전체 content는 chunks 테이블에 이미 있음).
 */
const SNIPPET_MAX = 240;

export function toCitation(chunk: SearchResult): Citation {
  const snippet = chunk.content.replace(/\s+/g, " ").trim();
  return {
    chunk_id: chunk.chunk_id,
    doc_id: chunk.doc_id,
    doc_title: chunk.doc_title,
    doc_version: chunk.doc_version,
    page: chunk.page,
    section_path: chunk.section_path,
    snippet:
      snippet.length > SNIPPET_MAX ? snippet.slice(0, SNIPPET_MAX) + "…" : snippet,
  };
}

export function toCitations(chunks: SearchResult[]): Citation[] {
  return chunks.map(toCitation);
}
