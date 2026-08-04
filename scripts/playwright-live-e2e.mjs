#!/usr/bin/env node

import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const frontendRoot = path.join(repoRoot, "frontend");
const require = createRequire(path.join(frontendRoot, "package.json"));
const { chromium } = require("playwright");

const baseUrl = process.env.LIVE_E2E_BASE_URL?.replace(/\/$/, "");
const secret = process.env.LIVE_E2E_AUTH_SESSION_SECRET;
const artifactDir = path.resolve(
  process.env.LIVE_E2E_ARTIFACT_DIR ??
    path.join(repoRoot, "data", "playwright-live-e2e"),
);
const viewerPrefix =
  process.env.LIVE_E2E_VIEWER_PREFIX ?? `live-e2e-${Date.now()}`;
const runNonce = process.env.LIVE_E2E_RUN_NONCE ?? randomUUID();

if (!baseUrl || !secret) {
  throw new Error(
    "LIVE_E2E_BASE_URL and LIVE_E2E_AUTH_SESSION_SECRET are required",
  );
}

const platforms = [
  {
    id: "aks",
    label: "AKS",
    cli: "kubectl",
    difficulty: /The Shift Lead/,
    expectedContext: ["Platformaks", "Node pools:", "Managed RG hint:"],
    forbiddenText: [/\bARO\b/i, /\bOpenShift\b/i, /\boc get\b/i],
  },
  {
    id: "aro-hcp",
    label: "ARO HCP",
    cli: "oc",
    difficulty: /The Junior SRE/,
    expectedContext: [
      "Platformaro-hcp",
      "Guest cluster:",
      "Hosted control plane namespace:",
      "Node pools:",
    ],
    forbiddenText: [/\bAKS\b/i, /\bkubectl\b/i],
  },
  {
    id: "aro-classic",
    label: "ARO Classic",
    cli: "oc",
    difficulty: /The Junior SRE/,
    expectedContext: ["Platformaro-classic", "Machines:"],
    forbiddenText: [/\bAKS\b/i, /\bkubectl\b/i, /\bHostedCluster\b/i],
  },
];

const allowedReferences = {
  aks: [
    "https://learn.microsoft.com/en-us/azure/aks/",
    "https://learn.microsoft.com/en-us/troubleshoot/azure/azure-kubernetes/",
    "https://learn.microsoft.com/en-us/azure/aks/support-policies",
    "https://kubernetes.io/docs/",
    "https://learn.microsoft.com/en-us/azure/azure-monitor/",
  ],
  "aro-hcp": [
    "https://learn.microsoft.com/en-us/azure/openshift/support-lifecycle",
    "https://github.com/Azure/ARO-HCP",
    "https://docs.openshift.com/container-platform/4.18/",
    "https://access.redhat.com/knowledgebase",
    "https://github.com/openshift/runbooks/tree/master/alerts",
  ],
  "aro-classic": [
    "https://learn.microsoft.com/en-us/azure/openshift/support-lifecycle",
    "https://learn.microsoft.com/en-us/azure/openshift/support-policies-v4",
    "https://docs.openshift.com/container-platform/4.18/",
    "https://access.redhat.com/knowledgebase",
    "https://github.com/openshift/runbooks/tree/master/alerts",
  ],
};

