# RAG 평가 Phase 1 — RAGAS scoring plane (generation 분리)

2026-05-19. eval-v2.

## 결정

`ragas==0.4.3` 표준 패턴 따름. **generation과 scoring 분리**:
- generation = `packages/core/scripts/ask-golden.ts` (core dev CLI)
- scoring = `jobs/eval/` (Python 단일 plane, ingest와 동일 컨벤션)

두 plane은 jsonl로만 통신. eval은 core를 import하지 않음. 결정적 4축·자체 LLM-judge·`expected_*` 라벨·`EXPECTED_DISTRIBUTION`·자체 DB 영속화 모두 폐기 (이전 슬라이스).

## 표준 근거

RAGAS·DeepEval·LangSmith 모두 평가만 — generation은 caller 책임. `EvaluationDataset`에 `response`가 박힌 형태로 입력. 우리도 동일 패턴.

## 메트릭

Reference-free 3종: `Faithfulness`, `AnswerRelevancy`, `LLMContextPrecisionWithoutReference`.

## Judge

`claude-sonnet-4-5` (응답 `gpt-4o-mini`와 family 분리). embedding `voyage-3` (core retrieval과 동일 공급자).

LLM/embedding 호출은 **litellm**로 통일. provider swap = `--judge openai/gpt-4o` 식 model string 한 줄 변경. `ANTHROPIC_API_KEY` 미설정 시 Claude Code CLI(headless) `claude_cli/` custom provider로 자동 fallback — 로컬 dev에서 API key 없이 사용자 Claude Code 구독으로 judge 실행 가능.

## 흐름

```
golden.json
  └─ pnpm core:ask-golden → asks.jsonl
       └─ pnpm eval:run → scores.jsonl
```

## 영향

신규:
- `packages/core/scripts/ask-golden.ts` — golden × ask → asks.jsonl
- `jobs/eval/scripts/score.py` (argparse CLI), `jobs/eval/src/evaluation/{scorer,config}.py` (ingest 컨벤션)
- `jobs/eval/src/evaluation/llm/{build,claude_cli}.py` — litellm provider 분기 + Claude Code CLI custom provider
- `jobs/eval/{pyproject.toml,package.json,.env.example,README.md}` (deps: ragas + litellm, langchain-* 제거)

수정:
- `data/eval/golden.json` — 5필드만
- `packages/core/{package.json}` — `ask-golden` script 추가
- `package.json` (root) — `core:ask-golden`, `eval:run`, `eval:full`

폐기 (이전 슬라이스에서 진행됨):
- `packages/core/src/modules/eval/` 통째
- `packages/core/scripts/eval-run.ts`
- `eval_items`/`eval_runs` 테이블 (drizzle drop 0002)
- TS 자체 LLM-judge

## 비범위

Phase 2: Langfuse score push, Datasets/Experiments, `reference` 필드 + reference-based 6종, TestsetGenerator, Cohen's κ.
Phase 3: production trace sample, AspectCritic, multi-turn.
