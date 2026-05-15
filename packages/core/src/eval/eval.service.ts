import {
  type AxisScores,
  type GoldenItem,
  WEIGHTS,
  partitionKeywords,
  score,
  weighted,
} from "./scoring";
import type { AskFn } from "../chat/chat.service";
import type {
  EvalItem,
  EvalRepository,
  EvalRunRow,
  SaveRunArgs,
} from "./eval.repository";

/**
 * 2026-05-07 eval 슬라이스 §7 — eval 도메인 use case. golden.json 한 항목씩 ask로 답을 받아
 * score를 매기고 결과를 eval_runs.results / .summary 형태로 정규화. CLI(scripts/eval-run.ts)는
 * 본 service만 호출하고 repository를 직접 보지 않는다.
 */

// golden.json 루트 — version은 eval_runs.goldensetVersion에 박제, items는 채점 단위.
// _source_excerpt / _source_page 같은 underscore 필드는 인간 검수용이라 본 모듈에서 무시한다.
export type GoldenSet = {
  version: string;
  items: GoldenItem[];
};

// spec §1.1 분배표 — lint가 본 표와 일치하지 않으면 fail.
type Distribution = {
  total: number;
  category: Record<string, number>;
  taxType: Record<string, number>;
  difficulty: Record<string, number>;
};

const EXPECTED_DISTRIBUTION: Distribution = {
  total: 30,
  category: {
    "기초 신고/마감": 6,
    "영세율/면세": 6,
    "매입세액 공제": 6,
    의제매입: 4,
    간이과세: 4,
    가산세: 4,
  },
  taxType: {
    "vat-common": 15,
    "vat-general": 10,
    "vat-simplified": 5,
  },
  difficulty: { easy: 10, medium: 14, hard: 6 },
};

export type LintResult = { ok: boolean; errors: string[] };

/**
 * spec §1.3 invariant — 카테고리/tax_type/난이도 분포, id 유니크, source_id 정합성을
 * golden.json에서 직접 검사. 호출자는 ok=false면 exit 1로 막아 commit 전 검출.
 * 순수 함수라 service factory와 무관하게 단독 export.
 */
