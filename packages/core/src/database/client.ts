import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as chatSchema from "#modules/chat/schema";
import * as retrievalSchema from "#modules/retrieval/schema";

// 도메인 모듈별 schema를 한 객체로 합쳐 drizzle에 주입 — 타입 추론(`Db`)이
// 모든 테이블을 인식하도록 wiring은 본 파일이 소유.
const schema = { ...chatSchema, ...retrievalSchema };

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export type DbHandle = {
  db: Db;
  close: () => Promise<void>;
};

/**
 * postgres 풀 + drizzle wrapper를 한 번에 만든다. 호출자가 close()를 보관해
 * 프로세스 종료 시점에 명시적으로 풀을 정리한다 (CLI 스크립트). web request
 * lifecycle에서는 close 미호출이 정상 — Next.js 프로세스가 살아 있는 동안 재사용.
 */
export function createDb(databaseUrl: string): DbHandle {
  // Neon은 pgbouncer transaction-mode 풀러 뒤라 prepare statement 캐시가 깨진다.
  // prepare:false로 끄면 로컬·Neon 양쪽에서 안전(로컬은 손해 미미). Python plane의
  // psycopg `prepare_threshold=None`과 정확히 같은 결정.
  const client = postgres(databaseUrl, { prepare: false });
  const db = drizzle(client, { schema, casing: "snake_case" });
  return {
    db,
    close: async () => {
      await client.end();
    },
  };
}
