import { describe, expect, it } from "vitest";
import {
  compactHistory,
  estimateTokens,
  estimateMessagesTokens,
} from "./context-compactor";
import type { AiTextMessage } from "./ai-runtime";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns positive count for non-empty strings", () => {
    expect(estimateTokens("hello")).toBeGreaterThan(0);
    expect(estimateTokens("a")).toBeGreaterThan(0);
  });

  it("longer text produces more tokens (monotonicity)", () => {
    const short = estimateTokens("hello");
    const long = estimateTokens("hello world, this is a much longer sentence");
    expect(long).toBeGreaterThan(short);
  });

  it("repeated characters produce fewer tokens than length (BPE compression)", () => {
    const repeated = estimateTokens("a".repeat(100));
    expect(repeated).toBeGreaterThan(0);
    expect(repeated).toBeLessThan(100);
  });

  it("counts natural language prose within reasonable bounds", () => {
    const sentence = "The etcd leader election failed and the cluster lost quorum.";
    const tokens = estimateTokens(sentence);
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(sentence.length);
  });
});

describe("estimateMessagesTokens", () => {
  it("includes per-message overhead beyond raw content tokens", () => {
    const messages: AiTextMessage[] = [
      { role: "user", content: "hello" },
    ];
    const contentOnly = estimateTokens("hello");
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(contentOnly);
  });

  it("grows with more messages", () => {
    const one: AiTextMessage[] = [
      { role: "user", content: "hello" },
    ];
    const two: AiTextMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hello" },
    ];
    expect(estimateMessagesTokens(two)).toBeGreaterThan(estimateMessagesTokens(one));
  });
});

