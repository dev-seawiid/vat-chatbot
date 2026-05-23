import uuid
from typing import Any


def build_chunk_rows(
    *,
    chunks: list[dict[str, Any]],
    embeddings_by_hash: dict[str, list[float]],
    doc_uuid: uuid.UUID,
) -> list[dict[str, Any]]:
    """Chunk dict + embedding 매핑 → DB row 리스트.

    schema의 page/section_path는 1차 검색·렌더링용 컬럼이라 평탄화하고, 나머지 법령
    메타(article/paragraph/item/refs 등)는 metadata jsonb에 흡수 — 후속 retrieval
    필터(parent fetch, 1-hop ref expansion)가 `metadata->>` 로 접근.

    누락 hash가 있으면 KeyError 전파 — 호출자가 부분 적재 대신 즉시 보고하도록.
    """
    return [
        {
            "doc_id": doc_uuid,
            "page": (c["pages"][0] if c.get("pages") else None),
            "section_path": " > ".join(c["heading_path"]) if c.get("heading_path") else None,
            "content": c["content"],
            "content_hash": c["content_hash"],
            "embedding": embeddings_by_hash[c["content_hash"]],
            "metadata": {
                "chunk_id": c["id"],
                "law": c["law"],
                "effective_date": c.get("effective_date"),
                "article": c.get("article"),
                "paragraph": c.get("paragraph"),
                "item": c.get("item"),
                "parent_article_id": c.get("parent_article_id"),
                "heading_path": c.get("heading_path", []),
                "refs": c.get("refs", []),
                "pages": c.get("pages", []),
                "source_node_ids": c.get("source_node_ids", []),
                "token_count": c.get("token_count"),
            },
        }
        for c in chunks
    ]
