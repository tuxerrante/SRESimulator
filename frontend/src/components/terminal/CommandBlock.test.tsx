import { render, screen } from "@testing-library/react";
import { expect, it, describe } from "vitest";
import { CommandBlock } from "./CommandBlock";
import type { TerminalEntry } from "@shared/types/terminal";

describe("CommandBlock", () => {
  it("renders a standard command output with exact whitespace", () => {
    const entry: TerminalEntry = {
      id: "1",
      command: "oc get nodes",
      output: "master-0   Ready",
      timestamp: Date.now(),
      exitCode: 0,
      type: "oc",
    };
    const { container } = render(<CommandBlock entry={entry} />);

    const preElement = container.querySelector("pre");
    expect(preElement).toBeDefined();

    // Assert exact text content without normalized whitespace
    expect(preElement?.textContent).toBe("master-0   Ready");

    // Assert the presence of the class that preserves whitespace
    expect(preElement?.className).toContain("whitespace-pre-wrap");
  });

  it("renders an exit code and error output for a failing or degraded KQL query", () => {
    const entry: TerminalEntry = {
      id: "2",
      command: "ClusterLogs | take 10",
      output: "// mock query received\nError: timeout",
      timestamp: Date.now(),
      exitCode: 1,
      type: "kql",
    };
    const { container } = render(<CommandBlock entry={entry} />);

    const preElement = container.querySelector("pre");
    expect(preElement).toBeDefined();

    // Test that the newline is preserved literally
    expect(preElement?.textContent).toBe("// mock query received\nError: timeout");
    expect(preElement?.className).toContain("whitespace-pre-wrap");

    expect(screen.getByText("exit code: 1")).toBeDefined();
  });
});
