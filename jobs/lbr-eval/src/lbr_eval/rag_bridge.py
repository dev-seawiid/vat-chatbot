"""core(TS) CLI 호출 어댑터 — retrieval-only 모드.

core가 serverless로 분리되면 본 모듈만 HTTP fetch로 교체. contract 유지.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[4]


@dataclass
class AskResult:
    chunks: list[dict[str, Any]]


def _last_json_line(stdout: str) -> dict[str, Any]:
    lines = [ln for ln in stdout.strip().splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError("core CLI produced no stdout")
    return json.loads(lines[-1])


def run_retrieval_only(question: str) -> AskResult:
    """retrieval-only 모드 — `pnpm core:retrieve` CLI 호출. answer 노드 우회, chunks만 반환.
    generation LLM은 draft 1회만 호출(HyDE+claims). answer agent 미호출.
    """
    result = subprocess.run(
        ["pnpm", "-F", "@vat/core", "--silent", "retrieve", question, "--json"],
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    payload = _last_json_line(result.stdout)
    return AskResult(chunks=payload.get("chunks", []))
