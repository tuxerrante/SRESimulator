import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatMessage } from "./ChatMessage";

const baseMessage = {
  id: "message-1",
  role: "assistant" as const,
  timestamp: 1,
};

describe("ChatMessage platform boundaries", () => {
  it("does not offer an ARO command as runnable in an AKS session", () => {
    render(
      <ChatMessage
        message={{
          ...baseMessage,
          content: "```oc\noc get nodes\n```",
        }}
        platform="aks"
        onRunCommand={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /^run$/i })).toBeNull();
    expect(screen.getByText(/not valid for AKS/)).not.toBeNull();
  });

  it("offers the platform-compatible AKS command", () => {
    render(
      <ChatMessage
        message={{
          ...baseMessage,
          content: "```kubectl\nkubectl get nodes\n```",
        }}
        platform="aks"
        onRunCommand={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /^run$/i }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("suppresses Classic-only references in HCP responses", () => {
    render(
      <ChatMessage
        message={{
          ...baseMessage,
          content:
            "[ARO support policies](https://learn.microsoft.com/en-us/azure/openshift/support-policies-v4)",
        }}
        platform="aro-hcp"
      />,
    );

    expect(screen.queryByRole("link", { name: /ARO support policies/i })).toBeNull();
    expect(screen.getByText("ARO support policies")).not.toBeNull();
  });

  it("keeps HCP-scoped references clickable", () => {
    render(
      <ChatMessage
        message={{
          ...baseMessage,
          content: "[ARO HCP architecture](https://github.com/Azure/ARO-HCP)",
        }}
        platform="aro-hcp"
      />,
    );

    expect(
      screen
        .getByRole("link", { name: /ARO HCP architecture/i })
        .getAttribute("href"),
    ).toBe("https://github.com/Azure/ARO-HCP");
  });
});
