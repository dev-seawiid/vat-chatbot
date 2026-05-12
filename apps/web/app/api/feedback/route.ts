// LangfuseClient는 Node 전용 (fetch 외에 process.env 접근). edge 런타임 시 일부 의존
// 미호환 가능성 + chat 라우트와 동일 정책 유지.
export const runtime = "nodejs";

export { POST } from "@/features/submit-feedback/server";
