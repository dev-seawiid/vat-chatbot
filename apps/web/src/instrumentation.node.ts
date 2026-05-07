import { NodeSDK } from "@opentelemetry/sdk-node";

import { langfuseSpanProcessor } from "@/shared/lib/observability/langfuse";

// Node 런타임 전용 OTEL 부트스트랩. AI SDK의 experimental_telemetry가 이 SDK에 등록된
// span processor 체인으로 spans을 흘려보낸다. langfuseSpanProcessor는 별도 모듈에서
// 싱글톤으로 export되며, route handler의 after(forceFlush)가 같은 인스턴스를 참조한다.
const sdk = new NodeSDK({
  spanProcessors: [langfuseSpanProcessor],
});

sdk.start();
