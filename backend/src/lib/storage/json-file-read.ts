import { readFile } from "node:fs/promises";

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/**
 * Reads a JSON store file, returning `null` when it does not exist yet.
 *
 * The JSON stores create their backing file through an atomic tmp-file rename,
 * so "missing" is a normal state before the first write rather than an error.
 * Callers substitute their own empty value, which keeps the absent-file case
 * off the `JSON.parse` path entirely.
 */
export async function readJsonFileOrEmpty(
  filePath: string,
): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}