function makeMessages(count: number, contentLength: number = 200): AiTextMessage[] {
  const msgs: AiTextMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: ${"x".repeat(contentLength)}`,
    });
  }
  return msgs;
}

describe("compactHistory", () => {
  it("returns messages unchanged when under budget", () => {
    const messages = makeMessages(4, 50);
    const result = compactHistory(messages, 0, 50000);

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.retainedState).toBeNull();
  });

  it("compacts with 5+ messages when over budget (default tail=4)", () => {
    const messages = makeMessages(5, 5000);
    const result = compactHistory(messages, 0, 100);

    expect(result.compacted).toBe(true);
    expect(result.compactedCount).toBeGreaterThan(0);
  });

  it("skips compaction with <= RETAINED_TAIL_MESSAGES even if over budget", () => {
    const messages = makeMessages(4, 5000);
    const result = compactHistory(messages, 0, 100);

    expect(result.compacted).toBe(false);
  });

  it("compacts when over budget with enough messages", () => {
    const messages = makeMessages(20, 2000);
    const result = compactHistory(messages, 0, 3000);

    expect(result.compacted).toBe(true);
    expect(result.originalCount).toBe(20);
    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(20);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
    expect(result.retainedState).not.toBeNull();
  });

  it("preserves tail messages verbatim", () => {
    const messages = makeMessages(20, 2000);
    const lastMessage = messages[messages.length - 1];
    const result = compactHistory(messages, 0, 3000);

    expect(result.compacted).toBe(true);
    const resultLast = result.messages[result.messages.length - 1];
    expect(resultLast.content).toBe(lastMessage.content);
  });

  it("starts compacted messages with summary then tail", () => {
    const messages = makeMessages(20, 2000);
    const result = compactHistory(messages, 0, 3000);

    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("[Context compacted:");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toContain("investigation context");
  });

  it("accounts for system prompt tokens in budget", () => {
    const messages = makeMessages(20, 2000);
    const withoutSystem = compactHistory(messages, 0, 5000);
    const withSystem = compactHistory(messages, 4000, 5000);

    if (withoutSystem.compacted && withSystem.compacted) {
      expect(withSystem.compactedCount).toBeGreaterThanOrEqual(withoutSystem.compactedCount);
    }
  });

  it("extracts phase from assistant messages", () => {
    const messages: AiTextMessage[] = [
      { role: "user", content: "I read the ticket." },
      { role: "assistant", content: "Good. [PHASE:context]" },
      ...makeMessages(18, 2000),
    ];
    const result = compactHistory(messages, 0, 3000);

    expect(result.retainedState?.phase).toBe("context");
  });

  it("extracts commands from code blocks", () => {
    const messages: AiTextMessage[] = [
      { role: "assistant", content: "Try running:\n```oc\noc get nodes\n```\n[PHASE:facts]" },
      ...makeMessages(18, 2000),
    ];
    const result = compactHistory(messages, 0, 3000);

    expect(result.retainedState?.mentionedCommands).toContain("oc get nodes");
  });

  it("extracts hypotheses from user messages", () => {
    const messages: AiTextMessage[] = [
      { role: "user", content: "I think the root cause is a failed etcd member." },
      ...makeMessages(19, 2000),
    ];
    const result = compactHistory(messages, 0, 3000);

    expect(result.retainedState?.hypotheses.length).toBeGreaterThan(0);
    expect(result.retainedState!.hypotheses[0]).toContain("root cause");
  });

  it("keeps newest items when caps are exceeded", () => {
    const messages: AiTextMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({
        role: "assistant",
        content: `The analysis confirmed that issue-${i} is the root cause of the failure in component-${i}. ${"detail ".repeat(300)}`,
      });
    }
    messages.push(...makeMessages(5, 2000));
    const result = compactHistory(messages, 0, 3000);

    expect(result.compacted).toBe(true);
    const facts = result.retainedState!.knownFacts;
    expect(facts.length).toBeLessThanOrEqual(15);
    const lastFact = facts[facts.length - 1];
    expect(lastFact).toBeDefined();
  });

  it("extracts NLP-based facts from assistant prose", () => {
    const messages: AiTextMessage[] = [
      {
        role: "assistant",
        content:
          "The investigation confirmed that the etcd leader was unreachable. " +
          "Geneva dashboard revealed a spike in 503 errors across the region. " +
          "The cluster is running version 4.14.",
      },
      ...makeMessages(19, 2000),
    ];
    const result = compactHistory(messages, 0, 3000);

    expect(result.retainedState).not.toBeNull();
    const facts = result.retainedState!.knownFacts;
    expect(facts.length).toBe(2);
    expect(facts.some(f => f.includes("etcd leader"))).toBe(true);
    expect(facts.some(f => f.includes("503 errors"))).toBe(true);
  });

  it("extracts NLP-based hypotheses from user messages", () => {
    const messages: AiTextMessage[] = [
      {
        role: "user",
        content:
          "I suspect that the MCO is stuck because of permission changes. " +
          "The node count looks correct. " +
          "This might be related to the recent certificate rotation.",
      },
      ...makeMessages(19, 2000),
    ];
    const result = compactHistory(messages, 0, 3000);

    expect(result.retainedState).not.toBeNull();
    const hypotheses = result.retainedState!.hypotheses;
    expect(hypotheses.length).toBe(2);
    expect(hypotheses.some(h => h.includes("MCO"))).toBe(true);
    expect(hypotheses.some(h => h.includes("certificate"))).toBe(true);
  });

  it("combines regex and NLP extraction in a realistic conversation", () => {
    const messages: AiTextMessage[] = [
      { role: "user", content: "The ticket says master-2 is missing." },
      {
        role: "assistant",
        content:
          "Let me help you investigate. [PHASE:context]\n" +
          "```oc\noc get nodes\n```\n" +
          "The output shows that master-2 is in NotReady state.",
      },
      {
        role: "user",
        content: "I think the node was accidentally deleted. What happened to it?",
      },
      {
        role: "assistant",
        content:
          "Good hypothesis. Let me check.\n" +
          "```kql\nClusterAuditLogs | where objectRef_resource == 'nodes'\n```\n" +
          "The audit log confirmed that a delete operation was performed by user admin. " +
          "[SCORE:safety:+10:checked audit logs before acting]",
      },
      ...makeMessages(16, 2000),
    ];
    const result = compactHistory(messages, 0, 3000);

    expect(result.compacted).toBe(true);
    const state = result.retainedState!;
    expect(state.phase).toBe("context");
    expect(state.mentionedCommands).toContain("oc get nodes");
    expect(state.mentionedCommands).toContain(
      "ClusterAuditLogs | where objectRef_resource == 'nodes'",
    );
    expect(state.hypotheses.some(h => h.includes("deleted"))).toBe(true);
    expect(state.knownFacts.some(f => f.includes("delete operation"))).toBe(true);
    expect(state.summaryOfDiscussion).toContain("Score safety: +10");
  });
});
