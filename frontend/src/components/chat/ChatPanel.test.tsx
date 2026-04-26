import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel } from "./ChatPanel";
import { useGameStore } from "@/stores/gameStore";

describe("ChatPanel timeout handling", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    useGameStore.getState().resetGame();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    useGameStore.getState().resetGame();
    vi.unstubAllGlobals();
  });

  it("shows a friendly timeout message and retry action for 504 responses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Gateway Timeout" }), {
        status: 504,
        headers: { "Content-Type": "application/json" },
      })
    );

    render(<ChatPanel />);

    fireEvent.change(
      screen.getByPlaceholderText("Describe what you want to investigate..."),
      { target: { value: "Check the API server" } }
    );
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => {
      expect(screen.getByText(/timed out/i)).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: /retry last message/i })).toBeTruthy();
    expect(screen.queryByText(/Error:/i)).toBeNull();
  });

  it("retries the same prompt when the retry action is used", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Gateway Timeout" }), {
        status: 504,
        headers: { "Content-Type": "application/json" },
      })
    );

    render(<ChatPanel />);

    fireEvent.change(
      screen.getByPlaceholderText("Describe what you want to investigate..."),
      { target: { value: "Check the API server" } }
    );
    fireEvent.click(screen.getByTitle("Send message"));

    const retryButton = await screen.findByRole("button", {
      name: /retry last message/i,
    });

    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));

    expect(firstRequest.messages.at(-1)?.content).toBe("Check the API server");
    expect(secondRequest.messages.at(-1)?.content).toBe("Check the API server");
  });
});
