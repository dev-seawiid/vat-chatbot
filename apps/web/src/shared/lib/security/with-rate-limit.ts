import { RATE_LIMIT_ERROR_BODY } from "./error-codes";
import { checkChatRateLimit, getClientIp } from "./ratelimit";

type RouteHandler = (req: Request) => Promise<Response>;

// Cross-cutting concern(rate limit)을 비즈니스 핸들러에서 분리하는 합성 wrapper.
// 핸들러는 자기 이름대로의 일만 하고, 한도 검사·429 응답 생성은 본 wrapper가 책임진다.
// 적용 라우트가 늘면 middleware.ts로 승격하는 게 자연스러우나, 단일 라우트일 때는 합성이
// 가장 가볍다(Edge 런타임 제약·matcher 관리 회피).
export function withRateLimit(handler: RouteHandler): RouteHandler {
  return async (req) => {
    const rate = await checkChatRateLimit(getClientIp(req));
    if (!rate.ok) return tooManyRequests(rate.retryAfterSec);
    return handler(req);
  };
}

function tooManyRequests(retryAfterSec: number): Response {
  return new Response(RATE_LIMIT_ERROR_BODY, {
    status: 429,
    headers: { "retry-after": String(retryAfterSec) },
  });
}
