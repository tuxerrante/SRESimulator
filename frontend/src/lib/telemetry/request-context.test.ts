import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTOR_REF_HEADER,
  GAME_SESSION_REF_HEADER,
  REQUEST_ID_HEADER,
} from "@shared/telemetry/constants";

const storage = new Map<string, string>();

const localStorageMock: Storage = {
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
  key(index: number) {
    return [...storage.keys()][index] ?? null;
  },
  get length() {
    return storage.size;
  },
};

async function loadRequestContextModule() {
  vi.resetModules();
  return import("./request-context");
}

describe("buildTelemetryHeaders", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
    localStorageMock.clear();
    vi.restoreAllMocks();
  });

  it("returns pseudonymous request headers without leaking the raw session token", async () => {
    const { buildTelemetryHeaders } = await loadRequestContextModule();
    const headers = await buildTelemetryHeaders("session-raw-token");

    expect(headers[REQUEST_ID_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(headers[ACTOR_REF_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(headers[GAME_SESSION_REF_HEADER]).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.values(headers)).not.toContain("session-raw-token");
  });

  it("reuses actor and session refs while minting a fresh request id for each call", async () => {
    const { buildTelemetryHeaders } = await loadRequestContextModule();

    const first = await buildTelemetryHeaders("session-raw-token");
    const second = await buildTelemetryHeaders("session-raw-token");

    expect(first[ACTOR_REF_HEADER]).toBe(second[ACTOR_REF_HEADER]);
    expect(first[GAME_SESSION_REF_HEADER]).toBe(second[GAME_SESSION_REF_HEADER]);
    expect(first[REQUEST_ID_HEADER]).not.toBe(second[REQUEST_ID_HEADER]);
  });
});
