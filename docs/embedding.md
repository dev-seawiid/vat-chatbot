# Embedding

ingest plane과 retrieval plane이 같은 모델·차원·호출 모드를 박제해야 cosine 유사도가 의미를 가지는 **cross-plane invariant**. 모델 ID 변경 = 전체 재적재.

## 1. Invariant

| 항목 | 값 | 박제 위치 |
|---|---|---|
| 모델 | `voyage-4` (ADR-0002 §1.5) | `jobs/ingest/src/ingest/shared/config.py::voyage_model` default + `packages/core/src/env.ts::VOYAGE_MODEL` default. 양 plane이 `VOYAGE_MODEL` env로 통제 |
| 차원 | 1024 | `chunks.embedding vector(1024)` (Drizzle + SQLAlchemy 양쪽) |
| input_type 분리 | `document` vs `query` | 두 mode가 다르게 학습돼 섞으면 검색 품질 ↓ |

## 2. 두 plane의 차이

| | ingest (Python) | retrieval (TS) |
|---|---|---|
| 호출 시점 | 청크 적재 1회 | 매 사용자 query마다 |
| input_type | `"document"` | `"query"` |
| 배치 | 128건씩 (`DEFAULT_BATCH_SIZE`) | 단건 |
| 클라이언트 | `voyageai.Client` SDK | `fetch` (Voyage TS SDK 미안정) |
| Retry | SDK 자체 5회 (`max_retries=5`) | 없음 — 실패 시 throw |
| 캐싱 | `content_hash` 키로 로컬 JSON 캐시 (재호출 0 비용) | 없음 (query마다 새 호출) |

## 3. Ingest (document mode)

`jobs/ingest/src/ingest/embedding/embedder.py`:
```python
DEFAULT_BATCH_SIZE = 128  # voyage 한도 1000건/120K 토큰 — 평균 ~200토큰 × 128 ≈ 26K (보수)
SDK_MAX_RETRIES = 5       # 429/5xx 자동 백오프

def embed_documents(texts, batch_size=128, model=None):
    client = voyageai.Client(api_key=..., max_retries=5)
    model = model or get_settings().voyage_model  # default voyage-4
    for batch in batches(texts, 128):
        result = client.embed(batch, model=model, input_type="document")
        out.extend(result.embeddings)
    return out
```

**`content_hash` 기반 캐시** (`scripts/embed_chunks.py`):
- `.cache/embeddings/{sid}.json`에 기존 결과 로드.
- 새 청크 중 `content_hash`가 캐시에 없는 것만 voyage API 호출.
- 동일 텍스트 재실행 시 API 비용 0. 청크 size·overlap 조정 같은 큰 변경에선 hash가 바뀌어 재호출.

## 4. Retrieval (query mode)

`packages/core/src/modules/retrieval/embedding.adapter.ts`. `traceEmbedding` HOF로 wrap해 Langfuse generation span에 model + Voyage `usage.total_tokens`를 박는다:

```ts
const embed: EmbedFn = traceEmbedding(
  {
    name: "voyage.embed",
    attrs: ([text, opts]) => ({ input: text, model: modelId, metadata: { input_type: opts.input_type } }),
    output: (embedding) => ({ dim: embedding.length }),  // 벡터 자체는 trace UI에 가치 없음
  },
  async (text, opts) => {
    const res = await fetch(VOYAGE_URL, { /* input_type: "query" */ });
    const parsed = VoyageResponseSchema.parse(await res.json());
    if (parsed.usage) setEmbeddingUsage(parsed.usage.total_tokens);  // 응답 파싱 후 ambient update
    return parsed.data[0]!.embedding;
  },
);
```

호출 위치: `RetrievalService.retrieve`가 `embed(query, { input_type: "query" })` → 결과 vector를 `ChunkRepository.search`에 넘김. retrieve 전체가 `retriever` span으로 감싸지고 그 안에 `embedding`/`pgvector.search` 두 child가 박힌다. 상세 흐름은 [retrieval.md](./retrieval.md), trace 스키마는 [observability.md §4](./observability.md#4-trace-스키마).

## 5. 모델 교체 시 절차

`voyage-4` → 다른 모델로 바꿀 때:
1. `.env`에 `VOYAGE_MODEL=<new>` 설정 (양 plane 동시 적용)
2. 차원이 다르면 `chunks.embedding` 컬럼 `vector(N)` 마이그레이션 + HNSW 인덱스 재생성
3. `.cache/embeddings/` 삭제 후 `pnpm ingest:embed` 재실행 → `pnpm ingest:load` 재실행 (ADR-0002 §1.6 reset+reload로 stale vector 잔류 방지)
4. RAGAS 골든셋 재실행으로 회귀 측정 ([evaluation.md](./evaluation.md))

## 6. 후속

- Voyage retry는 TS plane 미구현 — query 호출 실패 시 즉시 throw. 외부 호출 일시 실패 대응은 [TODO.md](./TODO.md).
- 모델 변경 비용이 크므로 candidates 비교는 RAGAS 골든셋으로 baseline 측정 후 결정.
