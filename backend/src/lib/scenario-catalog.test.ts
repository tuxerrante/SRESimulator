import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

function validScenarioJson(platform: "aro-classic" | "aro-hcp" | "aks" = "aks") {
  return JSON.stringify({
    id: "scenario_retryable",
    platform,
    title: "Retryable catalog scenario",
    difficulty: "easy",
    description: "A valid scenario after a failed catalog load.",
    incidentTicket: {
      id: "IcM-100",
      severity: "Sev3",
      title: "Catalog retry",
      description: "Catalog recovered after invalid JSON.",
      customerImpact: "Low",
      reportedTime: "{{daysAgo:1}}",
      clusterName: "cluster-retry",
      region: "eastus",
    },
    clusterContext: {
      name: "cluster-retry",
      version: "4.19.1",
      region: "eastus",
      nodeCount: 3,
      status: "Degraded",
      recentEvents: ["{{minutesAgo:10}} - event"],
      alerts: [
        {
          name: "AlertOne",
          severity: "warning",
          message: "warning message",
          firingTime: "{{minutesAgo:5}}",
        },
      ],
      upgradeHistory: [
        {
          from: "4.19.0",
          to: "4.19.1",
          status: "completed",
          timestamp: "{{daysAgo:2}}",
        },
      ],
    },
  });
}

describe("scenario catalog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "scenario-catalog-"));
    process.env.SCENARIO_CATALOG_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env.SCENARIO_CATALOG_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("retries loading after an initial catalog failure is fixed", async () => {
    await mkdir(join(tmpDir, "aks", "easy"), { recursive: true });
    const scenarioPath = join(tmpDir, "aks", "easy", "retryable.json");
    await writeFile(scenarioPath, "{");

    const catalogModule = await import("./scenario-catalog");

    await expect(
      catalogModule.getCatalogScenario({ platform: "aks", difficulty: "easy" }),
    ).rejects.toMatchObject({
      clientMessage: "Scenario catalog is invalid.",
    });

    await writeFile(scenarioPath, validScenarioJson("aks"));

    await expect(
      catalogModule.getCatalogScenario({ platform: "aks", difficulty: "easy" }),
    ).resolves.toMatchObject({
      id: "scenario_retryable",
      platform: "aks",
      difficulty: "easy",
    });
  });

  it("fails startup validation when any supported platform/difficulty pair has zero scenarios", async () => {
    await mkdir(join(tmpDir, "aro-classic", "easy"), { recursive: true });
    await writeFile(
      join(tmpDir, "aro-classic", "easy", "retryable.json"),
      validScenarioJson("aro-classic"),
    );

    const catalogModule = await import("./scenario-catalog");

    await expect(catalogModule.assertCatalogCoverage()).rejects.toMatchObject({
      clientMessage: "Scenario catalog is invalid.",
    });
  });

  it("rejects catalog platformContext keys that are not part of the runtime schema", async () => {
    await mkdir(join(tmpDir, "aks", "easy"), { recursive: true });
    await writeFile(
      join(tmpDir, "aks", "easy", "invalid-platform-context.json"),
      JSON.stringify({
        ...JSON.parse(validScenarioJson("aks")),
        platformContext: {
          nodePools: ["pool-a"],
        },
      }),
    );

    const catalogModule = await import("./scenario-catalog");

    await expect(
      catalogModule.getCatalogScenario({ platform: "aks", difficulty: "easy" }),
    ).rejects.toMatchObject({
      clientMessage: "Scenario catalog is invalid.",
    });
  });
});
