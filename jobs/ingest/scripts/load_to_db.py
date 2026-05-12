import json

from ingest.load.db.client import get_sessionmaker
from ingest.shared.paths import (
    CHUNKS_DIR,
    EMBEDDINGS_DIR,
    MANIFEST_JSON,
    SOURCES_JSON,
    make_arg_parser,
    print_table,
    require_path,
)
from ingest.load.chunk_repository import (
    count_chunks_by_doc,
    insert_chunks,
)
from ingest.load.document_repository import upsert_document
from ingest.load.service import build_chunk_rows


def main() -> int:
    args = make_arg_parser("Load chunks + embeddings into Postgres").parse_args()
    require_path(CHUNKS_DIR, hint="run ingest:chunk first")
    require_path(SOURCES_JSON)
    require_path(MANIFEST_JSON, hint="run ingest:fetch first")

    sources = json.loads(SOURCES_JSON.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_JSON.read_text(encoding="utf-8"))
    # id → sources.json entry — title/url 등 doc 메타 조회용.
    by_id = {p["id"]: p for p in sources.get("pdfs", [])}

    target_ids = set(args.ids)

    rows: list[list[str]] = []
    failed = 0
    SessionLocal = get_sessionmaker()
    with SessionLocal() as session:
        for path in sorted(CHUNKS_DIR.glob("*.json")):
            sid = path.stem
            if target_ids and sid not in target_ids:
                continue

            embed_path = EMBEDDINGS_DIR / f"{sid}.json"
            if not embed_path.exists():
                rows.append([sid, "-", "! no embeddings — run ingest:embed first"])
                failed += 1
                continue
            entry = by_id.get(sid)
            mani = manifest.get(sid)
            if not entry or not mani or not mani.get("sha256"):
                rows.append([sid, "-", "! sources.json/manifest 매핑 누락"])
                failed += 1
                continue

            chunks = json.loads(path.read_text(encoding="utf-8"))
            embeds = json.loads(embed_path.read_text(encoding="utf-8"))

            # documents 먼저 — chunks의 doc_id FK는 여기서 받은 uuid가 들어가야 함.
            # file_hash는 fetch 단계에서 이미 계산된 manifest sha256을 그대로 사용
            # (재계산 회피 + fetch 단계의 truth와 일치).
            doc_uuid = upsert_document(
                session,
                title=entry["title"],
                file_hash=mani["sha256"],
                source_url=entry.get("url"),
                version=entry["version"],
            )

            # 청크 JSON과 임베딩 JSON은 분리 저장 — content_hash로 join해야 청크 재생성 후
            # 임베딩 미갱신 같은 비정합 상태를 detect할 수 있다.
            by_hash = {e["content_hash"]: e["embedding"] for e in embeds}

            try:
                db_rows = build_chunk_rows(
                    chunks=chunks,
                    embeddings_by_hash=by_hash,
                    doc_uuid=doc_uuid,
                    source_id=sid,
                    kind=entry.get("kind", "pdf"),
                    tax_type=entry["tax_type"],
                    doc_version=entry["version"],
                )
            except KeyError as exc:
                # 누락 hash가 있으면 부분 적재로 진행하지 않고 즉시 보고 — 청크/임베딩 캐시
                # 동기화가 깨진 신호이므로 silent skip은 디버깅 곤란.
                rows.append(
                    [sid, "-", f"! missing embedding for hash {exc.args[0][:12]}"]
                )
                failed += 1
                continue

            # before/after 차이가 실제 신규 적재 수. ON CONFLICT DO NOTHING이라
            # SQLAlchemy result.rowcount는 신뢰 불가.
            before = count_chunks_by_doc(session, doc_uuid)
            insert_chunks(session, db_rows)
            after = count_chunks_by_doc(session, doc_uuid)
            rows.append([sid, str(len(chunks)), str(after - before)])

    print_table(
        headers=["ID", "CHUNKS", "INSERTED"],
        rows=rows,
        widths=[40, -7, -9],
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
