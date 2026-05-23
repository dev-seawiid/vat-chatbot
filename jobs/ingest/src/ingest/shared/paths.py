"""파이프라인 단계 간 공유 경로 + 진입점 boilerplate helper.

5개 script가 각자 `Path(__file__).resolve().parents[3]` + `.cache/<stage>` 상수를
재정의하던 중복을 단일 모듈에 모은다. DRY (Hunt/Thomas, Pragmatic Programmer §7).
"""

import argparse
import sys
from pathlib import Path

# parents: [0]=shared, [1]=ingest, [2]=src, [3]=ingest(jobs/ingest), [4]=jobs, [5]=repo root.
# paths.py 위치(src/ingest/shared/paths.py) 기준.
_REPO_ROOT = Path(__file__).resolve().parents[5]

REPO_ROOT = _REPO_ROOT
RAG_KB_DIR = _REPO_ROOT / "data" / "rag_knowledge_base"
EXTRACTED_DIR = _REPO_ROOT / ".cache" / "extracted"
PARSED_DIR = _REPO_ROOT / ".cache" / "parsed"
CHUNKS_DIR = _REPO_ROOT / ".cache" / "chunks"
EMBEDDINGS_DIR = _REPO_ROOT / ".cache" / "embeddings"


def require_path(path: Path, *, hint: str | None = None) -> None:
    """존재해야 할 입력 경로를 검사. 없으면 stderr 보고 + sys.exit(1).
    각 script 초입의 `if not X.exists(): print; return 1` boilerplate를 한 줄로 압축.
    """
    if not path.exists():
        msg = f"ERROR: {path} not found"
        if hint:
            msg += f" — {hint}"
        print(msg, file=sys.stderr)
        sys.exit(1)


def make_arg_parser(description: str) -> argparse.ArgumentParser:
    """5개 script 공통 진입 — positional ids는 필터(빈 리스트면 전체 처리).
    PEP 389 — argparse는 Python 표준 권장 CLI 파서. raw `sys.argv[1:]` 슬라이싱 회피.
    """
    p = argparse.ArgumentParser(description=description)
    p.add_argument(
        "ids",
        nargs="*",
        metavar="ID",
        help="filter by source ids (default: all entries in sources.json)",
    )
    return p


def print_table(
    headers: list[str], rows: list[list[str]], widths: list[int]
) -> None:
    """고정폭 표 출력 — dep 없이 stdlib만. width 양수=좌정렬, 음수=우정렬.
    각 script가 손수 `{sid:<40} {col:>9}` 포매팅하던 중복을 한 곳에서 처리.
    """
    def _fmt(cells: list[str]) -> str:
        return " ".join(
            f"{c:<{w}}" if w > 0 else f"{c:>{-w}}"
            for c, w in zip(cells, widths)
        )

    print()
    print(_fmt(headers))
    print("-" * (sum(abs(w) for w in widths) + len(widths) - 1))
    for row in rows:
        print(_fmt(row))
