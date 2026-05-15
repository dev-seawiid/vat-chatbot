import type { ChatUIMessage, Citation } from "../types";

export function getText(message: ChatUIMessage): string {
  let out = "";
  for (const part of message.parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
}

// 모델이 같은 chunk을 다른 quote로 cite_chunk 여러 번 호출할 수 있다 — UI는 칩 1개로
// 통합해야 하므로 accessor 단계에서 chunkId로 dedup하여 모든 소비자가 같은 list를 본다.
// raw stream이 필요하면 message.parts에서 data-citation을 직접 순회.
export function getCitations(message: ChatUIMessage): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const part of message.parts) {
    if (part.type !== "data-citation") continue;
    if (seen.has(part.data.chunkId)) continue;
    seen.add(part.data.chunkId);
    out.push(part.data);
  }
  return out;
}

export function getTraceId(message: ChatUIMessage): string | null {
  for (const part of message.parts) {
    if (part.type === "data-trace") return part.data.id;
  }
  return null;
}

// 서버 boundary용 — 외부 입력(JSON.parse 결과)을 ChatUIMessage로 강제 캐스팅하지 않고
// type guard로 안전하게 좁힌 뒤 user 텍스트만 추출. 검증 실패 시 빈 문자열을 반환해
// 호출자가 "empty query" 분기로 처리하도록 한다.
export function extractUserText(message: unknown): string {
  if (!isUserMessage(message)) return "";
  let out = "";
  for (const part of message.parts) {
    if (isTextPart(part)) out += part.text;
  }
  return out;
}

function isUserMessage(
  value: unknown,
): value is { role: "user"; parts: readonly unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "user" &&
    "parts" in value &&
    Array.isArray(value.parts)
  );
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}
