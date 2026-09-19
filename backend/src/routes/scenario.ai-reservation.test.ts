import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Response } from "express";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  ANONYMOUS_PROOF_COOKIE,
} from "../../../shared/auth/constants";
import {
  createAnonymousProofToken,
  hashAnonymousProofUserAgent,
} from "../../../shared/auth/anonymous-proof";
import { createSignedClientIp } from "../../../shared/auth/client-ip";
import { buildAnonymousClaimKeys } from "../lib/anonymous-claim";

const generateAiTextMock = vi.fn();
const warmupAiModelMock = vi.fn();
const captureBackendRouteErrorMock = vi.fn();
const loadKnowledgeBaseMock = vi.fn().mockResolvedValue("");
const chargeAiBudgetMock = vi.fn<(res: Response) => Promise<string>>(
  async () => "ok",
);
const markAiBudgetDegradedMock = vi.fn();

vi.mock("../lib/ai-budget", () => ({
  chargeAiBudget: chargeAiBudgetMock,
  markAiBudgetDegraded: markAiBudgetDegradedMock,
}));

vi.mock("../lib/ai-config", () => ({
  getAiReadiness() {
    return { mockMode: false, ready: true, reasons: [] };
  },
  shouldDegradeOnQuotaExhausted: () => true,
}));

vi.mock("../lib/knowledge", () => ({
  loadKnowledgeBase: loadKnowledgeBaseMock,
}));

vi.mock("../lib/ai-runtime", () => {
  // The subclass relationship is the contract every catch site relies on:
  // an exhausted budget must keep behaving like a throttle unless a branch
  // explicitly asks for the narrower type.
  class AiThrottledError extends Error {}
  class AiQuotaExhaustedError extends AiThrottledError {
    constructor(
      readonly scope: "daily" | "credits",
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AiThrottledError,
    AiQuotaExhaustedError,
    generateAiText: generateAiTextMock,
    warmupAiModel: warmupAiModelMock,
  };
});

vi.mock("../lib/telemetry/capture", () => ({
  captureBackendRouteError: captureBackendRouteErrorMock,
}));

function createApp(
  scenarioRouter: import("express").Router,
  options: { budgetExhausted?: boolean } = {},
) {
  const app = express();
  app.use(express.json());
  if (options.budgetExhausted) {
    // A faithful stand-in for the real pair: chargeAiBudget records the cause
    // it observed, markAiBudgetDegraded upgrades it to the outcome the route
    // chose and refuses to overwrite anything else.
    chargeAiBudgetMock.mockImplementation(async (res: Response) => {
      res.setHeader("x-sresim-ai-budget", "daily-exhausted");
      return "exhausted";
    });
    markAiBudgetDegradedMock.mockImplementation((res: Response) => {
      if (res.getHeader("x-sresim-ai-budget") !== "daily-exhausted") {
        return;
      }
      res.setHeader("x-sresim-ai-budget", "degraded");
    });
  }
  app.use("/api/scenario", scenarioRouter);
  return app;
}

async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}> {
  const { request } = await import("http");
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Bad address"));
        return;
      }
      const payload = JSON.stringify(body);
      const req = request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({
              status: res.statusCode ?? 500,
              body: JSON.parse(data),
              headers: res.headers,
            });
          });
        }
      );
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
      req.write(payload);
      req.end();
    });
  });
}

