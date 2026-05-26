"""ParsedDocument → embedding-ready Chunk.

"제N조" 위치를 boundary로 텍스트를 split해 한 조 = 한 chunk로 만든다.
조 텍스트가 1200 토큰을 초과하는 드문 케이스에 한해 char 단위 슬라이딩으로
분할(overlap 150). chapter/section은 chunk 헤더에 prepend해 검색 시그널 제공.

핵심 설계: article boundary는 텍스트에 그대로 박힌 "제N조"를 신뢰. parse 단계에
article 상태를 추적하면 부칙·본법에서 카운터가 1로 리셋돼 (chapter, article) 키 충돌이
발생하므로, 상태 추적 자체를 두지 않고 split로 처리한다. parent fetch 등 후속이
필요해지면 chapter+article을 chunk metadata로 갖고 있어 재구성 가능.
"""

import hashlib
import re
from collections.abc import Iterable

import voyageai

from ingest.chunking.dto import Chunk
from ingest.parse.dto import Node, ParsedDocument
from ingest.shared.config import get_settings

# 1200 = chunking 명세 권장 상한. 권장 300~900, 절대 한도 1200.
MAX_TOKENS = 1200
# 한 조가 1200 초과하는 케이스에 char 슬라이딩 시 overlap.
OVERLAP_TOKENS = 150
# 50 토큰 미만 chunk는 정보 밀도 부족(예: "제X조 삭제" 같은 1줄 조) → drop.
MIN_TOKENS = 50

# chunker가 article boundary로 사용. parser의 boundary 폐기와 한 짝.
# "제N조(...)" 또는 "제N조의M(...)" 형태만 매칭 — cross-reference("제5조제3항")는 괄호 부재로 미매칭.
_ARTICLE_BOUNDARY_RE = re.compile(r"^제\s*(\d+)\s*조(?:의\s*(\d+))?(?=\s*\(|\s*$)")


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _heading_line(
    law: str,
    article: str | None,
    chapter: str | None,
    section: str | None,
) -> str:
    parts = [law]
    if article:
        parts.append(f"제{article}조")
    head = " ".join(parts)
    crumbs = [c for c in (chapter, section) if c]
    if crumbs:
        head += " (" + " > ".join(crumbs) + ")"
    return head


def _split_by_article(nodes: Iterable[Node]) -> Iterable[tuple[str | None, list[Node]]]:
    """노드 시퀀스를 "제N조" boundary로 끊어 (article_no, nodes) 페어를 yield.

    boundary 매칭이 안 된 선행 노드들(chapter/section heading 등)은 article=None 그룹으로
    한 번만 yield — 호출자가 MIN_TOKENS 미만이면 drop. 같은 chapter 안의 두 조 사이에
    낀 절 heading 노드는 다음 조에 prepend되어 자연스럽게 흡수.

    docling이 page break 후 본문 재시작 시 같은 "제N조(...)"를 다시 추출하는 quirk가 있어
    같은 chapter+같은 article의 인접 boundary는 새 그룹 만들지 않고 기존 그룹에 흡수.
    """
    current_no: str | None = None
    current: list[Node] = []
    for n in nodes:
        if m := _ARTICLE_BOUNDARY_RE.match(n.text):
            new_no = f"{m.group(1)}의{m.group(2)}" if m.group(2) else m.group(1)
            same_chap_art = (
                current
                and current_no == new_no
                and current[-1].chapter == n.chapter
            )
            if same_chap_art:
                current.append(n)
                continue
            if current:
                yield current_no, current
            current_no = new_no
            current = [n]
        else:
            current.append(n)
    if current:
        yield current_no, current


def chunk_parsed(parsed: ParsedDocument) -> list[Chunk]:
    settings = get_settings()
    client = voyageai.Client(api_key=settings.voyage_api_key)
    model = settings.voyage_model

    chunks: list[Chunk] = []
    for article_no, article_nodes in _split_by_article(parsed.nodes):
        body = "\n".join(n.text for n in article_nodes if n.text).strip()
        if not body:
            continue
        first = article_nodes[0]
        head = _heading_line(parsed.law, article_no, first.chapter, first.section)
        full = f"{head}\n\n{body}"
        token_count = client.count_tokens([full], model=model)

        if token_count <= MAX_TOKENS:
            if token_count < MIN_TOKENS:
                continue
            chunks.append(_make_chunk(parsed, article_no, article_nodes, full, token_count, 0))
            continue

        # 한 조가 1200 초과하는 드문 케이스 — char 단위 슬라이딩(token≈char 가정).
        step = MAX_TOKENS - OVERLAP_TOKENS
        for idx, i in enumerate(range(0, len(body), step)):
            piece = body[i : i + MAX_TOKENS]
            content = f"{head}\n\n{piece}"
            tk = client.count_tokens([content], model=model)
            if tk < MIN_TOKENS:
                continue
            chunks.append(_make_chunk(parsed, article_no, article_nodes, content, tk, idx))
    return chunks


def _make_chunk(
    parsed: ParsedDocument,
    article: str | None,
    nodes: list[Node],
    content: str,
    token_count: int,
    split_idx: int,
) -> Chunk:
    first = nodes[0]
    # split_idx 추가 — char slide로 한 article이 여러 chunk가 될 때 id 충돌 차단.
    # 통상 단일 chunk는 0, split된 chunk는 0/1/2... 식.
    return Chunk(
        id=f"{parsed.law}#{first.ordinal:04d}-{split_idx}",
        law=parsed.law,
        effective_date=parsed.effective_date,
        chapter=first.chapter,
        section=first.section,
        article=article,
        content=content,
        content_hash=_content_hash(content),
        token_count=token_count,
        refs=sorted({r for n in nodes for r in n.refs}),
        pages=sorted({n.page for n in nodes if n.page is not None}),
        source_node_ids=[n.id for n in nodes],
    )
