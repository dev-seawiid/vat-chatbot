# Retrieval

질문 텍스트 → 관련 chunk top-k. 위치: `packages/core/src/modules/retrieval/`.

`RetrievalService.retrieve`는 **단발 dense vector 검색** 표면 — embed + pgvector top-k 합성. RAG 체인의 grade·rerank·multi-query 분기는 본 service 밖(LangGraph rag-graph)에서 합성. evaluation plane이 직접 호출할 수 있는 검색 primitive로 동작.

## 1. 흐름

```
query (string)
   │
   ├─ embed(query, input_type="query")           — embedding.adapter.ts (→ embedding.md)
   │     → number[1024]
   │
   └─ chunkRepo.search({ embedding, k, filter }) — chunk.repository.ts
         │
         └─ SELECT chunks JOIN documents
              WHERE tax_type filter (optional)
              ORDER BY embedding <=> $query_emb
              LIMIT $k
              → SearchResult[]
```

`RetrievalService.retrieve(query, opts)`가 두 단계를 합성. 두 단계 모두 telemetry HOF(`traceRetriever`/`traceEmbedding`/`traceSpan`)로 wrap — 자세한 layering은 [observability.md](./observability.md).

## 2. SQL (`chunk.repository.ts::search`)

```sql
SELECT
  chunks.id::text                       AS chunkId,
  chunks.doc_id::text                   AS docId,
  chunks.metadata->>'source_id'         AS sourceId,
  documents.title                       AS docTitle,
  documents.version                     AS docVersion,
  documents.source_url                  AS sourceUrl,
  chunks.page,
  chunks.section_path                   AS sectionPath,
  chunks.content,
  chunks.metadata,
  1 - (chunks.embedding <=> $query_emb) AS similarity
FROM chunks
INNER JOIN documents ON documents.id = chunks.doc_id
WHERE ($tax_type::text IS NULL OR chunks.metadata->>'tax_type' = $tax_type)
ORDER BY chunks.embedding <=> $query_emb
LIMIT $k;
```

- `<=>` = pgvector cosine distance. `1 - distance` = similarity.
- `INNER JOIN documents`로 인용 모달 표시에 필요한 `docTitle`/`docVersion`/`sourceUrl`까지 한 번에 반환.
- `tax_type` 필터는 legacy(ADR-0001 이전 PDF 소스 분류 키) — 현 법령 소스에선 metadata에 박지 않으므로 사실상 no-op. 메타 표면 정리는 후속.

**인덱스**: `idx_chunks_embedding` (HNSW + `vector_cosine_ops`). pgvector 기본 파라미터(m=16, ef_construction=64). 토이 규모(수백~수천 chunks)에서 ivfflat 튜닝보다 HNSW 기본이 빌드·운영 모두 무난.

## 3. SearchResult 타입

```ts
type SearchResult = {
  chunkId: string;
  docId: string;
  sourceId: string;          // metadata.source_id (legacy) — 법령 소스에선 빈 값
  docTitle: string;
  docVersion: string | null;
  sourceUrl: string | null;
  page: number | null;
  sectionPath: string | null;
  content: string;            // chunk 본문 — citation 객체화 시 그대로 박제
  similarity: number;         // 1 - cosine_distance
  metadata: Record<string, unknown>;  // chunking.md §4의 jsonb 키 셋
};
```

도메인 표면은 camelCase. SQL alias로 직접 매핑되어 변환 layer 없음.

## 4. Service 시그니처

`packages/core/src/modules/retrieval/retrieval.service.ts`:

```ts
type RetrieveOptions = {
  k?: number;                        // 기본 8
  filter?: { taxType?: string };     // legacy
};

type RetrievalService = {
  retrieve: RetrieveFn;              // (query, opts?) => Promise<SearchResult[]>
};
```

호출자:
- **RAG graph** `modules/chat/rag-graph.ts::searchWithRerank` — `retrieve(k=50)` + `VoyageRerankCompressor.compressDocuments` + slice 합성. `search_direct`(k=8)·`claim_searches`(k=4) 두 노드에서 호출
- **evaluation plane** `jobs/ragas-eval` — RAGAS 입력의 `retrieved_contexts`
- **lbr-eval(LegalBench-RAG)** `jobs/lbr-eval` — `chat.retrieve`(fused) 통해 production pipeline 결과 측정. raw `RetrievalService.retrieve` 직접 호출 X

## 5. 파라미터 결정

| 파라미터 | 기본값 | 호출 컨텍스트별 override |
|---|---|---|
| k | 8 | RAG graph는 `searchWithRerank`로 prefilter=50 후 DIRECT_K=8 / CLAIM_K=4 slice · CLI/eval은 default |
| filter.taxType | undefined | UI에선 미노출. legacy 키라 현 법령 소스 retrieval엔 효과 없음 |
| similarity threshold | 없음 | top-k 자체로 충분. rerank + RRF fuse가 후속 절단 |

## 6. RAG 체인에서의 위치

ADR-0003 §2 v15 그래프에서 retrieval은 두 검색 노드의 backbone — `rag-graph.ts::searchWithRerank` 헬퍼가 `retrieve(prefilter=50)` + `VoyageRerankCompressor.compressDocuments` + `slice(0, k)`를 합성:

```
search_direct  : searchWithRerank(query,   k=8)         ← DIRECT_K
claim_searches : searchWithRerank(claim_i, k=4) × N(≤6) ← CLAIM_K, Promise.all
fuse           : RRF(directChunks + claimChunks, top 10) ← FUSE_TOP_N
```

`RetrievalService.retrieve`는 양 노드에서 동일 표면(`PREFILTER_K=50` 단발 dense)으로 호출. rerank는 노드 헬퍼가 담당해 service 표면엔 빠져 있다. 자세한 노드 정의는 [generation.md §2](./generation.md#2-langgraph-노드).

## 7. Multi-turn 영향

`RetrievalService` 자체는 single-query primitive — 호출자가 query를 만들어 넘긴다. v15엔 별도 history-aware rewrite 노드가 없고 `search_direct`는 마지막 user message text를, `claim_searches`는 `generate_draft`가 messages 배열로부터 합성한 claim을 query로 사용. coreference·분해는 draft LLM이 직접 처리.
