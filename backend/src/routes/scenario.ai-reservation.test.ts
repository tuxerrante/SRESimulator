import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtemp, rm } from "fs/promises";
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

const generateAiTextMock = vi.fn();

vi.mock("../lib/ai-config", () => ({
  getAiReadiness() {
    return { mockMode: false, ready: true, reasons: [] };
  },
}));

vi.mock("../lib/knowledge", () => ({
  loadKnowledgeBase: vi.fn().mockResolvedValue(""),
}));

vi.mock("../lib/ai-runtime", () => ({
  AiThrottledError: class AiThrottledError extends Error {},
  generateAiText: generateAiTextMock,
}));

function createApp(scenarioRouter: import("express").Router) {
  const app = express();
  app.use(express.json());
  app.use("/api/scenario", scenarioRouter);
  return app;
}

async function postJson(
  app: express.Express,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
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
    delete process.env.STORAGE_BACKEND;
    generateAiTextMock.mockReset().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            resolve(
              JSON.stringify({
                id: "scenario_slow",
                title: "Slow AI Scenario",
                difficulty: "easy",
                description: "desc",
                incidentTicket: {
                  id: "IcM-123456",
                  severity: "Sev3",
                  title: "title",
                  description: "desc",
                  customerImpact: "impact",
                  reportedTime: new Date().toISOString(),
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
              })
            );
          }, 50);
        })
    );
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.AUTH_SESSION_SECRET;
    delete process.env.ANTI_ABUSE_HMAC_SECRET;
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
  });
});
