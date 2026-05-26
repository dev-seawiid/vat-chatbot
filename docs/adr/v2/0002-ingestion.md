# Ingestion Pipeline Redesign

소스 교체(ADR-0001)에 맞춰 ingest 파이프라인을 (1) fetch 폐기, (2) extract를 Docling 변환 + `DoclingDocument` JSON 캐시까지로 한정, (3) parse 단계 신설(조문 메타·별표 분리·cross-reference 추출 — 가볍고 재실행 가능), (4) chunk를 Voyage 토크나이저 + boundary + Contextual Retrieval + parent-child로, (5) embed를 voyage-4로, (6) load에 reset + BM25 sparse 동반 적재 추가하는 6단계로 재설계. 핵심 동기: ADR-0001 §3·§4 retrieval miss 원인이 파이프라인 전반에 분산돼 있고, Docling은 무거워(분/십수초 per PDF) 메타 규칙 변경 시 재실행이 비용 → extract/parse 분리가 산업 표준(Docling 공식 JSON 직렬화, LlamaIndex Documents→Nodes).

## 1. 단계별 변경

### 1.1 fetch — 단계 폐기

- **문제점**: law.go.kr는 안정 PDF URL을 노출하지 않아 fetch 자동화가 본질적으로 불가. 단계 유지가 사역(死役).
- **Before**: URL → `data/sources.json` 기반 자동 다운로드.
- **After**: 단계 폐기. `data/rag_knowledge_base/`에 사전 배치된 파일을 직접 입력.

### 1.2 extract — Docling + JSON 캐시

- **문제점**: `pdfplumber` 페이지 기반은 조문 경계를 무시하고 표·도표가 깨짐 — ADR-0001 §4 retrieval miss의 직접 원인. 한편 Docling은 PDF당 분/십수초로 무거워 후속 규칙 변경 시 재실행 비용 큼.
- **Before**: `pdfplumber` 페이지 단위 텍스트.
- **After**: Docling (DocLayNet 레이아웃 + TableFormer 표) 변환 후 `DoclingDocument`를 **lossless JSON으로 캐시**. 이후 단계는 PDF가 아닌 JSON에서 시작. 표 97.9% 정확도.

### 1.3 parse — 텍스트 정규화 + chapter/section/refs 메타 (신설)

- **문제점**: 정규식·메타 정책은 자주 바뀌는데 extract에 묶이면 매번 Docling 재실행. 원본 PDF가 같은 한자를 호환 영역(U+F900–FAFF)과 통합 영역에 일관 없이 표기해 검색이 단절됨(실측: 단어 "零"이 시행령엔 U+F9B2, 본법엔 U+96F6).
- **Before**: 없음 (메타 부착 단계 부재).
- **After**: extract 캐시 입력 → 후처리로
  1. Unicode NFKC 정규화 — 호환 한자 흡수. boundary 인식은 raw에서 먼저 하고 저장 텍스트만 정규화.
  2. footer noise 제거 (`법제처 N`, `국가법령정보센터`, 단독 페이지 번호 등).
  3. **chapter/section state tracking만** — `제N장`·`제N절`·`부칙 <...>` 추적. article/paragraph/item은 텍스트에 그대로 박혀있어 chunker가 boundary split로 처리하므로 별도 메타로 안 뺀다. state 추적은 부칙에서 article 카운터가 1로 리셋돼 본법과 키 충돌을 만든다.
  4. `제○○조 준용/적용/제외` 패턴을 추출해 노드 메타 `refs[]`에 기록(1-hop expansion은 ADR-0003).
- 산출물 Node 스키마: `{id, law, effective_date, chapter, section, text, refs[], page, ordinal}`. JSON 캐시 — 규칙 변경 시 Docling 건너뛰고 이 단계만 재실행.
- 별표·서식 분리는 실측상 extract 결과에 별표 노드가 0건(Docling이 furniture로 분류)이라 본 단계에서 미수행.

### 1.4 chunk — 조 단위 split (1200 토큰 초과만 char slide)

- **문제점**: 호 단위 임베딩 + `parent_article_id` metadata + 검색 시 부모 fetch + Contextual prefix(LLM 도메인 요약 prepend)로 정밀 매칭과 응집을 동시 잡으려 했으나, 부모 fetch와 prefix 두 보완 로직 **모두 미구현** 상태로 운영 — 호 단위 chunking의 본래 장점이 절반만 작동. 다항 답변(§39 ①~⑤)에서 호 chunk 일부만 retrieve돼 항목 누락 사고. 또한 parser가 article을 state로 추적해 부칙·본법 article=1이 같은 `parent_article_id` 키 공유.
- **Before**: 호 단위 + parent-child metadata + (미구현) 부모 fetch + (미구현) Contextual prefix.
- **After**: 조 단위 split —
  1. parser가 박은 chapter/section state + chunker 안의 `^제\s*N\s*조(...` 정규식으로 boundary 인식. 한 조 전체 = 한 chunk. chapter/section을 chunk 헤더에 prepend해 검색 시그널 제공.
  2. 한 조가 1200 토큰(권장 상한) 초과하는 드문 케이스만 char 단위 슬라이딩(overlap 150).
  3. 50 토큰 미만(예: "제N조 삭제" 1줄 조) drop.
  4. Voyage 공식 `voyageai.Client.count_tokens(model=...)` 토큰 측정.
- 산출물 Chunk 스키마: `{id, law, effective_date, chapter, section, article, content, content_hash, token_count, refs[], pages[], source_node_ids[]}`. parent_article_id는 미박제 — text에 article 그대로 박혀있어 후속 parent fetch 도입 시 `(chapter, article)` 키로 재구성. 본법·부칙 충돌 원천 차단.
- **수용 trade-off**: 호 단위 정밀 매칭("제X조 제Y항 제Z호") 약화. 향후 호 단위 정밀 매칭이 필요해지면 parent-child 구현(보완 로직 2개 추가)보다 BM25 hybrid 도입이 ROI ↑ — §1.6 결정 재평가 시 그 경로로. Contextual Retrieval prefix는 별도 sub-step 후속.

### 1.5 embed — voyage-4

- **문제점**: voyage-3 family는 Voyage 공식 maintenance 등급. 동일 가격에 신모델이 출시돼 유지 정당화 어려움. 도메인 특화 voyage-law-2도 후보였음.
- **Before**: `voyage-3` ($0.06/MTok).
- **After**: `voyage-4` (2026-01-15 출시). 동가($0.06/MTok), 첫 200M 토큰 무료. voyage-law-2는 미·중·독·인도 법률 학습으로 한국어 명시 없음 → voyage-4가 한국어+법률 둘 다 안전.

### 1.6 load — reset + reload

- **문제점**: append 전용이라 임베딩 모델·차원·정책 교체 시 stale vector가 잔류 → distribution mismatch.
- **Before**: dense vector append only.
- **After**: reset + reload (table truncate → 전량 reindex). BM25 sparse 인덱스 동반 적재는 ADR-0003에서 비범위로 결정 — 본 단계에서 제외.

## 2. 보류

Late Chunking, RAPTOR, Proposition-based chunking, HyDE-always-on, Full Graph RAG — §1 추가로 ROI 80% 회수 후 v2 이후 재평가.
