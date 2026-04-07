/**
 * Global simulation clock — single source of truth for "now" across all
 * backend layers (scenario generation, command simulation, chat prompts).
 *
 * Bound to real wall-clock time in UTC so that ticket timestamps (days ago),
 * alert firing times (minutes/hours ago), and command output all share
 * the same temporal reference.
 */

export function utcNow(): string {
  return new Date().toISOString();
}

export function utcOffsetMinutes(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();
}

export function utcDaysAgo(minDays = 1, maxDays = 7): string {
  const lo = Math.max(0, Math.min(minDays, maxDays));
  const hi = Math.max(minDays, maxDays);
  const days = lo + Math.floor(Math.random() * (hi - lo + 1));
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
