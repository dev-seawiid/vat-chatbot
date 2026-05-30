"""LegalBench-RAG (Pipitone 2024, arxiv 2408.10343) 본체 메트릭 — Precision@k, Recall@k.

원본은 snippet(file + char index) 단위. 우리 코퍼스는 조 단위 chunking → 조문 ID set 비교로 변형.
LLM 0회, 결정적.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from lbr_eval.article_id import (
    Granularity,
    chunk_to_article_id,
    format_article_id,
    parse_article_id,
)


@dataclass
class RetrievalScores:
    precision_at_k: float
    recall_at_k: float
    k: int
    retrieved_ids: list[str]
    must_include_ids: list[str]
    matched: list[str]


def _normalize_ids(ids: list[str], g: Granularity) -> set[str]:
    out: set[str] = set()
    for s in ids:
        aid = parse_article_id(s).with_granularity(g)
        out.add(format_article_id(aid, g))
    return out


def score_retrieval(
    *,
    retrieved_chunks: list[dict[str, Any]],
    must_include_articles: list[str],
    k: int,
    granularity: Granularity = "article",
) -> RetrievalScores:
    """retrieved_chunks: ask --json의 `chunks` 필드(metadata 포함). 상위 k개로 잘라 평가."""
    top_k = retrieved_chunks[:k]
    retrieved_ids: set[str] = set()
    for c in top_k:
        meta = c.get("metadata") or {}
        aid = chunk_to_article_id(meta, granularity)
        if aid is None:
            continue
        retrieved_ids.add(format_article_id(aid, granularity))

    include = _normalize_ids(must_include_articles, granularity)
    matched = retrieved_ids & include

    # Precision@k: retrieved 중 정답 비율. 0건 retrieve면 0.
    # Recall@k: 정답 중 retrieved 비율. include 0건이면 정의 불가 → 1.0(완전 만족).
    # 주: Recall@k가 주 시그널(누락은 LLM이 복구 불가). P@k는 비용·k튜닝 보조 지표
    # (R@k 동등할 때 토큰 절약 가능한 k 찾기). 논문(LBR §4.2)은 두 메트릭 동등 가중이나,
    # 우리는 누락 위험을 우선시.
    precision = (len(matched) / len(retrieved_ids)) if retrieved_ids else 0.0
    recall = (len(matched) / len(include)) if include else 1.0

    return RetrievalScores(
        precision_at_k=precision,
        recall_at_k=recall,
        k=k,
        retrieved_ids=sorted(retrieved_ids),
        must_include_ids=sorted(include),
        matched=sorted(matched),
    )
