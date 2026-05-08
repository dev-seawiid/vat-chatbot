import type { Citation } from "@vat/core";
import type { UIMessage } from "ai";

export type ChatDataParts = {
  citations: Citation[];
  // OTEL trace_id를 클라까지 흘려 user-thumbs score 송출 시 키로 사용. 텔레메트리 미부팅
  // 환경(예: dev에 키 미설정)에서는 서버가 송출 자체를 생략 → 클라는 part 부재로 감지.
  trace: { id: string };
};

export type ChatUIMessage = UIMessage<unknown, ChatDataParts>;
