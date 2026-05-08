const ACTOR_REF_KEY = "sresim-actor-ref";
let inMemoryActorRef: string | null = null;

export function getOrCreateActorRef(): string {
  try {
    const existing = globalThis.localStorage?.getItem(ACTOR_REF_KEY)?.trim();
    if (existing) {
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
