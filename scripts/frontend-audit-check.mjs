#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const severityRank = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

function requireArgValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    frontendDir: "frontend",
    auditLevel: "high",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      options.root = path.resolve(requireArgValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--frontend-dir") {
      options.frontendDir = requireArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--audit-level") {
      options.auditLevel = requireArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!(options.auditLevel in severityRank)) {
    throw new Error(
      `Unsupported audit level '${options.auditLevel}'. Expected one of ${Object.keys(severityRank).join(", ")}`
    );
  }

  return options;
}

function loadPolicy(root, frontendDir) {
  const policyPath = path.join(root, frontendDir, "audit-policy-exceptions.json");
  return JSON.parse(readFileSync(policyPath, "utf8"));
}

function normalizeVia(via) {
  if (!Array.isArray(via)) {
    return [];
  }

  return via
    .map((item) =>
      typeof item === "string" ? item : item?.name ?? item?.title ?? "unknown"
    )
    .sort();
}

function findMatchingException(vulnerability, policy) {
  const actualVia = normalizeVia(vulnerability.via);

  return (policy.exceptions ?? []).find((entry) => {
    const expectedVia = normalizeVia(entry.via);
    return (
      entry.name === vulnerability.name &&
      (entry.severity === undefined || entry.severity === vulnerability.severity) &&
      (entry.range === undefined || entry.range === (vulnerability.range ?? "")) &&
      expectedVia.length === actualVia.length &&
      expectedVia.every((item, index) => item === actualVia[index])
    );
  });
}

function runAudit(frontendPath) {
  const result =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "bun audit --json"], {
          cwd: frontendPath,
          encoding: "utf8",
        })
      : spawnSync("bun", ["audit", "--json"], {
          cwd: frontendPath,
          encoding: "utf8",
        });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout?.trim();
  if (!stdout) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `bun audit --json did not return JSON output.${stderr ? ` stderr: ${stderr}` : ""}`
    );
  }

  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `Failed to parse bun audit JSON output: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function summarizeVulnerabilities(report, policy, minimumSeverity) {
  const considered = [];
  const excepted = [];
  const blocking = [];

  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    if (!vulnerability || typeof vulnerability !== "object") {
      continue;
    }

    const name = vulnerability.name;
    const severity = vulnerability.severity ?? "info";
    if (!(severity in severityRank)) {
      continue;
    }
    if (severityRank[severity] < severityRank[minimumSeverity]) {
      continue;
    }

    const entry = {
      name,
      severity,
      via: normalizeVia(vulnerability.via).join(", "),
      range: vulnerability.range ?? "",
      fixAvailable: vulnerability.fixAvailable ?? false,
    };
    considered.push(entry);

    const matchingException = findMatchingException(vulnerability, policy);
    if (matchingException) {
      excepted.push({
        ...entry,
        reason: matchingException.reason ?? "No reason recorded.",
      });
      continue;
    }

    blocking.push(entry);
  }

  return { considered, excepted, blocking };
}

function printSummary(policy, minimumSeverity, report, summary) {
  const metadata = report.metadata?.vulnerabilities ?? {};
  console.log(`Frontend audit policy: ${policy.policyName}`);
  console.log(`Approved on: ${policy.approvedOn}`);
  console.log(`Review by: ${policy.reviewBy}`);
  console.log(`Gate threshold: ${minimumSeverity}`);
  console.log(
    `Raw bun audit counts: high=${metadata.high ?? 0}, critical=${metadata.critical ?? 0}, moderate=${metadata.moderate ?? 0}, total=${metadata.total ?? 0}`
  );
  console.log(
    `Filtered findings at or above ${minimumSeverity}: ${summary.considered.length} (${summary.excepted.length} excepted, ${summary.blocking.length} blocking)`
  );

  if (summary.excepted.length > 0) {
    console.log("Approved exception packages:");
    for (const entry of summary.excepted) {
      console.log(`- ${entry.name} [${entry.severity}]`);
      console.log(`  reason: ${entry.reason}`);
      if (entry.via) {
        console.log(`  via: ${entry.via}`);
      }
    }
  }

  if (summary.blocking.length > 0) {
    console.error("Blocking frontend audit findings:");
    for (const entry of summary.blocking) {
      console.error(`- ${entry.name} [${entry.severity}]`);
      if (entry.via) {
        console.error(`  via: ${entry.via}`);
      }
      if (entry.range) {
        console.error(`  range: ${entry.range}`);
      }
      if (entry.fixAvailable) {
        console.error(`  fixAvailable: ${JSON.stringify(entry.fixAvailable)}`);
      }
    }
  }
}

function main() {
  const { root, frontendDir, auditLevel } = parseArgs(process.argv.slice(2));
  const frontendPath = path.join(root, frontendDir);
  const policy = loadPolicy(root, frontendDir);
  const report = runAudit(frontendPath);
  const summary = summarizeVulnerabilities(report, policy, auditLevel);

  printSummary(policy, auditLevel, report, summary);

  if (summary.blocking.length > 0) {
    process.exit(1);
  }

  const expectedCount = policy.expectedCounts?.[auditLevel];
  const actualCount = report.metadata?.vulnerabilities?.[auditLevel] ?? 0;
  if (typeof expectedCount === "number" && Number.isFinite(expectedCount)) {
    if (actualCount > expectedCount) {
      console.error(
        `Expected at most ${expectedCount} ${auditLevel} vulnerabilities in the approved frontend exception set, found ${actualCount}.`
      );
      process.exit(1);
    }
    if (actualCount < expectedCount) {
      console.log(
        `Observed ${actualCount} ${auditLevel} vulnerabilities, below the approved exception ceiling of ${expectedCount}.`
      );
    }
  }

  console.log("Frontend audit passed with only approved exception packages remaining.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
