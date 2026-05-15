import type { ChatUIMessage, Citation } from "../types";

export function getText(message: ChatUIMessage): string {
  let out = "";
  for (const part of message.parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
}

// 같은 chunk이 다른 quote로 여러 번 선언될 수 있어 chunkId dedup — 모든 소비자가 같은 list.
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

// 외부 입력(JSON.parse 결과)을 캐스팅 없이 type guard로 좁힌 뒤 user 텍스트만 추출.
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
