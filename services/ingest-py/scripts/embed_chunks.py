from __future__ import annotations

import json
import sys
from pathlib import Path

from ingest.embed import embed_documents

REPO_ROOT = Path(__file__).resolve().parents[3]
CHUNKS_DIR = REPO_ROOT / ".cache" / "chunks"
OUT_DIR = REPO_ROOT / ".cache" / "embeddings"


def _load_existing(path: Path) -> dict[str, list[float]]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {row["content_hash"]: row["embedding"] for row in data}


def main() -> int:
    if not CHUNKS_DIR.exists():
        print(
            f"ERROR: {CHUNKS_DIR} not found — run chunk_pdfs.py first",
            file=sys.stderr,
        )
        return 1

    target_ids = set(sys.argv[1:])
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"\n{'ID':<40} {'CHUNKS':>7} {'NEW':>5} {'CACHED':>7}  OUT")
    print("-" * 95)

    failed = 0
    for path in sorted(CHUNKS_DIR.glob("*.json")):
        sid = path.stem
        if target_ids and sid not in target_ids:
            continue

        try:
            chunks = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"{sid:<40} ! {exc}")
            failed += 1
            continue

        out_path = OUT_DIR / f"{sid}.json"
        cached = _load_existing(out_path)

        # content_hash 미스인 청크만 재호출 — 동일 텍스트 재실행 시 API 비용 0.
        to_embed_idx = [
            i for i, c in enumerate(chunks) if c["content_hash"] not in cached
        ]
        to_embed_texts = [chunks[i]["content"] for i in to_embed_idx]

        if to_embed_texts:
            try:
                vectors = embed_documents(to_embed_texts)
            except Exception as exc:
                print(f"{sid:<40} ! {exc}")
                failed += 1
                continue
            for idx, vec in zip(to_embed_idx, vectors):
                cached[chunks[idx]["content_hash"]] = vec

        # 청크 순서 유지하며 저장. indent 없이 압축 저장 — 1024-dim × 수천 행은 가독성보다 용량.
        rows = [
            {"content_hash": c["content_hash"], "embedding": cached[c["content_hash"]]}
            for c in chunks
        ]
        out_path.write_text(
            json.dumps(rows, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        rel = out_path.relative_to(REPO_ROOT)
        print(
            f"{sid:<40} {len(chunks):>7} {len(to_embed_texts):>5}"
            f" {len(chunks) - len(to_embed_texts):>7}  {rel}"
        )

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
