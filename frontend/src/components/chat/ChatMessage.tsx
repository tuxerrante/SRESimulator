"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage as ChatMessageType } from "@shared/types/chat";
import { CodeBlock } from "@/components/shared/CodeBlock";
import { cn } from "@/lib/utils";
import { User, Bot, ExternalLink } from "lucide-react";

interface ChatMessageProps {
  message: ChatMessageType;
  onRunCommand?: (command: string, type: "oc" | "kql" | "geneva") => void;
}

export function ChatMessage({ message, onRunCommand }: ChatMessageProps) {
  const isUser = message.role === "user";

  // Strip control markers from display
  const displayContent = message.content
    .replace(/\[PHASE:\w+\]/g, "")
    .replace(/\[SCORE:\w+:[+-]\d+:[^\]]+\]/g, "")
    .replace(/\[RESOLVED\]/g, "")
    .trim();

  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-3",
        isUser ? "bg-zinc-800/50" : "bg-transparent"
      )}
    >
      <div
        className={cn(
          "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5",
          isUser ? "bg-blue-600" : "bg-amber-600"
        )}
      >
        {isUser ? (
          <User size={14} className="text-white" />
        ) : (
          <Bot size={14} className="text-white" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-zinc-500 mb-1">
          {isUser ? "You" : "Dungeon Master"}
        </div>
        <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-li:my-0">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a({ href, children, ...props }) {
                return (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 underline"
                    {...props}
                  >
                    {children}
                    <ExternalLink size={12} className="inline flex-shrink-0" />
                  </a>
                );
              },
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
                const lang = match ? match[1] : "";
                const codeStr = String(children).replace(/\n$/, "");

                if (lang && ["oc", "kql", "geneva", "bash"].includes(lang)) {
                  return (
                    <CodeBlock
                      code={codeStr}
                      language={lang}
                      onRun={onRunCommand}
                    />
                  );
                }

                // Inline code
                return (
                  <code
                    className="bg-zinc-800 px-1 py-0.5 rounded text-emerald-400 text-xs"
                    {...props}
                  >
                    {children}
                  </code>
                );
              },
              pre({ children }) {
                return <>{children}</>;
              },
            }}
          >
            {displayContent}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
