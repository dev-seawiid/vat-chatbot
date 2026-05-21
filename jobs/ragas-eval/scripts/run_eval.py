"""Langfuse Dataset 기반 RAGAS 평가 + score push back.

## 동작 흐름

  Langfuse Dataset (UI 등록)
        │
        ▼
  [Phase 1] 문항별 파이프라인 — 한 item씩 순차 처리, 결과를 로컬 jsonl에 체크포인트
        for item in remaining:
            answer, contexts = rag_run(item.input)          # core CLI subprocess
            scores            = score_all(metrics, sample)  # 4종 RAGAS metric 계산
            jsonl row append + 디스크 fsync                  # 비싼 judge 결과 영구화
        │
        ▼
  [Phase 2] Langfuse 업로드 — 위 jsonl을 traversal하며 score만 전송
        for row in jsonl:
            with item.run(run_name=...) as span:            # Langfuse 측 trace 생성·link
                langfuse.update_current_trace(input,output) # UI 표시용
                span.score_trace(name, value) per metric    # 메트릭 점수 push
        langfuse.flush()                                    # 버퍼 → 서버 일괄 전송 1회

## Fallback 전략

  · 중단·강제종료: jsonl까지 박힌 sample은 done → 재실행 시 skip (judge LLM 비용 0 재태움)
  · 빈 응답(LLM이 텍스트 0): jsonl에 그대로 박되 response-사용 metric은 0점으로 박고
                              judge 호출 skip — 평균이 정확히 반영되고 추가 비용 없음
  · 옛 jsonl row의 metric 누락: Phase 2 시점에 빈 응답이면 0으로 backfill
  · 재실행 trace 누적: run_name = `{dataset}-{timestamp}` 형태라 매 실행이 별도 run
  · 개별 metric 실패: dict에서 omit하고 진행 — 한 metric 깨져도 나머지 보존

ragas 0.4.x collections OOP API — evaluate() 옛 API 미사용.
"""
import inspect
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import IO

from langfuse import Langfuse
from ragas.metrics.collections import (
    AnswerCorrectness,
    AnswerRelevancy,
    ContextPrecisionWithReference,
    Faithfulness,
)

from ragas_eval.embeddings import make_embeddings
from ragas_eval.llm import make_llm
from ragas_eval.rag import rag_run

REPO_ROOT = Path(__file__).resolve().parents[3]
DATASET_NAME = os.environ.get("LANGFUSE_DATASET_NAME", "vat-rag-golden-v1")
# 실행마다 unique run_name — 같은 run에 trace 중복 누적 방지 (Langfuse docs 권장).
RUN_NAME = f"{DATASET_NAME}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
OUTPUT_PATH = Path(
    os.environ.get("RAGAS_EVAL_OUTPUT", str(REPO_ROOT / ".tmp/ragas-eval/results.jsonl"))
)


# ---------- jsonl I/O ----------

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
                # 손상된 끝줄(ctrl+C로 잘린 line)은 무시 — 재처리됨.
                continue
    return done


