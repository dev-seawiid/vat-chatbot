# Embedding

ingest plane과 retrieval plane이 같은 모델·차원·호출 모드를 박제해야 cosine 유사도가 의미를 가지는 **cross-plane invariant**. 모델 ID 변경 = 전체 재적재.

## 1. Invariant

| 항목 | 값 | 박제 위치 |
|---|---|---|
| 모델 | `voyage-3` | `jobs/ingest/src/ingest/embedding/embedder.py::DEFAULT_MODEL` + `packages/core/src/adapters/embedding.ts::EMBEDDING_MODEL_ID` |
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
DEFAULT_MODEL = "voyage-3"
DEFAULT_BATCH_SIZE = 128  # voyage-3 한도: 1000건/120K 토큰 — 보수적 설정 (~64K 토큰)

def embed_documents(texts: list[str], ...) -> list[list[float]]:
    client = voyageai.Client(api_key=..., max_retries=5)
    for batch in batches(texts, 128):
        result = client.embed(batch, model="voyage-3", input_type="document")
        out.extend(result.embeddings)
    return out
```

**`content_hash` 기반 캐시** (`scripts/embed_chunks.py`):
- `.cache/embeddings/{sid}.json`에 기존 결과 로드.
- 새 청크 중 `content_hash`가 캐시에 없는 것만 voyage API 호출.
- 결과 표:
  ```
  ID                          CHUNKS  NEW  CACHED  OUT
  nts-vat-2025-2q-manual         413   12     401  .cache/embeddings/...
  ```
- 동일 텍스트 재실행 시 API 비용 0. 청크 size·overlap 조정 같은 큰 변경에선 hash가 바뀌어 재호출.

## 4. Retrieval (query mode)

`packages/core/src/adapters/embedding.ts` — `startActiveObservation('voyage.embed', { asType: 'embedding' })`로 감싸 model + Voyage 응답 `usage.total_tokens`를 박는다. Langfuse가 model + usageDetails로 cost 환산(voyage-3 단가는 대시보드에 1회 등록).

```ts
const embed: EmbedFn = (text, opts) =>
  startActiveObservation("voyage.embed", async (obs) => {
    obs.update({ input: text, model: "voyage-3", metadata: { input_type: opts.input_type } });
    const res = await fetch(VOYAGE_URL, { /* ... input_type: "query" ... */ });
    const parsed = VoyageResponseSchema.parse(await res.json());
    if (parsed.usage) {
      const t = parsed.usage.total_tokens;
      obs.update({ usageDetails: { input: t, total: t } });
    }
    return parsed.data[0]!.embedding;
  }, { asType: "embedding" });
```

호출 위치: `RetrievalService.retrieve(query, opts)` 안에서 `embed(query, { input_type: "query" })` → 결과 vector를 `ChunkRepository.search`에 넘김. retrieve 전체가 `retriever` span으로 감싸지고 그 안에 `embedding`/`pgvector.search` 두 child가 박힌다. 자세한 흐름은 [retrieval.md](./retrieval.md), trace 스키마는 [observability.md §4](./observability.md#4-trace-스키마).

## 5. 모델 교체 시 절차

`voyage-3` → 다른 모델로 바꿀 때 필요한 단계:
1. `embedder.py::DEFAULT_MODEL`과 `adapters/embedding.ts::EMBEDDING_MODEL_ID` 동시 변경
2. 차원이 다르면 `chunks.embedding` 컬럼 `vector(N)` 마이그레이션 + HNSW 인덱스 재생성
3. `.cache/embeddings/` 전체 삭제 후 `pnpm ingest:embed` 재실행 → `pnpm ingest:load` 재실행
4. eval 골든셋 재실행으로 회귀 측정 ([evaluation.md](./evaluation.md))

## 6. 후속

- Voyage retry는 TS plane 미구현 — query 호출 실패 시 즉시 throw. 외부 호출이 일시 실패하는 케이스 대응은 [TODO.md](./TODO.md).
- 모델 변경 비용이 크므로 candidates 비교는 eval 골든셋으로 baseline 측정 후 결정.
