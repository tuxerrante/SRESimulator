export function isBunTextLockfile(contents) {
  return (
    typeof contents === "string" &&
    contents.includes('"lockfileVersion": 2') &&
    contents.includes('"configVersion":') &&
    contents.includes('"workspaces": {') &&
    contents.includes('"packages": {')
  );
}

export function assertBunTextLockfile(contents, source) {
  if (!isBunTextLockfile(contents)) {
    throw new Error(`${source} is not a Bun text lockfile`);
  }
}

// Registry values permitted in a package tuple's second element. Bun records
// the resolving registry there: "" means the default npm registry. Only the
// default (empty) value and explicitly approved registries may pass; every
// other value (an arbitrary, possibly attacker-controlled registry URL) is
// rejected so `bun install` can only fetch from trusted registries.
export const DEFAULT_ALLOWED_REGISTRIES = Object.freeze([
  "",
  "https://registry.npmjs.org/",
  "https://registry.npmjs.org",
]);

// Removes JSONC trailing commas (which Bun emits) so the file parses as JSON,
// without touching commas that appear inside string literals.
function stripTrailingCommas(jsonc) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonc.length; i += 1) {
    const char = jsonc[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < jsonc.length && /\s/.test(jsonc[j])) j += 1;
      if (jsonc[j] === "}" || jsonc[j] === "]") continue;
    }
    out += char;
  }
  return out;
}

// Returns the registry values (second tuple element) that are not allow-listed.
// In Bun's text lockfile every package entry is `"name": ["name@source",
// "<registry>", {deps}, "integrity"]`, so the second string element is the
// registry the package resolves from. The whole lockfile is parsed structurally
// and only its top-level `packages` object is inspected, so nested arrays in the
// deps object (e.g. "os"/"cpu"), workspace "trustedDependencies", and any string
// that merely contains the text `"packages":` can never be mistaken for a tuple.
export function collectDisallowedRegistries(
  contents,
  allowed = DEFAULT_ALLOWED_REGISTRIES,
) {
  let lockfile;
  try {
    lockfile = JSON.parse(stripTrailingCommas(contents));
  } catch (error) {
    throw new Error(
      `Bun lockfile is not parseable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const packages = lockfile?.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("Bun lockfile has no packages object");
  }
  const allowedSet = new Set(allowed);
  const disallowed = new Set();
  for (const tuple of Object.values(packages)) {
    if (!Array.isArray(tuple) || tuple.length < 2) continue;
    const registry = tuple[1];
    if (typeof registry !== "string") continue;
    if (!allowedSet.has(registry)) disallowed.add(registry);
  }
  return [...disallowed];
}
