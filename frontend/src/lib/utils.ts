import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Converts an ISO 8601 timestamp into a human-readable relative string
 * (e.g. "5m ago", "3h ago", "2d ago", "just now").
 * Returns the raw value if it cannot be parsed.
 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;

  const diffMs = Date.now() - date.getTime();
  const absDiffMs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? "ago" : "from now";

  const seconds = Math.floor(absDiffMs / 1000);
  if (seconds < 60) return diffMs >= 0 ? "just now" : `<1m ${suffix}`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${suffix}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${suffix}`;

  const days = Math.floor(hours / 24);
  return `${days}d ${suffix}`;
}

/**
 * Formats an ISO 8601 timestamp as a concise local date-time
 * (e.g. "Mar 23, 14:05").
 */
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;

  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const mins = String(date.getMinutes()).padStart(2, "0");
  return `${month} ${day}, ${hours}:${mins}`;
}
