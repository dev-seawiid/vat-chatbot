// 서버 wrapper(with-rate-limit)와 클라 onError 분기가 공유하는 단일 진실. 클라이언트
// 번들에 server-only 의존이 새지 않도록 상수만 분리(서버 모듈에서 export하면 client
// component가 import할 때 Upstash 클라이언트가 함께 끌려갈 수 있음).
export const RATE_LIMIT_ERROR_BODY = "RATE_LIMIT_EXCEEDED";
