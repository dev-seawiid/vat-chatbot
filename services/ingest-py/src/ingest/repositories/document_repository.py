from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from ingest.db.models import Document


def upsert_document(
    session: Session,
    *,
    title: str,
    file_hash: str,
    source_url: str | None = None,
    version: str | None = None,
) -> uuid.UUID:
    """file_hash 기반 멱등 — 같은 파일을 두 번 ingest해도 documents 한 행만 유지(spec §3.1).
    있으면 그 id를, 없으면 INSERT 후 새 id를 반환. 동일 file_hash로 title/version 갱신은
    무시 — 파일 내용이 같으면 문서도 같다는 invariant 유지(변경됐으면 새 file_hash).
    """
    existing = session.execute(
        select(Document.id).where(Document.file_hash == file_hash)
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    doc = Document(
        title=title,
        file_hash=file_hash,
        source_url=source_url,
        version=version,
    )
    session.add(doc)
    session.commit()
    return doc.id
