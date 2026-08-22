import { render, screen } from "@testing-library/react";
import { expect, it, describe } from "vitest";
import { CommandBlock } from "./CommandBlock";
import type { TerminalEntry } from "@shared/types/terminal";

describe("CommandBlock", () => {
  it("renders a standard command output", () => {
    const entry: TerminalEntry = {
      id: "1",
      command: "oc get nodes",
      output: "master-0   Ready",
      timestamp: Date.now(),
      exitCode: 0,
      type: "oc",
    };
    render(<CommandBlock entry={entry} />);
    expect(screen.getByText("oc get nodes")).toBeDefined();
    expect(screen.getByText("master-0 Ready")).toBeDefined();
    expect(screen.queryByText(/exit code:/)).toBeNull();
  });

  it("renders an exit code and error output for a failing or degraded KQL query", () => {
    const entry: TerminalEntry = {
      id: "2",
      command: "ClusterLogs | take 10",
      output: "// mock query received\nError: Command simulation failed: timeout",
      timestamp: Date.now(),
      exitCode: 1,
      type: "kql",
    };
    render(<CommandBlock entry={entry} />);
    expect(screen.getByText("ClusterLogs | take 10")).toBeDefined();
    expect(screen.getByText(/Error: Command simulation failed: timeout/)).toBeDefined();
    expect(screen.getByText("exit code: 1")).toBeDefined();
  });
});
