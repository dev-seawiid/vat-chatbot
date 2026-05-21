# TODO

후속 작업 — 한 줄 단위로 핵심만. 상세는 도입 시점에 재조사. 우선순위 라벨 없음(상황 따라).

- **Multi-turn memory layer**: 현재 Level 1(sliding window N=6 messages)까지. 상용 챗봇(ChatGPT/Claude/Gemini)은 Level 2(오래된 turn을 LLM-summarize로 압축)·Level 3(vector store 기반 long-term memory) 추가. 평균 대화 길이가 길어지면 Level 2부터 도입.
- **Langfuse dashboard에 voyage-3 custom model pricing 등록** (수동, 1회) — Models 화면에서 input USD/token만. 미등록 시 embedding spans은 박혀도 cost 컬럼 비어 있음.
- **Langfuse score push + Datasets/Experiments 연동** — run_eval.py(dataset iterate → score push) skeleton 작성됨. golden CSV는 UI 수동 업로드. `rag_run` 구현 후 end-to-end 검증 필요.
- **ragas-eval 동시성/성능** — 현재 D안(subprocess `pnpm core:ask --json`)으로 직렬 30회 호출. 30 cold start 부담 시 (1) ask CLI batch 모드 추가, (2) async pool 도입 고려.
- **langfuse-python v3 → v4 migration** — 현재 v3 `item.run()` + `score_trace()` 사용, `<4.0` 핀. v4(4.x 이미 GA)는 `dataset.run_experiment(...)` 단일 진입점으로 추상화 — RAGAS 통합 wiring 다시 짜야 해서 일단 v3 유지.
- **userId 박제** — 인증 도입 시 `propagateAttributes({ userId })`. 현 sessionId(conversationId)만으론 user-level cohort 분석 불가.
- **Sampling** — prod 트래픽 증가 시 `LangfuseSpanProcessor({ shouldExportSpan })` 또는 OTEL Sampler로 head-based 5~10%, 에러/long-tail은 always-on.
