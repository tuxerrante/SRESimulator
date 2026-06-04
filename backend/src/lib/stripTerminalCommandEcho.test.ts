import { describe, expect, it } from "vitest";
import { stripTerminalCommandEcho } from "../../../shared/stripTerminalCommandEcho";

describe("stripTerminalCommandEcho", () => {
  const cmd = "oc describe machinehealthcheck -n openshift-machine-api worker-healthcheck";

  it("removes a leading $ line matching the command", () => {
    const raw = `$ ${cmd}\nName:\tworker-healthcheck\n`;
    expect(stripTerminalCommandEcho(raw, cmd)).toBe("Name:\tworker-healthcheck\n");
  });

  it("removes [oc] and $ command lines (issue #88 style)", () => {
    const raw = `[oc]\n$ ${cmd}\nName:\tworker-healthcheck\n`;
    expect(stripTerminalCommandEcho(raw, cmd)).toBe("Name:\tworker-healthcheck\n");
  });

  it("removes a bare repeated command line", () => {
    const raw = `${cmd}\nName:\tworker-healthcheck\n`;
    expect(stripTerminalCommandEcho(raw, cmd)).toBe("Name:\tworker-healthcheck\n");
  });

  it("normalizes whitespace when matching echoed command", () => {
    const spaced = "oc  describe   node   master-0";
    const raw = `$ ${spaced}\nName:\tmaster-0\n`;
    expect(stripTerminalCommandEcho(raw, "oc describe node master-0")).toBe("Name:\tmaster-0\n");
  });

  it("does not strip output that merely starts with similar text", () => {
    const body = "oc describe is not a command here\nmore\n";
    expect(stripTerminalCommandEcho(body, "oc get pods")).toBe(body);
  });

  it("preserves a leading blank line when no echo was stripped", () => {
    const body = "\n\nName: x\n";
    expect(stripTerminalCommandEcho(body, "oc get x")).toBe(body);
  });

  it("returns empty string when output was only echoes", () => {
    expect(stripTerminalCommandEcho(`[kql]\n$ ClusterLogs | take 1`, "ClusterLogs | take 1")).toBe(
      "",
    );
  });
});
