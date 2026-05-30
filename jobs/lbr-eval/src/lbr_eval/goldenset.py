"""golden_set.csv 리더 — lbr-eval은 must_include_articles만 사용.

base 4-컬럼(id/Input/Expected Output/Metadata) + must_include_articles 1컬럼 읽음.
나머지 컬럼(must_exclude/expected_label/expected_refusal 등)은 ragas-eval 및 향후
다른 평가가 활용 가능 — lbr-eval은 무시.
"""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class GoldenItem:
    id: str
    question: str
    expected_output: str
    metadata: dict[str, Any] = field(default_factory=dict)
    must_include_articles: list[str] = field(default_factory=list)


def _parse_json_list(raw: str) -> list[Any]:
    raw = (raw or "").strip()
    if not raw:
        return []
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError(f"expected JSON list, got {type(parsed).__name__}: {raw!r}")
    return parsed


def load_golden_set(path: Path | str) -> list[GoldenItem]:
    path = Path(path)
    items: list[GoldenItem] = []
    with path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            metadata = json.loads(row.get("Metadata") or "{}")
            include = _parse_json_list(row.get("must_include_articles") or "")
            items.append(
                GoldenItem(
                    id=row["id"],
                    question=row["Input"],
                    expected_output=row["Expected Output"],
                    metadata=metadata,
                    must_include_articles=[str(x) for x in include],
                )
            )
    return items
