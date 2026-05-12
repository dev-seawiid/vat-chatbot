import json

from ingest.shared.paths import (
    EXTRACTED_DIR,
    MANIFEST_JSON,
    PDFS_DIR,
    REPO_ROOT,
    SOURCES_JSON,
    make_arg_parser,
    print_table,
    require_path,
)
from ingest.extract.extractor import extract_pdf


def main() -> int:
    args = make_arg_parser("Extract structured sections from cached PDFs").parse_args()
    require_path(SOURCES_JSON)
    require_path(MANIFEST_JSON, hint="run fetch_pdfs.py first")

    sources = json.loads(SOURCES_JSON.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST_JSON.read_text(encoding="utf-8"))

    target_ids = set(args.ids) or {p["id"] for p in sources.get("pdfs", [])}
    EXTRACTED_DIR.mkdir(parents=True, exist_ok=True)

    rows: list[list[str]] = []
    failed = 0
    for entry in sources.get("pdfs", []):
        sid = entry["id"]
        if sid not in target_ids:
            continue
        m = manifest.get(sid)
        if not m or not m.get("sha256"):
            rows.append([sid, "-", "-", "! not in manifest"])
            failed += 1
            continue
        pdf_path = PDFS_DIR / f"{m['sha256']}.pdf"
        if not pdf_path.exists():
            rows.append([sid, "-", "-", "! cached file missing"])
            failed += 1
            continue
        # pdfplumber + 추출 파이프라인은 던지는 예외 종류가 다양(파일 손상·인코딩·표 파싱 등).
        # bare Exception은 PEP 8가 권장하지 않지만, 한 줄로 보고 + 다음 파일 계속 처리하는
        # batch 특성상 광범위 catch가 정당 — 단, 메시지는 그대로 노출해 디버깅 가능.
        try:
            result = extract_pdf(pdf_path, source_id=sid, title=entry["title"])
        except Exception as exc:
            rows.append([sid, "-", "-", f"! {exc}"])
            failed += 1
            continue
        out_path = EXTRACTED_DIR / f"{sid}.json"
        out_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
        rel = str(out_path.relative_to(REPO_ROOT))
        rows.append(
            [sid, str(result.page_count), str(len(result.sections)), rel]
        )

    print_table(
        headers=["ID", "PAGES", "SECTIONS", "OUT"],
        rows=rows,
        widths=[40, -6, -9, 50],
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
