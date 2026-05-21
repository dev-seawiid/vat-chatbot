"""RAG bridge — Python(ragas-eval) → core(TS) subprocess 호출.

`packages/core/scripts/ask.ts --json`이 마지막 줄에 {"answer","contexts"}를 stdout으로 뱉음.
core가 단일 진실(prompt/모델/citation verify)이고 ragas-eval은 그대로 채점.
"""
import json
import subprocess
from pathlib import Path
from typing import Tuple

REPO_ROOT = Path(__file__).resolve().parents[4]


def rag_run(question: str) -> Tuple[str, list[str]]:
    """Run core.chat.ask via TS CLI, return (answer, retrieved_chunks)."""
    result = subprocess.run(
        ["pnpm", "-F", "@vat/core", "--silent", "ask", question, "--json"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    last_line = result.stdout.strip().splitlines()[-1]
    payload = json.loads(last_line)
    return payload["answer"], payload["contexts"]
