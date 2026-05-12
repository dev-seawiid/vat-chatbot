import uuid
from typing import Any


def build_chunk_rows(
    *,
    chunks: list[dict[str, Any]],
    embeddings_by_hash: dict[str, list[float]],
    doc_uuid: uuid.UUID,
    source_id: str,
    kind: str,
    tax_type: str,
    doc_version: str,
) -> list[dict[str, Any]]:
    """청크 dict + embedding 매핑 → DB row 리스트로 변환.

    spec §3.1 메타 정의에 따라 jsonb로 흡수:
    - 검색 predicate(`tax_type`/`doc_version`/`kind`) — `metadata->>` 로 WHERE 가능
    - 디버깅·렌더링용(`section_ordinal`/`chunk_ordinal`/`token_count`/`anchor`)

    `doc_version`은 documents.version과 중복이지만 chunk 단위 컨텍스트 렌더링·필터에서
    join 없이 바로 보이게 하려는 의도(spec §3.1 표).
    `source_id`는 sources.json의 자연키(예: `nts-vat-2025-2q-manual`) — 평가 채점에서
    `expected_citation_doc`과 직접 비교하기 위한 휴먼 가독 키(2026-05-07 eval 슬라이스 §0.4 #1).
    section_path는 W1 청크가 단일 레벨 heading만 가지므로 그대로 매핑.

    누락 hash가 있으면 KeyError 전파 — 호출자(script)가 부분 적재로 진행하지 않고 즉시
    보고하도록(청크/임베딩 캐시 동기화가 깨진 신호이므로 silent skip은 디버깅 곤란).
    """
    return [
        {
            "doc_id": doc_uuid,
            "page": c.get("page"),
            "section_path": c.get("heading"),
            "content": c["content"],
            "content_hash": c["content_hash"],
            "embedding": embeddings_by_hash[c["content_hash"]],
            "metadata": {
                "source_id": source_id,
                "kind": kind,
                "tax_type": tax_type,
                "doc_version": doc_version,
                "section_ordinal": c["section_ordinal"],
                "chunk_ordinal": c["chunk_ordinal"],
                "token_count": c["token_count"],
                "anchor": c.get("anchor"),
            },
        }
        for c in chunks
    ]
