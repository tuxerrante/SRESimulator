"use client";

import { cn } from "@/lib/utils";
import {
  PLATFORM_IDS,
  PLATFORM_PROFILES,
  type PlatformId,
} from "@shared/types/platform";

interface PlatformSelectorProps {
  value: PlatformId;
  onChange: (platform: PlatformId) => void;
}

export function PlatformSelector({
  value,
  onChange,
}: PlatformSelectorProps) {
  return (
    <div className="mb-6 w-full max-w-3xl">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Platform
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {PLATFORM_IDS.map((platform) => {
          const profile = PLATFORM_PROFILES[platform];
          const active = value === platform;

          return (
            <button
              key={platform}
              type="button"
              onClick={() => onChange(platform)}
              className={cn(
                "rounded-xl border p-4 text-left transition-all",
                active
                  ? "border-amber-600 bg-amber-950/30 shadow-[0_0_0_1px_rgba(217,119,6,0.35)]"
                  : "border-zinc-800 bg-zinc-900/70 hover:border-zinc-700 hover:bg-zinc-900",
              )}
            >
              <div className="text-sm font-semibold text-zinc-100">
                {profile.label}
              </div>
              <div className="mt-1 text-xs text-zinc-400">
                Primary CLI: {profile.primaryCli}
              </div>
              <div className="mt-2 text-xs leading-relaxed text-zinc-500">
                {profile.description}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
