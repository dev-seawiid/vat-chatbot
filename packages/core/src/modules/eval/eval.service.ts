import {
  type AxisScores,
  type GoldenItem,
  WEIGHTS,
  partitionKeywords,
  score,
  weighted,
} from "./scoring";
import type { AskFn } from "#modules/chat/chat.service";
import type {
  EvalItem,
  EvalRepository,
  EvalRunRow,
  SaveRunArgs,
} from "./eval.repository";

// _source_excerpt / _source_page 같은 underscore 필드는 인간 검수용 — 채점에서 무시.
export type GoldenSet = {
  version: string;
  items: GoldenItem[];
};

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

// commit 전 분포·id 유니크·source_id 정합성 검사. service factory와 무관한 순수 함수.
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
  axes: AxisScores;
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
      // 0/1 단위 점수의 평균은 실수가 되지만 AxisScores 타입 제약 때문에 단언 필요.
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

// text/citation 두 stream 모두 drain해야 finish가 resolve(chat.service의 fan-out 큐 invariant).
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

  const response = { text: meta.text, citations: meta.citations };
  const axisScores = score(item, response);
  const w = weighted(axisScores);
  const { hit, miss } = partitionKeywords(item, response);

  return {
    id: item.id,
    question: item.question,
    responseText: meta.text,
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

export function createEvalService(deps: { evalRepo: EvalRepository }) {
  const { evalRepo } = deps;

  return {
    // ask는 deps가 아니라 인자 — throttle 등 CLI 정책을 호출자가 결정.
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
