from pydantic import BaseModel


# Pydantic DTO — pipeline 단계 사이에서 JSON으로 직렬화되는 청크 표현.
# DB 적재 시점의 ORM 표현(`ingest.load.db.models.Chunk`)과는 다른 책임이라 modifier로 구분.
# DDD ubiquitous language: 같은 단어가 다른 의미일 때 modifier(DTO/Row)로 분리.
class ChunkDTO(BaseModel):
    doc_id: str
    section_ordinal: int
    chunk_ordinal: int
    content: str
    content_hash: str
    token_count: int
    heading: str
    page: int | None = None
    anchor: str | None = None