def load_rows(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


# ---------- metrics ----------

def build_metrics(llm, embeddings) -> list:
    return [
        Faithfulness(llm=llm),
        AnswerRelevancy(llm=llm, embeddings=embeddings),
        ContextPrecisionWithReference(llm=llm),
        AnswerCorrectness(llm=llm, embeddings=embeddings),
    ]


def _kwargs_for(metric, sample: dict) -> dict:
    sig = inspect.signature(metric.ascore)
    return {k: sample[k] for k in sig.parameters if k in sample}


def score_all(metrics: list, sample: dict) -> tuple[dict[str, float], float]:
    """각 metric 호출 + per-metric log. response 비고 metric이 response 사용 → 0점.
    judge LLM 호출 skip, 평균엔 RAG 실패가 0점으로 정확히 반영됨."""
    scores: dict[str, float] = {}
    total = 0.0
    response_empty = not sample.get("response", "").strip()

    for m in metrics:
        kwargs = _kwargs_for(m, sample)
        uses_response = "response" in kwargs
        if response_empty and uses_response:
            scores[m.name] = 0.0
            print(f"    · {m.name:<35}   ----  score=0.000 (empty response — judge skipped)")
            continue

        t0 = time.monotonic()
        try:
            result = m.score(**kwargs)
            scores[m.name] = float(result.value)
            dt = time.monotonic() - t0
            total += dt
            print(f"    ✓ {m.name:<35} {dt:6.2f}s  score={scores[m.name]:.3f}")
        except Exception as e:
            dt = time.monotonic() - t0
            total += dt
            first_line = str(e).strip().splitlines()[0][:120]
            print(f"    ✗ {m.name:<35} {dt:6.2f}s  FAILED: {first_line}")
    return scores, total


# ---------- phase 1 (per-item, resumable) ----------

def process_item(item, metrics: list, file: IO) -> tuple[float, float]:
    """한 item: RAG → score_all → jsonl row append + flush. 반환: (t_rag, t_judge)."""
    q_preview = item.input[:60].replace("\n", " ")
    print(f"    Q: {q_preview}{'...' if len(item.input) > 60 else ''}")

    t0 = time.monotonic()
    answer, contexts = rag_run(item.input)
    t_rag = time.monotonic() - t0
    print(f"    → RAG {t_rag:6.2f}s  ans={len(answer)}ch  ctx={len(contexts)} chunks")

    ground_truth = item.expected_output or ""
    sample = {
        "user_input": item.input,
        "response": answer,
        "retrieved_contexts": contexts,
        "reference": ground_truth,
    }
    scores, t_judge = score_all(metrics, sample)

    file.write(
        json.dumps(
            {
                "sample_id": item.id,
                "question": item.input,
                "answer": answer,
                "contexts": contexts,
                "ground_truth": ground_truth,
                "scores": scores,
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    file.flush()
    return t_rag, t_judge


def phase1_collect(dataset, metrics: list, output: Path) -> None:
    """resume → for remaining: process_item → 끝에 cumulative log."""
    output.parent.mkdir(parents=True, exist_ok=True)
    done = load_done(output)
    if done:
        print(f"resume: {len(done)} already done in {output}")

    items = list(dataset.items)
    remaining = [it for it in items if it.id not in done]
    print(f"phase 1: RAG+score for {len(remaining)} new / {len(items)} total")

    cum_rag = 0.0
    cum_judge = 0.0
    with output.open("a", encoding="utf-8") as f:
        for i, item in enumerate(remaining, 1):
            print(f"\n  [{i}/{len(remaining)}] {item.id}")
            t_rag, t_judge = process_item(item, metrics, f)
            cum_rag += t_rag
            cum_judge += t_judge
            print(
                f"    Σ item={t_rag + t_judge:6.2f}s  "
                f"(cum: RAG={cum_rag:.1f}s, judge={cum_judge:.1f}s)"
            )

    print(f"\nphase 1 done — cumulative: RAG {cum_rag:.1f}s + judge {cum_judge:.1f}s")


# ---------- phase 2 (batch push) ----------

def push_one(
    langfuse: Langfuse,
    item,
    row: dict,
    expected_response_using: set[str],
    expected_all: set[str],
) -> int:
    """한 row: 누락 metric 0-backfill(빈 응답일 때만) → with item.run() ctx에서
    update_current_trace + score_trace per metric. 반환: backfill 수."""
    scores = dict(row.get("scores") or {})
    backfilled = 0
    if not row.get("answer", "").strip():
        for name in (expected_all - scores.keys()) & expected_response_using:
            scores[name] = 0.0
            backfilled += 1

    with item.run(run_name=RUN_NAME) as root_span:
        # v3에서 item.run()은 trace input/output을 자동 박지 않음 — 명시 호출 필요.
        langfuse.update_current_trace(input=row["question"], output=row["answer"])
        for name, value in scores.items():
            root_span.score_trace(name=f"ragas_{name}", value=float(value))
    return backfilled


def phase2_push(langfuse: Langfuse, dataset, metrics: list, output: Path) -> None:
    """rows load → for row: push_one → langfuse.flush() 1회."""
    item_by_id = {it.id: it for it in dataset.items}
    expected_response_using = {
        m.name for m in metrics if "response" in inspect.signature(m.ascore).parameters
    }
    expected_all = {m.name for m in metrics}

    rows = load_rows(output)
    print(f"phase 2: push {len(rows)} traces -> Langfuse run='{RUN_NAME}'")

    pushed = 0
    total_backfill = 0
    for row in rows:
        item = item_by_id.get(row["sample_id"])
        if item is None:
            continue
        total_backfill += push_one(
            langfuse, item, row, expected_response_using, expected_all
        )
        pushed += 1

    langfuse.flush()
    suffix = f"  (backfilled {total_backfill} missing 0-scores)" if total_backfill else ""
    print(f"done: pushed {pushed}/{len(rows)} traces{suffix}")


# ---------- entrypoint ----------

def main() -> None:
    langfuse = Langfuse()
    dataset = langfuse.get_dataset(DATASET_NAME)
    metrics = build_metrics(make_llm(), make_embeddings())
    phase1_collect(dataset, metrics, OUTPUT_PATH)
    phase2_push(langfuse, dataset, metrics, OUTPUT_PATH)


if __name__ == "__main__":
    main()
