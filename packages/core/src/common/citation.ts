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

export type QuoteMatch = { start: number; end: number };

// LLM이 quote을 다듬어 출력하는 경우 substring 검증이 깨지는 사고가 많아 6-tier로 완화:
// 1) strict indexOf 2) outer 마커·구두점 제거 3) whitespace 정규화 + 위치 역매핑
// 4) 줄임표(... / …) 분리 후 순차 segment 5) whitespace 완전 제거 (PDF 추출 잡음 흡수)
// 6) prefix-suffix span (모델이 중간을 마커 없이 삭제한 경우)
// 매칭 성공 시 항상 원본 chunk의 실제 범위를 반환 — UI highlight 좌표 정확성 유지.
export function findQuote(content: string, quote: string): QuoteMatch | null {
  // 1. strict
  const strict = content.indexOf(quote);
  if (strict >= 0) return { start: strict, end: strict + quote.length };

  // 2. outer 마커·꺾쇠·괄호·공백·구두점 제거 후 재시도. 모델이 quote 양끝에 마침표/쉼표/마커를
  // 임의로 붙인 경우 대응 (예: "...까지" → "...까지." LLM 출력).
  const trimmed = quote.replace(/^[\s<>().,;:。、!?！？]+|[\s<>().,;:。、!?！？]+$/g, "");
  if (trimmed && trimmed !== quote) {
    const t = content.indexOf(trimmed);
    if (t >= 0) return { start: t, end: t + trimmed.length };
  }

  // 3. whitespace 정규화 + 위치 역매핑 (multi-space → single-space).
  const wsMatch = findByWhitespaceNormalized(content, quote);
  if (wsMatch) return wsMatch;

  // 4. 줄임표 분리 + 순차 segment. 내부 segment 검색은 findFlex로 strict→ws-normalized→ws-stripped.
  const ellipsisMatch = findByEllipsisSegments(content, quote);
  if (ellipsisMatch) return ellipsisMatch;

  // 5. whitespace 완전 제거 매칭 — PDF 추출 잡음("납세 지" ↔ "납세지") 및 한국어 띄어쓰기 변동 흡수.
  const strippedMatch = findByWhitespaceStripped(content, quote);
  if (strippedMatch) return strippedMatch;

  // 6. prefix-suffix span — 모델이 chunk 중간을 마커 없이 잘라낸 경우. quote 앞 15자 + 뒤 15자가
  // chunk에 순서대로 존재하면 그 범위를 매칭으로 인정. UI에는 chunk 원본 그대로 표시.
  return findByPrefixSuffixSpan(content, quote);
}

// 줄임표(... 또는 …) 패턴. 앞뒤 공백 흡수.
const ELLIPSIS_RE = /\s*(?:\.\.\.|…)\s*/;
const MIN_SEGMENT_LEN = 6; // 너무 짧은 segment는 false positive 위험 — 한국어 기준 6자.

function findByEllipsisSegments(
  content: string,
  quote: string,
): QuoteMatch | null {
  const segments = quote
    .split(ELLIPSIS_RE)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SEGMENT_LEN);
  if (segments.length < 2) return null;

  // 각 segment를 cursor 이후에서 순차 검색 — 순서 보장. findFlex로 strict→ws-normalized→ws-stripped fallback.
  let cursor = 0;
  let firstStart = -1;
  let lastEnd = -1;
  for (const seg of segments) {
    const hit = findFlex(content, seg, cursor);
    if (!hit) return null;
    if (firstStart === -1) firstStart = hit.start;
    lastEnd = hit.end;
    cursor = lastEnd;
  }
  return firstStart >= 0 && lastEnd > firstStart
    ? { start: firstStart, end: lastEnd }
    : null;
}

// 모델이 chunk 중간을 마커 없이 잘라낸 경우용. 앞/뒤 prefix·suffix를 chunk에서 순서대로 찾고
// 그 범위를 통째로 매칭으로 반환. min 길이로 false positive 차단.
const PREFIX_LEN = 15;
const SUFFIX_LEN = 15;
const MIN_TOTAL_LEN = 40;

