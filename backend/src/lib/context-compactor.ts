import { encode } from "gpt-tokenizer";
import type { AiTextMessage } from "./ai-runtime";
import { extractFacts, extractHypotheses } from "./nlp-extract";

/**
 * Best-effort retained state extracted during history compaction.
 * Structured fields (phase, commands, scores) use regex; natural-language
 * fields (facts, hypotheses) use compromise NLP for sentence-level analysis.
 */
export interface RetainedState {
  phase: string;
  knownFacts: string[];
  hypotheses: string[];
  /** Commands suggested by the DM or referenced by the user (may include unexecuted suggestions). */
  mentionedCommands: string[];
  unresolvedQuestions: string[];
  summaryOfDiscussion: string;
}

function envInt(key: string, fallback: number, min: number = 1): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) {
    console.warn(`[context-compactor] ${key}=${parsed} is below minimum ${min}, using ${min}`);
    return min;
  }
  return parsed;
}

const COMPACTION_TOKEN_BUDGET = envInt("COMPACTION_TOKEN_BUDGET", 12_000, 1000);

const RETAINED_TAIL_MESSAGES = envInt("COMPACTION_TAIL_MESSAGES", 4, 1);

/** BPE token count using o200k_base (GPT-4o / GPT-5 tokenizer). */
export function estimateTokens(text: string): number {
  return encode(text).length;
}

// ts-unused-exports:disable-next-line
export function estimateMessagesTokens(messages: AiTextMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

const CMD_PATTERN = /```(?:oc|kql|geneva)\n([\s\S]*?)```/g;

function extractCommandsFromContent(content: string, cmdSet: Set<string>): void {
  let cmdMatch;
  while ((cmdMatch = CMD_PATTERN.exec(content)) !== null) {
    const cmd = cmdMatch[1].trim();
    if (cmd) {
      cmdSet.delete(cmd);
      cmdSet.add(cmd);
    }
  }
  CMD_PATTERN.lastIndex = 0;
}

/**
 * Hybrid extraction: regex for structured markers (phase, commands, scores,
 * questions); NLP (compromise) for natural-language facts and hypotheses.
 * Uses Set-based dedup internally, keeps newest items when caps are exceeded.
 */
function extractRetainedState(messages: AiTextMessage[]): RetainedState {
  let phase = "reading";
  const factsSet = new Set<string>();
  const factsList: string[] = [];
  const hypothesesSet = new Set<string>();
  const hypothesesList: string[] = [];
  const commandsSet = new Set<string>();
  const questionsSet = new Set<string>();
  const questionsList: string[] = [];
  const summaryParts: string[] = [];

  for (const msg of messages) {
    const content = msg.content;

    const phaseMatch = content.match(/\[PHASE:(\w+)\]/);
    if (phaseMatch) phase = phaseMatch[1];

    extractCommandsFromContent(content, commandsSet);

    if (msg.role === "user") {
      for (const h of extractHypotheses(content)) {
        if (!hypothesesSet.has(h)) {
          hypothesesSet.add(h);
          hypothesesList.push(h);
        }
      }

      if (content.match(/\?$/m)) {
        const questions = content.split("\n").filter(l => l.trim().endsWith("?"));
        for (const q of questions) {
          const trimmed = q.trim().slice(0, 150);
          if (trimmed && !questionsSet.has(trimmed)) {
            questionsSet.add(trimmed);
            questionsList.push(trimmed);
          }
        }
      }
    }

    if (msg.role === "assistant") {
      for (const f of extractFacts(content)) {
        if (!factsSet.has(f)) {
          factsSet.add(f);
          factsList.push(f);
        }
      }

      const scorePattern = /\[SCORE:(\w+):([+-]\d+):([^\]]+)\]/g;
      let scoreMatch;
      while ((scoreMatch = scorePattern.exec(content)) !== null) {
        summaryParts.push(`Score ${scoreMatch[1]}: ${scoreMatch[2]} (${scoreMatch[3]})`);
      }
    }
  }

  const resolvedQuestions = new Set<string>();
  for (const fact of factsList) {
    for (const q of questionsList) {
      const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matchCount = qWords.filter(w => fact.toLowerCase().includes(w)).length;
      if (matchCount >= 2) resolvedQuestions.add(q);
    }
  }

  return {
    phase,
    knownFacts: keepNewest(factsList, 15),
    hypotheses: keepNewest(hypothesesList, 5),
    mentionedCommands: keepNewest([...commandsSet], 20),
    unresolvedQuestions: keepNewest(questionsList.filter(q => !resolvedQuestions.has(q)), 10),
    summaryOfDiscussion: summaryParts.join("; "),
  };
}

