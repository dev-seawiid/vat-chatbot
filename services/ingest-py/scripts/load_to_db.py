from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from uuid import UUID

from ingest.gateway import (
    connect,
    count_chunks_by_doc,
    insert_chunks,
    upsert_document,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCES_PATH = REPO_ROOT / "data" / "sources.json"
PDFS_DIR = REPO_ROOT / ".cache" / "pdfs"
MANIFEST_PATH = PDFS_DIR / "manifest.json"
EXTRACTED_DIR = REPO_ROOT / ".cache" / "extracted"
CHUNKS_DIR = REPO_ROOT / ".cache" / "chunks"
EMBED_DIR = REPO_ROOT / ".cache" / "embeddings"


def _to_db_row(
    chunk: dict[str, Any],
    embedding: list[float],
    doc_uuid: UUID,
    kind: str,
) -> dict[str, Any]:
    """청크 dict + embedding → DB row 매핑.

    spec metadata jsonb 정책에 따라 검색 predicate에 안 쓰이는 필드들
    (section_ordinal/chunk_ordinal/token_count/anchor)을 metadata로 흡수.
    section_path는 W1 청크가 단일 레벨 heading만 가지므로 그대로 매핑 — 향후
    hierarchical chunker 도입 시 같이 갱신.
    """
    return {
        "doc_id": doc_uuid,
        "page": chunk.get("page"),
        "section_path": chunk.get("heading"),
        "content": chunk["content"],
        "content_hash": chunk["content_hash"],
        "embedding": embedding,
        "metadata": {
            "kind": kind,
            "section_ordinal": chunk["section_ordinal"],
            "chunk_ordinal": chunk["chunk_ordinal"],
            "token_count": chunk["token_count"],
            "anchor": chunk.get("anchor"),
        },
    }


def main() -> int:
    if not CHUNKS_DIR.exists():
        print(
            f"ERROR: {CHUNKS_DIR} not found — run ingest:chunk first",
            file=sys.stderr,
        )
        return 1
    if not SOURCES_PATH.exists() or not MANIFEST_PATH.exists():
        print("ERROR: sources.json / manifest.json missing — run ingest:fetch first", file=sys.stderr)
        return 1

    sources = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    # id → sources.json entry — title/url 등 doc 메타 조회용.
    by_id = {p["id"]: p for p in sources.get("pdfs", [])}

    target_ids = set(sys.argv[1:])

    print(f"\n{'ID':<40} {'CHUNKS':>7} {'INSERTED':>9}")
    print("-" * 65)

    failed = 0
    with connect() as conn:
        for path in sorted(CHUNKS_DIR.glob("*.json")):
            sid = path.stem
            if target_ids and sid not in target_ids:
                continue

            embed_path = EMBED_DIR / f"{sid}.json"
            if not embed_path.exists():
                print(f"{sid:<40} ! no embeddings — run ingest:embed first")
                failed += 1
                continue
            entry = by_id.get(sid)
            mani = manifest.get(sid)
            if not entry or not mani or not mani.get("sha256"):
                print(f"{sid:<40} ! sources.json/manifest 매핑 누락")
                failed += 1
                continue

            chunks = json.loads(path.read_text(encoding="utf-8"))
            embeds = json.loads(embed_path.read_text(encoding="utf-8"))

            # documents 먼저 — chunks의 doc_id FK는 여기서 받은 uuid가 들어가야 함.
            # file_hash는 fetch 단계에서 이미 계산된 manifest sha256을 그대로 사용
            # (재계산 회피 + fetch 단계의 truth와 일치).
            doc_uuid = upsert_document(
                conn,
                title=entry["title"],
                file_hash=mani["sha256"],
                source_url=entry.get("url"),
                version=str(entry["issued_year"]) if entry.get("issued_year") else None,
            )

            # 청크 JSON과 임베딩 JSON은 분리 저장 — content_hash로 join해야 청크 재생성 후
            # 임베딩 미갱신 같은 비정합 상태를 detect할 수 있다.
            by_hash = {e["content_hash"]: e["embedding"] for e in embeds}

            try:
                rows = [
                    _to_db_row(c, by_hash[c["content_hash"]], doc_uuid, kind=entry.get("kind", "pdf"))
                    for c in chunks
                ]
            except KeyError as exc:
                # 누락 hash가 있으면 부분 적재로 진행하지 않고 즉시 보고 — 청크/임베딩 캐시
                # 동기화가 깨진 신호이므로 silent skip은 디버깅 곤란.
                print(f"{sid:<40} ! missing embedding for hash {exc.args[0][:12]}")
                failed += 1
                continue

            # before/after 차이가 실제 신규 적재 수. ON CONFLICT DO NOTHING이라
            # executemany의 rowcount는 신뢰 불가.
            before = count_chunks_by_doc(conn, doc_uuid)
            insert_chunks(conn, rows)
            after = count_chunks_by_doc(conn, doc_uuid)
            print(f"{sid:<40} {len(chunks):>7} {after - before:>9}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
