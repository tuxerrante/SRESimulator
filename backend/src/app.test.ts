import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe("createApp", () => {
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;
  const originalSentryEnabled = process.env.SENTRY_ENABLED;
  const originalSentryDsn = process.env.SENTRY_DSN;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@sentry/node");

    if (originalTrustProxyHeaders === undefined) {
      delete process.env.TRUST_PROXY_HEADERS;
    } else {
      process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
    }

    if (originalSentryEnabled === undefined) {
      delete process.env.SENTRY_ENABLED;
    } else {
      process.env.SENTRY_ENABLED = originalSentryEnabled;
    }

    if (originalSentryDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalSentryDsn;
    }
  });

  it("does not trust proxy headers by default", async () => {
    delete process.env.TRUST_PROXY_HEADERS;

    const { createApp } = await import("./app");
    const app = createApp();

    expect(app.get("trust proxy")).toBe(false);
  });

  it("trusts proxy headers only when explicitly enabled", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";

    const { createApp } = await import("./app");
    const app = createApp();

    expect(app.get("trust proxy")).toBe(true);
  });

  it("builds the express app without requiring Sentry env vars", async () => {
    delete process.env.SENTRY_ENABLED;
    delete process.env.SENTRY_DSN;

    const { createApp } = await import("./app");

    const app = createApp();
    expect(app).toBeDefined();
  });

  it("wires Sentry error handling without initializing in createApp", async () => {
    process.env.SENTRY_ENABLED = "true";
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

    const init = vi.fn();
    const setTags = vi.fn();
    const setExtras = vi.fn();
    const setupExpressErrorHandler = vi.fn();

    vi.doMock("@sentry/node", () => ({
      init,
      setTags,
      setExtras,
      setupExpressErrorHandler,
    }));

    const { createApp } = await import("./app");
    const app = createApp();

    expect(app).toBeDefined();
    expect(init).not.toHaveBeenCalled();
    expect(setupExpressErrorHandler).toHaveBeenCalledWith(app);
  });

  it("applies request context before JSON parsing fails", async () => {
    process.env.SENTRY_ENABLED = "true";
    process.env.SENTRY_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

    const init = vi.fn();
    const setTags = vi.fn();
    const setExtras = vi.fn();
    const setupExpressErrorHandler = vi.fn();

    vi.doMock("@sentry/node", () => ({
      init,
      setTags,
      setExtras,
      setupExpressErrorHandler,
    }));

    const { createApp } = await import("./app");
    const app = createApp();
    const server = await new Promise<Server>((resolve) => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/scenario`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sresim-request-id": "3a8f6d6e-32ef-4a97-8891-0bc5987888f1",
          "x-sresim-actor-ref": "2c9374a5-94f3-4c58-aab5-413f28643f03",
          "x-sresim-game-session-ref": "4d2c91fa8e7b6a10",
        },
        body: "{",
      });

      expect(response.status).toBe(400);
      expect(setTags).toHaveBeenCalledWith({
        feature: "scenario",
        requestId: "3a8f6d6e-32ef-4a97-8891-0bc5987888f1",
        actorRef: "2c9374a5-94f3-4c58-aab5-413f28643f03",
        gameSessionRef: "4d2c91fa8e7b6a10",
      });
      expect(setExtras).toHaveBeenCalledWith({
        request: {
          method: "POST",
          route: "/api/scenario",
        },
      });
      expect(init).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });
});
