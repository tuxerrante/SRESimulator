import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "http";
import type { Express } from "express";
import type { PlatformId } from "../../../shared/types/platform";
import {
  createScenarioSession,
  getBackendUrl,
  getGameplayAdminHeaders,
  getViewerAuthCookie,
  isExternalTarget,
  startLocalServer,
} from "./helpers";

let baseUrl: string;
let localServer: Server | null = null;

async function createLocalApp(): Promise<Express> {
  process.env.AI_MOCK_MODE = "true";
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  process.env.AUTH_SESSION_SECRET = "test-secret";
  process.env.ANTI_ABUSE_HMAC_SECRET = "test-hmac";
  process.env.GAMEPLAY_ADMIN_TOKEN = "gameplay-admin-secret";
  process.env.PERSISTENT_LEADERBOARD_ENABLED = "true";

  const { initStorage } = await import("../lib/storage");
  await initStorage();
  const { default: express } = await import("express");
  const { default: cors } = await import("cors");
  const { chatRouter } = await import("../routes/chat");
  const { commandRouter } = await import("../routes/command");
  const { scenarioRouter } = await import("../routes/scenario");
  const { gameplayRouter } = await import("../routes/gameplay");
  const { scoresRouter } = await import("../routes/scores");
  const { healthRouter } = await import("../routes/health");
  const { guideRouter } = await import("../routes/guide");

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  app.use("/api/command", commandRouter);
  app.use("/api/scenario", scenarioRouter);
  app.use("/api/gameplay", gameplayRouter);
  app.use("/api/scores", scoresRouter);
  app.use("/api/guide", guideRouter);
  app.use("/", healthRouter);
  return app;
}

beforeAll(async () => {
  if (isExternalTarget()) {
    baseUrl = getBackendUrl();
    return;
  }

  const app = await createLocalApp();
  const result = await startLocalServer(app);
  baseUrl = result.url;
  localServer = result.server;
}, 120000);

afterAll(() => {
  if (localServer) {
    localServer.close();
    localServer = null;
  }
});

describe("platform session flows", () => {
  it("runs one full easy session for each supported gameplay platform", async () => {
    for (const platform of ["aro-classic", "aro-hcp", "aks"] as const) {
      const cliType = platform === "aks" ? "kubectl" : "oc";
      const cliCommand = platform === "aks" ? "kubectl get nodes" : "oc get nodes";

      const scenarioResponse = await createScenarioSession(baseUrl, platform, "easy");
      expect(scenarioResponse.scenario.platform).toBe(platform);

      const commandResponse = await fetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken: scenarioResponse.sessionToken,
          command: cliCommand,
          type: cliType,
          scenario: scenarioResponse.scenario,
        }),
      });
      expect(commandResponse.status).toBe(200);

      const telemetryResponse = await fetch(`${baseUrl}/api/gameplay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken: scenarioResponse.sessionToken,
          platform,
          lifecycleState: "completed",
          nickname: `e2e-${platform}`,
          commandCount: 1,
          chatMessageCount: 1,
          durationMs: 1000,
          scoringEvents: [],
        }),
      });
      expect(telemetryResponse.status).toBe(202);

      const scoreResponse = await fetch(`${baseUrl}/api/scores`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(getViewerAuthCookie() ? { cookie: getViewerAuthCookie()! } : {}),
        },
        body: JSON.stringify({
          sessionToken: scenarioResponse.sessionToken,
          nickname: `e2e-${platform}`,
        }),
      });
      expect([200, 201]).toContain(scoreResponse.status);

      const analyticsResponse = await fetch(
        `${baseUrl}/api/gameplay/admin?platform=${platform}`,
        { headers: getGameplayAdminHeaders() },
      );
      expect(analyticsResponse.status).toBe(200);
      const analytics = await analyticsResponse.json() as {
        recentSessions?: Array<{ platform?: PlatformId }>;
      };
      expect(analytics.recentSessions?.[0]?.platform).toBe(platform);
    }
  });

  it("rejects cluster CLI commands that do not match the session platform", async () => {
    for (const platform of ["aro-classic", "aro-hcp", "aks"] as const) {
      const scenarioResponse = await createScenarioSession(baseUrl, platform, "easy");
      const invalidType = platform === "aks" ? "oc" : "kubectl";
      const invalidCommand =
        platform === "aks" ? "oc get nodes" : "kubectl get nodes";

      const commandResponse = await fetch(`${baseUrl}/api/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionToken: scenarioResponse.sessionToken,
          command: invalidCommand,
          type: invalidType,
          scenario: scenarioResponse.scenario,
        }),
      });

      expect(commandResponse.status).toBe(409);
      const payload = await commandResponse.json() as { error?: string };
      expect(payload.error).toContain(`platform ${platform}`);
    }

    const hcpSession = await createScenarioSession(baseUrl, "aro-hcp", "easy");
    const classicResourceResponse = await fetch(`${baseUrl}/api/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionToken: hcpSession.sessionToken,
        command: "oc get machines -A",
        type: "oc",
        scenario: hcpSession.scenario,
      }),
    });
    expect(classicResourceResponse.status).toBe(409);
  });
});
