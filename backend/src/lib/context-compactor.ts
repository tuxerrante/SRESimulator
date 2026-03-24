import type { AiTextMessage } from "./ai-runtime";

/**
 * Best-effort retained state extracted via heuristics during history
 * compaction. The extraction uses regex patterns and truncation, so
 * it may miss or simplify some details from the original conversation.
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

const CHARS_PER_TOKEN_ESTIMATE = 4;

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const COMPACTION_TOKEN_BUDGET = envInt("COMPACTION_TOKEN_BUDGET", 12_000);

const RETAINED_TAIL_MESSAGES = envInt("COMPACTION_TAIL_MESSAGES", 4);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

// ts-unused-exports:disable-next-line
export function estimateMessagesTokens(messages: AiTextMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

function extractRetainedState(messages: AiTextMessage[]): RetainedState {
  const state: RetainedState = {
    phase: "reading",
    knownFacts: [],
    hypotheses: [],
    mentionedCommands: [],
    unresolvedQuestions: [],
    summaryOfDiscussion: "",
  };

  const summaryParts: string[] = [];

  for (const msg of messages) {
    const content = msg.content;

    const phaseMatch = content.match(/\[PHASE:(\w+)\]/);
    if (phaseMatch) state.phase = phaseMatch[1];

    if (msg.role === "user") {
      const cmdPattern = /```(?:oc|kql|geneva)\n([\s\S]*?)```/g;
      let cmdMatch;
      while ((cmdMatch = cmdPattern.exec(content)) !== null) {
        const cmd = cmdMatch[1].trim();
        if (cmd && !state.mentionedCommands.includes(cmd)) {
          state.mentionedCommands.push(cmd);
        }
      }

      if (content.match(/\b(?:think|hypothesis|theory|believe|suspect|seems like|root cause)\b/i)) {
        const line = content.slice(0, 200).replace(/\n/g, " ").trim();
        if (!state.hypotheses.includes(line)) state.hypotheses.push(line);
      }

      if (content.match(/\?$/m)) {
        const questions = content.split("\n").filter(l => l.trim().endsWith("?"));
        for (const q of questions) {
          const trimmed = q.trim().slice(0, 150);
          if (trimmed && !state.unresolvedQuestions.includes(trimmed)) {
            state.unresolvedQuestions.push(trimmed);
          }
        }
      }
    }

    if (msg.role === "assistant") {
      const cmdPattern = /```(?:oc|kql|geneva)\n([\s\S]*?)```/g;
      let cmdMatch;
      while ((cmdMatch = cmdPattern.exec(content)) !== null) {
        const cmd = cmdMatch[1].trim();
        if (cmd && !state.mentionedCommands.includes(cmd)) {
          state.mentionedCommands.push(cmd);
        }
      }

      const factPatterns = [
        /\*\*(?:What we know|Key findings?|Evidence|Confirmed|Observation)[:\s]*\*\*([\s\S]*?)(?=\n\n|\*\*|$)/gi,
        /(?:confirmed|found|shows|indicates|reveals)\s+(?:that\s+)?(.{20,150})/gi,
      ];
      for (const pattern of factPatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const fact = match[1].trim().slice(0, 150);
          if (fact && !state.knownFacts.includes(fact)) {
            state.knownFacts.push(fact);
          }
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
  for (const fact of state.knownFacts) {
    for (const q of state.unresolvedQuestions) {
      const qWords = q.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matchCount = qWords.filter(w => fact.toLowerCase().includes(w)).length;
      if (matchCount >= 2) resolvedQuestions.add(q);
    }
  }
  state.unresolvedQuestions = state.unresolvedQuestions.filter(q => !resolvedQuestions.has(q));

  state.summaryOfDiscussion = summaryParts.join("; ");

  return state;
}

function buildCompactionMessage(state: RetainedState, compactedCount: number): string {
  const sections: string[] = [
    `[Context compacted: ${compactedCount} earlier messages summarized below]`,
    "",
    `**Current investigation phase:** ${state.phase}`,
  ];

  if (state.knownFacts.length > 0) {
    sections.push("", "**Known facts:**");
    for (const f of state.knownFacts.slice(0, 15)) {
      sections.push(`- ${f}`);
    }
  }

  if (state.hypotheses.length > 0) {
    sections.push("", "**User hypotheses:**");
    for (const h of state.hypotheses.slice(0, 5)) {
      sections.push(`- ${h}`);
    }
  }

  if (state.mentionedCommands.length > 0) {
    sections.push("", "**Commands suggested or run:**");
    for (const c of state.mentionedCommands.slice(0, 20)) {
      sections.push("- `" + c + "`");
    }
  }

  if (state.unresolvedQuestions.length > 0) {
    sections.push("", "**Open questions:**");
    for (const q of state.unresolvedQuestions.slice(0, 5)) {
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
