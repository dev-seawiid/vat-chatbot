from __future__ import annotations

from pydantic import BaseModel, Field


class Section(BaseModel):
    ordinal: int
    heading: str
    content: str
    page: int | None = None
    anchor: str | None = None


class ExtractResult(BaseModel):
    source_id: str
    kind: str
    title: str
    page_count: int
    sections: list[Section]
    meta: dict = Field(default_factory=dict)


class Chunk(BaseModel):
    doc_id: str
    section_ordinal: int
    chunk_ordinal: int
    content: str
    content_hash: str
    token_count: int
    heading: str
    page: int | None = None
    anchor: str | None = None
