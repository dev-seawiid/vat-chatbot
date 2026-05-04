from __future__ import annotations

from typing import Any

import psycopg
from pgvector.psycopg import register_vector

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


# 명명 파라미터(%(name)s)로 dict-of-row를 그대로 executemany에 넘길 수 있게 설계 —
# 호출부에서 청크 dict + embedding 키를 합쳐 한 번에 전달 가능.
_UPSERT_SQL = """
INSERT INTO chunks
    (doc_id, section_ordinal, chunk_ordinal, content, content_hash,
     token_count, heading, page, anchor, embedding)
VALUES
    (%(doc_id)s, %(section_ordinal)s, %(chunk_ordinal)s, %(content)s, %(content_hash)s,
     %(token_count)s, %(heading)s, %(page)s, %(anchor)s, %(embedding)s)
ON CONFLICT (content_hash) DO NOTHING;
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


def upsert_chunks(conn: psycopg.Connection, rows: list[dict[str, Any]]) -> None:
    """content_hash 충돌 시 무시 — 동일 텍스트 재적재 시 행 수 변화 없음(멱등)."""
    with conn.cursor() as cur:
        cur.executemany(_UPSERT_SQL, _strip_nul(rows))
    conn.commit()


def count_by_doc(conn: psycopg.Connection, doc_id: str) -> int:
    """ON CONFLICT DO NOTHING은 cur.rowcount가 부정확 — 적재 전후 count 차이로 신규 수 측정용."""
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM chunks WHERE doc_id = %s;", (doc_id,))
        return cur.fetchone()[0]
