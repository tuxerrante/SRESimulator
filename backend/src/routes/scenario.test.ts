import { describe, expect, it, vi, beforeAll, beforeEach, afterAll } from "vitest";
import express from "express";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  ANONYMOUS_PROOF_COOKIE,
  VIEWER_SESSION_COOKIE,
} from "../../../shared/auth/constants";
import {
  createAnonymousProofToken,
  hashAnonymousProofUserAgent,
} from "../../../shared/auth/anonymous-proof";
import { createSignedClientIp } from "../../../shared/auth/client-ip";
import { createViewerSessionToken } from "../../../shared/auth/session";

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

describe("POST /api/scenario", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let scenarioRouter: typeof import("./scenario").scenarioRouter;
  let tmpDir: string;
  const anonymousUserAgent = "scenario-test-agent";

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

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "scenario-test-"));
    originalEnv.AI_MOCK_MODE = process.env.AI_MOCK_MODE;
    originalEnv.DATA_DIR = process.env.DATA_DIR;
    originalEnv.TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
    originalEnv.AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET;
    originalEnv.ANTI_ABUSE_HMAC_SECRET = process.env.ANTI_ABUSE_HMAC_SECRET;
    process.env.AI_MOCK_MODE = "true";
    process.env.DATA_DIR = tmpDir;
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.AUTH_SESSION_SECRET = "test-secret";
    process.env.ANTI_ABUSE_HMAC_SECRET = "test-hmac";

    vi.resetModules();

    const storageModule = await import("../lib/storage");
    await storageModule.initStorage();

    const scenarioModule = await import("./scenario");
    scenarioRouter = scenarioModule.scenarioRouter;
  });

  beforeEach(() => {
    process.env.AI_MOCK_MODE = "true";
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.AUTH_SESSION_SECRET = "test-secret";
    process.env.ANTI_ABUSE_HMAC_SECRET = "test-hmac";
  });

  afterAll(async () => {
    if (originalEnv.AI_MOCK_MODE === undefined) {
      delete process.env.AI_MOCK_MODE;
    } else {
      process.env.AI_MOCK_MODE = originalEnv.AI_MOCK_MODE;
    }
    if (originalEnv.DATA_DIR === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalEnv.DATA_DIR;
    }
    if (originalEnv.TURNSTILE_SECRET_KEY === undefined) {
      delete process.env.TURNSTILE_SECRET_KEY;
    } else {
      process.env.TURNSTILE_SECRET_KEY = originalEnv.TURNSTILE_SECRET_KEY;
    }
    if (originalEnv.AUTH_SESSION_SECRET === undefined) {
      delete process.env.AUTH_SESSION_SECRET;
    } else {
      process.env.AUTH_SESSION_SECRET = originalEnv.AUTH_SESSION_SECRET;
    }
    if (originalEnv.ANTI_ABUSE_HMAC_SECRET === undefined) {
      delete process.env.ANTI_ABUSE_HMAC_SECRET;
    } else {
      process.env.ANTI_ABUSE_HMAC_SECRET = originalEnv.ANTI_ABUSE_HMAC_SECRET;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a mock scenario and session token for a signed GitHub viewer", async () => {
    const authToken = createViewerSessionToken(
      {
        kind: "github",
        githubUserId: "12345",
        githubLogin: "octocat",
        displayName: "The Octocat",
        avatarUrl: null,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      "test-secret"
    );
    const app = createApp(scenarioRouter);
    const res = await postJson(app, "/api/scenario", {
      difficulty: "easy",
    }, {
      cookie: `${VIEWER_SESSION_COOKIE}=${authToken}`,
    });

    expect(res.status).toBe(200);
    expect(res.body.scenario).toBeDefined();
    expect(res.body.sessionToken).toBeDefined();
    const scenario = res.body.scenario as Record<string, unknown>;
    expect(scenario.difficulty).toBe("easy");
    expect(scenario.id).toBe("scenario_mock_easy");
  });

  it("rejects invalid difficulty", async () => {
    const app = createApp(scenarioRouter);
    const res = await postJson(app, "/api/scenario", {
      difficulty: "extreme",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid difficulty");
  });

  it("rejects anonymous medium difficulty without GitHub login", async () => {
    const app = createApp(scenarioRouter);
    const res = await postJson(app, "/api/scenario", {
      difficulty: "medium",
      turnstileToken: "pass",
      fingerprintHash: "fp_hash",
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("GitHub login is required for medium and hard scenarios.");
    expect(res.body.code).toBe("github_required");
  });

  it("rejects anonymous easy mode without captcha and fingerprint verification", async () => {
    const app = createApp(scenarioRouter);
    const res = await postJson(app, "/api/scenario", {
      difficulty: "easy",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Anonymous Easy mode requires captcha-backed verification."
    );
    expect(res.body.code).toBe("anonymous_verification_required");
  });

  it("allows anonymous easy mode after captcha and signed browser verification", async () => {
    const app = createApp(scenarioRouter);
    const res = await postJson(app, "/api/scenario", {
      difficulty: "easy",
      turnstileToken: "pass",
      fingerprintHash: "ignored-by-backend",
    }, {
      cookie: createAnonymousProofCookie("fp_hash"),
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.10"),
    });

    expect(res.status).toBe(200);
    expect(res.body.sessionToken).toBeDefined();
  });

  it("blocks a second anonymous easy run within the daily window even if the body fingerprint changes", async () => {
    const app = createApp(scenarioRouter);
    const cookie = createAnonymousProofCookie("fp_hash_replay");
    const first = await postJson(app, "/api/scenario", {
      difficulty: "easy",
      turnstileToken: "pass",
      fingerprintHash: "fp_hash_replay",
    }, {
      cookie,
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.11"),
    });
    const second = await postJson(app, "/api/scenario", {
      difficulty: "easy",
      turnstileToken: "pass",
      fingerprintHash: "rotated-client-body-hash",
    }, {
      cookie,
      "user-agent": anonymousUserAgent,
      ...createSignedClientIpHeaders("203.0.113.11"),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("Anonymous Easy mode is limited to one run per day.");
    expect(second.body.code).toBe("anonymous_daily_limit_reached");
  });

  it("still returns github_required for anonymous medium requests when anti-abuse secret is missing", async () => {
    delete process.env.ANTI_ABUSE_HMAC_SECRET;
    const app = createApp(scenarioRouter);
    const res = await postJson(app, "/api/scenario", {
      difficulty: "medium",
      turnstileToken: "pass",
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("github_required");
  });
});
