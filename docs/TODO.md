# TODO

후속 작업 — 한 줄 단위로 핵심만. 상세는 도입 시점에 재조사. 우선순위 라벨 없음(상황 따라).

- **LangChain Langfuse CallbackHandler 통합** — `@langfuse/langchain::CallbackHandler`를 `graph.invoke(state, { callbacks: [handler] })`로 주입해 LangGraph 노드 LCEL spans + ChatOpenAI usage(input/output tokens) 자동 박제. 현재는 retrieval/embedding/rerank/pgvector 4개 span만 송출 — generate/grade 노드는 trace 부재. ([observability.md §4](./observability.md#4-trace-스키마))
- **ChatOpenAI usage_metadata 콜백** — `chat.service.ts`의 `finish.inputTokens`/`outputTokens`가 항상 undefined. LangChain callback에서 `llm.usage_metadata`를 캡처해 채울 것.
- **Contextual Retrieval prefix** — ADR-0002 §1.4-2의 50-100토큰 도메인 요약 prepend(인덱싱 시 1회 LLM, prompt caching). retrieval error -49~67% 보고된 기법. chunking 단계에 sub-step 추가.
- **Parent-child fetch** — chunking metadata에 박힌 `parent_article_id`로 검색 시 부모 조문 자동 fetch. ADR-0003에서 비범위 결정, 후속.
- **`tax_type` 메타 정리** — 법령 소스(ADR-0001)에선 분류 키가 사라짐. `chunks.metadata->>'tax_type'` 필터 + `SearchFilter.taxType` 표면 폐기.
- **Multi-turn memory layer** — 현재 Level 1(sliding window N=6 messages). 평균 대화 길이가 길어지면 Level 2(오래된 turn LLM-summarize)·Level 3(vector store long-term memory) 도입.
- **Langfuse dashboard에 voyage-4 + rerank-2.5 custom model pricing 등록** (수동, 1회) — Models 화면에서 input USD/token. 미등록 시 embedding/rerank spans은 박혀도 cost 컬럼 비어 있음.
- **ragas-eval 동시성** — Phase 1은 item 직렬 30회(metric 4종은 `asyncio.gather` 동시). cold start 부담 줄이려면 (1) `core:ask` CLI batch 모드, (2) async pool.
- **langfuse-python v3 → v4 migration** — 현재 v3 `item.run()` + `score_trace()` 사용, `<4.0` 핀. v4(GA)는 `dataset.run_experiment(...)` 단일 진입점으로 추상화 — RAGAS 통합 wiring 다시 짜야 해서 일단 v3 유지.
- **userId 박제** — 인증 도입 시 `propagateAttributes({ userId })`. 현 sessionId(conversationId)만으론 user-level cohort 분석 불가.
- **Sampling** — prod 트래픽 증가 시 `LangfuseSpanProcessor({ shouldExportSpan })` 또는 OTEL Sampler로 head-based 5~10%, 에러/long-tail은 always-on.
- **모델 호출 retry** — generation/embedding TS plane 모두 미구현. 일시 실패 시 즉시 throw → 5xx.
