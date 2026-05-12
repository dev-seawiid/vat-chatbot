import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, Index, Integer, Text, UniqueConstraint, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# SQLAlchemy 2.0 declarative model — TS plane의 Drizzle schema.ts와 1:1.
# 단, 마이그레이션 진실은 Drizzle 단일 소스 — 본 모델로 create_all()을 호출하지 않는다.
# ingest plane이 read/write하는 documents/chunks 두 테이블만 정의. 나머지(messages 등)는
# TS plane이 다루므로 정의하지 않는다(필요해지면 추가).


class Base(DeclarativeBase):
    pass


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, server_default=text("gen_random_uuid()")
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text)
    version: Mapped[str | None] = mapped_column(Text)
    file_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Chunk(Base):
    __tablename__ = "chunks"

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid, primary_key=True, server_default=text("gen_random_uuid()")
    )
    # 부모 documents 행 삭제 시 청크도 함께 정리 — orphan 청크가 검색 결과에 섞이는 사고 방지.
    doc_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    page: Mapped[int | None] = mapped_column(Integer)
    section_path: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # 청크 내용 식별자 — 임베딩 캐시 키와 동일. 재실행/재크롤 안전성에 핵심.
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(1024), nullable=False)
    # SQLAlchemy declarative base의 `metadata` attribute 충돌 회피 — DB 컬럼은 'metadata',
    # 파이썬 attr은 chunk_metadata.
    chunk_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    __table_args__ = (
        # 같은 doc 안에서 동일 청크 중복 방지(서로 다른 doc은 동일 텍스트 가능).
        UniqueConstraint("doc_id", "content_hash", name="uq_chunks_doc_content_hash"),
        Index("idx_chunks_doc_id", "doc_id"),
        # 벡터 검색 인덱스는 Drizzle 측에서 HNSW + cosine으로 관리(spec §2). 본 모델은
        # 마이그레이션 생성에 사용하지 않으므로 인덱스를 정의해도 무해하지만 명세 일치 위해 생략.
    )
