import { resolve } from "node:path";

import { config } from "dotenv";
import { z } from "zod";

// monorepo 루트 .env 한 곳을 양 plane(TS·Python)이 공유 — drizzle.config.ts와 동일 정책.
// __dirname(packages/core/src) → ../../../ = repo root.
config({ path: resolve(__dirname, "../../../.env") });

const Env = z.object({
  // 로컬 docker-compose 기본값. Neon URL로 덮어쓰면 동일 코드로 대상 전환.
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://vat_user:vat_pw@localhost:5432/vat_db"),
  // Voyage 키는 placeholder("00")여도 zod는 통과 — 실제 호출 시점에 401로 명시 실패시켜
  // "키가 잘못됐다"는 신호가 빠르게 표면화되도록 둔다(빈 문자열만 즉시 거부).
  VOYAGE_API_KEY: z.string().min(1, "VOYAGE_API_KEY is required"),
  // @ai-sdk/google가 자동으로 lookup하는 표준 환경변수 이름. AI Studio(https://aistudio.google.com/apikey)
  // 무료 티어로 토이 운영. 배포 시 vendor 교체하려면 model.ts 도입(별도 작업).
  GOOGLE_GENERATIVE_AI_API_KEY: z
    .string()
    .min(1, "GOOGLE_GENERATIVE_AI_API_KEY is required"),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
