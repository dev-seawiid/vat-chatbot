import "server-only";

import { LangfuseSpanProcessor } from "@langfuse/otel";

// 싱글톤 — instrumentation.node.ts(NodeSDK 등록)와 route handler(after-forceFlush)가 같은
// 인스턴스를 공유해야 한다. Node.js 모듈 캐시가 process-global이라 import 경로만 동일하면 보장.
//
// 환경변수(LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL)는 LangfuseSpanProcessor가 직접 읽는다.
// 미설정 시에도 인스턴스 생성 자체는 성공하고, export 시점에 키 부재로 spans drop. 즉
// dev에서 Langfuse 미연결 상태로 앱이 동작하는 것을 막지 않는다.
export const langfuseSpanProcessor = new LangfuseSpanProcessor();
