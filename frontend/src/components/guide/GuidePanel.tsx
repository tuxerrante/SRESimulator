"use client";

import { useEffect, useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useGameStore } from "@/stores/gameStore";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import type { InvestigationPhase } from "@shared/types/chat";

const PHASE_HEADING_MAP: Record<InvestigationPhase, string> = {
  reading: "1-reading",
  context: "2-context-gathering",
  facts: "3-facts-gathering",
  theory: "4-theory-building",
  action: "5-actioning-recovery",
};

const PHASE_SECTION_NUMBERS: Record<InvestigationPhase, string> = {
  reading: "1",
  context: "2",
  facts: "3",
  theory: "4",
  action: "5",
};

export function GuidePanel() {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentPhase = useGameStore((s) => s.currentPhase);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/guide")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load guide");
        return res.json();
      })
      .then((data) => setContent(data.content))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!content || !containerRef.current) return;

    const targetId = PHASE_HEADING_MAP[currentPhase];
    const el = containerRef.current.querySelector(`[data-phase-id="${targetId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [currentPhase, content]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-400 text-sm px-4">
        {error}
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading guide…
      </div>
    );
  }

  const activeSection = PHASE_SECTION_NUMBERS[currentPhase];

  return (
    <div ref={containerRef} className="h-full overflow-y-auto bg-zinc-950 p-4">
      <div className="prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:my-3 prose-ul:my-1 prose-li:my-0 prose-table:my-2">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h2({ children }) {
              const text = String(children);
              const slugMatch = text.match(/^(\d+)\.\s+(.+)/);
              const sectionNum = slugMatch?.[1];
              const slug = text
                .toLowerCase()
                .replace(/[^\w\s-]/g, "")
                .replace(/\s+/g, "-")
                .trim();
              const isActive = sectionNum === activeSection;

              return (
                <h2
                  data-phase-id={slug}
                  className={cn(
                    "scroll-mt-4 rounded-md px-2 py-1 -mx-2 transition-colors",
                    isActive && "bg-amber-600/15 ring-1 ring-amber-600/40"
                  )}
                >
                  {children}
                  {isActive && (
                    <span className="ml-2 text-xs font-normal text-amber-400">
                      ← current phase
                    </span>
                  )}
                </h2>
              );
            },
            blockquote({ children }) {
              return (
                <blockquote className="border-l-2 border-amber-600/50 bg-amber-950/20 pl-3 py-1 my-2 text-amber-200/80 not-italic">
                  {children}
                </blockquote>
              );
            },
            code({ className, children, ...props }) {
              return (
                <code
                  className={cn(
                    "bg-zinc-800 px-1 py-0.5 rounded text-emerald-400 text-xs",
                    className
                  )}
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
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
