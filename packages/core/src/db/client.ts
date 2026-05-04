import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "../env";
import * as schema from "./schema";

// 양 plane이 같은 DB를 보지만 커넥션은 plane별로 자기 풀을 가진다.
// 모듈 스코프 싱글톤 — 핫리로드/스크립트 다회 호출에서 커넥션 폭증 방지.
let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (_db) return _db;
  // Neon은 pgbouncer transaction-mode 풀러 뒤라 prepare statement 캐시가 깨진다.
  // prepare:false로 끄면 로컬·Neon 양쪽에서 안전(로컬은 손해 미미). Python plane의
  // psycopg `prepare_threshold=None`과 정확히 같은 결정.
  _client = postgres(env.DATABASE_URL, { prepare: false });
  _db = drizzle(_client, { schema });
  return _db;
}

// 테스트/CLI에서 명시적 종료가 필요할 때만 호출. 일반 web request lifecycle에선 미호출.
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}
