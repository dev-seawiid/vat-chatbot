from __future__ import annotations

import json
import sys
from pathlib import Path

from ingest.sources.pdf import extract_pdf

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCES_PATH = REPO_ROOT / "data" / "sources.json"
CACHE_DIR = REPO_ROOT / ".cache" / "pdfs"
MANIFEST_PATH = CACHE_DIR / "manifest.json"
OUT_DIR = REPO_ROOT / ".cache" / "extracted"


def main() -> int:
    if not SOURCES_PATH.exists():
        print(f"ERROR: {SOURCES_PATH} not found", file=sys.stderr)
        return 1
    if not MANIFEST_PATH.exists():
        print(f"ERROR: {MANIFEST_PATH} not found — run fetch_pdfs.py first", file=sys.stderr)
        return 1

    sources = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    target_ids = set(sys.argv[1:]) or {p["id"] for p in sources.get("pdfs", [])}
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"\n{'ID':<40} {'PAGES':>6} {'SECTIONS':>9}  OUT")
    print("-" * 100)

    failed = 0
    for entry in sources.get("pdfs", []):
        sid = entry["id"]
        if sid not in target_ids:
            continue
        m = manifest.get(sid)
        if not m or not m.get("sha256"):
            print(f"{sid:<40} {'-':>6} {'-':>9}  ! not in manifest")
            failed += 1
            continue
        pdf_path = CACHE_DIR / f"{m['sha256']}.pdf"
        if not pdf_path.exists():
            print(f"{sid:<40} {'-':>6} {'-':>9}  ! cached file missing")
            failed += 1
            continue
        try:
            result = extract_pdf(pdf_path, source_id=sid, title=entry["title"])
        except Exception as exc:
            print(f"{sid:<40} {'-':>6} {'-':>9}  ! {exc}")
            failed += 1
            continue
        out_path = OUT_DIR / f"{sid}.json"
        out_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
        rel = out_path.relative_to(REPO_ROOT)
        print(f"{sid:<40} {result.page_count:>6} {len(result.sections):>9}  {rel}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