export function lintGoldenSet(
  set: GoldenSet,
  validSourceIds: Set<string>,
): LintResult {
  const errors: string[] = [];
  const items = set.items;

  if (items.length !== EXPECTED_DISTRIBUTION.total) {
    errors.push(
      `total mismatch: expected ${EXPECTED_DISTRIBUTION.total}, got ${items.length}`,
    );
  }

  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) errors.push(`duplicate id: ${it.id}`);
    seen.add(it.id);
    if (!validSourceIds.has(it.expectedCitationDoc)) {
      errors.push(`unknown sourceId: ${it.id} → ${it.expectedCitationDoc}`);
    }
    if (it.expectedKeywords.length === 0) {
      errors.push(`empty keywords: ${it.id}`);
    }
  }

  for (const axis of ["category", "taxType", "difficulty"] as const) {
    const expected = EXPECTED_DISTRIBUTION[axis];
    const actual: Record<string, number> = {};
    for (const it of items) {
      const k = it[axis];
      actual[k] = (actual[k] ?? 0) + 1;
    }
    for (const [k, v] of Object.entries(expected)) {
      const got = actual[k] ?? 0;
      if (got !== v)
        errors.push(`${axis}.${k} mismatch: expected ${v}, got ${got}`);
    }
    for (const k of Object.keys(actual)) {
      if (!(k in expected))
        errors.push(`${axis}.${k} unexpected (${actual[k]} item(s))`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// 한 문항 실행 결과 — eval_runs.results jsonb에 그대로 박제(spec §5.1).
export type EvalResultEntry = {
  id: string;
  question: string;
  responseText: string;
  citations: Array<{
    sourceId: string;
    page: number | null;
    sectionPath: string | null;
    content: string;
    quote: string;
    quoteStart: number;
    quoteEnd: number;
  }>;
  scores: AxisScores;
  weighted: number;
  latencyMs: number;
  tokens: { input: number | undefined; output: number | undefined };
  expectedKeywordsHit: string[];
  expectedKeywordsMiss: string[];
  finishReason: string;
  model: string;
};

export type EvalSummary = {
  n: number;
  weightedAvg: number;
  axes: AxisScores; // 0/1 축은 평균이 0~1 실수가 됨 — 타입은 동일
  byCategory: Record<string, { n: number; weightedAvg: number }>;
  byDifficulty: Record<string, { n: number; weightedAvg: number }>;
  byTaxType: Record<string, { n: number; weightedAvg: number }>;
  failures: string[];
  totals: {
    latencyMsP50: number;
    latencyMsP95: number;
    inputTokensSum: number;
    outputTokensSum: number;
  };
  weights: typeof WEIGHTS;
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function summarize(
  results: EvalResultEntry[],
  items: GoldenItem[],
): EvalSummary {
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const avg = (arr: number[]) => (arr.length ? sum(arr) / arr.length : 0);
  const itemById = new Map(items.map((it) => [it.id, it]));

  const groupBy = <K extends keyof GoldenItem>(field: K) => {
    const groups: Record<string, number[]> = {};
    for (const r of results) {
      const it = itemById.get(r.id);
      if (!it) continue;
      const k = String(it[field]);
      (groups[k] ??= []).push(r.weighted);
    }
    return Object.fromEntries(
      Object.entries(groups).map(([k, vals]) => [
        k,
        { n: vals.length, weightedAvg: avg(vals) },
      ]),
    );
  };

  const latencies = results.map((r) => r.latencyMs);

  return {
    n: results.length,
    weightedAvg: avg(results.map((r) => r.weighted)),
    axes: {
      keywordRecall: avg(results.map((r) => r.scores.keywordRecall)),
      // 0/1 축의 평균은 실수지만 AxisScores 타입의 0|1 제약 때문에 단언이 필요.
      // 채점 단계의 단위 점수는 정확히 0|1이므로 평균만 cast.
      citationPresent: avg(results.map((r) => r.scores.citationPresent)) as
        | 0
        | 1,
      citationCorrect: avg(results.map((r) => r.scores.citationCorrect)) as
        | 0
        | 1,
      noHallucination: avg(results.map((r) => r.scores.noHallucination)) as
        | 0
        | 1,
    },
    byCategory: groupBy("category"),
    byDifficulty: groupBy("difficulty"),
    byTaxType: groupBy("taxType"),
    failures: results.filter((r) => r.weighted < 0.5).map((r) => r.id),
    totals: {
      latencyMsP50: percentile(latencies, 0.5),
      latencyMsP95: percentile(latencies, 0.95),
      inputTokensSum: sum(results.map((r) => r.tokens.input ?? 0)),
      outputTokensSum: sum(results.map((r) => r.tokens.output ?? 0)),
    },
    weights: WEIGHTS,
  };
}

// 한 항목을 ask로 실행해 결과 entry 생성. text/citation 두 stream을 모두 drain해야
// finish가 resolve — chat.service가 fullStream 단일 백그라운드 루프에서 두 큐로 fan-out
// 하므로 어느 한 쪽만 소비하면 큐가 막혀 finish 대기가 영원해진다.
async function runOne(
  ask: AskFn,
  item: GoldenItem,
  k: number,
): Promise<EvalResultEntry> {
  const t0 = Date.now();
  const { textStream, citationStream, finish } = await ask(item.question, { k });
  const drainText = (async () => {
    for await (const _ of textStream) void _;
  })();
  const drainCitations = (async () => {
    for await (const _ of citationStream) void _;
  })();
  await Promise.all([drainText, drainCitations]);
  const meta = await finish;
  const t1 = Date.now();

  // 검증 통과한 인용만 finish.citations에 담겨 옴 — score의 citationCorrect가 환각 인용에
  // 끌려가지 않도록 chat.service에서 post-hoc verify(quote ⊂ chunk.content)로 거른 결과.
  const response = { text: meta.text, citations: meta.citations };
  const axisScores = score(item, response);
  const w = weighted(axisScores);
  const { hit, miss } = partitionKeywords(item, response);

  return {
    id: item.id,
    question: item.question,
    responseText: meta.text,
    // eval_runs.results jsonb에 박제 — 채점 재현성 + LLM-judge 재실행 가능성을 위해
    // quote/위치까지 그대로 저장. content는 chunk 본문 통째라 jsonb 사이즈가 커지지만
    // 회귀 분석 시점에 청크 join 없이 한 행으로 답·인용·근거 텍스트가 다 보이는 게 더 가치 큼.
    citations: meta.citations.map((c) => ({
      sourceId: c.sourceId,
      page: c.page,
      sectionPath: c.sectionPath,
      content: c.content,
      quote: c.quote,
      quoteStart: c.quoteStart,
      quoteEnd: c.quoteEnd,
    })),
    scores: axisScores,
    weighted: w,
    latencyMs: t1 - t0,
    tokens: { input: meta.inputTokens, output: meta.outputTokens },
    expectedKeywordsHit: hit,
    expectedKeywordsMiss: miss,
    finishReason: meta.finishReason,
    model: meta.model,
  };
}

export type RunnerOptions = {
  k: number;
  embeddingModel: string;
  promptVersion: string | null;
  goldensetVersion: string;
  limit?: number;
};

export type EvalService = ReturnType<typeof createEvalService>;

/**
 * eval domain service — repository 위임 + runEval composite. ask는 deps가 아니라 runEval 인자로
 * 받는다(throttle 등 CLI 정책을 호출자가 결정). saveRun/listRuns/upsertItems는 controller가
 * repository를 직접 import하지 못하게 service 경유를 강제.
 */
export function createEvalService(deps: { evalRepo: EvalRepository }) {
  const { evalRepo } = deps;

  return {
    /**
     * 본 슬라이스의 메인 흐름 — eval_items upsert → 항목 직렬 실행 → summarize → saveRun.
     * 직렬 실행은 토이 규모(30문항) + rate limit/디버깅 우위. 병렬화는 v2.
     * ask는 호출자가 주입 — 보통 throttle 래핑된 chat service의 ask.
     */
    async runEval(args: {
      ask: AskFn;
      set: GoldenSet;
      options: RunnerOptions;
      onItem?: (entry: EvalResultEntry, idx: number, total: number) => void;
    }): Promise<{
      runId: string;
      results: EvalResultEntry[];
      summary: EvalSummary;
    }> {
      const { ask, set, options, onItem } = args;

      const evalItemRows: EvalItem[] = set.items.map((it) => ({
        id: it.id,
        question: it.question,
        expectedKeywords: it.expectedKeywords,
        expectedCitationDoc: it.expectedCitationDoc,
        category: it.category,
        difficulty: it.difficulty,
        taxType: it.taxType,
      }));
      await evalRepo.upsertItems(evalItemRows);

      const items = options.limit
        ? set.items.slice(0, options.limit)
        : set.items;
      const results: EvalResultEntry[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = await runOne(ask, items[i], options.k);
        results.push(entry);
        onItem?.(entry, i, items.length);
      }

      const summary = summarize(results, items);

      // 실제 호출에서 사용된 모델 — generate.ts가 ResolvedModel.modelId로 박제한 값.
      const usedModel = results[0]?.model ?? "(none)";

      const saveArgs: SaveRunArgs = {
        model: usedModel,
        embeddingModel: options.embeddingModel,
        retrievalK: options.k,
        promptVersion: options.promptVersion,
        goldensetVersion: options.goldensetVersion,
        results,
        summary,
      };
      const runId = await evalRepo.saveRun(saveArgs);

      return { runId, results, summary };
    },

    async saveRun(args: SaveRunArgs): Promise<string> {
      return evalRepo.saveRun(args);
    },

    async listRuns(limit = 20): Promise<EvalRunRow[]> {
      return evalRepo.listRuns(limit);
    },

    async upsertItems(items: EvalItem[]): Promise<void> {
      return evalRepo.upsertItems(items);
    },
  };
}
