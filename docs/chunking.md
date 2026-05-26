# Chunking

`ParsedDocument`의 노드 시퀀스를 "제N조" boundary로 split해 한 조 = 한 chunk로 만든다. 위치: `jobs/ingest/src/ingest/chunking/chunker.py`. ADR-0001에서 소스가 법령 텍스트로 교체되고 ADR-0002 §1.3에서 parse 단계가 신설되면서 chunking 입력이 raw PDF → 구조화 노드로 바뀌었다.

## 1. 결정 요약

| 항목 | 값 | 근거 |
|---|---|---|
| boundary | `^제\s*\d+\s*조(?:의\s*\d+)?(?=\s*\(|\s*$)` | "제N조(...)" 또는 줄 끝만 매칭 — cross-reference 텍스트("제5조제3항에 따른") 오인식 차단 |
| max_tokens | 1200 | chunking 명세 권장 상한(권장 300~900, 절대 1200) |
| overlap | 150 토큰 | 한 조가 1200 초과해 char 슬라이딩이 발동할 때만 적용 |
| min_tokens | 50 | 미만 chunk drop — "제N조 삭제" 같은 1줄 조 |
| 토크나이저 | Voyage 공식 `voyageai.Client.count_tokens(model=...)` | ADR-0002 §1.4 — voyage 임베딩과 동일 토크나이저로 토큰 한도 정확성 확보 |
| 헤더 prepend | `{law} 제N조 ({chapter} > {section})\n\n{body}` | 법명·조항호 식별이 검색 정확도에 결정적 |
| 식별자 | `content_hash = sha256(content)[:16]` | 임베딩 캐시 키 + DB UNIQUE 제약. 재실행 안전 |

ADR-0002 §1.4에 명시된 Contextual Retrieval prefix(LLM 도메인 요약 prepend)는 별도 sub-step으로 미구현 — 후속.

## 2. 알고리즘 (`chunk_parsed`)

```
parsed: ParsedDocument
   │
   ├─ _split_by_article(parsed.nodes)
   │     "^제N조(..." 매칭 노드를 boundary로 끊어
   │     (article_no, nodes_in_that_article) 페어 yield
   │     boundary 이전 선행 노드(chapter heading 등)는 article=None 그룹으로 한 번만 yield
   │
   └─ for (article_no, nodes) in pairs:
        body  = "\n".join(n.text for n in nodes).strip()
        head  = "{law} 제{article_no}조 ({chapter} > {section})"
        full  = f"{head}\n\n{body}"
        tk    = voyage.count_tokens(full)
        if tk < 50:            → drop
        if tk <= 1200:         → 한 chunk
        else:                  → char 슬라이딩(step=1050, window=1200)
                                 각 piece도 50 미만이면 drop
```

article state tracking은 두지 않는다 — text에 박힌 "제N조"를 split key로 신뢰. parser가 article을 state로 추적하면 부칙·본법에서 카운터가 1로 리셋돼 `(chapter, article)` 키 충돌이 생기지만, split 방식은 boundary가 텍스트 위치라 자연스럽게 chapter context와 함께 chunk가 만들어져 충돌 없음.

## 3. content_hash와 idempotent

`content_hash = sha256(content)[:16]`이 세 단계에서 같은 키로 동작:
- **embed 단계**: 기존 캐시에 있는 content_hash는 skip → API 비용 0
- **load 단계**: `chunks (doc_id, content_hash)` UNIQUE + `INSERT ... ON CONFLICT DO NOTHING`
- **재실행**: 같은 chunk가 두 번 적재되지 않음

## 4. Chunk DTO (`jobs/ingest/src/ingest/chunking/dto.py`)

```python
class Chunk(BaseModel):
    id: str                            # "{law}#{ordinal:04d}"
    law: str
    effective_date: str | None
    chapter: str | None                # parser가 추적
    section: str | None                # parser가 추적
    article: str | None                # chunker가 boundary에서 추출 (예: "5", "5의2")
    content: str                       # head + body
    content_hash: str
    token_count: int
    refs: list[str]                    # parser가 추출한 "제○○조" cross-reference
    pages: list[int]
    source_node_ids: list[str]
```

load 단계가 이를 `chunks.metadata` jsonb로 직렬화 (snake-case 키 그대로). `paragraph`/`item`/`sub_item`/`parent_article_id`/`heading_path` 같은 옛 필드는 폐기 — 사용처 없음. paragraph/item 단위 필터링이 필요해지면 chunk 내 텍스트에 `①②③`/`1. 2. 3.`이 그대로 있어 LLM이 직접 인용 가능.

## 5. CLI

```bash
pnpm ingest:chunk           # 전체 source
pnpm ingest:chunk -- --ids vat-law-2025  # 단건
```

입력 `.cache/parsed/{sid}.json` → 출력 `.cache/chunks/{sid}.json`.

## 6. 알려진 한계 / 후속

- **Contextual Retrieval prefix 미구현**: ADR-0002 §1.4의 50-100토큰 도메인 요약 prepend. retrieval error -49~67% 보고된 기법.
- **Parent fetch 미구현**: ADR-0003에서 비범위 결정. 필요해지면 chunk metadata의 `(chapter, article)` 키로 재구성.
- **호 단위 정밀 매칭 약화**: 한 조가 한 chunk라 "제X조 제Y항 제Z호" 정밀 매칭 약함. 필요해지면 parent-child 구현보다 BM25 hybrid 도입이 ROI ↑ (ADR-0002 §1.4 trade-off).

## 7. 관련 단계

- 입력: parse 결과 (`docs/adr/v2/0002-ingestion.md` §1.3 — chapter/section/refs 메타 + NFKC 정규화)
- 출력: 청크 본문 + content_hash → [embedding.md](./embedding.md)에서 벡터 변환 → load 단계에서 `chunks` 테이블 적재 (reset+reload 정책: ADR-0002 §1.6)
