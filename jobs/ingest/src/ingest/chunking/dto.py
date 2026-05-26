from pydantic import BaseModel, Field


class Chunk(BaseModel):
    id: str
    law: str
    effective_date: str | None = None
    chapter: str | None = None
    section: str | None = None
    article: str | None = None
    content: str
    content_hash: str
    token_count: int
    refs: list[str] = Field(default_factory=list)
    pages: list[int] = Field(default_factory=list)
    source_node_ids: list[str] = Field(default_factory=list)
