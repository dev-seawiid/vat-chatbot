from typing import Literal

from pydantic import BaseModel, Field


class Node(BaseModel):
    id: str
    law: str
    effective_date: str | None = None
    article: str | None = None
    paragraph: int | None = None
    item: int | None = None
    sub_item: str | None = None
    kind: Literal["body", "annex"] = "body"
    annex: str | None = None
    heading_path: list[str] = Field(default_factory=list)
    text: str
    refs: list[str] = Field(default_factory=list)
    page: int | None = None
    ordinal: int


class ParsedDocument(BaseModel):
    source: str
    law: str
    effective_date: str | None = None
    nodes: list[Node]
