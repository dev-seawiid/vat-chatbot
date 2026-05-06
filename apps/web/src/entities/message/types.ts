import type { UIMessage } from "ai";

import type { Citation } from "@/entities/citation/types";

export type ChatDataParts = {
  citations: Citation[];
};

export type ChatUIMessage = UIMessage<unknown, ChatDataParts>;
