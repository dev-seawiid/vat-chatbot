import "dotenv/config";

import { defineConfig } from "drizzle-kit";

// drizzle-kit은 cwd=packages/core로 실행되므로 dotenv가 packages/core/.env를 자동 로드.
// (CLI 진입점이라 본 파일이 직접 로딩 책임을 진다 — 라이브러리 코드는 검증만.)

export default defineConfig({
  schema: "./src/**/schema.ts",
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
