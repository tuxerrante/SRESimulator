function serverErrorFromRaw(status: number, raw: string): Error {
  return new Error(`Server error (${status}): ${raw.slice(0, 120)}`);
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error("Response was not a JSON object");
}

export async function fetchJsonObject(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallbackErrorMessage: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(input, init);
  const raw = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(raw);
  } catch {
    throw serverErrorFromRaw(response.status, raw);
  }
  if (!response.ok) {
    throw new Error(
      typeof parsed.error === "string" ? parsed.error : fallbackErrorMessage,
    );
  }
  return parsed;
}
