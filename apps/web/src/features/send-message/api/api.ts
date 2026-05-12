"use client";

import { DefaultChatTransport } from "ai";

import { conversationStorage } from "@/entities/conversation";
import type { ChatUIMessage } from "@/entities/message";

// AI SDK 공식 권장 패턴(docs/04-ai-sdk-ui/03-chatbot-message-persistence "Sending only the
// last message") — 서버 persistence가 있으므로 매 요청마다 history 전체를 보낼 필요가
// 없다. 마지막 메시지와 conversationId만 송신해 페이로드를 최소화한다.
export function createChatTransport(): DefaultChatTransport<ChatUIMessage> {
  return new DefaultChatTransport<ChatUIMessage>({
    api: "/api/chat",
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        message: messages[messages.length - 1],
        conversationId: conversationStorage.getOrCreateId(),
      },
    }),
  });
}
