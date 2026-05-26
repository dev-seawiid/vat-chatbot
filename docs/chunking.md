# Chunking

`ParsedDocument`의 노드(조·항·호 단위)를 임베딩 단위로 묶는 단계. 위치: `jobs/ingest/src/ingest/chunking/chunker.py`. ADR-0001에서 소스가 법령 텍스트로 교체되고 ADR-0002 §1.3에서 parse 단계가 신설되면서 chunking 입력이 raw PDF → 구조화 노드로 바뀌었다.

## 1. 결정 요약

| 항목 | 값 | 근거 |
|---|---|---|
| max_tokens | 512 | 평균 호 분량 + voyage-4 context 안 여유 |
| overlap | 150 토큰 | 한 호가 max를 초과할 때 char 슬라이딩 단계에서만 사용 (일반 경로는 호 boundary 자체가 자연 분할) |
| 토크나이저 | Voyage 공식 `voyageai.Client.count_tokens(model=...)` | ADR-0002 §1.4 — voyage 임베딩과 동일 토크나이저로 토큰 한도 정확성 확보 |
| 그룹화 키 | `(article, paragraph, item)` | 같은 호의 흩어진 list_item이 자연스럽게 합쳐지고, 임베딩이 호 단위로 떨어짐 |
| 헤딩 prepend | `{law} 제N조 제N항 제N호 (chapter > ...)\n\n{body}` | 법명·조항호 식별이 검색 정확도에 결정적 |
| 식별자 | `content_hash = sha256(content)[:16]` | 임베딩 캐시 키 + DB UNIQUE 제약. 재실행 안전 |

ADR-0002 §1.4에 명시된 Contextual Retrieval prefix(LLM 도메인 요약 prepend)는 별도 sub-step으로 미구현 — 후속.

## 2. 알고리즘 (`chunk_parsed`)

```
parsed: ParsedDocument
   │
   ├─ _group_nodes(parsed.nodes)
   │     동일 (article, paragraph, item) 키로 연속 노드 그룹핑
   │     → list[list[Node]]
   │
   └─ for group in groups:
        body  = "\n".join(node.text for node in group).strip()
        head  = "{law} 제N조 제N항 제N호 (chapter path)"
        full  = f"{head}\n\n{body}"
        tk    = voyage.count_tokens(full)
        if tk <= 512:
          → Chunk(full)
        else:
          # 호/항 단위가 512를 넘는 드문 케이스 — char 단위 슬라이딩(token≈char 가정).
          for i in range(0, len(body), 512-150):
            piece = body[i:i+512]
            → Chunk(f"{head}\n\n{piece}")
```

병합(merge) 단계가 없는 이유: parse가 이미 조·항·호로 끊어둔다 — 호 자체가 자연스러운 임베딩 단위. raw recursive splitter처럼 separator 우선순위 탐색·overlap 누적 로직이 필요 없음.

## 3. content_hash와 idempotent

`content_hash = sha256(head + body)[:16]`이 세 단계에서 같은 키로 동작:
- **embed 단계** (`scripts/embed_chunks.py`): 기존 캐시에 있는 content_hash는 skip → API 비용 0
- **load 단계** (`scripts/load_to_db.py`): `chunks (doc_id, content_hash)` UNIQUE + `INSERT ... ON CONFLICT DO NOTHING`
- **재실행**: 같은 chunk가 두 번 적재되지 않음

## 4. Chunk DTO (`jobs/ingest/src/ingest/chunking/dto.py`)

```python
class Chunk(BaseModel):
    id: str                            # "{law}#{ordinal:04d}"
    law: str
    effective_date: str | None
    article: str | None
    paragraph: int | None
    item: int | None
    parent_article_id: str | None      # "{law}#{article}" — parent-child fetch용(ADR-0002 §1.4-3)
    heading_path: list[str]            # chapter > section > ...
    content: str                       # head + body
    content_hash: str
    token_count: int
    refs: list[str]                    # parse가 추출한 "제○○조" cross-reference
    pages: list[int]
    source_node_ids: list[str]
```

load 단계가 이를 `chunks.metadata` jsonb로 직렬화 (law/article/paragraph/item/effective_date/refs/parent_article_id/heading_path/pages/source_node_ids snake-case 키 그대로). `tax_type`이나 `source_id` 같은 ADR-0001 이전 키는 폐기 — 소스가 법령으로 단일화되어 필터 차원이 사라짐.

## 5. CLI

```bash
pnpm ingest:chunk           # 전체 source
pnpm ingest:chunk -- --ids vat-law-2025  # 단건
```

입력 `.cache/parsed/{sid}.json` → 출력 `.cache/chunks/{sid}.json`.

## 6. 알려진 한계 / 후속

- **Contextual Retrieval prefix 미구현**: ADR-0002 §1.4-2의 50-100토큰 도메인 요약 prepend. retrieval error -49~67% 보고된 기법. 후속 — [TODO.md](./TODO.md).
- **Parent-child fetch 미구현**: `parent_article_id`는 메타에 박지만 검색 시 부모 조문 자동 fetch는 ADR-0003에서 비범위 — 후속.
- **별표·서식 노드 분리 채택 수준**: parse 단계가 namespace 표시만 함 — chunking에서는 동일 group으로 처리. 후속 retrieval 단에서 분리 권고 시 재평가.

## 7. 관련 단계

- 입력: parse 결과 (`docs/adr/v2/0002-ingestion.md` §1.3 — `제N조/항/호/별표` 메타 추출, NFKC 정규화, refs 박제)
- 출력: 청크 본문 + content_hash → [embedding.md](./embedding.md)에서 벡터 변환 → load 단계에서 `chunks` 테이블 적재 (reset+reload 정책: ADR-0002 §1.6)
