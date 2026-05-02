from __future__ import annotations

import voyageai

from ingest.config import get_settings

# voyage-3 spec: batch당 최대 1000건/120K 토큰. 스펙 §1.1 기준 128로 보수적 설정 —
# 평균 청크 ~500토큰 × 128 ≈ 64K 토큰으로 한도 절반.
DEFAULT_BATCH_SIZE = 128
DEFAULT_MODEL = "voyage-3"

# SDK 내부에서 429/5xx에 대해 지수 백오프로 재시도. 별도 래핑 불필요.
SDK_MAX_RETRIES = 5


def _client() -> voyageai.Client:
    return voyageai.Client(
        api_key=get_settings().voyage_api_key,
        max_retries=SDK_MAX_RETRIES,
    )


def embed_documents(
    texts: list[str],
    batch_size: int = DEFAULT_BATCH_SIZE,
    model: str = DEFAULT_MODEL,
) -> list[list[float]]:
    """문서(청크) 임베딩. 검색 시 query는 input_type='query'로 별도 호출 필요."""
    client = _client()
    out: list[list[float]] = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        result = client.embed(batch, model=model, input_type="document")
        out.extend(result.embeddings)
    return out
