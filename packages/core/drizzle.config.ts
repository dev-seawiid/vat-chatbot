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
    url: process.env.DATABASE_URL!,
  },
});
