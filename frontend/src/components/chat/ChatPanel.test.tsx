import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatPanel } from "./ChatPanel";
import { useGameStore } from "@/stores/gameStore";

function createSseResponse(payloads: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

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

  it("keeps the generic wrapper for non-timeout errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "backend exploded" }), {
        status: 500,
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
      expect(
        screen.getByText("Error: backend exploded. Please try again.")
      ).toBeTruthy();
    });

    expect(screen.queryByRole("button", { name: /retry last message/i })).toBeNull();
  });

  it("retries without duplicating the user turn or failed assistant error", async () => {
    fetchMock
      .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Gateway Timeout" }), {
        status: 504,
        headers: { "Content-Type": "application/json" },
      })
      )
      .mockResolvedValueOnce(
        createSseResponse([{ text: "Recovered guidance" }])
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

    await waitFor(() => {
      expect(screen.getByText("Recovered guidance")).toBeTruthy();
    });

    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));

    expect(firstRequest.messages).toEqual([
      { role: "user", content: "Check the API server" },
    ]);
    expect(secondRequest.messages).toEqual([
      { role: "user", content: "Check the API server" },
    ]);
    expect(screen.getAllByText("Check the API server")).toHaveLength(1);
    expect(screen.queryByText(/timed out/i)).toBeNull();
  });
});
