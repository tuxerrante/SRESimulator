function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashFingerprintSeed(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return toHex(digest);
}

export async function collectBrowserFingerprintHash(): Promise<string> {
  const seed = [
    navigator.userAgent,
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    `${window.screen.width}x${window.screen.height}`,
    String(window.screen.colorDepth),
    String(navigator.hardwareConcurrency ?? 0),
    String(window.devicePixelRatio ?? 1),
    String(navigator.maxTouchPoints ?? 0),
  ].join("|");

  return hashFingerprintSeed(seed);
}
