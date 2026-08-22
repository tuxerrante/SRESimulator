#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { assertBunTextLockfile } from "./bun-lockfile-format.mjs";

function fail(message) {
  throw new Error(message);
}

function checkLockfile(relativePath) {
  const contents = readFileSync(relativePath, "utf8");

  try {
    assertBunTextLockfile(contents, relativePath);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (/http:\/\//i.test(contents)) {
    fail(`${relativePath}: contains an insecure http:// source`);
  }
  if (/registry\.yarnpkg\.com|registry\.npmmirror\.com/i.test(contents)) {
    fail(`${relativePath}: contains a non-npm registry host`);
  }
  // Bun records a package's resolved source in the first tuple element as
  // `name@<source>` (e.g. `pkg@https://host/pkg.tgz` or `pkg@tarball:...`).
  // Reject any remote URL/tarball/git source so only registry versions pass.
  if (/"[^"\n]*@(?:https?:\/\/|tarball:|git\+|git:\/\/|github:)/i.test(contents)) {
    fail(`${relativePath}: contains a URL-based package source`);
  }
}

try {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    fail("Usage: bun-lockfile-check.mjs <lockfile> [...lockfile]");
  }
  for (const path of paths) {
    checkLockfile(path);
  }
  console.log(`Validated ${paths.length} Bun lockfile(s).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
