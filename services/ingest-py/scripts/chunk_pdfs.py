from __future__ import annotations

import json
import sys
from pathlib import Path

from ingest.chunk import DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP, chunk_extract_result
from ingest.schemas import ExtractResult

REPO_ROOT = Path(__file__).resolve().parents[3]
EXTRACTED_DIR = REPO_ROOT / ".cache" / "extracted"
OUT_DIR = REPO_ROOT / ".cache" / "chunks"


def main() -> int:
    if not EXTRACTED_DIR.exists():
        print(
            f"ERROR: {EXTRACTED_DIR} not found — run extract_pdfs.py first",
            file=sys.stderr,
        )
        return 1

    target_ids = set(sys.argv[1:])
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(
        f"\n{'ID':<40} {'SECTIONS':>9} {'CHUNKS':>7} {'AVG_TOK':>8} {'MAX_TOK':>8}  OUT"
    )
    print("-" * 110)

    failed = 0
    for path in sorted(EXTRACTED_DIR.glob("*.json")):
        sid = path.stem
        if target_ids and sid not in target_ids:
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            result = ExtractResult.model_validate(data)
        except Exception as exc:
            print(f"{sid:<40} ! {exc}")
            failed += 1
            continue

        chunks = chunk_extract_result(
            result, max_tokens=DEFAULT_MAX_TOKENS, overlap=DEFAULT_OVERLAP
        )
        if chunks:
            avg = sum(c.token_count for c in chunks) // len(chunks)
            mx = max(c.token_count for c in chunks)
        else:
            avg = mx = 0

        out_path = OUT_DIR / f"{sid}.json"
        out_path.write_text(
            json.dumps(
                [c.model_dump() for c in chunks],
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        rel = out_path.relative_to(REPO_ROOT)
        print(
            f"{sid:<40} {len(result.sections):>9} {len(chunks):>7} {avg:>8} {mx:>8}  {rel}"
        )

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
