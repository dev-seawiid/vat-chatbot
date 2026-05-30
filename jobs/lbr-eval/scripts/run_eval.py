"""LegalBench-RAG retrieval eval — Precision@k, Recall@k.

Phase 1: 각 문항에 retrieval-only RAG → metrics 계산 → jsonl 체크포인트.
Phase 2: jsonl → Langfuse trace push (LANGFUSE_DATASET_NAME 설정 시).

LLM 호출: per item draft 1회(HyDE+claims, retrieval pipeline 필수). answer agent 미호출.
ragas-eval과 보완 관계 — ragas-eval은 generation 평가(LLM judge), lbr-eval은 retrieval 평가(deterministic).
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import IO

from langfuse import Langfuse

from lbr_eval import GoldenItem, load_golden_set, run_retrieval_only
from lbr_eval.metrics import score_retrieval

REPO_ROOT = Path(__file__).resolve().parents[3]
DATASET_NAME = os.environ.get("LANGFUSE_DATASET_NAME", "")
RUN_NAME = f"lbr-{DATASET_NAME or 'local'}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUTPUT_PATH = Path(
    os.environ.get("LBR_EVAL_OUTPUT", str(REPO_ROOT / ".tmp/lbr-eval/results.jsonl"))
)
GOLDEN_SET_PATH = Path(
    os.environ.get("GOLDEN_SET_PATH", str(REPO_ROOT / "data/golden_set.csv"))
)
EVAL_K = int(os.environ.get("LBR_EVAL_K", "10"))
# 현 chunking은 조 단위라 paragraph/item 메타 미적재 → "article"이 유일 유효값.
GRANULARITY = os.environ.get("LBR_EVAL_GRANULARITY", "article")


def load_done(path: Path) -> set[str]:
    if not path.exists():
        return set()
    done: set[str] = set()
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                done.add(json.loads(line)["sample_id"])
            except (json.JSONDecodeError, KeyError):
                continue
    return done


def process_item(item: GoldenItem, file: IO) -> float:
    q_preview = item.question[:60].replace("\n", " ")
    print(f"    Q: {q_preview}{'...' if len(item.question) > 60 else ''}")

    t0 = time.monotonic()
    rag = run_retrieval_only(item.question)
    t_rag = time.monotonic() - t0
    print(f"    → retrieval {t_rag:6.2f}s  chunks={len(rag.chunks)}")

    scores = score_retrieval(
        retrieved_chunks=rag.chunks,
        must_include_articles=item.must_include_articles,
        k=EVAL_K,
        granularity=GRANULARITY,  # type: ignore[arg-type]
    )
    print(
        f"    ✓ P@{EVAL_K}={scores.precision_at_k:.3f}  "
        f"R@{EVAL_K}={scores.recall_at_k:.3f}  matched={len(scores.matched)}/{len(scores.must_include_ids)}"
    )

    file.write(
        json.dumps(
            {
                "sample_id": item.id,
                "question": item.question,
                "scores": {
                    "precision_at_k": scores.precision_at_k,
                    "recall_at_k": scores.recall_at_k,
                },
                "retrieved_ids": scores.retrieved_ids,
                "must_include_ids": scores.must_include_ids,
                "matched": scores.matched,
                "k": EVAL_K,
                "granularity": GRANULARITY,
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    file.flush()
    return t_rag


def phase1_collect(items: list[GoldenItem], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    done = load_done(output)
    if done:
        print(f"resume: {len(done)} already done in {output}")

    remaining = [it for it in items if it.id not in done]
    print(f"phase 1: retrieval+score for {len(remaining)} new / {len(items)} total")

    cum = 0.0
    with output.open("a", encoding="utf-8") as f:
        for i, item in enumerate(remaining, 1):
            print(f"\n  [{i}/{len(remaining)}] {item.id}")
            cum += process_item(item, f)
            print(f"    Σ cum={cum:.1f}s")


def phase2_push(output: Path) -> None:
    if not DATASET_NAME:
        print("LANGFUSE_DATASET_NAME unset — phase 2 skipped (local-only run)")
        return
    langfuse = Langfuse()
    dataset = langfuse.get_dataset(DATASET_NAME)
    item_by_id = {it.id: it for it in dataset.items}

    rows = []
    with output.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    print(f"phase 2: push {len(rows)} traces → Langfuse run='{RUN_NAME}'")

    pushed = 0
    for row in rows:
        item = item_by_id.get(row["sample_id"])
        if item is None:
            continue
        with item.run(run_name=RUN_NAME) as root_span:
            langfuse.update_current_trace(input=row["question"], output="(retrieval-only)")
            for name, value in row["scores"].items():
                root_span.score_trace(name=f"lbr_{name}", value=float(value))
        pushed += 1

    langfuse.flush()
    print(f"done: pushed {pushed}/{len(rows)} traces")


def main() -> None:
    items = load_golden_set(GOLDEN_SET_PATH)
    print(f"loaded {len(items)} items from {GOLDEN_SET_PATH}")
    phase1_collect(items, OUTPUT_PATH)
    phase2_push(OUTPUT_PATH)


if __name__ == "__main__":
    main()