describe("scenario reservation before AI generation", () => {
  const anonymousUserAgent = "scenario-ai-test-agent";
  let tmpDir: string;

  function createValidAiScenario() {
    return {
      id: "scenario_slow",
      platform: "aro-classic",
      title: "Slow AI Scenario",
      difficulty: "easy",
      description: "desc",
      incidentTicket: {
        id: "IcM-123456",
        severity: "Sev3",
        title: "title",
        description: "desc",
        customerImpact: "impact",
                  reportedTime: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString(),
        clusterName: "cluster",
        region: "eastus",
      },
      clusterContext: {
        name: "cluster",
        version: "4.18.1",
        region: "eastus",
        nodeCount: 3,
        status: "Degraded",
        recentEvents: [],
        alerts: [],
        upgradeHistory: [],
      },
    };
  }

  function expectCatalogFallback(
    response: { status: number; body: Record<string, unknown> },
    degradedReason = "invalid_payload",
  ) {
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("degraded");
    expect(response.body.degradedReason).toBe(degradedReason);
    expect(
      (response.body.scenario as Record<string, unknown>).platform,
    ).toBe("aro-classic");
  }

  function createAnonymousProofCookie(fingerprintHash: string): string {
    const issuedAt = Date.now();
    const proofToken = createAnonymousProofToken(
      {
        fingerprintHash,
        userAgentHash: hashAnonymousProofUserAgent(anonymousUserAgent),
        issuedAt,
        expiresAt: issuedAt + 60_000,
      },
      "test-hmac"
    );
    return `${ANONYMOUS_PROOF_COOKIE}=${proofToken}`;
  }

  function createSignedClientIpHeaders(ip: string): Record<string, string> {
    return {
      "x-sresim-client-ip": ip,
      "x-sresim-client-ip-signature": createSignedClientIp(ip, "test-hmac"),
    };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "scenario-ai-reservation-"));
    process.env.DATA_DIR = tmpDir;
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.AUTH_SESSION_SECRET = "test-secret";
    process.env.ANTI_ABUSE_HMAC_SECRET = "test-hmac";
    delete process.env.SCENARIO_SOURCE;
    delete process.env.SCENARIO_CATALOG_DIR;
    delete process.env.AI_SCENARIO_TIMEOUT_MS;
    delete process.env.STORAGE_BACKEND;
    loadKnowledgeBaseMock.mockClear();
    generateAiTextMock.mockReset().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve(JSON.stringify(createValidAiScenario()));
          }, 50);
        })
    );
    captureBackendRouteErrorMock.mockReset();
    chargeAiBudgetMock.mockReset().mockResolvedValue("ok");
    markAiBudgetDegradedMock.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.AUTH_SESSION_SECRET;
    delete process.env.ANTI_ABUSE_HMAC_SECRET;
    delete process.env.SCENARIO_SOURCE;
    delete process.env.SCENARIO_CATALOG_DIR;
    delete process.env.AI_SCENARIO_TIMEOUT_MS;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects the second anonymous request before spending a second AI generation", async () => {
    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_hash"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.44"),
    };

    const [first, second] = await Promise.all([
      postJson(
        app,
        "/api/scenario",
        { difficulty: "easy", turnstileToken: "pass" },
        headers
      ),
      postJson(
        app,
        "/api/scenario",
        { difficulty: "easy", turnstileToken: "pass" },
        headers
      ),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 429]);
    expect(generateAiTextMock).toHaveBeenCalledTimes(1);
  }, 60000);

  it("releases the reserved claim when the budget answers the request itself", async () => {
    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const fingerprintHash = "fp_budget_refused";
    const ip = "203.0.113.45";
    const headers = {
      cookie: createAnonymousProofCookie(fingerprintHash),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders(ip),
    };
    const claimKeys = buildAnonymousClaimKeys(
      { fingerprintHash, ip, userAgent: anonymousUserAgent },
      "test-hmac"
    );

    // A refusal on the shared minute window: chargeAiBudget writes the 429
    // itself and reports "answered", which is what the real one does.
    chargeAiBudgetMock.mockImplementationOnce(async (res: Response) => {
      res.status(429).json({ error: "The shared AI budget is busy." });
      return "answered";
    });

    const refused = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(refused.status).toBe(429);
    expect(generateAiTextMock).not.toHaveBeenCalled();

    // Polled rather than read once: the refusal is written inside
    // chargeAiBudget, so the client has its answer before the route reaches
    // the release. The store is the thing that changed state, and it is what
    // the next request will read.
    await vi.waitFor(async () => {
      expect(
        await storageModule.getAnonymousTrialStore().hasActiveClaim(claimKeys[0]!),
      ).toBe(false);
    });

    // The refusal spent nothing, so the one daily trial this identity has must
    // still be there. Without the release the claim stays reserved and the
    // retry the 429 invited is answered with a second 429 -- the caller is
    // locked out for a day by a request that never reached a provider.
    const retried = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(retried.status).toBe(200);
    expect(generateAiTextMock).toHaveBeenCalledTimes(1);
  }, 60000);

  it("requests low reasoning effort for AI-generated scenarios", async () => {
    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_low_reasoning"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.43"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(response.status).toBe(200);
    expect(generateAiTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "scenario",
        _reasoningEffortOverride: "low",
      }),
    );
  });

  it("falls back to the platform catalog when live generation times out", async () => {
    process.env.AI_SCENARIO_TIMEOUT_MS = "20";
    generateAiTextMock.mockImplementation(() => new Promise<string>(() => {}));

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_timeout_fallback"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.44"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { platform: "aro-classic", difficulty: "easy", turnstileToken: "pass" },
      headers,
    );

    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("degraded");
    expect(response.body.degradedReason).toBe("timeout");
    expect(
      (response.body.scenario as Record<string, unknown>).platform,
    ).toBe("aro-classic");
  });

  it("falls back to the platform catalog when live generation is throttled", async () => {
    const { AiThrottledError } = await import("../lib/ai-runtime");
    generateAiTextMock.mockRejectedValueOnce(
      new AiThrottledError("scenario provider throttled"),
    );

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_throttled_fallback"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.45"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { platform: "aro-classic", difficulty: "easy", turnstileToken: "pass" },
      headers,
    );

    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("degraded");
    expect(response.body.degradedReason).toBe("throttled");
    expect(
      (response.body.scenario as Record<string, unknown>).platform,
    ).toBe("aro-classic");
  });

  it("names an exhausted budget apart from an ordinary throttle in the fallback", async () => {
    const { AiQuotaExhaustedError } = await import("../lib/ai-runtime");
    generateAiTextMock.mockRejectedValueOnce(
      new AiQuotaExhaustedError("daily", "The shared budget is spent."),
    );

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_quota_fallback"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.46"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { platform: "aro-classic", difficulty: "easy", turnstileToken: "pass" },
      headers,
    );

    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("degraded");
    expect(response.body.degradedReason).toBe("quota_exhausted");
  });

  it("labels a spent shared budget the same way a spent provider budget is labelled", async () => {
    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter, { budgetExhausted: true });
    const headers = {
      cookie: createAnonymousProofCookie("fp_global_budget"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.47"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { platform: "aro-classic", difficulty: "easy", turnstileToken: "pass" },
      headers,
    );

    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("degraded");
    expect(response.body.degradedReason).toBe("quota_exhausted");
    // No doomed round trip: the provider is never asked for a request the
    // shared account already cannot afford.
    expect(generateAiTextMock).not.toHaveBeenCalled();
    // Nor is the prompt built for it. This is the assertion that pins the
    // check *ahead* of the knowledge-base read: that read shares the request
    // deadline, so on a slow filesystem it can expire first and relabel a
    // spent budget as a timeout -- the one degraded reason that sends the
    // operator looking at latency instead of at the budget.
    expect(loadKnowledgeBaseMock).not.toHaveBeenCalled();
    // The session below is playable and the scenario is a real one from the
    // catalog, so the header has to stop describing the budget and start
    // describing the response -- read off the wire, not off the mock.
    expect(response.headers["x-sresim-ai-budget"]).toBe("degraded");
  });

  it("uses the catalog fallback when AI returns schema-invalid JSON", async () => {
    const invalidScenario = createValidAiScenario();
    invalidScenario.clusterContext = {
      ...invalidScenario.clusterContext,
      alerts: "bad-value" as unknown as [],
    };
    generateAiTextMock.mockResolvedValueOnce(JSON.stringify(invalidScenario));

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_invalid_payload"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.99"),
    };

    const first = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );
    const second = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expectCatalogFallback(first);
    expect(second.status).toBe(429);
    expect(generateAiTextMock).toHaveBeenCalledTimes(1);
  });

  it("uses the catalog fallback when AI returns non-JSON output", async () => {
    generateAiTextMock.mockResolvedValueOnce("not valid json");

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_invalid_json"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.98"),
    };

    const first = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );
    const second = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expectCatalogFallback(first);
    expect(second.status).toBe(429);
    expect(generateAiTextMock).toHaveBeenCalledTimes(1);
    const capturedError = captureBackendRouteErrorMock.mock.calls[0]?.[1] as
      | (Error & { cause?: unknown })
      | undefined;
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError?.cause).toBeInstanceOf(SyntaxError);
  });

  it("falls back when incident and cluster context identity fields diverge", async () => {
    const invalidScenario = createValidAiScenario();
    invalidScenario.incidentTicket.region = "westeurope";
    generateAiTextMock.mockResolvedValueOnce(JSON.stringify(invalidScenario));

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_mismatch_region"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.97"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expectCatalogFallback(response);
  });

  it("falls back when incident and cluster names diverge", async () => {
    const invalidScenario = createValidAiScenario();
    invalidScenario.incidentTicket.clusterName = "different-cluster";
    generateAiTextMock.mockResolvedValueOnce(JSON.stringify(invalidScenario));

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_mismatch_cluster"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.96"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expectCatalogFallback(response);
  });

  it("falls back when platformContext fields are structurally invalid", async () => {
    const invalidScenario = {
      ...createValidAiScenario(),
      platformContext: {
        machineNames: ["worker-a", ""],
      },
    };
    generateAiTextMock.mockResolvedValueOnce(JSON.stringify(invalidScenario));

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_invalid_platform_context"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.93"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers,
    );

    expectCatalogFallback(response);
  });

  it("falls back when timestamps are parseable but not strict ISO 8601", async () => {
    const invalidScenario = createValidAiScenario();
    invalidScenario.incidentTicket.reportedTime = "03/07/2026 12:34:56";
    generateAiTextMock.mockResolvedValueOnce(JSON.stringify(invalidScenario));

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_non_iso_timestamp"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.95"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expectCatalogFallback(response);
  });

  it("falls back when AI scenarios contain impossible calendar dates", async () => {
    const invalidScenario = createValidAiScenario();
    invalidScenario.incidentTicket.reportedTime = "2026-02-29T12:34:56Z";
    generateAiTextMock.mockResolvedValueOnce(JSON.stringify(invalidScenario));

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_impossible_date"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.94"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expectCatalogFallback(response);
  });

  it("returns a curated catalog scenario without calling AI generation when catalog mode is enabled", async () => {
    process.env.SCENARIO_SOURCE = "catalog";

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_catalog"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.45"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(response.status).toBe(200);
    const scenario = response.body.scenario as Record<string, unknown>;
    expect(scenario.id).toBe("aro-classic-easy-master-node-deleted");
    expect(JSON.stringify(scenario)).not.toContain("{{minutesAgo:");
    expect(JSON.stringify(scenario)).not.toContain("{{daysAgo:");
    expect(generateAiTextMock).not.toHaveBeenCalled();
    expect(warmupAiModelMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when catalog mode is enabled but no curated scenario is available", async () => {
    process.env.SCENARIO_SOURCE = "catalog";
    process.env.SCENARIO_CATALOG_DIR = tmpDir;

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_catalog_missing"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.46"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("Scenario catalog is not available for aro-classic/easy.");
    expect(generateAiTextMock).not.toHaveBeenCalled();
  });

  it("returns a client-safe error when a catalog file is invalid", async () => {
    process.env.SCENARIO_SOURCE = "catalog";
    process.env.SCENARIO_CATALOG_DIR = tmpDir;
    await mkdir(join(tmpDir, "aro-classic", "easy"), { recursive: true });
    await writeFile(
      join(tmpDir, "aro-classic", "easy", "broken.json"),
      JSON.stringify({
        id: "scenario_broken",
        platform: "aro-classic",
        difficulty: "easy",
        description: "broken",
        incidentTicket: { id: "IcM-1", title: "broken" },
        clusterContext: { name: "broken", nodeCount: 1 },
      })
    );

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_catalog_invalid"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.47"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Scenario catalog is invalid.");
    expect(JSON.stringify(response.body)).not.toContain(tmpDir);
    expect(JSON.stringify(response.body)).not.toContain("broken.json");
    expect(generateAiTextMock).not.toHaveBeenCalled();
  });

  it("rejects catalog scenarios that omit required nested arrays", async () => {
    process.env.SCENARIO_SOURCE = "catalog";
    process.env.SCENARIO_CATALOG_DIR = tmpDir;
    await mkdir(join(tmpDir, "aro-classic", "easy"), { recursive: true });
    await writeFile(
      join(tmpDir, "aro-classic", "easy", "missing-alerts.json"),
      JSON.stringify({
        id: "scenario_missing_alerts",
        platform: "aro-classic",
        title: "Missing alerts",
        difficulty: "easy",
        description: "broken",
        incidentTicket: {
          id: "IcM-2",
          severity: "Sev3",
          title: "broken",
          description: "broken",
          customerImpact: "impact",
          reportedTime: new Date(Date.now() - (2 * 24 * 60 * 60 * 1000)).toISOString(),
          clusterName: "cluster",
          region: "eastus",
        },
        clusterContext: {
          name: "cluster",
          version: "4.19.0",
          region: "eastus",
          nodeCount: 1,
          status: "Degraded",
          recentEvents: [],
          upgradeHistory: [],
        },
      })
    );

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_catalog_missing_alerts"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.48"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Scenario catalog is invalid.");
    expect(generateAiTextMock).not.toHaveBeenCalled();
  });

  it("returns a client-safe error when a catalog file contains invalid JSON syntax", async () => {
    process.env.SCENARIO_SOURCE = "catalog";
    process.env.SCENARIO_CATALOG_DIR = tmpDir;
    await mkdir(join(tmpDir, "aro-classic", "easy"), { recursive: true });
    await writeFile(join(tmpDir, "aro-classic", "easy", "invalid-json.json"), "{");

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_catalog_bad_json"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.49"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Scenario catalog is invalid.");
    expect(JSON.stringify(response.body)).not.toContain(tmpDir);
    expect(JSON.stringify(response.body)).not.toContain("invalid-json.json");
    expect(generateAiTextMock).not.toHaveBeenCalled();
  });

  it("returns a client-safe error when catalog file reads fail before JSON parsing", async () => {
    process.env.SCENARIO_SOURCE = "catalog";
    process.env.SCENARIO_CATALOG_DIR = tmpDir;
    await mkdir(join(tmpDir, "aro-classic", "easy", "directory.json"), { recursive: true });

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_catalog_read_failure"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.51"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("Scenario catalog is invalid.");
    expect(JSON.stringify(response.body)).not.toContain(tmpDir);
    expect(JSON.stringify(response.body)).not.toContain("directory.json");
    expect(generateAiTextMock).not.toHaveBeenCalled();
  });

  it("returns the anonymous daily-limit response before validating catalog files", async () => {
    process.env.SCENARIO_SOURCE = "catalog";
    process.env.SCENARIO_CATALOG_DIR = tmpDir;
    await mkdir(join(tmpDir, "aro-classic", "easy"), { recursive: true });
    await writeFile(join(tmpDir, "aro-classic", "easy", "invalid-json.json"), "{");

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();
    const claimKeys = buildAnonymousClaimKeys(
      {
        fingerprintHash: "fp_catalog_claim_priority",
        ip: "203.0.113.50",
        userAgent: anonymousUserAgent,
      },
      "test-hmac"
    );
    await storageModule.getAnonymousTrialStore().reserveClaimKeys(claimKeys, {
      claimKey: claimKeys[0]!,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    const scenarioModule = await import("./scenario");
    const app = createApp(scenarioModule.scenarioRouter);
    const headers = {
      cookie: createAnonymousProofCookie("fp_catalog_claim_priority"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.50"),
    };

    const response = await postJson(
      app,
      "/api/scenario",
      { difficulty: "easy", turnstileToken: "pass" },
      headers
    );

    expect(response.status).toBe(429);
    expect(response.body.code).toBe("anonymous_daily_limit_reached");
    expect(response.body.error).toBe("Anonymous Easy mode is limited to one run per day.");
    expect(generateAiTextMock).not.toHaveBeenCalled();
  });
});
