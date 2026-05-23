import json

from ingest.chunking.chunker import chunk_parsed
from ingest.parse.dto import ParsedDocument
from ingest.shared.paths import (
    CHUNKS_DIR,
    PARSED_DIR,
    REPO_ROOT,
    make_arg_parser,
    print_table,
    require_path,
)


def main() -> int:
    args = make_arg_parser(
        "Chunk parsed nodes into embedding-ready segments"
    ).parse_args()
    require_path(PARSED_DIR, hint="run ingest:parse first")

    files = sorted(PARSED_DIR.glob("*.json"))
    if args.ids:
        wanted = set(args.ids)
        files = [f for f in files if f.stem in wanted]
    if not files:
        print(f"No parsed caches in {PARSED_DIR}")
        return 1

    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[list[str]] = []
    for src in files:
        parsed = ParsedDocument.model_validate_json(src.read_text(encoding="utf-8"))
        chunks = chunk_parsed(parsed)
        out = CHUNKS_DIR / f"{src.stem}.json"
        out.write_text(
            json.dumps([c.model_dump() for c in chunks], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        avg = sum(c.token_count for c in chunks) / len(chunks) if chunks else 0
        rows.append([
            parsed.law,
            str(len(parsed.nodes)),
            str(len(chunks)),
            f"{avg:.0f}",
            str(out.relative_to(REPO_ROOT)),
        ])
    print_table(
        headers=["LAW", "NODES", "CHUNKS", "AVG_TOK", "OUT"],
        rows=rows,
        widths=[25, -6, -7, -8, 50],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
