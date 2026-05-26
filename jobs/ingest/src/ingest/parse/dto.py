from pydantic import BaseModel, Field


class Node(BaseModel):
    id: str
    law: str
    effective_date: str | None = None
    chapter: str | None = None
    section: str | None = None
    text: str
    refs: list[str] = Field(default_factory=list)
    page: int | None = None
    ordinal: int


class ParsedDocument(BaseModel):
    source: str
    law: str
    effective_date: str | None = None
    nodes: list[Node]
