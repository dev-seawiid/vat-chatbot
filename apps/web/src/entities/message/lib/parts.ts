import type { Citation } from "@/entities/citation/types";
import type { ChatUIMessage } from "@/entities/message/types";

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

export function lastUserText(messages: ChatUIMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return "";
  return getText(last);
}
