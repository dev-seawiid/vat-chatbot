import { desc, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { evalItems, evalRuns } from "./schema";

// spec §4 eval — eval_items(골든셋 보조 인덱스) + eval_runs(실행 결과) 두 aggregate를 묶어
// 본 repository에서 다룬다. 토이 규모라 별도 분리 안 함. eval service가 본 모듈에 의존.

// 2026-05-07 eval 슬라이스 §4 — golden.json 한 항목의 정답 형태. id는 슬러그(`vat-<cat>-<diff>-<n>`).
export type EvalItem = {
  id: string;
  question: string;
  expectedKeywords: string[];
  expectedCitationDoc: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  taxType: string;
};

// eval_runs 1행 적재 args. results/summary 구조는 §5 spec, 본 repository는 jsonb로 그대로 전달.
export type SaveRunArgs = {
  model: string;
  embeddingModel: string;
  retrievalK: number;
  promptVersion: string | null;
  goldensetVersion: string;
  results: unknown;
  summary: unknown;
};

export type EvalRunRow = {
  id: string;
  ranAt: Date;
  model: string;
  embeddingModel: string;
  retrievalK: number;
  promptVersion: string | null;
  goldensetVersion: string;
  results: unknown;
  summary: unknown;
};

export type EvalRepository = ReturnType<typeof createEvalRepository>;

export function createEvalRepository(db: Db) {
  return {
    /**
     * golden.json → DB 동기화. 슬러그 PK라 ON CONFLICT (id) DO UPDATE.
     * 정답이 사라진 항목은 자동 삭제하지 않음 — 과거 eval_runs.results가 참조하므로
     * 수동 삭제만 허용(2026-05-07 eval 슬라이스 §4.2).
     */
    async upsertItems(items: EvalItem[]): Promise<void> {
      if (items.length === 0) return;
      await db
        .insert(evalItems)
        .values(
          items.map((it) => ({
            id: it.id,
            question: it.question,
            expectedKeywords: it.expectedKeywords,
            expectedCitationDoc: it.expectedCitationDoc,
            category: it.category,
            difficulty: it.difficulty,
            taxType: it.taxType,
          })),
        )
        .onConflictDoUpdate({
          target: evalItems.id,
          set: {
            question: sql`EXCLUDED.question`,
            expectedKeywords: sql`EXCLUDED.expected_keywords`,
            expectedCitationDoc: sql`EXCLUDED.expected_citation_doc`,
            category: sql`EXCLUDED.category`,
            difficulty: sql`EXCLUDED.difficulty`,
            taxType: sql`EXCLUDED.tax_type`,
            updatedAt: sql`now()`,
          },
        });
    },

    /**
     * 1회 실행 결과를 단일 jsonb 페어(results/summary)로 박제. ranAt은 DB default.
     * 적재된 row id를 반환해 stdout/Langfuse trace 키로 다시 쓰일 수 있게 한다.
     */
    async saveRun(args: SaveRunArgs): Promise<string> {
      const [row] = await db
        .insert(evalRuns)
        .values({
          model: args.model,
          embeddingModel: args.embeddingModel,
          retrievalK: args.retrievalK,
          promptVersion: args.promptVersion,
          goldensetVersion: args.goldensetVersion,
          results: args.results,
          summary: args.summary,
        })
        .returning({ id: evalRuns.id });
      return row.id;
    },

    /**
     * 최근 실행 N개를 ranAt 내림차순으로 — admin 대시보드/CLI 비교용. 토이 단계는 단순 SELECT.
     */
    async listRuns(limit = 20): Promise<EvalRunRow[]> {
      return db
        .select()
        .from(evalRuns)
        .orderBy(desc(evalRuns.ranAt))
        .limit(limit);
    },
  };
}
