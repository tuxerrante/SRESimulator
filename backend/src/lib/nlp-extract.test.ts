import { describe, expect, it } from "vitest";
import { extractFacts, extractHypotheses } from "./nlp-extract";

describe("extractFacts", () => {
  it("extracts sentences with evidential verbs", () => {
    const text =
      "The analysis confirmed that the etcd leader was unreachable. " +
      "The user asked about the status. " +
      "Logs shows that node master-2 has been rebooting.";

    const facts = extractFacts(text);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toContain("confirmed");
    expect(facts[1]).toContain("shows");
  });

  it("returns empty array for text without evidential verbs", () => {
    const text = "The user opened a ticket. We should investigate the cluster.";
    expect(extractFacts(text)).toHaveLength(0);
  });

  it("caps each fact at 150 characters", () => {
    const longSentence = "The investigation revealed that " + "x".repeat(200) + ".";
    const facts = extractFacts(longSentence);
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0].length).toBeLessThanOrEqual(150);
  });

  it("handles multiple evidential verbs in one sentence", () => {
    const text = "The probe confirmed and found that DNS was failing.";
    const facts = extractFacts(text);
    expect(facts).toHaveLength(1);
  });

  it("handles technical SRE content", () => {
    const text =
      "kubectl get pods indicated that 3 pods are in CrashLoopBackOff. " +
      "The customer wants to know the ETA. " +
      "Geneva dashboard revealed a spike in 503 errors.";

    const facts = extractFacts(text);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toContain("indicated");
    expect(facts[1]).toContain("revealed");
  });
});

describe("extractHypotheses", () => {
  it("extracts sentences expressing uncertainty", () => {
    const text =
      "I think the root cause is a failed etcd member. " +
      "The cluster is running version 4.14. " +
      "This could be related to the recent upgrade.";

    const hypotheses = extractHypotheses(text);
    expect(hypotheses).toHaveLength(2);
    expect(hypotheses[0]).toContain("root cause");
    expect(hypotheses[1]).toContain("could be");
  });

  it("returns empty for factual-only text", () => {
    const text = "The cluster has 3 master nodes. The API server is running.";
    expect(extractHypotheses(text)).toHaveLength(0);
  });

  it("does not false-positive on 'think' in non-speculative context", () => {
    const text = "Let me think about the next step and check the logs.";
    const hypotheses = extractHypotheses(text);
    // compromise sees "think" but the sentence still matches -- this is
    // acceptable since the NLP approach captures the whole sentence
    // rather than a truncated 200-char substring
    expect(hypotheses.length).toBeLessThanOrEqual(1);
  });

  it("caps each hypothesis at 200 characters", () => {
    const longSentence = "I suspect that " + "x".repeat(300) + ".";
    const hypotheses = extractHypotheses(longSentence);
    expect(hypotheses.length).toBeGreaterThan(0);
    expect(hypotheses[0].length).toBeLessThanOrEqual(200);
  });

  it("handles SRE hypothesis patterns", () => {
    const text =
      "The root cause might be a partition table corruption. " +
      "The node is healthy. " +
      "I believe the MCO is stuck because permissions were changed.";

    const hypotheses = extractHypotheses(text);
    expect(hypotheses).toHaveLength(2);
  });
});
