"""ParsedDocument → embedding-ready Chunk.

(article, paragraph, item) 키로 parse 노드를 그룹화하면 호 단위 임베딩이
자연스럽게 떨어지고 같은 호의 흩어진 list_item들이 합쳐진다. heading은
법명·조항호 식별이 검색 정확도에 결정적이라 chunk 맨 앞에 prepend한다.

Contextual prefix(LLM 도메인 요약 prepend, ADR §1.4-2)는 별도 sub-step.
"""

import hashlib
from collections.abc import Iterable

import voyageai

from ingest.chunking.dto import Chunk
from ingest.parse.dto import Node, ParsedDocument
from ingest.shared.config import get_settings

MAX_TOKENS = 512
OVERLAP_TOKENS = 150


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _heading_line(
    law: str,
    article: str | None,
    paragraph: int | None,
    item: int | None,
    chapters: list[str],
) -> str:
    parts = [law]
    if article:
        parts.append(f"제{article}조")
    if paragraph:
        parts.append(f"제{paragraph}항")
    if item:
        parts.append(f"제{item}호")
    head = " ".join(parts)
    if chapters:
        head += " (" + " > ".join(chapters) + ")"
    return head


def _group_nodes(nodes: Iterable[Node]) -> list[list[Node]]:
    groups: list[list[Node]] = []
    current: list[Node] = []
    current_key: tuple | None = None
    for n in nodes:
        key = (n.article, n.paragraph, n.item)
        if current and key != current_key:
            groups.append(current)
            current = []
        current.append(n)
        current_key = key
    if current:
        groups.append(current)
    return groups


def chunk_parsed(parsed: ParsedDocument) -> list[Chunk]:
    settings = get_settings()
    client = voyageai.Client(api_key=settings.voyage_api_key)
    model = settings.voyage_model

    chunks: list[Chunk] = []
    for group in _group_nodes(parsed.nodes):
        body = "\n".join(n.text for n in group if n.text).strip()
        if not body:
            continue
        first = group[0]
        head = _heading_line(
            parsed.law, first.article, first.paragraph, first.item, first.heading_path
        )
        parent_id = f"{parsed.law}#{first.article}" if first.article else None

        full = f"{head}\n\n{body}"
        token_count = client.count_tokens([full], model=model)
        if token_count <= MAX_TOKENS:
            chunks.append(_make_chunk(parsed, first, group, full, token_count, parent_id))
            continue

        # 호/항 단위가 max를 초과하는 드문 케이스 — char 단위 슬라이딩(token≈char 가정).
        step = MAX_TOKENS - OVERLAP_TOKENS
        for i in range(0, len(body), step):
            piece = body[i : i + MAX_TOKENS]
            content = f"{head}\n\n{piece}"
            tk = client.count_tokens([content], model=model)
            chunks.append(_make_chunk(parsed, first, group, content, tk, parent_id))
    return chunks


def _make_chunk(
    parsed: ParsedDocument,
    first: Node,
    group: list[Node],
    content: str,
    token_count: int,
    parent_id: str | None,
) -> Chunk:
    return Chunk(
        id=f"{parsed.law}#{first.ordinal:04d}",
        law=parsed.law,
        effective_date=parsed.effective_date,
        article=first.article,
        paragraph=first.paragraph,
        item=first.item,
        parent_article_id=parent_id,
        heading_path=first.heading_path,
        content=content,
        content_hash=_content_hash(content),
        token_count=token_count,
        refs=sorted({r for n in group for r in n.refs}),
        pages=sorted({n.page for n in group if n.page is not None}),
        source_node_ids=[n.id for n in group],
    )
