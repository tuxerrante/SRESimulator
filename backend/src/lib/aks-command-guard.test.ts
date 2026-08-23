import { describe, expect, it } from "vitest";
import { enforceAksKubectl } from "./aks-command-guard";

describe("enforceAksKubectl", () => {
  it("rewrites an oc fence and leading oc token to kubectl", () => {
    const input = "Run this:\n```oc\noc get pods -n kube-system\n```\nLook for restarts.";
    const output = enforceAksKubectl(input);
    expect(output).toBe(
      "Run this:\n```kubectl\nkubectl get pods -n kube-system\n```\nLook for restarts.",
    );
  });

  it("rewrites the fence tag even when the body command is already kubectl", () => {
    const input = "```oc\nkubectl get nodes\n```";
    expect(enforceAksKubectl(input)).toBe("```kubectl\nkubectl get nodes\n```");
  });

  it("rewrites only the leading oc token, not later occurrences in the command", () => {
    const input = "```oc\noc get pods -l app=oc\n```";
    expect(enforceAksKubectl(input)).toBe("```kubectl\nkubectl get pods -l app=oc\n```");
  });

  it("rewrites the leading oc token on every line of a multi-command block", () => {
    const input = "```oc\noc get nodes\noc describe node worker-1\noc adm top nodes\n```";
    expect(enforceAksKubectl(input)).toBe(
      "```kubectl\nkubectl get nodes\nkubectl describe node worker-1\nkubectl adm top nodes\n```",
    );
  });

  it("handles multiple oc blocks", () => {
    const input = "```oc\noc get nodes\n```\n\n```oc\noc describe node worker-1\n```";
    expect(enforceAksKubectl(input)).toBe(
      "```kubectl\nkubectl get nodes\n```\n\n```kubectl\nkubectl describe node worker-1\n```",
    );
  });

  it("handles an oc fence at the very start of the text", () => {
    const input = "```oc\noc get ns\n```";
    expect(enforceAksKubectl(input)).toBe("```kubectl\nkubectl get ns\n```");
  });

  it("tolerates spaces in the fence info string and CRLF newlines", () => {
    const input = "``` oc \r\noc get pods\r\n```";
    expect(enforceAksKubectl(input)).toBe("```kubectl\r\nkubectl get pods\r\n```");
  });

  it("preserves indentation of an indented fence", () => {
    const input = "  ```oc\n  oc get pods\n  ```";
    expect(enforceAksKubectl(input)).toBe("  ```kubectl\n  kubectl get pods\n  ```");
  });

  it("leaves kql, geneva, and bash blocks untouched", () => {
    const input = [
      "```kql\nClusterLogs | where Level == 'Error'\n```",
      "```geneva\nsome geneva query\n```",
      "```bash\noc get pods\n```",
    ].join("\n\n");
    expect(enforceAksKubectl(input)).toBe(input);
  });

  it("does not corrupt the substring 'oc' inside prose or other words", () => {
    const input = "The process occurred on the node; check oc-adjacent docs.";
    expect(enforceAksKubectl(input)).toBe(input);
  });

  it("does not rewrite an oc command in prose outside a code fence", () => {
    const input = "You might think to run oc get pods, but AKS has no oc.";
    expect(enforceAksKubectl(input)).toBe(input);
  });

  it("does not match a fence whose language merely starts with oc (e.g. ocp)", () => {
    const input = "```ocp\noc get pods\n```";
    expect(enforceAksKubectl(input)).toBe(input);
  });

  it("returns text without oc fences unchanged", () => {
    const input = "Here is a kubectl command:\n```kubectl\nkubectl get nodes\n```";
    expect(enforceAksKubectl(input)).toBe(input);
  });
});
