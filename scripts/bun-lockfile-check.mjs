#!/usr/bin/env node

import { readFileSync } from "node:fs";

function fail(message) {
  throw new Error(message);
}

function checkLockfile(relativePath) {
  const contents = readFileSync(relativePath, "utf8");

  if (!contents.includes('"lockfileVersion": 2')) {
    fail(`${relativePath}: expected Bun text lockfileVersion 2`);
  }
  if (!contents.includes('"packages": {')) {
    fail(`${relativePath}: expected package resolution block`);
  }
  if (/http:\/\//i.test(contents)) {
    fail(`${relativePath}: contains an insecure http:// source`);
  }
  if (/registry\.yarnpkg\.com|registry\.npmmirror\.com/i.test(contents)) {
    fail(`${relativePath}: contains a non-npm registry host`);
  }
  if (/\[[^\n]*@[^\n]*",\s*"https?:\/\//.test(contents)) {
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
