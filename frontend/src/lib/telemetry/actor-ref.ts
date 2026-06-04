const ACTOR_REF_KEY = "sresim-actor-ref";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let inMemoryActorRef: string | null = null;

function createFallbackUuid(): string {
  const randomHex = () =>
    Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, "0");
  const variantNibble = (
    (Number.parseInt(randomHex().slice(0, 1), 16) & 0x3) | 0x8
  ).toString(16);

  return [
    randomHex(),
    randomHex().slice(0, 4),
    `4${randomHex().slice(1, 4)}`,
    `${variantNibble}${randomHex().slice(1, 4)}`,
    `${randomHex()}${randomHex().slice(0, 4)}`,
  ].join("-");
}

function createSafeActorRef(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return createFallbackUuid();
  }
}

export function getOrCreateActorRef(): string {
  try {
    const existing = globalThis.localStorage?.getItem(ACTOR_REF_KEY)?.trim();
    if (existing && UUID_PATTERN.test(existing)) {
      inMemoryActorRef = existing;
      return existing;
    }
  } catch {
    if (inMemoryActorRef) {
      return inMemoryActorRef;
    }
  }

  const created = inMemoryActorRef ?? createSafeActorRef();
  inMemoryActorRef = created;

  try {
    globalThis.localStorage?.setItem(ACTOR_REF_KEY, created);
  } catch {
    // Ignore blocked storage and keep the page-load fallback.
  }

  return created;
}
