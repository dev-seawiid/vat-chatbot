import type { Citation, ProgressEvent } from "@vat/core";
import type { UIMessage } from "ai";

export type { Citation, ProgressEvent };

export type ChatDataParts = {
  // 서버가 모델의 cite_chunk 호출마다 1건씩 emit → message.parts에 N건 누적.
  citation: Citation;
  // OTEL trace_id — user-thumbs score 송출 키. 텔레메트리 미부팅 환경에선 part 부재.
  trace: { id: string };
  // ADR-0003 §8 — retrieval 단계별 진행 stage. 스트리밍 중 갱신, 최신 1건만 의미 있음.
  progress: ProgressEvent;
};

export type ChatUIMessage = UIMessage<unknown, ChatDataParts>;
