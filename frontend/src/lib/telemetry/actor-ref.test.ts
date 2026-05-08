import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStorage = new Map<string, string>();
const localStorageMock: Storage = {
  getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    mockStorage.delete(key);
  }),
  clear: vi.fn(() => {
    mockStorage.clear();
  }),
  get length() {
    return mockStorage.size;
  },
  key: vi.fn((index: number) => [...mockStorage.keys()][index] ?? null),
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

async function loadActorRefModule() {
  vi.resetModules();
  return import("./actor-ref");
}

describe("getOrCreateActorRef", () => {
  const originalCrypto = globalThis.crypto;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: localStorageMock,
      writable: true,
      configurable: true,
    });
    mockStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      writable: true,
      configurable: true,
    });
  });

  it("creates and then reuses a stable anonymous actor reference", async () => {
    const { getOrCreateActorRef } = await loadActorRefModule();
    const first = getOrCreateActorRef();
    const second = getOrCreateActorRef();

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(second).toBe(first);
  });

  it("falls back to a stable in-memory actor reference when storage is unavailable", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { getOrCreateActorRef } = await loadActorRefModule();
    const first = getOrCreateActorRef();
    const second = getOrCreateActorRef();

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(second).toBe(first);
  });

  it("replaces malformed stored actor refs with a new UUID", async () => {
    mockStorage.set("sresim-actor-ref", "user@example.com");

    const { getOrCreateActorRef } = await loadActorRefModule();
    const actorRef = getOrCreateActorRef();

    expect(actorRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(actorRef).not.toBe("user@example.com");
    expect(mockStorage.get("sresim-actor-ref")).toBe(actorRef);
  });

  it("falls back to a stable in-memory actor reference when storage throws", async () => {
    const blockedStorage: Storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      removeItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      clear: vi.fn(() => {
        throw new Error("blocked");
      }),
      get length() {
        return 0;
      },
      key: vi.fn(() => {
        throw new Error("blocked");
      }),
    };

    Object.defineProperty(globalThis, "localStorage", {
      value: blockedStorage,
      writable: true,
      configurable: true,
    });

    const { getOrCreateActorRef } = await loadActorRefModule();
    const first = getOrCreateActorRef();
    const second = getOrCreateActorRef();

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(second).toBe(first);
  });

  it("uses a non-throwing uuid fallback when randomUUID is unavailable", async () => {
    Object.defineProperty(globalThis, "crypto", {
      value: {
        randomUUID() {
          throw new Error("randomUUID unavailable");
        },
      } as unknown as Crypto,
      writable: true,
      configurable: true,
    });

    const { getOrCreateActorRef } = await loadActorRefModule();
    const actorRef = getOrCreateActorRef();

    expect(actorRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
