#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  assertBunTextLockfile,
  collectDisallowedRegistries,
} from "./bun-lockfile-format.mjs";

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
  // Bun records a package's resolved source in the first tuple element as
  // `name@<source>` (e.g. `pkg@https://host/pkg.tgz` or `pkg@tarball:...`).
  // Reject any non-registry source — remote URL/tarball/git as well as local
  // file/link/workspace schemes — so only registry versions pass the gate.
  if (
    /"[^"\n]*@(?:https?:\/\/|tarball:|git\+|git:\/\/|github:|file:|link:|workspace:)/i.test(
      contents
    )
  ) {
    fail(`${relativePath}: contains a non-registry package source`);
  }
  // The second tuple element records the registry a package resolves from.
  // Allow-list only the default npm registry (and explicitly approved ones);
  // reject any other registry so `bun install` cannot fetch from an arbitrary,
  // possibly attacker-controlled host.
  const disallowedRegistries = collectDisallowedRegistries(contents);
  if (disallowedRegistries.length > 0) {
    fail(
      `${relativePath}: contains a non-allow-listed registry source ` +
        `(${disallowedRegistries.map((value) => JSON.stringify(value)).join(", ")})`
    );
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
