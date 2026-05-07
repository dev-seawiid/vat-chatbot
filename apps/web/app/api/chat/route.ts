// instrumentation.node.ts가 NodeSDK를 등록하므로 본 라우트는 반드시 node 런타임.
// edge면 NodeSDK 비호환으로 spans drop. (Next route segment config는 라우팅 파일에서만
// 인식되므로 re-export 외에 본 export는 필수.)
export const runtime = "nodejs";

export { POST } from "@/pages/chat/server";
