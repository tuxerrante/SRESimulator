import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startLocalServer } from "./helpers";

const repoRoot = resolve(process.cwd(), "..");
const helmHookTemplatePath = resolve(
  repoRoot,
  "helm/sre-simulator/templates/tests/test-connection.yaml",
);
const backendNetworkPolicyTemplatePath = resolve(
  repoRoot,
  "helm/sre-simulator/templates/networkpolicy.yaml",
);
const frontendServiceTemplatePath = resolve(
  repoRoot,
  "helm/sre-simulator/templates/frontend-service.yaml",
);

function readTemplate(path: string): string {
  return readFileSync(path, "utf8");
}

describe("helm runtime contracts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("does not trigger IPv6 key-generator validation warnings", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { aiRateLimit } = await import("../lib/rate-limit");

    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", {
        configurable: true,
        value: "2001:db8::1234",
      });
      next();
    });
    app.use("/api/check", aiRateLimit, (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const { url, server } = await startLocalServer(app);
    try {
      const response = await fetch(`${url}/api/check`);
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }

    const logOutput = [...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((value) => String(value))
      .join("\n");
    expect(logOutput).not.toContain("ERR_ERL_KEY_GEN_IPV6");
  });

  it("lets the helm test pod reach the backend without matching the frontend service selector", () => {
    const hookTemplate = readTemplate(helmHookTemplatePath);
    const networkPolicyTemplate = readTemplate(backendNetworkPolicyTemplatePath);
    const frontendServiceTemplate = readTemplate(frontendServiceTemplatePath);

    expect(hookTemplate).toContain('{{- include "sre-simulator.helmTest.selectorLabels" . | nindent 4 }}');
    expect(hookTemplate).not.toContain('{{- include "sre-simulator.frontend.selectorLabels" . | nindent 4 }}');
    expect(networkPolicyTemplate).toContain('{{- include "sre-simulator.helmTest.selectorLabels" . | nindent 14 }}');
    expect(frontendServiceTemplate).not.toContain(
      '{{- include "sre-simulator.helmTest.selectorLabels" . | nindent 4 }}',
    );
  });
});
