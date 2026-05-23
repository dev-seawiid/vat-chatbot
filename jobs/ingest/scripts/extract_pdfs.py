from docling.datamodel.base_models import ConversionStatus

from ingest.extract.extractor import extract_pdfs
from ingest.shared.paths import (
    EXTRACTED_DIR,
    RAG_KB_DIR,
    REPO_ROOT,
    make_arg_parser,
    print_table,
    require_path,
)


def main() -> int:
    args = make_arg_parser(
        "Convert PDFs in data/rag_knowledge_base/ to DoclingDocument JSON cache"
    ).parse_args()
    require_path(RAG_KB_DIR, hint="place law PDFs in data/rag_knowledge_base/")

    pdfs = sorted(RAG_KB_DIR.glob("*.pdf"))
    if args.ids:
        wanted = set(args.ids)
        pdfs = [p for p in pdfs if p.stem in wanted]
    if not pdfs:
        print(f"No PDFs to extract in {RAG_KB_DIR}")
        return 1

    outcomes = extract_pdfs(pdfs, EXTRACTED_DIR)
    rows = [
        [
            o.source.name,
            o.status.name,
            str(o.output.relative_to(REPO_ROOT)) if o.output else "-",
        ]
        for o in outcomes
    ]
    print_table(
        headers=["PDF", "STATUS", "OUT"],
        rows=rows,
        widths=[70, -10, 50],
    )
    failed = sum(1 for o in outcomes if o.status != ConversionStatus.SUCCESS)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
