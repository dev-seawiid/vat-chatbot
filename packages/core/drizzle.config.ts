import { resolve } from "node:path";

import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// .env는 monorepo 루트에 한 곳만 둔다 — services/ingest-py(Python)와 동일 정책으로
// 양 plane(TS·Python)이 같은 DATABASE_URL을 본다.
config({ path: resolve(__dirname, "../../.env") });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // 로컬 docker-compose 기본값. .env에서 Neon URL로 덮어쓰면 동일 명령으로 대상 전환.
    // Python 측 config.py와 같은 fallback을 사용해 양 plane이 동일 기본값을 본다.
    url:
      process.env.DATABASE_URL ??
      "postgresql://vat_user:vat_pw@localhost:5432/vat_db",
  },
});
