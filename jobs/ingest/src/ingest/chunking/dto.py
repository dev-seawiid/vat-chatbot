from pydantic import BaseModel, Field


class Chunk(BaseModel):
    id: str
    law: str
    effective_date: str | None = None
    article: str | None = None
    paragraph: int | None = None
    item: int | None = None
    parent_article_id: str | None = None
    heading_path: list[str] = Field(default_factory=list)
    content: str
    content_hash: str
    token_count: int
    refs: list[str] = Field(default_factory=list)
    pages: list[int] = Field(default_factory=list)
    source_node_ids: list[str] = Field(default_factory=list)
