# Chunking

PDF 추출 결과를 임베딩 단위로 자르는 단계. 위치: `jobs/ingest/src/ingest/chunking/chunker.py`. RAG 품질의 1차 변수라 size·overlap·boundary 결정이 retrieval 정확도에 직접 영향.

## 1. 결정 요약

| 항목 | 값 | 근거 |
|---|---|---|
| max_tokens | 500 | voyage-3 context 안 여유 + 한 청크가 1~2 paragraph 분량 ≈ 사람이 인용 가능한 크기 |
| overlap | 50 토큰 | boundary 직후 문장이 한 청크에서 잘리는 경우 다음 청크에 전치사·주어 잔존 |
| 토크나이저 | tiktoken `cl100k_base` | voyage 전용 토크나이저 비공개 — OpenAI 토크나이저로 토큰 예산 차용. 청크 일관성 목적엔 충분, 실제 임베딩 토큰 수와 정확히 일치하진 않음 |
| separator 우선순위 | `["\n\n", "\n", ". ", "? ", "! ", " "]` | 큰 단위 → 작은 단위 순으로 시도해 의미 경계 보존. 마지막 단계로도 안 맞으면 토큰 단위 hard slice |
| 헤딩 prepend | 청크 본문 앞에 `# {section.heading}` 1줄 | 임베딩에 위치·주제 단서 추가. citation·메타엔 별도 anchor/page라 컨텐츠 복제 손실 없음 |
| 식별자 | `content_hash = sha256(content)` | 임베딩 캐시 키 + DB UNIQUE 제약과 동일. 재실행 안전 |

## 2. 알고리즘

**(1) Recursive split** — `_split_recursive`
- 텍스트가 max_tokens 이하면 그대로 반환.
- 그 외엔 separators 리스트에서 가장 굵은 단위(`\n\n`)부터 시도. 자른 조각이 여전히 크면 더 작은 separator로 재귀.
- 모든 separator로도 안 맞으면 tiktoken으로 토큰 단위 hard slice.

**(2) Merge with overlap** — `_merge_with_overlap`
- 인접 조각을 buffer에 누적해 max_tokens까지 합침.
- 한 청크가 닫힐 때 직전 청크의 꼬리 `overlap` 토큰을 다음 청크 앞에 prepend.

**(3) Per-section** — `chunk_section`
- ExtractResult의 Section 단위로 (2)를 호출.
- 각 청크 본문 앞에 `# {heading}\n\n` prepend.
- `ChunkDTO`로 묶음: `{doc_id, section_ordinal, chunk_ordinal, content, content_hash, token_count, heading, page, anchor}`.

## 3. content_hash와 idempotent

`content_hash = sha256(content_with_heading_prepend)`은 세 단계에서 같은 키로 동작:
- **embed 단계** (`scripts/embed_chunks.py`): 기존 `.cache/embeddings/{sid}.json`에 있는 content_hash는 skip → API 비용 0
- **load 단계** (`scripts/load_to_db.py`): `chunks (doc_id, content_hash)` UNIQUE + `INSERT ... ON CONFLICT DO NOTHING`
- **재실행**: 같은 chunk이 두 번 적재되지 않음

## 4. 메타데이터 (`chunks.metadata` jsonb)

청크 단위로 적재되는 메타 (`jobs/ingest/src/ingest/load/service.py::build_chunk_rows`):

```jsonc
{
  "source_id": "nts-vat-2025-2q-manual",  // sources.json 자연키 — citation sourceId
  "kind": "pdf",
  "tax_type": "vat-common",                // retrieval 필터 키
  "doc_version": "2025-2q",                // 다버전 우선순위 (현재 미사용)
  "section_ordinal": 0,
  "chunk_ordinal": 3,
  "token_count": 487,
  "anchor": "p12"                          // PDF 페이지 앵커
}
```

`tax_type`은 retrieval 메타 필터에 활용 (`metadata->>'tax_type'`). `source_id`는 citation의 `sourceId` 필드와 동일 키로 흐름.

## 5. CLI

```bash
pnpm ingest:chunk           # 전체 source
pnpm ingest:chunk -- --ids nts-vat-2025-2q-manual  # 단건
```

입력 `.cache/extracted/{sid}.json` → 출력 `.cache/chunks/{sid}.json`. 결과 표:

```
ID                          SECTIONS  CHUNKS  AVG_TOK  MAX_TOK  OUT
nts-vat-2025-2q-manual           215     413      453      500  .cache/chunks/...
```

## 6. 알려진 한계 / 후속

- **중복 청크 비율**: PDF의 짝수/홀수 페이지(좌·우 페이지)가 같은 헤더 텍스트로 인해 page별로 별도 section으로 emit돼 약 50% 중복. DB UNIQUE 제약이 load에서 흡수해 검색·답변엔 무영향이지만 임베딩 API 비용은 낭비됨. `chunk_pdfs.py`에 1~2줄 dedup 추가가 후속 — [TODO.md](./TODO.md) 참조.
- **한국어 토큰 길이 편차**: `cl100k_base`가 한국어를 OpenAI 모델 기준으로 토크나이즈해 실제 voyage 토큰 수와 다름. 청크 크기 일관성엔 영향 없음.
- **Semantic chunking / hierarchical chunking**: 단순 recursive separator + token cap. 의미 경계 기반 분할은 v2.

## 7. 관련 단계

- 입력: PDF 추출 결과 (`ingestion.md::extract`)
- 출력: 청크 본문 + content_hash → [embedding.md](./embedding.md)에서 벡터 변환 → load 단계에서 `chunks` 테이블 적재
