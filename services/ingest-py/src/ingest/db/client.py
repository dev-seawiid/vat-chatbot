from __future__ import annotations

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
