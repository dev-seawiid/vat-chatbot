import type { Citation } from "@vat/core";
import type { UIMessage } from "ai";

export type ChatDataParts = {
  citations: Citation[];
};

export type ChatUIMessage = UIMessage<unknown, ChatDataParts>;
