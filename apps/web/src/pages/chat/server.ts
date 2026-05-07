// 슬라이스의 server-side Public API.
// index.tsx(client component)와 분리해서 client 모듈 그래프에 server-only 의존(@langfuse,
// next/server, @vat/core gateway 등)이 끌려오지 않도록 한다. Next 라우팅 어댑터(app/api/...)는
// 본 entry만 import한다.
export { POST } from "./api/handler";
