from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Json

# 명명 파라미터로 dict-of-row를 그대로 executemany에 넘김 — 호출부는 청크 dict + embedding을
# 합쳐 한 번에 전달.
_INSERT_CHUNKS_SQL = """
INSERT INTO chunks
    (doc_id, page, section_path, content, content_hash, embedding, metadata)
VALUES
    (%(doc_id)s, %(page)s, %(section_path)s, %(content)s, %(content_hash)s,
     %(embedding)s, %(metadata)s)
ON CONFLICT (doc_id, content_hash) DO NOTHING;
"""


def _strip_nul(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Postgres TEXT는 NUL(0x00)을 거부 — PDF 추출 단계에서 새어나온 NUL을 모든 문자열 필드에서 제거.
    content_hash는 의도적으로 정제 전 원본 기준을 유지 — 임베딩 캐시(hash 키)·이미 적재된 행과의
    정합성 보존이 우선이고, NUL은 검색·인용에 무의미한 바이트라 정제로 잃을 의미가 없다.
    """
    return [
        {k: v.replace("\x00", "") if isinstance(v, str) else v for k, v in r.items()}
        for r in rows
    ]


def insert_chunks(conn: psycopg.Connection, rows: list[dict[str, Any]]) -> None:
    """(doc_id, content_hash) 충돌 시 무시 — 동일 doc 안 같은 청크 재적재해도 행 수 변화 없음.
    rows의 metadata 필드는 plain dict — 함수 내부에서 Json 어댑터로 wrap (psycopg3는 dict→jsonb
    자동 변환을 안 해줌).
    """
    prepared: list[dict[str, Any]] = []
    for r in rows:
        # 입력 dict mutate 방지 — 호출자 쪽에서 같은 dict가 재사용될 수 있음.
        new_r = dict(r)
        meta = new_r.get("metadata")
        if isinstance(meta, dict):
            new_r["metadata"] = Json(meta)
        prepared.append(new_r)
    cleaned = _strip_nul(prepared)
    with conn.cursor() as cur:
        cur.executemany(_INSERT_CHUNKS_SQL, cleaned)
    conn.commit()


def count_chunks_by_doc(conn: psycopg.Connection, doc_id: UUID | str) -> int:
    """ON CONFLICT DO NOTHING은 cur.rowcount가 부정확 — 적재 전후 count 차이로 신규 수 측정용."""
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM chunks WHERE doc_id = %s;", (doc_id,))
        return cur.fetchone()[0]
