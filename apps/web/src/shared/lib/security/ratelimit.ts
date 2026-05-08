import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// 3-단 sliding window 가드(spec §5.2): per-IP 5/min + per-IP 10/day + 전역 20/day.
// env(UPSTASH_REDIS_REST_URL/TOKEN) 미설정 시 모든 가드 통과 — Langfuse와 같은 결의
// graceful degrade로 dev 마찰 0. prod는 Vercel marketplace의 Upstash for Redis 연결.

type SlidingWindow = `${number} ${"s" | "m" | "h" | "d"}`;

// 정책의 모든 뉘앙스(한도·윈도우·Redis prefix·scope 라벨·키 단위)를 한 객체에 응집.
// 새 한도 추가 시 본 객체만 갱신하면 검사 루프가 자동 포함한다.
const RATE_LIMITS = {
  perIpMinute: {
    count: 5,
    window: "1 m",
    prefix: "rl:ip:m",
    scope: "ip-min",
    perIp: true,
  },
  perIpDay: {
    count: 10,
    window: "1 d",
    prefix: "rl:ip:d",
    scope: "ip-day",
    perIp: true,
  },
  global: {
    count: 20,
    window: "1 d",
    prefix: "rl:global",
    scope: "global",
    perIp: false,
  },
} as const satisfies Record<
  string,
  {
    count: number;
    window: SlidingWindow;
    prefix: string;
    scope: string;
    perIp: boolean;
  }
>;

type LimitName = keyof typeof RATE_LIMITS;

export type RateLimitScope = (typeof RATE_LIMITS)[LimitName]["scope"];

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number; scope: RateLimitScope };

const GLOBAL_BUCKET_KEY = "global";
const FALLBACK_IP = "unknown";
const MIN_RETRY_AFTER_SEC = 1;
const FORWARDED_FOR_HEADER = "x-forwarded-for";
const REAL_IP_HEADER = "x-real-ip";

type Limiters = Record<LimitName, Ratelimit>;

// dev mode HMR로 모듈 재평가 시 새 Ratelimit·Redis 클라이언트가 누적되는 문제 회피.
// 3-state: undefined=미초기화, null=env 미설정으로 비활성 결정, 객체=활성.
const globalForRl = globalThis as unknown as {
  __vatRatelimit?: Limiters | null;
};

function getLimiters(): Limiters | null {
  if (globalForRl.__vatRatelimit !== undefined) {
    return globalForRl.__vatRatelimit;
  }
  globalForRl.__vatRatelimit = createLimiters();
  return globalForRl.__vatRatelimit;
}

function createLimiters(): Limiters | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const redis = new Redis({ url, token });
  const entries = (
    Object.entries(RATE_LIMITS) as [
      LimitName,
      (typeof RATE_LIMITS)[LimitName],
    ][]
  ).map(([name, cfg]) => {
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(cfg.count, cfg.window),
      prefix: cfg.prefix,
      analytics: false,
    });
    return [name, limiter] as const;
  });
  return Object.fromEntries(entries) as Limiters;
}

// 등록 순서대로 직렬 평가해 가장 먼저 막히는 scope를 반환. 막힌 단계 이전 카운터는 1
// 소비된 채 누적되지만(작은 over-counting) 한도 체크 표준 패턴이라 토이엔 무시 가능.
export async function checkChatRateLimit(ip: string): Promise<RateLimitResult> {
  const limiters = getLimiters();
  if (!limiters) return { ok: true };

  for (const name of Object.keys(RATE_LIMITS) as LimitName[]) {
    const cfg = RATE_LIMITS[name];
    const key = cfg.perIp ? ip : GLOBAL_BUCKET_KEY;
    const result = await limiters[name].limit(key);
    if (!result.success) return blocked(result.reset, cfg.scope);
  }
  return { ok: true };
}

function blocked(resetEpochMs: number, scope: RateLimitScope): RateLimitResult {
  const retryAfterSec = Math.max(
    MIN_RETRY_AFTER_SEC,
    Math.ceil((resetEpochMs - Date.now()) / 1000),
  );
  return { ok: false, retryAfterSec, scope };
}

// Vercel은 x-forwarded-for 첫 토큰을 클라이언트 IP로 노출(다중 프록시 시 좌측 첫 항목).
// 헤더 부재 시 FALLBACK_IP로 폴백 — 동일 키로 묶이지만 토이 운영에선 충분.
export function getClientIp(req: Request): string {
  const xff = req.headers.get(FORWARDED_FOR_HEADER);
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  return req.headers.get(REAL_IP_HEADER) ?? FALLBACK_IP;
}
