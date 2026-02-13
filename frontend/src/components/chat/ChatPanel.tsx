"use client";

import { useEffect, useRef } from "react";
import { ChatMessage } from "./ChatMessage";
import { ChatInput } from "./ChatInput";
import { useChat } from "@/hooks/useChat";
import { Loader2 } from "lucide-react";

interface ChatPanelProps {
  onRunCommand?: (command: string, type: "oc" | "kql" | "geneva") => void;
}

export function ChatPanel({ onRunCommand }: ChatPanelProps) {
  const { messages, isStreaming, sendMessage } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="flex flex-col h-full bg-zinc-900 border-r border-zinc-700">
      <div className="px-4 py-2 border-b border-zinc-700 bg-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-200">
          Investigation Chat
        </h2>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
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
