# Retrieval

질문 텍스트 → 관련 chunk top-k. 위치: `packages/core/src/retrieval/`.

## 1. 흐름

```
query (string)
   │
   ├─ embed(query, input_type="query")           — adapter/embedding.ts (→ embedding.md)
   │     → number[1024]
   │
   └─ chunkRepo.search({ embedding, k, filter }) — chunk.repository.ts
         │
         └─ SELECT chunks JOIN documents
              WHERE tax_type filter
              ORDER BY embedding <=> $1
              LIMIT $k
              → SearchResult[]
```

`RetrievalService.retrieve(query, opts)`가 두 단계를 합성. `ChatService.ask`가 본 service만 호출하고 repository를 직접 보지 않음.

## 2. SQL

`packages/core/src/retrieval/chunk.repository.ts::search`:

```sql
SELECT
  chunks.id::text                       AS chunk_id,
  chunks.doc_id::text                   AS doc_id,
  chunks.metadata->>'source_id'         AS source_id,
  documents.title                       AS doc_title,
  documents.version                     AS doc_version,
  documents.source_url                  AS source_url,
  chunks.page,
  chunks.section_path,
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
- `INNER JOIN documents`로 인용 모달 표시에 필요한 `docTitle`·`docVersion`·`sourceUrl`까지 한 번에 반환 (citation 객체 변환 시 추가 query 없음).
- `chunks.metadata->>'tax_type'`은 jsonb path expression — DB가 jsonb 인덱스 없이도 빠르게 처리 (현재 메타 필터는 단일 키).

**인덱스**: `idx_chunks_embedding` (HNSW + `vector_cosine_ops`). pgvector 기본 파라미터(m=16, ef_construction=64). 토이 규모(수백~수천 chunks)에서 ivfflat 튜닝보다 HNSW 기본이 빌드·운영 모두 무난.

## 3. SearchResult 타입

```ts
type SearchResult = {
  chunkId: string;
  docId: string;
  sourceId: string;          // sources.json 자연키 = Citation.sourceId
  docTitle: string;
  docVersion: string | null;
  sourceUrl: string | null;
  page: number | null;
  sectionPath: string | null;
  content: string;            // chunk 본문 — citation 객체화 시 그대로 박제
  similarity: number;         // 1 - cosine_distance
  metadata: Record<string, unknown>;
};
```

도메인 표면은 camelCase. SQL alias로 직접 매핑되어 변환 layer 없음.

## 4. Service 시그니처

`packages/core/src/retrieval/retrieval.service.ts`:

```ts
type RetrieveOptions = {
  k?: number;                        // 기본 8
  filter?: { taxType?: string };
};

type RetrievalService = {
  retrieve(query: string, opts?: RetrieveOptions): Promise<SearchResult[]>;
};

function createRetrievalService(deps: {
  embed: EmbedFn;
  chunkRepo: ChunkRepository;
}): RetrievalService;
```

CLI(`scripts/retrieve.ts`)와 `ChatService.ask` 둘 다 본 service를 호출.

## 5. 파라미터 결정

| 파라미터 | 기본값 | 근거 |
|---|---|---|
| k | 8 | top-8이 system prompt context size 안에 8 chunks × ~500 token = ~4000 token, 모델 context 여유 + retrieval 누락 보완 |
| filter.taxType | undefined | 명시 시 메타 필터로 후보 좁힘. UI에선 미노출(자동 분류는 후속) |
| similarity threshold | 없음 | top-k 자체로 충분. similarity가 낮은 chunk도 함께 보내 모델이 거절 판단 (`context에 근거 없으면 "확인되지 않습니다"`) |

## 6. 재랭커 / 하이브리드

비채택. 평가셋 baseline 측정 후 도입 결정 — [TODO.md](./TODO.md).
- 재랭커 (cross-encoder rerank): top-k=20 가져와 재랭킹 후 top-8
- 하이브리드 (벡터 + BM25): 한국어 keyword 매칭 보완

## 7. 호출 위치

- **chat.service.ts::ask** — 사용자 질문 처리. retrieve(query, { k, filter }) → chunks → buildSystemMessage. [generation.md](./generation.md).
- **jobs/ragas-eval/scripts/run_eval.py** — 골든셋 채점 시 retrieve.k 옵션을 평가 입력에 박제.
- **scripts/retrieve.ts** — CLI 단독 검색 (디버깅용).

## 8. Multi-turn 영향

현재 `ChatService.ask`는 multi-turn이지만 **retrieve는 단일 query** (사용자 직전 message만으로 embed). history-aware retrieval(query rewriting)은 후속 — [TODO.md](./TODO.md).
