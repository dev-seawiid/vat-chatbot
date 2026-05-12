// Client-safe entries만 노출 — server-only는 ./server에서 import한다.
export { RATE_LIMIT_ERROR_BODY } from "./error-codes";
export type { RateLimitResult, RateLimitScope } from "./ratelimit";
