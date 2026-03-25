"use client";

import { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import { ChatInput } from "./ChatInput";
import { useChat } from "@/hooks/useChat";
import { useGameStore } from "@/stores/gameStore";
import { Loader2 } from "lucide-react";

interface ChatPanelProps {
  onRunCommand?: (command: string, type: "oc" | "kql" | "geneva") => void;
}

export function ChatPanel({ onRunCommand }: ChatPanelProps) {
  const { messages, isStreaming, sendMessage } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Subscribe to the raw messages array to detect content updates during streaming
  const storeMessages = useGameStore((s) => s.messages);
  const lastContent = storeMessages[storeMessages.length - 1]?.content;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [storeMessages.length, lastContent]);

  return (
    <div data-tour="chat-panel" className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-zinc-700 bg-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-200">
          Investigation Chat
        </h2>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-600 text-sm px-8 text-center">
            Start your investigation by describing what you observe in the incident ticket.
          </div>
        )}
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            message={message}
            onRunCommand={onRunCommand}
          />
        ))}
        {isStreaming && (
          <div className="flex items-center gap-2 px-4 py-2 text-zinc-500 text-xs">
            <Loader2 size={12} className="animate-spin" />
            Dungeon Master is thinking...
          </div>
        )}
      </div>

      <ChatInput onSend={sendMessage} disabled={isStreaming} />
    </div>
  );
}
