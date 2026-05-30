import type { Citation } from "../types";

// 법령명 짧은 prefix 매핑 — chip 가독 우선. 미매핑 docTitle은 원문 그대로.
const DOC_PREFIX: Record<string, string> = {
  부가가치세법: "법",
  "부가가치세법 시행령": "령",
  "부가가치세법 시행규칙": "규",
  국세기본법: "국기법",
  "국세기본법 시행령": "국기령",
};

const ARTICLE_RE = /제(\d+)조(?:의(\d+))?/g;

type ParsedArticle = { num: string; sub: string | null };

// sectionPath / content에서 가장 먼저 등장하는 `제\d+조(의\d+)?` 매치.
// ingest가 sectionPath에 chapter>section만 채우므로 content 본문 헤더에서도 탐색.
function parseArticle(
  ...sources: (string | null | undefined)[]
): ParsedArticle | null {
  for (const s of sources) {
    if (!s) continue;
    const matches = [...s.matchAll(ARTICLE_RE)];
    if (matches.length === 0) continue;
    const m = matches[0];
    return { num: m[1], sub: m[2] ?? null };
  }
  return null;
}

type CitationLabelInput = Pick<
  Citation,
  "docTitle" | "sectionPath" | "content"
>;

export function docPrefix(docTitle: string): string {
  return DOC_PREFIX[docTitle] ?? docTitle;
}

// chip용 — "§48" / "§47의2".
export function articleShortLabel(c: CitationLabelInput): string | null {
  const a = parseArticle(c.sectionPath, c.content);
  if (!a) return null;
  return a.sub ? `§${a.num}의${a.sub}` : `§${a.num}`;
}

// 카드 headline용 — "제48조" / "제47조의2".
export function articleLongLabel(c: CitationLabelInput): string | null {
  const a = parseArticle(c.sectionPath, c.content);
  if (!a) return null;
  return a.sub ? `제${a.num}조의${a.sub}` : `제${a.num}조`;
}

// MessageBubble chip용 — "법§48, 령§90".
export function shortCitationLabel(c: CitationLabelInput): string {
  const prefix = docPrefix(c.docTitle);
  const article = articleShortLabel(c);
  return article ? `${prefix}${article}` : prefix;
}

// 중복 라벨 dedupe → comma-join. 같은 조문에서 여러 chunk가 매칭돼도 chip은 1회만.
export function joinCitationLabels(citations: CitationLabelInput[]): string {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const c of citations) {
    const label = shortCitationLabel(c);
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels.join(", ");
}

// docVersion(effective_date YYYYMMDD) → "시행 YYYY.MM.DD". 8자리 숫자 아니면 null.
// ingest는 effective_date를 documents.version에 매핑. UI에는 시행일임을 라벨로 명시.
const EFFECTIVE_DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
export function formatDocVersion(docVersion: string | null): string | null {
  if (!docVersion) return null;
  const m = EFFECTIVE_DATE_RE.exec(docVersion);
  if (!m) return null;
  return `시행 ${m[1]}.${m[2]}.${m[3]}`;
}

// CitationPanel 헤더 — 법령별 카운트 brief. 예: "부가가치세법 3건 · 시행령 1건".
export function groupCountBreakdown(
  citations: Pick<Citation, "docTitle">[],
): string {
  const counts = new Map<string, number>();
  for (const c of citations) {
    counts.set(c.docTitle, (counts.get(c.docTitle) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([title, n]) => `${title} ${n}건`)
    .join(" · ");
}
