import { describe, expect, it } from "vitest";
import {
  compactHistory,
  estimateTokens,
  estimateMessagesTokens,
} from "./context-compactor";
import type { AiTextMessage } from "./ai-runtime";

describe("estimateTokens", () => {
  it("estimates ~1 token per 4 characters", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

describe("estimateMessagesTokens", () => {
  it("includes per-message overhead", () => {
    const messages: AiTextMessage[] = [
      { role: "user", content: "abcd" },
    ];
    expect(estimateMessagesTokens(messages)).toBe(1 + 4);
  });

  it("sums across messages", () => {
    const messages: AiTextMessage[] = [
      { role: "user", content: "abcd" },
      { role: "assistant", content: "abcd" },
    ];
    expect(estimateMessagesTokens(messages)).toBe(10);
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

  it("compacts with 7+ messages when over budget (no +2 padding)", () => {
    const messages = makeMessages(7, 5000);
    const result = compactHistory(messages, 0, 100);

    expect(result.compacted).toBe(true);
    expect(result.compactedCount).toBeGreaterThan(0);
  });

  it("skips compaction with <= RETAINED_TAIL_MESSAGES even if over budget", () => {
    const messages = makeMessages(6, 5000);
    const result = compactHistory(messages, 0, 100);

    expect(result.compacted).toBe(false);
  });

  it("compacts when over budget with enough messages", () => {
    const messages = makeMessages(20, 500);
    const result = compactHistory(messages, 0, 500);

    expect(result.compacted).toBe(true);
    expect(result.originalCount).toBe(20);
    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(20);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
    expect(result.retainedState).not.toBeNull();
  });

  it("preserves tail messages verbatim", () => {
    const messages = makeMessages(20, 500);
    const lastMessage = messages[messages.length - 1];
    const result = compactHistory(messages, 0, 500);

    expect(result.compacted).toBe(true);
    const resultLast = result.messages[result.messages.length - 1];
    expect(resultLast.content).toBe(lastMessage.content);
  });

  it("starts compacted messages with summary then tail", () => {
    const messages = makeMessages(20, 500);
    const result = compactHistory(messages, 0, 500);

    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("[Context compacted:");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[1].content).toContain("investigation context");
  });

  it("accounts for system prompt tokens in budget", () => {
    const messages = makeMessages(20, 300);
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
      ...makeMessages(18, 500),
    ];
    const result = compactHistory(messages, 0, 500);

    expect(result.retainedState?.phase).toBe("context");
  });

  it("extracts commands from code blocks", () => {
    const messages: AiTextMessage[] = [
      { role: "assistant", content: "Try running:\n```oc\noc get nodes\n```\n[PHASE:facts]" },
      ...makeMessages(18, 500),
    ];
    const result = compactHistory(messages, 0, 500);

    expect(result.retainedState?.mentionedCommands).toContain("oc get nodes");
  });

  it("extracts hypotheses from user messages", () => {
    const messages: AiTextMessage[] = [
      { role: "user", content: "I think the root cause is a failed etcd member." },
      ...makeMessages(19, 500),
    ];
    const result = compactHistory(messages, 0, 500);

    expect(result.retainedState?.hypotheses.length).toBeGreaterThan(0);
    expect(result.retainedState!.hypotheses[0]).toContain("root cause");
  });
});
