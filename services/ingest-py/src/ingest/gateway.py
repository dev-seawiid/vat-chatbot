from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from pgvector.psycopg import register_vector
from psycopg.types.json import Json

from ingest.config import get_settings


def connect() -> psycopg.Connection:
    """로컬·Neon 양쪽에서 안전하게 동작하는 커넥션을 반환."""
    # Neon은 pgbouncer transaction-mode 풀러 뒤에 있다 — 같은 커넥션이 매 트랜잭션마다
    # 다른 백엔드에 연결될 수 있어, psycopg가 캐시한 prepared statement가 깨진다.
    # prepare_threshold=None으로 prepare를 끄면 로컬·Neon 모두에서 안전 (로컬은 손해 없음).
    conn = psycopg.connect(
        get_settings().database_url,
        prepare_threshold=None,
    )
    # 어댑터 미등록 시 VECTOR 컬럼에 list 바인딩하면 형변환 에러 — 등록하면 list[float] → vector
    # 자동 매핑되어 호출부가 SQL 문자열 포맷을 직접 만질 필요 없음.
    register_vector(conn)
    return conn


# documents -----------------------------------------------------------------


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


# chunks --------------------------------------------------------------------

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
