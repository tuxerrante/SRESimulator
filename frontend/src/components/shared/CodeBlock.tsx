"use client";

import { Play, Copy, Check } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language: string;
  onRun?: (command: string, type: "oc" | "kql" | "geneva") => void;
}

const LANGUAGE_LABELS: Record<string, string> = {
  oc: "OpenShift CLI",
  kql: "KQL Query",
  geneva: "Geneva",
  bash: "Bash",
};

export function CodeBlock({ code, language, onRun }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const isRunnable = ["oc", "kql", "geneva"].includes(language);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRun = () => {
    if (onRun && isRunnable) {
      onRun(code, language as "oc" | "kql" | "geneva");
    }
  };

  return (
    <div className="my-2 rounded-lg border border-zinc-700 bg-zinc-900 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800 border-b border-zinc-700">
        <span className="text-xs text-zinc-400 font-mono">
          {LANGUAGE_LABELS[language] || language}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            title="Copy"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {isRunnable && (
            <button
              onClick={handleRun}
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors",
                "bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 hover:text-emerald-300"
              )}
              title="Run command"
            >
              <Play size={12} />
              Run
            </button>
          )}
        </div>
      </div>
      <pre className="p-3 overflow-x-auto text-sm">
        <code className="text-emerald-400 font-mono whitespace-pre-wrap">
          {code}
        </code>
      </pre>
    </div>
  );
}
