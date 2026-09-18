"use client";

/** Shape of `GET /api/ai/budget`. Every field is server-computed and public. */
export interface AiBudgetSnapshot {
  enabled: boolean;
  dailyLimit: number;
  dailyRemaining: number;
  minuteLimit: number;
  minuteRemaining: number;
  degraded: boolean;
  resetAt: string | null;
  upstream: { dailyLimit: number | null; dailyRemaining: number | null } | null;
}

/** Warn only once a fifth of the day's shared requests is left. */
const LOW_BUDGET_FRACTION = 0.2;

interface Remaining {
  remaining: number;
  limit: number;
}

/**
 * The provider's own count wins when it is available: the local counter only
 * knows what this process served, and the account is shared with anything else
 * using the same key.
 */
function resolveRemaining(snapshot: AiBudgetSnapshot): Remaining {
  const upstreamRemaining = snapshot.upstream?.dailyRemaining;
  const upstreamLimit = snapshot.upstream?.dailyLimit;
  if (typeof upstreamRemaining === "number") {
    return {
      remaining: upstreamRemaining,
      limit: typeof upstreamLimit === "number" ? upstreamLimit : snapshot.dailyLimit,
    };
  }
  return { remaining: snapshot.dailyRemaining, limit: snapshot.dailyLimit };
}

function formatResetAt(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const parsed = new Date(resetAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function AiBudgetBanner({ snapshot }: { snapshot: AiBudgetSnapshot | null }) {
  if (!snapshot?.enabled) {
    return null;
  }

  const { remaining, limit } = resolveRemaining(snapshot);
  const exhausted = snapshot.degraded || remaining <= 0;
  const low = limit > 0 && remaining <= limit * LOW_BUDGET_FRACTION;

  // Healthy is silent on purpose: a banner that is always there is one nobody
  // reads when it finally says something.
  if (!exhausted && !low) {
    return null;
  }

  const resetLabel = formatResetAt(snapshot.resetAt);

  return (
    <div
      role="status"
      className="mt-6 px-4 py-2 rounded-lg bg-amber-950/50 border border-amber-800/50 text-amber-400 text-sm max-w-md text-center"
    >
      {exhausted
        ? `The shared AI budget for today is spent, so answers are simulated${
            resetLabel ? ` until ${resetLabel}` : ""
          }. Everything else still works.`
        : `The shared AI budget is running low: ${remaining} of ${limit} requests left today.`}
    </div>
  );
}
