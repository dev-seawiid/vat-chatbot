import { z } from "zod";

// 라이브러리는 env를 검증만 한다 — 로딩(.env 파일 → process.env)은 소비자(consumer) 책임.
// apps/web: Next.js가 자기 .env.local을 process.env에 자동 주입.
// CLI 스크립트: 진입점에서 `import "dotenv/config"` 또는 `tsx --env-file=...`.
// 따라서 본 모듈은 부수효과 없이 schema와 parser만 export한다.

export const EnvSchema = z.object({
  // 로컬 docker-compose 기본값. Neon URL로 덮어쓰면 동일 코드로 대상 전환.
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://vat_user:vat_pw@localhost:5432/vat_db"),
  // 빈 문자열만 즉시 거부 — placeholder 값은 실제 호출 시점에 401로 명시 실패시켜
  // "키가 잘못됐다"는 신호가 빠르게 표면화되도록 둔다.
  VOYAGE_API_KEY: z.string().min(1, "VOYAGE_API_KEY is required"),
  // ingest plane(jobs/ingest/.../config.py)의 voyage_model과 같은 값이어야 dimension·학습 일치.
  VOYAGE_MODEL: z.string().default("voyage-4"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(input: Record<string, unknown>): Env {
  return EnvSchema.parse(input);
}
