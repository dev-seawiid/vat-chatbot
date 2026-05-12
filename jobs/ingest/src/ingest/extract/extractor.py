import re
from collections import Counter
from pathlib import Path

import pdfplumber

from ingest.extract.dto import ExtractResult, Section

# 목차 라인 패턴: 점선/가운뎃점/말줄임표 + 페이지 번호로 끝나는 형태.
# 국세청 매뉴얼 목차 줄이 "1. 부가가치세 신고와 납부 ··················· 2" 식이라 본문과 구별됨.
TOC_LINE_PATTERN = re.compile(r"(\.{3,}|·{3,}|…+).*?\d+\s*$")
TOC_LINE_RATIO = 0.4

# 러닝 헤더·푸터 식별 임계: 같은 짧은 줄이 페이지의 40% 이상에 등장하면 노이즈로 본다.
# 60자 제한은 본문 문장이 우연히 반복되는 케이스를 배제하기 위함.
HEADER_FOOTER_FREQ_RATIO = 0.4
HEADER_FOOTER_MAX_LEN = 60
MIN_HEADER_FOOTER_PAGES = 3

MAX_HEADING_LEN = 80


def _is_toc_page(text: str) -> bool:
    lines = [s for s in (line.strip() for line in text.splitlines()) if s]
    if len(lines) < 5:
        return False
    matches = sum(1 for line in lines if TOC_LINE_PATTERN.search(line))
    return matches / len(lines) >= TOC_LINE_RATIO


def _identify_noisy_lines(page_texts: list[str]) -> set[str]:
    """매 페이지 반복되는 짧은 줄(러닝 헤더·풋터·페이지 번호 등)을 식별."""
    freq: Counter[str] = Counter()
    for text in page_texts:
        for line in text.splitlines():
            s = line.strip()
            if s and len(s) <= HEADER_FOOTER_MAX_LEN:
                freq[s] += 1
    threshold = max(
        MIN_HEADER_FOOTER_PAGES, int(len(page_texts) * HEADER_FOOTER_FREQ_RATIO)
    )
    return {line for line, count in freq.items() if count >= threshold}


def _page_heading(lines: list[str], page_idx: int, doc_title: str) -> str:
    # 노이즈 제거 후 첫 의미 있는 줄을 페이지 헤딩으로 채택.
    # citation 표시용이라 완벽할 필요는 없고, 같은 페이지 내 가장 위쪽 본문이면 충분.
    for line in lines:
        if 4 <= len(line) <= MAX_HEADING_LEN:
            return line
    return f"{doc_title} - p.{page_idx}"


def extract_pdf(path: Path, source_id: str, title: str) -> ExtractResult:
    with pdfplumber.open(path) as pdf:
        page_count = len(pdf.pages)
        # 노이즈 식별을 위해 두 번 순회 — 1패스: 모든 페이지 텍스트 수집, 2패스: 정제·섹션화.
        page_texts = [(p.extract_text() or "") for p in pdf.pages]

    noisy = _identify_noisy_lines(page_texts)

    sections: list[Section] = []
    toc_skipped = 0
    empty_skipped = 0
    for page_idx, text in enumerate(page_texts, start=1):
        if _is_toc_page(text):
            toc_skipped += 1
            continue
        cleaned = [
            s
            for s in (line.strip() for line in text.splitlines())
            if s and s not in noisy
        ]
        content = "\n".join(cleaned).strip()
        if not content:
            empty_skipped += 1
            continue
        sections.append(
            Section(
                ordinal=len(sections),
                heading=_page_heading(cleaned, page_idx, title),
                content=content,
                page=page_idx,
                anchor=f"p{page_idx}",
            )
        )

    return ExtractResult(
        source_id=source_id,
        kind="pdf",
        title=title,
        page_count=page_count,
        sections=sections,
        meta={
            "parser": "pdfplumber",
            "strategy": "page-based",
            "noisy_lines_filtered": len(noisy),
            "toc_pages_skipped": toc_skipped,
            "empty_pages_skipped": empty_skipped,
        },
    )
