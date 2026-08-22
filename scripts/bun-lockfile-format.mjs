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
