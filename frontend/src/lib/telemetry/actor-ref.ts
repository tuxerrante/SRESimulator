const ACTOR_REF_KEY = "sresim-actor-ref";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let inMemoryActorRef: string | null = null;

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

  const created = inMemoryActorRef ?? crypto.randomUUID();
  inMemoryActorRef = created;

  try {
    globalThis.localStorage?.setItem(ACTOR_REF_KEY, created);
  } catch {
    // Ignore blocked storage and keep the page-load fallback.
  }

  return created;
}
