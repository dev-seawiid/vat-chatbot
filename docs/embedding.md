# Embedding

ingest plane과 retrieval plane이 같은 모델·차원·호출 모드를 박제해야 cosine 유사도가 의미를 가지는 **cross-plane invariant**. 모델 ID 변경 = 전체 재적재.

## 1. Invariant

| 항목 | 값 | 박제 위치 |
|---|---|---|
| 모델 | `voyage-4` | `jobs/ingest/src/ingest/shared/config.py::voyage_model` default + `packages/core/src/env.ts::VOYAGE_MODEL` default. 양 plane이 `VOYAGE_MODEL` env로 통제 |
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

## 3. 적재 시 임베딩 (document mode)

ingest 단계에서 청크를 문서용(`input_type="document"`) 벡터로 변환한다. 구현은 `embedder.py`(`voyageai` Python SDK, 재시도 5회).

- **배치 처리**: 청크를 128건(`DEFAULT_BATCH_SIZE`)씩 묶어 호출한다. Voyage 한도(1회 1000건·120K 토큰) 안쪽의 보수적인 값.
- **캐시로 재호출 방지**: `content_hash`를 키로 `.cache/embeddings/{sid}.json`에 결과를 저장하고, 캐시에 없는 청크만 API를 부른다. 텍스트가 그대로면 재실행해도 비용이 0이고, 청크 크기·overlap이 바뀌면 해시가 달라져 자동으로 다시 임베딩한다.

## 4. 검색 시 임베딩 (query mode)

검색 시 사용자 질의를 질의용(`input_type="query"`) 벡터로 변환한다. 구현은 `embedding.adapter.ts`. Voyage TS SDK가 아직 불안정해 `fetch`로 직접 호출하며, 질의는 한 건씩 처리한다.

- **호출 흐름**: `RetrievalService.retrieve`가 이 어댑터를 불러 질의 벡터를 얻고, 그 벡터를 `ChunkRepository.search`에 넘겨 유사 청크를 찾는다. 상세 [rag-chain §2](./rag-chain.md#2-검색-primitive-retrievalservice).
- **관측**: `traceEmbedding`이 모델명과 Voyage `usage.total_tokens`를 Langfuse generation span에 기록한다(벡터 값 자체는 남기지 않음). trace 구조는 [observability §4](./observability.md#4-trace-스키마).

## 5. 모델 교체 시 절차

`voyage-4` → 다른 모델로 바꿀 때:
1. `.env`에 `VOYAGE_MODEL=<new>` 설정 (양 plane 동시 적용)
2. 차원이 다르면 `chunks.embedding` 컬럼 `vector(N)` 마이그레이션 + HNSW 인덱스 재생성
3. `.cache/embeddings/` 삭제 후 `pnpm ingest:embed` 재실행 → `pnpm ingest:load` 재실행 (reset+reload로 stale vector 잔류 방지)
4. RAGAS 골든셋 재실행으로 회귀 측정 ([evaluation.md](./evaluation.md))
