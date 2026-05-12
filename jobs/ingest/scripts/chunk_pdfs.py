import json

from pydantic import ValidationError

from ingest.chunking.chunker import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_OVERLAP,
    chunk_extract_result,
)
from ingest.shared.paths import (
    CHUNKS_DIR,
    EXTRACTED_DIR,
    REPO_ROOT,
    make_arg_parser,
    print_table,
    require_path,
)
from ingest.extract.dto import ExtractResult


def main() -> int:
    args = make_arg_parser("Chunk extracted sections into token-bounded pieces").parse_args()
    require_path(EXTRACTED_DIR, hint="run extract_pdfs.py first")

    target_ids = set(args.ids)
    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)

    rows: list[list[str]] = []
    failed = 0
    for path in sorted(EXTRACTED_DIR.glob("*.json")):
        sid = path.stem
        if target_ids and sid not in target_ids:
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            result = ExtractResult.model_validate(data)
        except (json.JSONDecodeError, ValidationError) as exc:
            rows.append([sid, "-", "-", "-", "-", f"! {exc}"])
            failed += 1
            continue

        chunks = chunk_extract_result(
            result, max_tokens=DEFAULT_MAX_TOKENS, overlap=DEFAULT_OVERLAP
        )
        # TODO(v2): doc 내 content_hash 중복 skip — extract가 PDF 챕터 시작부의
        # 좌/우 페이지(같은 헤더 텍스트)를 page별로 별도 section으로 emit해서
        # nts-vat-2025-2q-manual은 415→209로 약 50%가 중복. DB UNIQUE 제약이
        # load 시 흡수하므로 검색·답변엔 무영향이지만, 다수 PDF 추가 시 임베딩
        # API 비용이 그만큼 낭비. 여기서 seen=set() 으로 1~2줄 dedup이면 충분.
        if chunks:
            avg = sum(c.token_count for c in chunks) // len(chunks)
            mx = max(c.token_count for c in chunks)
        else:
            avg = mx = 0

        out_path = CHUNKS_DIR / f"{sid}.json"
        out_path.write_text(
            json.dumps(
                [c.model_dump() for c in chunks],
                indent=2,
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        rel = str(out_path.relative_to(REPO_ROOT))
        rows.append(
            [sid, str(len(result.sections)), str(len(chunks)), str(avg), str(mx), rel]
        )

    print_table(
        headers=["ID", "SECTIONS", "CHUNKS", "AVG_TOK", "MAX_TOK", "OUT"],
        rows=rows,
        widths=[40, -9, -7, -8, -8, 40],
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
