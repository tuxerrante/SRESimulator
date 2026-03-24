import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "fs/promises";

const mockedReadFile = vi.mocked(readFile);

const MOCK_INVESTIGATION = `## The Five Phases
Overview of methodology

## 1. Reading
Read the ticket carefully`;

const MOCK_ALERTS = `## Cluster Availability & Health

### Cluster Shutdown & Failed Restart
- Symptoms: API pods offline
- Fix: Restart VMs

### Missing Master Node / Disturbed Indexing
- Symptoms: master-2 missing
- Fix: Redeploy machine

## Networking & Security

### DNS Issues
- Symptoms: DNS resolution failing
- Fix: Check CoreDNS`;

const MOCK_COMMUNITY = `## Networking

### Route Returns 503 After Applying NetworkPolicy
- Symptoms: route returns 503
- Root Cause: deny-by-default NetworkPolicy

## Node Health

### Node NotReady -- Kubelet or CRI-O Failure
- Symptoms: node NotReady
- Root Cause: kubelet crash`;

function setupMocks() {
  mockedReadFile.mockImplementation(async (filePath) => {
    const p = String(filePath);
    if (p.includes("sre-investigation-techniques")) return MOCK_INVESTIGATION;
    if (p.includes("Openshift-clusters-alerts-resolutions")) return MOCK_ALERTS;
    if (p.includes("Community-reported-issues")) return MOCK_COMMUNITY;
    throw new Error("Unknown file");
  });
}

describe("loadKnowledgeBase", () => {
  beforeEach(() => {
    vi.resetModules();
    mockedReadFile.mockReset();
  });

  it("loads and concatenates all knowledge base files", async () => {
    setupMocks();

    const { loadKnowledgeBase: freshLoad } = await import("./knowledge");
    const result = await freshLoad();

    expect(result).toContain("sre investigation techniques");
    expect(result).toContain("The Five Phases");
    expect(result).toContain("Cluster Availability");
    expect(result).toContain("Route Returns 503");
  });

  it("handles missing files gracefully", async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT"));

    const { loadKnowledgeBase: freshLoad } = await import("./knowledge");
    const result = await freshLoad();

    expect(result).toBe("");
  });
});

describe("loadKnowledgeSections", () => {
  beforeEach(() => {
    vi.resetModules();
    mockedReadFile.mockReset();
  });

  it("parses KB files into sections with titles and keywords", async () => {
    setupMocks();

    const { loadKnowledgeSections } = await import("./knowledge");
    const sections = await loadKnowledgeSections();

    expect(sections.length).toBeGreaterThan(0);

    const titles = sections.map((s) => s.title);
    expect(titles).toContain("The Five Phases");
    expect(titles).toContain("Cluster Shutdown & Failed Restart");
    expect(titles).toContain("Route Returns 503 After Applying NetworkPolicy");
  });

  it("caches sections after first load", async () => {
    setupMocks();

    const { loadKnowledgeSections } = await import("./knowledge");
    const first = await loadKnowledgeSections();
    const second = await loadKnowledgeSections();

    expect(first).toBe(second);
  });
});

describe("queryKnowledgeSections", () => {
  beforeEach(() => {
    vi.resetModules();
    mockedReadFile.mockReset();
  });

  it("always includes investigation methodology sections", async () => {
    setupMocks();

    const { loadKnowledgeSections, queryKnowledgeSections } = await import("./knowledge");
    const sections = await loadKnowledgeSections();
    const result = queryKnowledgeSections(sections, ["unrelated query"], 8000);

    expect(result).toContain("The Five Phases");
    expect(result).toContain("Reading");
  });

  it("selects sections matching scenario keywords", async () => {
    setupMocks();

    const { loadKnowledgeSections, queryKnowledgeSections } = await import("./knowledge");
    const sections = await loadKnowledgeSections();
    const result = queryKnowledgeSections(
      sections,
      ["NetworkPolicy route 503"],
      8000,
    );

    expect(result).toContain("Route Returns 503");
  });

  it("respects maxChars limit", async () => {
    setupMocks();

    const { loadKnowledgeSections, queryKnowledgeSections } = await import("./knowledge");
    const sections = await loadKnowledgeSections();
    const result = queryKnowledgeSections(sections, ["everything"], 500);

    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("truncates investigation text when it alone exceeds maxChars", async () => {
    setupMocks();

    const { loadKnowledgeSections, queryKnowledgeSections } = await import("./knowledge");
    const sections = await loadKnowledgeSections();
    const result = queryKnowledgeSections(sections, ["NetworkPolicy 503"], 30);

    expect(result.length).toBeLessThanOrEqual(30);
  });
});
