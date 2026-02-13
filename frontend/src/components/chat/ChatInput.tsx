"use client";

import { useState, useRef, useCallback } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    if (!value.trim() || disabled) return;
    onSend(value);
    setValue("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  };

  return (
    <div className="border-t border-zinc-700 p-3 bg-zinc-900">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to investigate..."
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2",
            "text-sm text-zinc-100 placeholder-zinc-500",
            "focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        />
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className={cn(
            "flex-shrink-0 p-2 rounded-lg transition-colors",
            "bg-amber-600 text-white hover:bg-amber-500",
            "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-amber-600"
          )}
          title="Send message"
        >
          <Send size={18} />
        </button>
      </div>
      <div className="mt-1.5 text-xs text-zinc-600">
        Press Enter to send, Shift+Enter for new line
      </div>
    </div>
  );
}
