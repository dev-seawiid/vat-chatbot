from ingest.parse.parser import parse_file
from ingest.shared.paths import (
    EXTRACTED_DIR,
    PARSED_DIR,
    REPO_ROOT,
    make_arg_parser,
    print_table,
    require_path,
)


def main() -> int:
    args = make_arg_parser(
        "Parse Docling JSON cache into article/paragraph/item nodes"
    ).parse_args()
    require_path(EXTRACTED_DIR, hint="run ingest:extract first")

    files = sorted(EXTRACTED_DIR.glob("*.json"))
    if args.ids:
        wanted = set(args.ids)
        files = [f for f in files if f.stem in wanted]
    if not files:
        print(f"No extract caches in {EXTRACTED_DIR}")
        return 1

    PARSED_DIR.mkdir(parents=True, exist_ok=True)
    rows: list[list[str]] = []
    for src in files:
        parsed = parse_file(src)
        out = PARSED_DIR / f"{src.stem}.json"
        out.write_text(parsed.model_dump_json(indent=2), encoding="utf-8")
        rows.append([
            src.name,
            parsed.law,
            str(len(parsed.nodes)),
            str(out.relative_to(REPO_ROOT)),
        ])

    print_table(
        headers=["EXTRACT", "LAW", "NODES", "OUT"],
        rows=rows,
        widths=[60, 20, -6, 50],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
