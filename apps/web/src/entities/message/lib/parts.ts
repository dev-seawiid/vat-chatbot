import type { ChatUIMessage, Citation } from "../types";

export function getText(message: ChatUIMessage): string {
  let out = "";
  for (const part of message.parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
}

export function getCitations(message: ChatUIMessage): Citation[] {
  const out: Citation[] = [];
  for (const part of message.parts) {
    if (part.type === "data-citations") out.push(...part.data);
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
