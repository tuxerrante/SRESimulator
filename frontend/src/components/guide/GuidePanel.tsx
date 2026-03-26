"use client";

import { useEffect, useState, useRef, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useGameStore } from "@/stores/gameStore";
import { cn } from "@/lib/utils";
import {
  Loader2,
  BookOpen,
  FileText,
  Compass,
  Search,
  Lightbulb,
  Shield,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Target,
} from "lucide-react";
import type { InvestigationPhase } from "@shared/types/chat";

/* ── Phase metadata ──────────────────────────────────────────── */

const PHASE_META: Record<
  string,
  { icon: typeof FileText; color: string; bg: string; ring: string; label: string }
> = {
  "1": { icon: FileText, color: "text-blue-400", bg: "bg-blue-500/10", ring: "ring-blue-500/25", label: "Reading" },
  "2": { icon: Compass, color: "text-purple-400", bg: "bg-purple-500/10", ring: "ring-purple-500/25", label: "Context Gathering" },
  "3": { icon: Search, color: "text-emerald-400", bg: "bg-emerald-500/10", ring: "ring-emerald-500/25", label: "Facts Gathering" },
  "4": { icon: Lightbulb, color: "text-amber-400", bg: "bg-amber-500/10", ring: "ring-amber-500/25", label: "Theory Building" },
  "5": { icon: Shield, color: "text-red-400", bg: "bg-red-500/10", ring: "ring-red-500/25", label: "Action" },
};

const PHASE_NUM: Record<InvestigationPhase, string> = {
  reading: "1",
  context: "2",
  facts: "3",
  theory: "4",
  action: "5",
};

/* ── Markdown section parser ─────────────────────────────────── */

interface GuideSection {
  kind: "intro" | "phases" | "phase" | "quickref";
  heading: string;
  body: string;
  num?: string;
}

function parseSections(md: string): GuideSection[] {
  const out: GuideSection[] = [];
  const parts = md.split(/^## /m);

  const intro = parts[0].replace(/^#\s+.+\n+/, "").replace(/^---\s*$/gm, "").trim();
  if (intro) out.push({ kind: "intro", heading: "", body: intro });

  for (let i = 1; i < parts.length; i++) {
    const [first, ...rest] = parts[i].split("\n");
    const heading = first.trim();
    const body = rest
      .join("\n")
      .replace(/^---\s*$/gm, "")
      .replace(/\*\[SRE Simulator\][\s\S]*$/, "")
      .trim();

    if (/five phases/i.test(heading)) {
      out.push({ kind: "phases", heading, body });
    } else if (/quick reference/i.test(heading)) {
      out.push({ kind: "quickref", heading, body });
    } else {
      const m = heading.match(/^(\d+)\./);
      if (m) out.push({ kind: "phase", heading, body, num: m[1] });
    }
  }
  return out;
}

/* ── Helpers ─────────────────────────────────────────────────── */

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node)
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/* ── Shared markdown component overrides ─────────────────────── */

const mdComponents = {
  h1: () => null,
  h2: () => null,
  hr: () => null,
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,

  blockquote({ children }: { children?: ReactNode }) {
    return (
      <div className="flex gap-2.5 items-start rounded-lg border border-amber-500/20 bg-amber-950/25 px-3 py-2.5 my-3">
        <Target size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
        <div className="text-xs text-amber-200/90 leading-relaxed [&_p]:my-0">
          {children}
        </div>
      </div>
    );
  },

  strong({ children }: { children?: ReactNode }) {
    const t = textOf(children);
    if (t === "Do:") {
      return (
        <strong className="inline-flex items-center gap-1.5 text-emerald-400 font-semibold">
          <CheckCircle2 size={11} className="flex-shrink-0" />
          {children}
        </strong>
      );
    }
    if (t === "Watch out for:") {
      return (
        <strong className="inline-flex items-center gap-1.5 text-amber-400 font-semibold">
          <AlertTriangle size={11} className="flex-shrink-0" />
          {children}
        </strong>
      );
    }
    return <strong className="text-zinc-200">{children}</strong>;
  },

  code({ className, children, ...props }: { className?: string; children?: ReactNode }) {
    return (
      <code
        className={cn(
          "bg-zinc-800 px-1 py-0.5 rounded text-emerald-400 text-xs font-mono",
          className,
        )}
        {...props}
      >
        {children}
      </code>
    );
  },

  p({ children }: { children?: ReactNode }) {
    return <p className="text-xs text-zinc-400 leading-relaxed my-1.5">{children}</p>;
  },

  ul({ children }: { children?: ReactNode }) {
    return <ul className="space-y-1 my-2 ml-3 list-disc">{children}</ul>;
  },

  ol({ children }: { children?: ReactNode }) {
    return <ol className="space-y-1.5 my-2 ml-4 list-decimal">{children}</ol>;
  },

  li({ children }: { children?: ReactNode }) {
    return <li className="text-xs text-zinc-300 leading-relaxed">{children}</li>;
  },

  em({ children }: { children?: ReactNode }) {
    return <em className="text-zinc-500 italic">{children}</em>;
  },

  a({ href, children }: { href?: string; children?: ReactNode }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-purple-400 hover:text-purple-300 underline underline-offset-2"
      >
        {children}
      </a>
    );
  },

  table({ children }: { children?: ReactNode }) {
    return (
      <div className="rounded-lg border border-zinc-800 my-3 overflow-x-auto">
        <table className="w-full text-xs">{children}</table>
      </div>
    );
  },

  thead({ children }: { children?: ReactNode }) {
    return <thead className="bg-zinc-800/50">{children}</thead>;
  },

  th({ children }: { children?: ReactNode }) {
    return (
      <th className="px-3 py-2 text-left text-zinc-500 font-medium text-[10px] uppercase tracking-wider border-b border-zinc-800">
        {children}
      </th>
    );
  },

  td({ children }: { children?: ReactNode }) {
    return (
      <td className="px-3 py-2 text-zinc-300 border-t border-zinc-800/50">
        {children}
      </td>
    );
  },

  tr({ children }: { children?: ReactNode }) {
    return (
      <tr className="hover:bg-zinc-800/20 transition-colors">{children}</tr>
    );
  },
};

