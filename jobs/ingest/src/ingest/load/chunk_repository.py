import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ingest.load.db.models import Chunk


def _strip_nul(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Postgres TEXT는 NUL(0x00)을 거부 — PDF 추출 단계에서 새어나온 NUL을 모든 문자열 필드에서 제거.
    content_hash는 의도적으로 정제 전 원본 기준을 유지 — 임베딩 캐시(hash 키)·이미 적재된 행과의
    정합성 보존이 우선이고, NUL은 검색·인용에 무의미한 바이트라 정제로 잃을 의미가 없다.
    """
    return [
        {k: v.replace("\x00", "") if isinstance(v, str) else v for k, v in r.items()}
        for r in rows
    ]


def _map_to_orm_keys(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """호출자는 DB 컬럼명 그대로 dict를 만들지만, SQLAlchemy declarative base의 `metadata`
    attribute 충돌 회피로 ORM 속성은 `chunk_metadata`로 매핑돼 있다 — insert().values()에
    넘기기 전에 키 이름만 바꿔준다(DB 컬럼명은 그대로 'metadata'로 직렬화됨).
    """
    out: list[dict[str, Any]] = []
    for r in rows:
        new_r = dict(r)
        if "metadata" in new_r:
            new_r["chunk_metadata"] = new_r.pop("metadata")
        out.append(new_r)
    return out


def insert_chunks(session: Session, rows: list[dict[str, Any]]) -> None:
    """(doc_id, content_hash) 충돌 시 무시 — 동일 doc 안 같은 청크 재적재해도 행 수 변화 없음.
    SQLAlchemy의 JSONB·Vector 컬럼이 dict/list 자동 직렬화 — 호출자는 plain dict만 전달.
    """
    if not rows:
        return
    cleaned = _map_to_orm_keys(_strip_nul(rows))
    stmt = insert(Chunk).values(cleaned).on_conflict_do_nothing(
        index_elements=["doc_id", "content_hash"]
    )
    session.execute(stmt)
    session.commit()


def count_chunks_by_doc(session: Session, doc_id: uuid.UUID | str) -> int:
    """ON CONFLICT DO NOTHING은 result.rowcount가 부정확 — 적재 전후 count 차이로 신규 수 측정용."""
    return session.execute(
        select(func.count()).select_from(Chunk).where(Chunk.doc_id == doc_id)
    ).scalar_one()
