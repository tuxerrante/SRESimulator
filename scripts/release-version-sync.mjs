#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const VERSION_FILES = {
  frontendPackage: "frontend/package.json",
  frontendLockfile: "frontend/package-lock.json",
  backendPackage: "backend/package.json",
  backendLockfile: "backend/package-lock.json",
  chart: "helm/sre-simulator/Chart.yaml",
  releaseMeta: "frontend/src/lib/release.ts",
  changelog: "CHANGELOG.md",
};

function fail(message) {
  throw new Error(message);
}

function requireArgValue(flag, value) {
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (!mode || !["verify", "prepare"].includes(mode)) {
    fail("Usage: release-version-sync.mjs <verify|prepare> --tag vX.Y.Z [--root PATH]");
  }

  let tag = "";
  let root = process.cwd();

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--tag") {
      tag = requireArgValue("--tag", rest[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--root") {
      root = path.resolve(requireArgValue("--root", rest[index + 1]));
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    fail(`Release tag is not semver: ${tag}`);
  }

  return { mode, tag, root, version: tag.slice(1) };
}

function readFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  return fs.readFileSync(filePath, "utf8");
}

function writeFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  fs.writeFileSync(filePath, contents);
}

function updatePackageVersion(root, relativePath, version) {
  const pkg = JSON.parse(readFile(root, relativePath));
  pkg.version = version;
  writeFile(root, relativePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function updateLockfileVersion(root, relativePath, version) {
  const lockfile = JSON.parse(readFile(root, relativePath));
  lockfile.version = version;
  if (lockfile.packages?.[""]) {
    lockfile.packages[""].version = version;
  }
  writeFile(root, relativePath, `${JSON.stringify(lockfile, null, 2)}\n`);
}

function replaceOrFail(content, pattern, replacement, errorMessage) {
  if (!pattern.test(content)) {
    fail(errorMessage);
  }
  return content.replace(pattern, replacement);
}

function updateChartVersion(root, version) {
  const chart = readFile(root, VERSION_FILES.chart);
  const updatedVersion = replaceOrFail(
    chart,
    /^version:\s*[0-9]+\.[0-9]+\.[0-9]+\s*$/m,
    `version: ${version}`,
    `Failed to update ${VERSION_FILES.chart}: expected version line not found`
  );
  const updated = replaceOrFail(
    updatedVersion,
    /^appVersion:\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m,
    `appVersion: "${version}"`,
    `Failed to update ${VERSION_FILES.chart}: expected appVersion line not found`
  );

  writeFile(root, VERSION_FILES.chart, updated);
}

function updateReleaseMeta(root, tag) {
  const releaseMeta = readFile(root, VERSION_FILES.releaseMeta);
  const updated = replaceOrFail(
    releaseMeta,
    /APP_VERSION\s*=\s*"[^"]+"/,
    `APP_VERSION = "${tag}"`,
    `Failed to update ${VERSION_FILES.releaseMeta}: expected APP_VERSION assignment not found`
  );
  writeFile(root, VERSION_FILES.releaseMeta, updated);
}

function readVersionState(root) {
  const frontendPkg = JSON.parse(readFile(root, VERSION_FILES.frontendPackage));
  const frontendLockfile = JSON.parse(
    readFile(root, VERSION_FILES.frontendLockfile)
  );
  const backendPkg = JSON.parse(readFile(root, VERSION_FILES.backendPackage));
  const backendLockfile = JSON.parse(readFile(root, VERSION_FILES.backendLockfile));
  const chart = readFile(root, VERSION_FILES.chart);
  const releaseMeta = readFile(root, VERSION_FILES.releaseMeta);

  const chartVersion = (
    chart.match(/^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m) || []
  )[1];
  const chartAppVersion = (
    chart.match(/^appVersion:\s*"([0-9]+\.[0-9]+\.[0-9]+)"\s*$/m) || []
  )[1];
  const appVersion = (
    releaseMeta.match(/APP_VERSION\s*=\s*"([^"]+)"/) || []
  )[1];

  return {
    frontendPackageVersion: frontendPkg.version,
    frontendLockfileVersion: frontendLockfile.version,
    frontendLockfileRootVersion: frontendLockfile.packages?.[""]?.version,
    backendPackageVersion: backendPkg.version,
    backendLockfileVersion: backendLockfile.version,
    backendLockfileRootVersion: backendLockfile.packages?.[""]?.version,
    chartVersion,
    chartAppVersion,
    appVersion,
  };
}

function verifyChangelog(root, version) {
  const changelog = readFile(root, VERSION_FILES.changelog);
  const lines = changelog.split("\n");
  const header = `## [${version}]`;
  const startIndex = lines.findIndex((line) => line.startsWith(header));
  if (startIndex === -1) {
    fail(`No changelog notes found for ${version}`);
  }

  const sectionLines = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## [")) {
      break;
    }
    sectionLines.push(line);
  }

  if (!/\S/.test(sectionLines.join("\n").trim())) {
    fail(`No changelog notes found for ${version}`);
  }
}

function verifyState(state, tag, version) {
  const checks = [
    ["frontend/package.json", state.frontendPackageVersion, version],
    ["frontend/package-lock.json", state.frontendLockfileVersion, version],
    [
      'frontend/package-lock.json packages[""].version',
      state.frontendLockfileRootVersion,
      version,
    ],
    ["backend/package.json", state.backendPackageVersion, version],
    ["backend/package-lock.json", state.backendLockfileVersion, version],
    [
      'backend/package-lock.json packages[""].version',
      state.backendLockfileRootVersion,
      version,
    ],
    ["helm/sre-simulator/Chart.yaml version", state.chartVersion, version],
    ["helm/sre-simulator/Chart.yaml appVersion", state.chartAppVersion, version],
    ["frontend/src/lib/release.ts APP_VERSION", state.appVersion, tag],
  ];

  for (const [source, actual, expected] of checks) {
    if (!actual) {
      fail(`Missing version value in ${source}`);
    }
    if (actual !== expected) {
      fail(`${source} mismatch: ${actual} != ${expected}`);
    }
  }
}

function main() {
  const { mode, tag, root, version } = parseArgs(process.argv.slice(2));

  verifyChangelog(root, version);

  if (mode === "prepare") {
    updatePackageVersion(root, VERSION_FILES.frontendPackage, version);
    updateLockfileVersion(root, VERSION_FILES.frontendLockfile, version);
    updatePackageVersion(root, VERSION_FILES.backendPackage, version);
    updateLockfileVersion(root, VERSION_FILES.backendLockfile, version);
    updateChartVersion(root, version);
    updateReleaseMeta(root, tag);
    console.log(`Updated release version surfaces for ${tag}.`);
    return;
  }

  const state = readVersionState(root);
  verifyState(state, tag, version);
  console.log(`Semver surfaces aligned for ${tag}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
