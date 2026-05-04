from __future__ import annotations

import json
import sys
from pathlib import Path

from ingest.db import connect, count_by_doc, upsert_chunks

REPO_ROOT = Path(__file__).resolve().parents[3]
CHUNKS_DIR = REPO_ROOT / ".cache" / "chunks"
EMBED_DIR = REPO_ROOT / ".cache" / "embeddings"


def main() -> int:
    if not CHUNKS_DIR.exists():
        print(
            f"ERROR: {CHUNKS_DIR} not found — run ingest:chunk first",
            file=sys.stderr,
        )
        return 1

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

            chunks = json.loads(path.read_text(encoding="utf-8"))
            embeds = json.loads(embed_path.read_text(encoding="utf-8"))
            # 청크 JSON과 임베딩 JSON은 분리 저장(인덱스 정렬은 같지만) — content_hash로
            # 다시 join해야 청크 재생성 후 임베딩 미갱신 같은 비정합 상태를 detect할 수 있다.
            by_hash = {e["content_hash"]: e["embedding"] for e in embeds}

            try:
                rows = [
                    {**c, "embedding": by_hash[c["content_hash"]]} for c in chunks
                ]
            except KeyError as exc:
                # 누락 hash가 있으면 부분 적재로 진행하지 않고 즉시 보고 — 청크/임베딩 캐시
                # 동기화가 깨진 신호이므로 silent skip은 디버깅 곤란.
                print(f"{sid:<40} ! missing embedding for hash {exc.args[0][:12]}")
                failed += 1
                continue

            # before/after 차이가 실제 신규 적재 수. ON CONFLICT DO NOTHING이라
            # executemany의 rowcount는 신뢰 불가.
            before = count_by_doc(conn, sid)
            upsert_chunks(conn, rows)
            after = count_by_doc(conn, sid)
            print(f"{sid:<40} {len(chunks):>7} {after - before:>9}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
