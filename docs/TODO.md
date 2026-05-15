# TODO

후속 작업 — 한 줄 단위로 핵심만. 상세는 도입 시점에 재조사. 우선순위 라벨 없음(상황 따라).

- **Multi-turn memory layer**: 현재 Level 1(sliding window N=6 messages)까지. 상용 챗봇(ChatGPT/Claude/Gemini)은 Level 2(오래된 turn을 LLM-summarize로 압축)·Level 3(vector store 기반 long-term memory) 추가. 평균 대화 길이가 길어지면 Level 2부터 도입.
