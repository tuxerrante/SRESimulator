import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_RETRY_DELAY_MS = 10;

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

export async function acquireJsonProcessLock(
  lockPath: string,
  timeoutMs: number,
  label: string,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
      if (Date.now() >= deadline) {
        const timeoutError = new Error(
          `Timed out waiting for ${label} after ${timeoutMs}ms`,
        ) as Error & { cause?: unknown };
        timeoutError.cause = error;
        throw timeoutError;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    }
  }
}
