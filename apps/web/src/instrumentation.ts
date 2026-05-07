// Next.js instrumentation 진입점. 서버 부팅 시 1회 호출되며, NodeSDK는 edge runtime
// 비호환이라 NEXT_RUNTIME 가드로 분기한다(Next.js OpenTelemetry 가이드 권장 패턴).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation.node");
  }
}
