import json
from pathlib import Path

from ingest.embedding.embedder import embed_documents
from ingest.shared.config import get_settings
from ingest.shared.paths import (
    CHUNKS_DIR,
    EMBEDDINGS_DIR,
    REPO_ROOT,
    make_arg_parser,
    print_table,
    require_path,
)


def _load_existing(path: Path, model: str) -> dict[str, list[float]]:
    """캐시 row 중 현재 model과 일치하는 것만 재사용. 모델 다르면 dim·학습 mismatch."""
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {r["content_hash"]: r["embedding"] for r in data if r.get("model") == model}


def main() -> int:
    args = make_arg_parser(
        "Embed chunks with Voyage (content_hash+model 캐시 재사용)"
    ).parse_args()
    require_path(CHUNKS_DIR, hint="run ingest:chunk first")

    target_ids = set(args.ids)
    EMBEDDINGS_DIR.mkdir(parents=True, exist_ok=True)
    model = get_settings().voyage_model

    rows: list[list[str]] = []
    failed = 0
    for path in sorted(CHUNKS_DIR.glob("*.json")):
        sid = path.stem
        if target_ids and sid not in target_ids:
            continue

        try:
            chunks = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            rows.append([sid, model, "-", "-", "-", f"! {exc}"])
            failed += 1
            continue

        out_path = EMBEDDINGS_DIR / f"{sid}.json"
        cached = _load_existing(out_path, model)

        # 동일 모델·동일 content_hash인 청크는 재호출 회피 — 재실행 시 API 비용 0.
        to_embed_idx = [
            i for i, c in enumerate(chunks) if c["content_hash"] not in cached
        ]
        to_embed_texts = [chunks[i]["content"] for i in to_embed_idx]

        if to_embed_texts:
            # voyage SDK가 던지는 예외 클래스가 외부 의존이라 narrow type을 import할 가치
            # 낮음(SDK 버전 따라 다름). 광범위 catch + 메시지 노출이 실용 trade-off.
            try:
                vectors = embed_documents(to_embed_texts, model=model)
            except Exception as exc:
                rows.append([sid, model, "-", "-", "-", f"! {exc}"])
                failed += 1
                continue
            for idx, vec in zip(to_embed_idx, vectors):
                cached[chunks[idx]["content_hash"]] = vec

        # 청크 순서 유지. indent 없이 압축 — 1024-dim × 수천 행은 가독성보다 용량.
        out_rows = [
            {
                "content_hash": c["content_hash"],
                "embedding": cached[c["content_hash"]],
                "model": model,
            }
            for c in chunks
        ]
        out_path.write_text(
            json.dumps(out_rows, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        rel = str(out_path.relative_to(REPO_ROOT))
        rows.append([
            sid,
            model,
            str(len(chunks)),
            str(len(to_embed_texts)),
            str(len(chunks) - len(to_embed_texts)),
            rel,
        ])

    print_table(
        headers=["ID", "MODEL", "CHUNKS", "NEW", "CACHED", "OUT"],
        rows=rows,
        widths=[40, 12, -7, -5, -7, 40],
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
