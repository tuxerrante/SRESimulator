import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "fs/promises";

const mockedReadFile = vi.mocked(readFile);

describe("loadKnowledgeBase", () => {
  beforeEach(() => {
    vi.resetModules();
    mockedReadFile.mockReset();
  });

  it("loads and concatenates all knowledge base files", async () => {
    mockedReadFile.mockImplementation(async (filePath) => {
      const p = String(filePath);
      if (p.includes("sre-investigation-techniques"))
        return "# SRE Techniques\nContent A";
      if (p.includes("Openshift-clusters-alerts-resolutions"))
        return "# Alerts\nContent B";
      if (p.includes("Community-reported-issues"))
        return "# Community\nContent C";
      throw new Error("Unknown file");
    });

    const { loadKnowledgeBase: freshLoad } = await import("./knowledge");
    const result = await freshLoad();

    expect(result).toContain("sre investigation techniques");
    expect(result).toContain("Content A");
    expect(result).toContain("Content B");
    expect(result).toContain("Content C");
  });

  it("handles missing files gracefully", async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT"));

    const { loadKnowledgeBase: freshLoad } = await import("./knowledge");
    const result = await freshLoad();

    expect(result).toBe("");
  });
});
