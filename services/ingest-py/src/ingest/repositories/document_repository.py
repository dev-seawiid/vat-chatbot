from __future__ import annotations

from uuid import UUID

import psycopg


def upsert_document(
    conn: psycopg.Connection,
    *,
    title: str,
    file_hash: str,
    source_url: str | None = None,
    version: str | None = None,
) -> UUID:
    """file_hash 기반 멱등 — 같은 파일을 두 번 ingest해도 documents 한 행만 유지(spec §3.1).
    있으면 그 id를, 없으면 INSERT 후 새 id를 반환. 동일 file_hash로 title/version 갱신은
    무시 — 파일 내용이 같으면 문서도 같다는 invariant 유지(변경됐으면 새 file_hash).
    """
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM documents WHERE file_hash = %s;", (file_hash,))
        row = cur.fetchone()
        if row:
            return row[0]
        cur.execute(
            """
            INSERT INTO documents (title, source_url, version, file_hash)
            VALUES (%s, %s, %s, %s)
            RETURNING id;
            """,
            (title, source_url, version, file_hash),
        )
        new_id = cur.fetchone()[0]
    conn.commit()
    return new_id
