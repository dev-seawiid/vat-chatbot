"""조문 ID 합성·파싱 — LegalBench-RAG는 snippet(file + char offset) 단위지만
우리 코퍼스는 조 단위 chunking → 조문 ID로 매칭. ingest는 `article`을 "49" 또는 "5의2" raw로 적재.
사람·골든셋용 ID는 "제49조" / "제5조의2" 형식.

paragraph/item 메타는 현 chunking이 조 단위라 미적재 — granularity는 사실상 "article"만 유효.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal


Granularity = Literal["article", "paragraph", "item"]


@dataclass(frozen=True)
class ArticleId:
    law: str
    article: str
    paragraph: int | None = None
    item: int | None = None

    def with_granularity(self, g: Granularity) -> "ArticleId":
        if g == "article":
            return ArticleId(self.law, self.article)
        if g == "paragraph":
            return ArticleId(self.law, self.article, self.paragraph)
        return self


def format_article_id(aid: ArticleId, g: Granularity = "article") -> str:
    parts: list[str] = [aid.law, aid.article]
    if g in ("paragraph", "item") and aid.paragraph is not None:
        parts.append(f"제{aid.paragraph}항")
    if g == "item" and aid.item is not None:
        parts.append(f"제{aid.item}호")
    return "-".join(parts)


_PARA_RE = re.compile(r"^제(\d+)항$")
_ITEM_RE = re.compile(r"^제(\d+)호$")


def parse_article_id(s: str) -> ArticleId:
    parts = s.split("-")
    if len(parts) < 2:
        raise ValueError(f"bad article id: {s!r}")
    law, article = parts[0], parts[1]
    paragraph: int | None = None
    item: int | None = None
    for extra in parts[2:]:
        if (m := _PARA_RE.match(extra)) and paragraph is None:
            paragraph = int(m.group(1))
        elif (m := _ITEM_RE.match(extra)) and item is None:
            item = int(m.group(1))
        else:
            raise ValueError(f"unknown segment: {extra!r} in {s!r}")
    return ArticleId(law=law, article=article, paragraph=paragraph, item=item)


_RAW_ARTICLE_RE = re.compile(r"^(\d+)(?:의(\d+))?$")


def _normalize_article(raw: str) -> str:
    """ingest의 raw "29" / "5의2" → 사람용 "제29조" / "제5조의2"."""
    if raw.startswith("제"):
        return raw
    m = _RAW_ARTICLE_RE.match(raw)
    if not m:
        return raw
    n, sub = m.group(1), m.group(2)
    return f"제{n}조의{sub}" if sub else f"제{n}조"


def chunk_to_article_id(
    metadata: dict[str, Any],
    g: Granularity = "article",
) -> ArticleId | None:
    law = metadata.get("law")
    article = metadata.get("article")
    if not (isinstance(law, str) and isinstance(article, str)):
        return None
    article_norm = _normalize_article(article)
    paragraph_raw = metadata.get("paragraph")
    item_raw = metadata.get("item")
    paragraph = (
        int(paragraph_raw)
        if isinstance(paragraph_raw, (int, str)) and str(paragraph_raw).isdigit()
        else None
    )
    item = (
        int(item_raw)
        if isinstance(item_raw, (int, str)) and str(item_raw).isdigit()
        else None
    )
    aid = ArticleId(law=law, article=article_norm, paragraph=paragraph, item=item)
    return aid.with_granularity(g)
