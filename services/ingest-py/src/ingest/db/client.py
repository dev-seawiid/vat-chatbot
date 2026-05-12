from __future__ import annotations

from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from ingest.config import get_settings


def _normalize_url(url: str) -> str:
    """SQLAlchemy 2.0은 driver를 명시해야 psycopg3를 고름. 기본 `postgresql://`은 psycopg2를 찾는다."""
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


@lru_cache
def get_engine() -> Engine:
    """프로세스당 1회 engine 인스턴스 — connection pool 재사용. Neon pgbouncer transaction-mode
    풀러 대응으로 prepare_threshold=None을 psycopg3에 전달(prepared statement cache 무효 회피).
    pgvector adapter는 `pgvector.sqlalchemy.Vector` 컬럼 타입이 자동 핸들 — connection-level
    register_vector 호출 불필요.
    """
    return create_engine(
        _normalize_url(get_settings().database_url),
        connect_args={"prepare_threshold": None},
    )


@lru_cache
def get_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(get_engine(), expire_on_commit=False)
