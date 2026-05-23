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

### 1.3 parse — 법령 구조 메타 (신설)

- **문제점**: 정규식·메타 정책은 자주 바뀌는데 extract에 묶이면 매번 Docling 재실행. 별표·서식이 본문과 한 컬렉션이면 조문 검색 결과를 오염. 원본 PDF가 같은 한자를 호환 영역(U+F900–FAFF)과 통합 영역에 일관 없이 표기해 검색이 단절됨(실측: 단어 "零"이 시행령엔 U+F9B2, 본법엔 U+96F6).
- **Before**: 없음 (메타 부착 단계 부재).
- **After**: extract 캐시 입력 → 후처리로
  1. Unicode NFKC 정규화 — 호환 한자 흡수. boundary 인식은 raw에서 먼저 하고 저장 텍스트만 정규화(NFKC가 ①→1로 분해해 항 번호 시그널 소실 방지).
  2. `제N조/항/호/별표` 정규식 파싱 → `{law, article, paragraph, item, effective_date}` 메타.
  3. 별표·서식 노드를 본문과 분리해 별도 namespace 표시.
  4. `제○○조 준용/적용/제외` 패턴을 추출해 노드 메타 `refs[]`에 기록(1-hop expansion은 ADR-0003).
- 산출물도 JSON 캐시 — 규칙 변경 시 Docling 건너뛰고 이 단계만 재실행.

### 1.4 chunk — Voyage 토크나이저 + Contextual Retrieval

- **문제점**: 주석은 OpenAI `tiktoken` 사용으로 표기됐으나 Voyage 임베딩과 토크나이저 불일치 → API 토큰 한도 오차. 의미 단위 무시 분할로 retrieval이 절단된 조문 반환. 짧은 호 단독 임베딩 시 맥락 손실.
- **Before**: `tiktoken` 추정 + 의미 단위 무시.
- **After**: parse 산출 입력 →
  1. Voyage 공식 `voyageai.Client.count_tokens(model=...)` + 조·항·호 boundary respect + 헤딩 path prepend + 150-token overlap.
  2. Contextual Retrieval: 각 chunk 앞에 "○○법 ○장 ○○ 중 …" 50-100토큰 도메인 요약 prepend(인덱싱 시 1회 LLM, prompt caching). retrieval error -49~67% 보고.
  3. Parent-child: 호 단위로 임베딩하되 부모 조문 ID를 메타 보존(검색 시 부모 fetch는 ADR-0003).

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
