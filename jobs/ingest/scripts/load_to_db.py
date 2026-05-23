import hashlib
import json
import unicodedata
from pathlib import Path

from sqlalchemy import text

from ingest.load.chunk_repository import count_chunks_by_doc, insert_chunks
from ingest.load.db.client import get_sessionmaker
from ingest.load.document_repository import upsert_document
from ingest.load.service import build_chunk_rows
from ingest.shared.paths import (
    CHUNKS_DIR,
    EMBEDDINGS_DIR,
    RAG_KB_DIR,
    make_arg_parser,
    print_table,
    require_path,
)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def _find_pdf(stem_nfc: str) -> Path | None:
    """캐시 stem(NFC)에 대응하는 원본 PDF — macOS APFS는 파일명을 NFD로 저장."""
    for p in RAG_KB_DIR.glob("*.pdf"):
        if unicodedata.normalize("NFC", p.stem) == stem_nfc:
            return p
    return None


def main() -> int:
    parser = make_arg_parser("Load chunks + dense embeddings into Postgres")
    parser.add_argument(
        "--reset",
        action="store_true",
        help="truncate chunks+documents before reload (ADR-0002 §1.6)",
    )
    args = parser.parse_args()
    require_path(CHUNKS_DIR, hint="run ingest:chunk first")
    require_path(EMBEDDINGS_DIR, hint="run ingest:embed first")
    require_path(RAG_KB_DIR)

    target_ids = set(args.ids)
    rows: list[list[str]] = []
    failed = 0
    SessionLocal = get_sessionmaker()
    with SessionLocal() as session:
        if args.reset:
            session.execute(
                text("TRUNCATE chunks, documents RESTART IDENTITY CASCADE")
            )
            session.commit()

        for chunk_path in sorted(CHUNKS_DIR.glob("*.json")):
            stem = unicodedata.normalize("NFC", chunk_path.stem)
            if target_ids and stem not in target_ids:
                continue

            embed_path = EMBEDDINGS_DIR / chunk_path.name
            if not embed_path.exists():
                rows.append([stem[:40], "-", "! no embeddings — run ingest:embed first"])
                failed += 1
                continue

            pdf_path = _find_pdf(stem)
            if pdf_path is None:
                rows.append([stem[:40], "-", "! source PDF not found in RAG_KB_DIR"])
                failed += 1
                continue

            chunks = json.loads(chunk_path.read_text(encoding="utf-8"))
            embeds = json.loads(embed_path.read_text(encoding="utf-8"))
            if not chunks:
                rows.append([stem[:40], "0", "! empty chunks"])
                continue
            first = chunks[0]

            doc_uuid = upsert_document(
                session,
                title=first["law"],
                file_hash=_sha256(pdf_path),
                version=first.get("effective_date"),
            )

            by_hash = {e["content_hash"]: e["embedding"] for e in embeds}
            try:
                db_rows = build_chunk_rows(
                    chunks=chunks,
                    embeddings_by_hash=by_hash,
                    doc_uuid=doc_uuid,
                )
            except KeyError as exc:
                rows.append([stem[:40], "-", f"! missing embedding for hash {exc.args[0][:12]}"])
                failed += 1
                continue

            before = count_chunks_by_doc(session, doc_uuid)
            insert_chunks(session, db_rows)
            after = count_chunks_by_doc(session, doc_uuid)
            rows.append([first["law"], str(len(chunks)), str(after - before)])

    print_table(
        headers=["LAW", "CHUNKS", "INSERTED"],
        rows=rows,
        widths=[25, -7, -10],
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