/** Keep the N most recent items (items added later are at higher indices). */
function keepNewest(items: string[], max: number): string[] {
  if (items.length <= max) return items;
  return items.slice(items.length - max);
}

function buildCompactionMessage(state: RetainedState, compactedCount: number): string {
  const sections: string[] = [
    `[Context compacted: ${compactedCount} earlier messages summarized below]`,
    "",
    `**Current investigation phase:** ${state.phase}`,
  ];

  if (state.knownFacts.length > 0) {
    sections.push("", "**Known facts:**");
    for (const f of state.knownFacts) {
      sections.push(`- ${f}`);
    }
  }

  if (state.hypotheses.length > 0) {
    sections.push("", "**User hypotheses:**");
    for (const h of state.hypotheses) {
      sections.push(`- ${h}`);
    }
  }

  if (state.mentionedCommands.length > 0) {
    sections.push("", "**Commands suggested or run:**");
    for (const c of state.mentionedCommands) {
      const normalized = c.replace(/\s+/g, " ").trim();
      sections.push("- `" + normalized + "`");
    }
  }

  if (state.unresolvedQuestions.length > 0) {
    sections.push("", "**Open questions:**");
    for (const q of state.unresolvedQuestions) {
      sections.push(`- ${q}`);
    }
  }

  if (state.summaryOfDiscussion) {
    sections.push("", `**Scoring history:** ${state.summaryOfDiscussion}`);
  }

  return sections.join("\n");
}

export interface CompactionResult {
  messages: AiTextMessage[];
  compacted: boolean;
  originalCount: number;
  compactedCount: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  retainedState: RetainedState | null;
}

/**
 * Compact chat history when estimated token count exceeds budget.
 * Older messages are replaced with a structured summary that preserves
 * investigation phase, known facts, hypotheses, executed commands, and
 * open questions. Recent messages (tail) are kept verbatim.
 */
export function compactHistory(
  messages: AiTextMessage[],
  systemPromptTokens: number = 0,
  budget: number = COMPACTION_TOKEN_BUDGET
): CompactionResult {
  const originalCount = messages.length;
  const estimatedTokensBefore = estimateMessagesTokens(messages);
  const effectiveBudget = Math.max(budget - systemPromptTokens, 2000);

  if (estimatedTokensBefore <= effectiveBudget || messages.length <= RETAINED_TAIL_MESSAGES) {
    return {
      messages,
      compacted: false,
      originalCount,
      compactedCount: 0,
      estimatedTokensBefore,
      estimatedTokensAfter: estimatedTokensBefore,
      retainedState: null,
    };
  }

  const tailStart = Math.max(0, messages.length - RETAINED_TAIL_MESSAGES);
  const headMessages = messages.slice(0, tailStart);
  const tailMessages = messages.slice(tailStart);

  const retainedState = extractRetainedState(headMessages);
  const compactionMsg = buildCompactionMessage(retainedState, headMessages.length);

  const compactedMessages: AiTextMessage[] = [
    { role: "user", content: compactionMsg },
    { role: "assistant", content: "Understood. I have the full investigation context from the compacted history above. Let's continue from where we left off." },
    ...tailMessages,
  ];

  const estimatedTokensAfter = estimateMessagesTokens(compactedMessages);

  return {
    messages: compactedMessages,
    compacted: true,
    originalCount,
    compactedCount: headMessages.length,
    estimatedTokensBefore,
    estimatedTokensAfter,
    retainedState,
  };
}
