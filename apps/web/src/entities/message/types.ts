import type { Citation } from "@vat/core";
import type { UIMessage } from "ai";

export type { Citation };

export type ChatDataParts = {
  // 모델이 cite_chunk tool을 호출할 때마다 서버가 1건씩 emit하는 인용 객체.
  // 본문 텍스트엔 [n] 마커가 박히지 않으므로 클라는 본 part를 누적해 본문 아래에 칩으로 렌더.
  citation: Citation;
  // OTEL trace_id를 클라까지 흘려 user-thumbs score 송출 시 키로 사용. 텔레메트리 미부팅
  // 환경(예: dev에 키 미설정)에서는 서버가 송출 자체를 생략 → 클라는 part 부재로 감지.
  trace: { id: string };
};

export type ChatUIMessage = UIMessage<unknown, ChatDataParts>;