/* ── Main component ──────────────────────────────────────────── */

export function GuidePanel() {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentPhase = useGameStore((s) => s.currentPhase);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timedOut = false;
    let unmounted = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);

    fetch("/api/guide", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load guide");
        return r.json();
      })
      .then((d) => {
        if (!d.content) throw new Error("Guide content is empty");
        if (!unmounted) setContent(d.content);
      })
      .catch((e) => {
        if (unmounted) return;
        if (timedOut) {
          setError("Guide request timed out — is the backend running?");
        } else if (!controller.signal.aborted) {
          setError(e.message);
        }
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      unmounted = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, []);

  const sections = useMemo(
    () => (content ? parseSections(content) : []),
    [content],
  );

  const activeNum = PHASE_NUM[currentPhase];

  useEffect(() => {
    if (!sections.length || !containerRef.current) return;
    const el = containerRef.current.querySelector(
      `[data-phase="${activeNum}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [currentPhase, sections, activeNum]);

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
        Loading guide&hellip;
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-700 bg-zinc-900 flex-shrink-0">
        <BookOpen size={14} className="text-purple-400" />
        <h2 className="text-sm font-semibold text-zinc-200">
          SRE Investigation Guide
        </h2>
      </div>

      <div ref={containerRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {sections.map((s) => {
          const key = s.num ? `${s.kind}-${s.num}` : s.kind;
          switch (s.kind) {
            case "intro":
              return (
                <div key={key} className="px-1">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={mdComponents}
                  >
                    {s.body}
                  </ReactMarkdown>
                </div>
              );

            case "phases": {
              const textBeforeTable = s.body.split(/\n\|/)[0].trim();
              return (
                <div key={key} className="space-y-3">
                  {textBeforeTable && (
                    <div className="px-1">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={mdComponents}
                      >
                        {textBeforeTable}
                      </ReactMarkdown>
                    </div>
                  )}
                  <PhasesOverview activeNum={activeNum} />
                </div>
              );
            }

            case "phase": {
              const meta = PHASE_META[s.num!];
              if (!meta) return null;
              const isActive = s.num === activeNum;
              const done = parseInt(s.num!) < parseInt(activeNum);
              const Icon = meta.icon;

              return (
                <section
                  key={key}
                  data-phase={s.num}
                  className={cn(
                    "rounded-lg border transition-all scroll-mt-4 overflow-hidden",
                    isActive &&
                      `${meta.bg} ring-1 ${meta.ring} border-transparent`,
                    done && "border-zinc-800/60 bg-zinc-900/40 opacity-75",
                    !isActive && !done && "border-zinc-800 bg-zinc-900/50",
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center gap-2.5 px-3 py-2 border-b",
                      isActive ? "border-white/5" : "border-zinc-800/60",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold shrink-0",
                        isActive &&
                          `${meta.bg} ${meta.color} ring-1 ${meta.ring}`,
                        done && "bg-emerald-500/10 text-emerald-500",
                        !isActive && !done && "bg-zinc-800 text-zinc-500",
                      )}
                    >
                      {done ? <CheckCircle2 size={12} /> : s.num}
                    </span>
                    <Icon
                      size={14}
                      className={cn(
                        isActive && meta.color,
                        done && "text-emerald-500/70",
                        !isActive && !done && "text-zinc-600",
                      )}
                    />
                    <span
                      className={cn(
                        "text-sm font-semibold",
                        isActive && "text-zinc-100",
                        done && "text-zinc-500",
                        !isActive && !done && "text-zinc-300",
                      )}
                    >
                      {s.heading.replace(/^\d+\.\s+/, "")}
                    </span>
                    {isActive && (
                      <span className="ml-auto text-[10px] font-semibold tracking-wide text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">
                        CURRENT
                      </span>
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={mdComponents}
                    >
                      {s.body}
                    </ReactMarkdown>
                  </div>
                </section>
              );
            }

            case "quickref":
              return (
                <section
                  key={key}
                  className="rounded-lg border border-amber-500/15 bg-amber-950/10 overflow-hidden"
                >
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-500/10 bg-amber-900/10">
                    <Zap size={14} className="text-amber-400" />
                    <span className="text-xs font-semibold text-amber-300 uppercase tracking-wide">
                      The SRE Mantra
                    </span>
                  </div>
                  <div className="px-3 py-2.5">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={mdComponents}
                    >
                      {s.body}
                    </ReactMarkdown>
                  </div>
                </section>
              );

            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

/* ── Phases overview sub-component ───────────────────────────── */

function PhasesOverview({ activeNum }: { activeNum: string }) {
  const activeIdx = parseInt(activeNum);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-800/30">
        <Target size={12} className="text-amber-400" />
        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
          Investigation Phases
        </span>
      </div>
      <div className="p-2 space-y-px">
        {Object.entries(PHASE_META).map(([num, meta]) => {
          const Icon = meta.icon;
          const idx = parseInt(num);
          const isActive = num === activeNum;
          const done = idx < activeIdx;

          return (
            <div
              key={num}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md transition-all",
                isActive && `${meta.bg} ring-1 ${meta.ring}`,
              )}
            >
              <span
                className={cn(
                  "inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold shrink-0",
                  isActive && meta.color,
                  done && "text-emerald-500",
                  !isActive && !done && "text-zinc-600",
                )}
              >
                {done ? <CheckCircle2 size={11} /> : num}
              </span>
              <Icon
                size={12}
                className={cn(
                  isActive && meta.color,
                  done && "text-emerald-500/60",
                  !isActive && !done && "text-zinc-700",
                )}
              />
              <span
                className={cn(
                  "text-xs font-medium flex-1",
                  isActive && meta.color,
                  done && "text-zinc-500",
                  !isActive && !done && "text-zinc-500",
                )}
              >
                {meta.label}
              </span>
              {isActive && (
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
