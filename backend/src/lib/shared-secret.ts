import { timingSafeEqual } from "node:crypto";

function normalizeSharedSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function matchesSharedSecret(
  providedSecret: string | undefined,
  expectedSecret: string | undefined,
): boolean {
  const normalizedProvided = normalizeSharedSecret(providedSecret);
  const normalizedExpected = normalizeSharedSecret(expectedSecret);

  if (!normalizedProvided || !normalizedExpected) {
    return false;
  }

  const providedBuffer = Buffer.from(normalizedProvided);
  const expectedBuffer = Buffer.from(normalizedExpected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}
