import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJsonObject, parseJsonObject } from "./api-client";

describe("parseJsonObject", () => {
  it("parses a JSON object payload", () => {
    expect(parseJsonObject('{"ok":true}')).toEqual({ ok: true });
  });

  it("rejects empty payloads", () => {
    expect(() => parseJsonObject("   ")).toThrow("Response body is empty");
  });

  it("rejects non-object JSON payloads", () => {
    expect(() => parseJsonObject('["x"]')).toThrow("Response was not a JSON object");
  });
});

describe("fetchJsonObject", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "fetch");
  });

  it("returns parsed object for successful JSON responses", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"value":"ok"}',
      } as Response),
    });

    await expect(
      fetchJsonObject("/api/test", undefined, "Failed to load payload"),
    ).resolves.toEqual({ value: "ok" });
  });

  it("uses API error field for non-2xx JSON responses", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error":"Bad request"}',
      } as Response),
    });

    await expect(
      fetchJsonObject("/api/test", undefined, "Failed to load payload"),
    ).rejects.toThrow("Bad request");
  });

  it("reports non-2xx non-JSON responses as server errors", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "service unavailable",
      } as Response),
    });

    await expect(
      fetchJsonObject("/api/test", undefined, "Failed to load payload"),
    ).rejects.toThrow("Server error (503): service unavailable");
  });

  it("uses fallback message with parse reason for 2xx invalid JSON", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => " ",
      } as Response),
    });

    await expect(
      fetchJsonObject("/api/test", undefined, "Failed to load payload"),
    ).rejects.toThrow("Failed to load payload: Response body is empty");
  });
});
