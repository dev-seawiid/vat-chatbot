import { sql } from "drizzle-orm";

import type { Db } from "./client";
import { type Citation, conversations, messages } from "./schema";

// spec §2.1 인터페이스 — TS plane DB 진입점. 도메인별 namespace로 묶어
// 소비자(`apps/web` route handler/CLI)가 drizzle 객체를 직접 import하지 않도록 통제한다.
// W2: chunks.search, W3: messages.savePair (apps/web 영속화) — 이후 feedback/audit/eval 추가.

export type SearchFilter = {
  // metadata.tax_type 정확 일치. spec §3.1 라벨 컨벤션의 `vat-general`/`vat-simplified`/
  // `vat-common` 중 하나, 또는 미래 세목 prefix(`inc-`/`corp-` 등).
  tax_type?: string;
};

export type SearchOptions = {
  embedding: number[];
  k?: number;
  filter?: SearchFilter;
};

export type SearchResult = {
  chunk_id: string;
  doc_id: string;
  doc_title: string;
  doc_version: string | null;
  page: number | null;
  section_path: string | null;
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

export type Gateway = ReturnType<typeof createGateway>;

export function createGateway(db: Db) {
  return {
    chunks: {
      /**
       * spec §3.2 retrieval SQL — pgvector cosine top-k + tax_type 메타 필터.
       * version 가중·최신 우선은 의도적으로 SQL 밖에 둠(generation 단 정책).
       * documents JOIN으로 인용 모달 표시에 필요한 doc_title·doc_version까지 한 번에 반환.
       */
      async search({
        embedding,
        k = 8,
        filter,
      }: SearchOptions): Promise<SearchResult[]> {
        // pgvector 바인딩은 "[a,b,c]" 텍스트 → ::vector 캐스트 형태가 가장 폭넓게 호환.
        // postgres-js에 array 직접 바인딩은 dimension 메타 손실 위험이 있어 회피.
        const vec = `[${embedding.join(",")}]`;
        const taxType = filter?.tax_type ?? null;

        const rows = await db.execute<SearchResult>(sql`
          SELECT c.id::text                            AS chunk_id,
                 c.doc_id::text                        AS doc_id,
                 d.title                               AS doc_title,
                 d.version                             AS doc_version,
                 c.page,
                 c.section_path,
                 c.content,
                 c.metadata,
                 1 - (c.embedding <=> ${vec}::vector)  AS similarity
          FROM chunks c
          JOIN documents d ON d.id = c.doc_id
          WHERE (${taxType}::text IS NULL OR c.metadata->>'tax_type' = ${taxType}::text)
          ORDER BY c.embedding <=> ${vec}::vector
          LIMIT ${k}
        `);
        return rows as unknown as SearchResult[];
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
