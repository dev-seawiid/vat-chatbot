# TODO

후속 작업 — 한 줄 단위로 핵심만. 상세는 도입 시점에 재조사. 우선순위 라벨 없음(상황 따라).

- **Multi-turn memory layer**: 현재 Level 1(sliding window N=6 messages)까지. 상용 챗봇(ChatGPT/Claude/Gemini)은 Level 2(오래된 turn을 LLM-summarize로 압축)·Level 3(vector store 기반 long-term memory) 추가. 평균 대화 길이가 길어지면 Level 2부터 도입.
- **Langfuse dashboard에 voyage-3 custom model pricing 등록** (수동, 1회) — Models 화면에서 input USD/token만. 미등록 시 embedding spans은 박혀도 cost 컬럼 비어 있음.
- **Langfuse Datasets/Experiments 연동** — eval 골든셋(`eval_runs`)을 Langfuse Datasets에 업로드하고 평가 결과를 Experiment run으로. 현재는 자체 DB만이라 trace ↔ eval join이 대시보드에서 불가.
- **userId 박제** — 인증 도입 시 `propagateAttributes({ userId })`. 현 sessionId(conversationId)만으론 user-level cohort 분석 불가.
- **Sampling** — prod 트래픽 증가 시 `LangfuseSpanProcessor({ shouldExportSpan })` 또는 OTEL Sampler로 head-based 5~10%, 에러/long-tail은 always-on.
