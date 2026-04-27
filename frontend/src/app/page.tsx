"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useGameStore } from "@/stores/gameStore";
import type { Difficulty, Scenario } from "@shared/types/game";
import { Shield, Loader2, Trophy, Heart, User, LogOut } from "lucide-react";
import { Github } from "@/components/icons/Github";
import { DifficultyGrid } from "@/components/home/DifficultyGrid";
import { TurnstileWidget } from "@/components/home/TurnstileWidget";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { APP_VERSION, HOME_FEATURE_HIGHLIGHTS } from "@/lib/release";
import { getAnonymousVerificationMessage } from "@/lib/auth/anonymous-verification";
import { collectBrowserFingerprintHash } from "@/lib/auth/fingerprint";
import { buildScenarioRequestBody } from "@/lib/auth/scenario-request";

export default function HomePage() {
  const router = useRouter();
  const startGame = useGameStore((s) => s.startGame);
  const nickname = useGameStore((s) => s.nickname);
  const setNickname = useGameStore((s) => s.setNickname);
  const hydrateNickname = useGameStore((s) => s.hydrateNickname);
  const viewer = useGameStore((s) => s.viewer);
  const setViewer = useGameStore((s) => s.setViewer);
  const clearViewer = useGameStore((s) => s.clearViewer);
  const [loading, setLoading] = useState<Difficulty | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [authConfigured, setAuthConfigured] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionLoadError, setSessionLoadError] = useState(false);
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const hasCallsign = Boolean(nickname);
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const anonymousVerificationMessage = getAnonymousVerificationMessage({
    turnstileConfigured: Boolean(turnstileSiteKey),
    turnstileVerified: Boolean(turnstileToken),
  });

  useEffect(() => {
    hydrateNickname();

    void (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to load player session");
        }

        const data = (await response.json()) as {
          viewer: {
            kind: "github";
            githubUserId: string;
            githubLogin: string;
            displayName: string;
            avatarUrl: string | null;
          } | null;
          authConfigured: boolean;
        };

        setSessionLoadError(false);
        setAuthConfigured(data.authConfigured);
        if (data.viewer) {
          setViewer(data.viewer);
        } else {
          clearViewer();
        }
      } catch {
        setSessionLoadError(true);
        setAuthConfigured(false);
        clearViewer();
      } finally {
        setSessionReady(true);
      }
    })();

    const params = new URLSearchParams(window.location.search);
    const authError = params.get("error");
    if (authError) {
      setError("GitHub sign-in failed. Please try again.");
      window.history.replaceState({}, "", "/");
    }
  }, [clearViewer, hydrateNickname, setViewer]);

  useEffect(() => {
    if (!sessionReady) {
      setFingerprintHash(null);
      setTurnstileToken(null);
      return;
    }

    if (viewer) {
      setFingerprintHash(null);
      setTurnstileToken(null);
      return;
    }

    let cancelled = false;
    void collectBrowserFingerprintHash()
      .then((hash) => {
        if (!cancelled) {
          setFingerprintHash(hash);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Unable to prepare anonymous browser verification.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionReady, viewer]);

  const handleSelect = async (difficulty: Difficulty) => {
    if (!sessionReady) {
      setError("Still loading access options. Please wait a moment.");
      return;
    }

    if (sessionLoadError) {
      setError("Unable to load access options. Refresh the page and try again.");
      return;
    }

    if (!viewer && difficulty === "easy" && (!fingerprintHash || !turnstileToken)) {
      setError("Complete the captcha check to start an anonymous Easy run.");
      return;
    }

    setLoading(difficulty);
    setError(null);

    try {
      const response = await fetch("/api/scenario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildScenarioRequestBody({
            difficulty,
            viewer,
            fingerprintHash,
            turnstileToken,
          })
        ),
      });

      const raw = await response.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Server error (${response.status}): ${raw.slice(0, 120)}`);
      }

      if (!response.ok) {
        throw new Error((parsed.error as string) || "Failed to generate scenario");
      }

      const { scenario, sessionToken } = parsed as unknown as { scenario: Scenario; sessionToken: string };
      startGame(scenario, sessionToken);
      router.push("/game");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(null);
    }
  };

  const handleLogout = async () => {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        throw new Error("Failed to sign out");
      }
      clearViewer();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign out");
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="mb-4 inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
          AI-guided incident response training
        </div>
        <div className="flex items-center gap-3 mb-2">
          <Shield size={36} className="text-amber-500" />
          <h1 className="text-4xl font-bold tracking-tight text-zinc-100">SRE Simulator</h1>
        </div>
        <p className="text-zinc-200 text-center mb-2 max-w-xl text-lg">
          Learn to investigate outages before they hit production.
        </p>
        <p className="text-zinc-300 text-sm text-center mb-10 max-w-lg leading-relaxed">
          An AI Dungeon Master will break a cluster. Your job is to investigate
          and fix it using the proper SRE methodology for Azure Red Hat
          OpenShift.
        </p>

        <div className="flex items-center gap-2 mb-8 w-full max-w-xs">
          <User size={18} className="text-zinc-500 shrink-0" />
          <input
            type="text"
            value={nickname ?? ""}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Enter your callsign"
            aria-label="Callsign"
            maxLength={20}
            className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-600 transition-colors"
          />
        </div>
        {!hasCallsign && (
          <p className="mb-8 -mt-5 text-xs text-zinc-400">
            Enter a callsign to unlock scenarios.
          </p>
        )}

        <div className="mb-6 w-full max-w-3xl rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
          {!sessionReady ? (
            <div className="text-sm text-zinc-400">Loading access options...</div>
          ) : sessionLoadError ? (
            <div className="text-sm text-red-300">
              Unable to load access options. Refresh the page to continue.
            </div>
          ) : viewer ? (
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-sm font-semibold text-zinc-100">
                  Signed in with GitHub as {viewer.displayName}
                </div>
                <div className="text-xs text-zinc-400">
                  @{viewer.githubLogin} can access all difficulties and keep persistent best scores.
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                <LogOut size={14} />
                Sign out
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-sm font-semibold text-zinc-100">
                  Anonymous trial mode
                </div>
                <div className="text-xs text-zinc-400">
                  Guests can play one Easy scenario per day. GitHub login unlocks Medium, Hard, and persistent best scores.
                </div>
              </div>
              {authConfigured ? (
                <Link
                  href="/api/auth/github/login"
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-500"
                >
                  <Github size={16} />
                  Sign in with GitHub
                </Link>
              ) : (
                <button
                  type="button"
                  disabled
                  className="inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-500"
                >
                  <Github size={16} />
                  Sign in with GitHub
                </button>
              )}
            </div>
          )}
        </div>

        {sessionReady && !sessionLoadError && !viewer && (
          <div className="mb-6 w-full max-w-3xl rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
            <div className="mb-3 text-sm font-semibold text-zinc-100">
              Anonymous play
            </div>
            {turnstileSiteKey ? (
              <TurnstileWidget siteKey={turnstileSiteKey} onTokenChange={setTurnstileToken} />
            ) : (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-500">
                Anonymous guest mode is unavailable until Turnstile is configured.
              </div>
            )}
            {anonymousVerificationMessage && (
              <div className="mt-3 text-xs text-zinc-400">
                {anonymousVerificationMessage}
              </div>
            )}
          </div>
        )}

        <DifficultyGrid
          viewer={viewer}
          hasCallsign={hasCallsign && sessionReady && !sessionLoadError}
          loadingDifficulty={loading}
          onSelect={handleSelect}
        />

        <Link
          href="/leaderboard"
          className="mt-8 flex items-center gap-2 text-zinc-500 hover:text-amber-400 transition-colors text-sm"
        >
          <Trophy size={16} />
          Hall of Fame
        </Link>

        {loading && (
          <div className="mt-6 flex items-center gap-2 text-zinc-500 text-sm">
            <Loader2 size={14} className="animate-spin" />
            Generating scenario...
          </div>
        )}

        {error && (
          <div className="mt-6 px-4 py-2 rounded-lg bg-red-950/50 border border-red-800/50 text-red-400 text-sm max-w-md text-center">
            {error}
          </div>
        )}
      </div>

      <footer className="flex flex-col items-center gap-4 py-6 px-6">
        <a
          href="https://github.com/tuxerrante"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "group flex items-center gap-3 px-5 py-3 rounded-xl border transition-all",
            "border-zinc-800 bg-zinc-900/60 hover:border-amber-700/50 hover:bg-zinc-900"
          )}
        >
          <Github size={20} className="text-zinc-400 group-hover:text-zinc-200 transition-colors" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-zinc-300 group-hover:text-zinc-100 transition-colors">
              tuxerrante
            </span>
            <span className="text-[11px] text-zinc-600 group-hover:text-zinc-500 transition-colors flex items-center gap-1">
              Built with <Heart size={10} className="text-red-500/70" /> by Alessandro Affinito
            </span>
          </div>
        </a>

        <div className="text-zinc-500 text-xs text-center">
          ARO SRE Simulator &mdash; Investigation training powered by AI
          <span className="mx-2">&middot;</span>
          <button
            type="button"
            onClick={() => setShowReleaseNotes((prev) => !prev)}
            className="underline decoration-zinc-600 underline-offset-2 hover:text-zinc-200 hover:decoration-zinc-300 transition-colors"
            aria-expanded={showReleaseNotes}
            aria-controls="release-notes-panel"
            aria-label={`${showReleaseNotes ? "Hide" : "Show"} release notes (${APP_VERSION})`}
          >
            {APP_VERSION}
          </button>
          <span className="mx-2">&middot;</span>
          <Link href="/about" className="hover:text-zinc-200 transition-colors">
            About
          </Link>
        </div>
        <section
          id="release-notes-panel"
          hidden={!showReleaseNotes}
          aria-hidden={!showReleaseNotes}
          className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 text-left"
        >
          <h2 className="mb-2 text-sm font-semibold text-zinc-100">
            Main feature updates
          </h2>
          <ul className="space-y-1 text-sm text-zinc-300">
            {HOME_FEATURE_HIGHLIGHTS.map((feature) => (
              <li key={feature} className="leading-relaxed">
                - {feature}
              </li>
            ))}
          </ul>
        </section>
      </footer>
    </div>
  );
}