function createViewerToken(platformId) {
  const now = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      kind: "github",
      githubUserId: `${viewerPrefix}-${platformId}`,
      githubLogin: `${viewerPrefix}-${platformId}`,
      displayName: `Live E2E ${platformId}`,
      avatarUrl: null,
      issuedAt: now,
      expiresAt: now + 60 * 60 * 1000,
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function isAllowedReference(platform, href) {
  const candidate = new URL(href);
  return allowedReferences[platform].some((allowedHref) => {
    const allowed = new URL(allowedHref);
    const prefix = allowed.pathname.endsWith("/")
      ? allowed.pathname
      : `${allowed.pathname}/`;
    return (
      candidate.origin === allowed.origin &&
      (candidate.pathname === allowed.pathname ||
        candidate.pathname.startsWith(prefix))
    );
  });
}

async function waitForAssistant(page, previousCount) {
  await page.waitForFunction(
    (count) =>
      Array.from(document.querySelectorAll("div")).filter(
        (element) => element.textContent?.trim() === "Dungeon Master",
      ).length > count,
    previousCount,
    { timeout: 120_000 },
  );
  await page
    .getByText("Dungeon Master is thinking...", { exact: true })
    .waitFor({ state: "hidden", timeout: 120_000 })
    .catch(() => {});
}

async function sendChat(page, message) {
  const assistantLabels = page.getByText("Dungeon Master", { exact: true });
  const previousCount = await assistantLabels.count();
  const input = page.getByPlaceholder(
    "Describe what you want to investigate...",
  );
  await input.fill(message);
  await input.press("Enter");
  await waitForAssistant(page, previousCount);
  return assistantLabels.last().locator("xpath=..").innerText();
}

async function runAnonymousEntry(browser) {
  const startedAt = Date.now();
  const context = await browser.newContext({
    viewport: { width: 1800, height: 1100 },
    userAgent: `SRESimulator-Live-E2E/${viewerPrefix}-${runNonce}-anonymous`,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const failedResponses = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failedResponses.push({ status: response.status(), url: response.url() });
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    });
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
    const verificationButton = page.getByRole("button", {
      name: "Use local test verification",
    });
    await verificationButton.waitFor({ timeout: 30_000 });
    await verificationButton.click();
    await page
      .getByRole("button", { name: "Local test verification enabled" })
      .waitFor({ timeout: 10_000 });
    await page.getByLabel("Callsign").fill(`${viewerPrefix}-anonymous`);
    await page.getByRole("button", { name: /^AKS/ }).click();
    await page.getByRole("button", { name: /The Junior SRE/ }).click();
    await page.waitForURL("**/game", { timeout: 120_000 });
    const incidentTicket = page.locator('[data-tour="incident-ticket"]');
    await incidentTicket.waitFor({ timeout: 30_000 });
    const incident = (await incidentTicket.innerText())
      .replace(/\s+/g, " ")
      .trim();
    await page.screenshot({
      path: path.join(artifactDir, "anonymous-entry.png"),
      fullPage: true,
    });
    if (failedResponses.length > 0) {
      throw new Error(
        `anonymous entry observed HTTP 5xx: ${JSON.stringify(failedResponses)}`,
      );
    }
    if (failedRequests.length > 0) {
      throw new Error(
        `anonymous entry observed failed requests: ${JSON.stringify(failedRequests)}`,
      );
    }
    if (consoleErrors.length > 0) {
      throw new Error(
        `anonymous entry observed console errors: ${JSON.stringify(consoleErrors)}`,
      );
    }

    return {
      user: `${viewerPrefix}-anonymous`,
      platform: "aks",
      incident,
      verification: "passed",
      scenario: "passed",
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    await page.screenshot({
      path: path.join(artifactDir, "anonymous-entry-failure.png"),
      fullPage: true,
    });
    const diagnostics = {
      failedResponses,
      failedRequests,
      consoleErrors,
    };
    if (
      failedResponses.length + failedRequests.length + consoleErrors.length >
      0
    ) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}; captured diagnostics: ${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await context.close();
  }
}

async function runPlatform(browser, platform) {
  const startedAt = Date.now();
  const context = await browser.newContext({
    viewport: { width: 1800, height: 1100 },
  });
  await context.addCookies([
    {
      name: "sresim_viewer_session",
      value: createViewerToken(platform.id),
      url: baseUrl,
      httpOnly: true,
      secure: new URL(baseUrl).protocol === "https:",
      sameSite: "Lax",
    },
  ]);

  const page = await context.newPage();
  const consoleErrors = [];
  const failedResponses = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      failedResponses.push({ status: response.status(), url: response.url() });
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    });
  });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
    await page
      .getByText(`Signed in with GitHub as Live E2E ${platform.id}`, {
        exact: true,
      })
      .waitFor({ timeout: 30_000 });
    await page.getByLabel("Callsign").fill(`battle-${platform.id}`);
    await page
      .getByRole("button", { name: new RegExp(`^${platform.label}`) })
      .click();
    await page.getByRole("button", { name: platform.difficulty }).click();
    await page.waitForURL("**/game", { timeout: 120_000 });
    const incident = (
      await page.locator('[data-tour="incident-ticket"]').innerText()
    )
      .replace(/\s+/g, " ")
      .trim();

    await page
      .getByText(new RegExp(`live incident on ${platform.label}`))
      .waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Next/ }).click();
    await page.getByRole("button", { name: /^Next/ }).click();
    await page
      .getByText(new RegExp(`${platform.cli}/KQL commands`))
      .waitFor();
    await page.getByRole("button", { name: "Close tour" }).click();

    await page.getByRole("button", { name: "Dashboard" }).click();
    const dashboardText = (await page.locator("body").innerText())
      .replace(/\s+/g, "")
      .toLowerCase();
    for (const expected of platform.expectedContext) {
      if (
        !dashboardText.includes(expected.replace(/\s+/g, "").toLowerCase())
      ) {
        throw new Error(
          `${platform.id} dashboard missing expected context: ${expected}`,
        );
      }
    }

    const readingResponse = await sendChat(
      page,
      "I read the ticket and compared the symptom, customer impact, cluster version, region, alert timing, and recent events. I have not inferred a root cause yet. What inconsistency should I prioritize?",
    );
    const factsResponse = await sendChat(
      page,
      `I checked the Dashboard and compared active alerts, recent events, node status, and upgrade history. I am ready for facts gathering. Respond with exactly one read-only ${platform.cli} command in a fenced ${platform.cli} block, using scenario resources.`,
    );
    let assistantText = `${readingResponse}\n${factsResponse}`;
    let chatLinks = await page
      .locator('[data-tour="chat-panel"] a[href]')
      .evaluateAll((links) => links.map((link) => link.href));
    if (chatLinks.length === 0) {
      assistantText += `\n${await sendChat(
        page,
        "Before continuing, provide one clickable official documentation reference appropriate to this platform.",
      )}`;
      chatLinks = await page
        .locator('[data-tour="chat-panel"] a[href]')
        .evaluateAll((links) => links.map((link) => link.href));
    }

    for (const forbidden of platform.forbiddenText) {
      if (forbidden.test(assistantText)) {
        throw new Error(
          `${platform.id} response contained forbidden text: ${forbidden}`,
        );
      }
    }
    if (chatLinks.length === 0) {
      throw new Error(`${platform.id} produced no documentation links`);
    }
    for (const href of chatLinks) {
      if (!isAllowedReference(platform.id, href)) {
        throw new Error(`${platform.id} rendered an invalid link: ${href}`);
      }
    }

    const expectedLabel =
      platform.cli === "kubectl" ? "Kubernetes CLI" : "OpenShift CLI";
    const wrongLabel =
      platform.cli === "kubectl" ? "OpenShift CLI" : "Kubernetes CLI";
    const expectedCodeLabel = page.getByText(expectedLabel, { exact: true });
    await expectedCodeLabel.last().waitFor({ timeout: 60_000 });

    const wrongBlocks = page.getByText(
      new RegExp(`^${wrongLabel} \\(not valid for`),
    );
    for (let index = 0; index < (await wrongBlocks.count()); index += 1) {
      const block = wrongBlocks
        .nth(index)
        .locator('xpath=ancestor::div[contains(@class,"my-2")][1]');
      if ((await block.getByRole("button", { name: /^Run$/ }).count()) > 0) {
        throw new Error(`${platform.id} exposed a runnable invalid CLI`);
      }
    }

    const codeBlock = expectedCodeLabel
      .last()
      .locator('xpath=ancestor::div[contains(@class,"my-2")][1]');
    await codeBlock.getByRole("button", { name: /^Run$/ }).click();
    await page.getByRole("button", { name: "Terminal" }).click();
    await page
      .getByText("Simulating command execution...", { exact: true })
      .waitFor({ state: "hidden", timeout: 120_000 })
      .catch(() => {});
    await page
      .getByText("1 command", { exact: true })
      .waitFor({ timeout: 120_000 });

    await page.screenshot({
      path: path.join(artifactDir, `${platform.id}.png`),
      fullPage: true,
    });
    if (failedResponses.length > 0) {
      throw new Error(
        `${platform.id} observed HTTP 5xx: ${JSON.stringify(failedResponses)}`,
      );
    }
    if (failedRequests.length > 0) {
      throw new Error(
        `${platform.id} observed failed requests: ${JSON.stringify(failedRequests)}`,
      );
    }
    if (consoleErrors.length > 0) {
      throw new Error(
        `${platform.id} observed console errors: ${JSON.stringify(consoleErrors)}`,
      );
    }

    return {
      user: `${viewerPrefix}-${platform.id}`,
      platform: platform.id,
      incident,
      scenario: "passed",
      onboarding: "passed",
      dashboard: "passed",
      chat: "passed",
      links: chatLinks,
      command: "passed",
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    await page.screenshot({
      path: path.join(artifactDir, `${platform.id}-failure.png`),
      fullPage: true,
    });
    const diagnostics = {
      failedResponses,
      failedRequests,
      consoleErrors,
    };
    if (
      failedResponses.length + failedRequests.length + consoleErrors.length >
      0
    ) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}; captured diagnostics: ${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await context.close();
  }
}

await mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
let report;
try {
  const settled = await Promise.allSettled(
    [
      runAnonymousEntry(browser),
      ...platforms.map((platform) => runPlatform(browser, platform)),
    ],
  );
  const [anonymousEntryResult, ...platformResults] = settled;
  const results = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  const failures = platformResults.flatMap((result, index) =>
    result.status === "rejected"
      ? [{
          platform: platforms[index]?.id ?? "unknown",
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        }]
      : [],
  );
  if (anonymousEntryResult.status === "rejected") {
    failures.unshift({
      platform: "anonymous-entry",
      error:
        anonymousEntryResult.reason instanceof Error
          ? anonymousEntryResult.reason.message
          : String(anonymousEntryResult.reason),
    });
  }
  report = {
    mode: "parallel",
    simulatedUsers: platforms.length + 1,
    results,
    failures,
  };

} finally {
  await browser.close();
}

await writeFile(
  path.join(artifactDir, "results.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
if (report.failures.length > 0) {
  throw new Error(
    `Parallel live E2E failures: ${JSON.stringify(report.failures)}`,
  );
}
if (
  new Set(report.results.map((result) => result.incident)).size !==
  report.results.length
) {
  throw new Error("Parallel users did not receive distinct scenarios");
}
