import { cosineDistance, desc, eq, sql } from "drizzle-orm";

import type { Citation } from "../rag/citation";
import type { Db } from "./client";
import { chunks, conversations, documents, evalItems, evalRuns, messages } from "./schema";

// spec §2.1 인터페이스 — TS plane DB 진입점. 도메인별 namespace로 묶어
// 소비자(`apps/web` route handler/CLI)가 drizzle 객체를 직접 import하지 않도록 통제한다.
// W2: chunks.search, W3: messages.savePair (apps/web 영속화) — 이후 feedback/audit/eval 추가.

export type SearchFilter = {
  // metadata.tax_type(jsonb 키는 spec §3.1의 snake case 그대로) 정확 일치 필터. 도메인 표면
  // 컨벤션은 camelCase로 통일해 TS 호출자가 SQL 내부 키와 분리되도록 한다.
  taxType?: string;
};

export type SearchOptions = {
  embedding: number[];
  k?: number;
  filter?: SearchFilter;
};

export type SearchResult = {
  chunkId: string;
  docId: string;
  sourceId: string;
  docTitle: string;
  docVersion: string | null;
  // documents.source_url — sources.json의 url(예: NTS 다운로드 링크). UI 인용 패널에서
  // "원본 PDF 다운로드" 앵커로 사용. 적재 시 nullable이므로 호출자도 분기 처리.
  sourceUrl: string | null;
  page: number | null;
  sectionPath: string | null;
  content: string;
  similarity: number;
  metadata: Record<string, unknown>;
};

export type SavePairArgs = {
  conversationId: string;
  query: string;
  text: string;
  citations: Citation[];
  retrievedChunkIds: string[];
  model: string;
  latencyMs: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  traceId: string | null;
};

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

// eval_runs 1행 적재 args. results/summary 구조는 §5 spec, 본 gateway는 jsonb로 그대로 전달.
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

export type Gateway = ReturnType<typeof createGateway>;

export function createGateway(db: Db) {
  return {
    chunks: {
      /**
       * spec §3.2 retrieval — pgvector cosineDistance(<=>) top-k + tax_type 메타 필터.
       * version 가중·최신 우선은 의도적으로 builder 밖에 둠(generation 단 정책).
       * documents JOIN으로 인용 모달 표시에 필요한 docTitle·docVersion까지 한 번에 반환.
       * Drizzle builder가 SELECT alias를 객체 키로 자동 매핑 → 도메인은 camelCase 유지.
       */
      async search({
        embedding,
        k = 8,
        filter,
      }: SearchOptions): Promise<SearchResult[]> {
        const distance = cosineDistance(chunks.embedding, embedding);
        const taxType = filter?.taxType ?? null;

        return db
          .select({
            chunkId: sql<string>`${chunks.id}::text`.as("chunkId"),
            docId: sql<string>`${chunks.docId}::text`.as("docId"),
            // chunks.metadata jsonb의 키는 spec §3.1 컨벤션 그대로(snake) — SQL 내부의 키이므로
            // 도메인 camel 표면과 격리. ingest 단(Python)이 동일 키로 적재.
            sourceId: sql<string>`${chunks.metadata}->>'source_id'`.as("sourceId"),
            docTitle: documents.title,
            docVersion: documents.version,
            sourceUrl: documents.sourceUrl,
            page: chunks.page,
            sectionPath: chunks.sectionPath,
            content: chunks.content,
            metadata: chunks.metadata,
            similarity: sql<number>`1 - (${distance})`.as("similarity"),
          })
          .from(chunks)
          .innerJoin(documents, eq(documents.id, chunks.docId))
          .where(
            sql`(${taxType}::text IS NULL OR ${chunks.metadata}->>'tax_type' = ${taxType}::text)`,
          )
          .orderBy(distance)
          .limit(k) as Promise<SearchResult[]>;
      },
    },
    evalItems: {
      /**
       * golden.json → DB 동기화. 슬러그 PK라 ON CONFLICT (id) DO UPDATE.
       * 정답이 사라진 항목은 자동 삭제하지 않음 — 과거 eval_runs.results가 참조하므로
       * 수동 삭제만 허용(2026-05-07 eval 슬라이스 §4.2).
       */
      async upsert(items: EvalItem[]): Promise<void> {
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
    },
    eval: {
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
    },
    messages: {
      /**
       * 한 chat turn(user 질문 + assistant 답변)을 단일 트랜잭션에 기록.
       * invariant: 두 메시지가 함께 남거나 함께 없거나 — 한쪽만 남는 어긋난 상태를 막는다.
       * conversations 행은 첫 turn에만 생성(onConflictDoNothing) → 단일 롤링 대화에서
       * 두 번째 turn부터는 messages 2건만 추가. title은 첫 user query 앞 60자.
       */
      async savePair(args: SavePairArgs): Promise<void> {
        await db.transaction(async (tx) => {
          await tx
            .insert(conversations)
            .values({
              id: args.conversationId,
              title: args.query.slice(0, 60),
            })
            .onConflictDoNothing();

          await tx.insert(messages).values([
            {
              conversationId: args.conversationId,
              role: "user",
              content: args.query,
              citations: [],
              retrievedChunkIds: null,
            },
            {
              conversationId: args.conversationId,
              role: "assistant",
              content: args.text,
              citations: args.citations,
              retrievedChunkIds: args.retrievedChunkIds,
              model: args.model,
              latencyMs: args.latencyMs,
              inputTokens: args.inputTokens,
              outputTokens: args.outputTokens,
              traceId: args.traceId,
            },
          ]);
        });
      },
    },
  };
}