function findByPrefixSuffixSpan(
  content: string,
  quote: string,
): QuoteMatch | null {
  const flat = quote.replace(/\s+/g, " ").trim();
  if (flat.length < MIN_TOTAL_LEN) return null;
  const prefix = flat.slice(0, PREFIX_LEN);
  const suffix = flat.slice(-SUFFIX_LEN);
  if (prefix === suffix) return null; // 너무 짧음.

  const prefixHit = findFlex(content, prefix, 0);
  if (!prefixHit) return null;
  const suffixHit = findFlex(content, suffix, prefixHit.end);
  if (!suffixHit) return null;
  return { start: prefixHit.start, end: suffixHit.end };
}

// strict indexOf 실패 시 ws-normalized → ws-stripped fallback. ellipsis segment·prefix-suffix 공용.
function findFlex(
  content: string,
  needle: string,
  from: number,
): QuoteMatch | null {
  const strict = content.indexOf(needle, from);
  if (strict >= 0) return { start: strict, end: strict + needle.length };
  const sliced = content.slice(from);
  const m = findByWhitespaceNormalized(sliced, needle);
  if (m) return { start: from + m.start, end: from + m.end };
  const s = findByWhitespaceStripped(sliced, needle);
  if (s) return { start: from + s.start, end: from + s.end };
  return null;
}

// 공백 완전 제거 매칭. 비공백 char별 원본 index를 보관해 매칭 위치를 원본 좌표로 복원.
// PDF 추출이 단어 중간을 줄바꿈으로 끊어 공백을 침투시키는 케이스("납세 지" 원문은 "납세지") 흡수.
function findByWhitespaceStripped(
  content: string,
  quote: string,
): QuoteMatch | null {
  const positions: number[] = [];
  let stripped = "";
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (!/\s/.test(ch)) {
      stripped += ch;
      positions.push(i);
    }
  }
  const normQuote = quote.replace(/\s+/g, "");
  if (!normQuote) return null;
  const normStart = stripped.indexOf(normQuote);
  if (normStart < 0) return null;
  const origStart = positions[normStart];
  const lastIdx = normStart + normQuote.length - 1;
  const origLast = positions[lastIdx];
  if (origStart === undefined || origLast === undefined) return null;
  return { start: origStart, end: origLast + 1 };
}

function findByWhitespaceNormalized(
  content: string,
  quote: string,
): QuoteMatch | null {
  // content의 각 비공백 char에 대한 원본 index를 보관. 정규화된 공백은 매핑 안 함(공백 위치는 인접
  // char로 추정). 정규화 시작·끝의 원본 좌표만 알면 충분.
  const positions: number[] = [];
  let normalized = "";
  let prevSpace = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]!;
    if (/\s/.test(ch)) {
      if (!prevSpace && normalized.length > 0) {
        normalized += " ";
        positions.push(i);
        prevSpace = true;
      }
    } else {
      normalized += ch;
      positions.push(i);
      prevSpace = false;
    }
  }
  const normQuote = quote.replace(/\s+/g, " ").trim();
  if (!normQuote) return null;
  const normStart = normalized.indexOf(normQuote);
  if (normStart < 0) return null;
  const origStart = positions[normStart];
  const lastIdx = normStart + normQuote.length - 1;
  const origLast = positions[lastIdx];
  if (origStart === undefined || origLast === undefined) return null;
  return { start: origStart, end: origLast + 1 };
}

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

// 매칭 범위를 원본 좌표로 받고 stored quote도 원본에서 다시 slice — invariant 강제.
export function toCitation(
  chunk: ChunkLike,
  match: QuoteMatch,
): Citation {
  const quote = chunk.content.slice(match.start, match.end);
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
    quoteStart: match.start,
    quoteEnd: match.end,
  };
}

// findQuote 6-tier 매칭이 모두 실패한 경우 — chunk 자체는 retrieval/RRF가 적합하다고 판단했으므로
// citation을 DROP하지 않고 highlight 없이 노출. UI는 quoteStart=quoteEnd=0이면 content 전체를
// mark 없이 표시. quote 필드는 LLM 출력 그대로 보관(디버깅·로그용).
export function toCitationUnmatched(
  chunk: ChunkLike,
  rawQuote: string,
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
    quote: rawQuote,
    quoteStart: 0,
    quoteEnd: 0,
  };
}
