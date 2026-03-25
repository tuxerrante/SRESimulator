"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Shield,
  AlertTriangle,
  MessageSquare,
  LayoutDashboard,
  BookOpen,
  ArrowRight,
  ArrowLeft,
  X,
} from "lucide-react";

export const ONBOARDING_STORAGE_KEY = "sre-sim-onboarding-seen";

export function hasSeenOnboardingTour(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "true";
}

interface TourStep {
  target: string | null;
  title: string;
  message: string;
  icon: typeof Shield;
  iconColor: string;
}

const STEPS: TourStep[] = [
  {
    target: null,
    title: "Welcome to SRE Simulator",
    message:
      "You're about to investigate a live incident on an OpenShift cluster. Let's take a quick tour of the cockpit so you know where everything is.",
    icon: Shield,
    iconColor: "text-amber-400",
  },
  {
    target: '[data-tour="incident-ticket"]',
    title: "Incident Ticket",
    message:
      "This is your incident ticket. Read it carefully — understanding the problem statement is the first step of any investigation.",
    icon: AlertTriangle,
    iconColor: "text-amber-400",
  },
  {
    target: '[data-tour="chat-panel"]',
    title: "Investigation Chat",
    message:
      "Chat with the AI mentor here. Describe what you want to investigate and it will translate your intent into oc/KQL commands.",
    icon: MessageSquare,
    iconColor: "text-emerald-400",
  },
  {
    target: '[data-tour="dashboard-tab"]',
    title: "Cluster Dashboard",
    message:
      "Check the Dashboard tab for cluster status, active alerts, and recent events. Always gather context before running commands!",
    icon: LayoutDashboard,
    iconColor: "text-blue-400",
  },
  {
    target: '[data-tour="guide-tab"]',
    title: "Investigation Guide",
    message:
      "The Guide tab explains the 5-phase investigation method (Reading, Context, Facts, Theory, Action). Follow it for a higher score!",
    icon: BookOpen,
    iconColor: "text-purple-400",
  },
];

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface OnboardingTourProps {
  onComplete: (result: { completed: boolean }) => void;
}

export function OnboardingTour({ onComplete }: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const [spotlight, setSpotlight] = useState<SpotlightRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  const computeSpotlight = useCallback(() => {
    const { target } = STEPS[step];
    if (!target) return null;
    const el = document.querySelector(target);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const pad = 6;
    return {
      top: rect.top - pad,
      left: rect.left - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    };
  }, [step]);

  useEffect(() => {
    const update = () => {
      rafRef.current = requestAnimationFrame(() => {
        setSpotlight(computeSpotlight());
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      cancelAnimationFrame(rafRef.current);
    };
  }, [step, computeSpotlight]);

  const finish = useCallback(
    (completed: boolean = false) => {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
      onComplete({ completed });
    },
    [onComplete],
  );

  const next = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      finish(true);
    }
  };

  const prev = () => {
    if (step > 0) setStep(step - 1);
  };

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;
  const isFirst = step === 0;

  const tooltipPosition = getTooltipPosition(spotlight);

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop with spotlight cutout via CSS clip-path */}
      <div
        className="absolute inset-0 bg-black/70 transition-all duration-300"
        style={{
          clipPath: spotlight
            ? `polygon(
                0% 0%, 0% 100%, 100% 100%, 100% 0%, 0% 0%,
                ${spotlight.left}px ${spotlight.top}px,
                ${spotlight.left}px ${spotlight.top + spotlight.height}px,
                ${spotlight.left + spotlight.width}px ${spotlight.top + spotlight.height}px,
                ${spotlight.left + spotlight.width}px ${spotlight.top}px,
                ${spotlight.left}px ${spotlight.top}px
              )`
            : undefined,
        }}
        onClick={() => finish()}
      />

      {/* Spotlight border ring */}
      {spotlight && (
        <div
          className="absolute rounded-lg ring-2 ring-amber-400/60 pointer-events-none transition-all duration-300"
          style={{
            top: spotlight.top,
            left: spotlight.left,
            width: spotlight.width,
            height: spotlight.height,
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        className="absolute transition-all duration-300"
        style={tooltipPosition}
      >
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[360px] overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-zinc-800 bg-zinc-800/50">
            <Icon size={18} className={current.iconColor} />
            <span className="text-sm font-semibold text-zinc-100 flex-1">
              {current.title}
            </span>
            <button
              onClick={() => finish()}
              className="text-zinc-500 hover:text-zinc-300 transition-colors p-0.5"
              aria-label="Close tour"
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="px-4 py-3">
            <p className="text-sm text-zinc-300 leading-relaxed">
              {current.message}
            </p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-800 bg-zinc-800/30">
            <div className="flex items-center gap-1.5">
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${
                    i === step
                      ? "bg-amber-400"
                      : i < step
                        ? "bg-amber-400/40"
                        : "bg-zinc-600"
                  }`}
                />
              ))}
              <span className="text-[10px] text-zinc-500 ml-1.5">
                {step + 1}/{STEPS.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {!isFirst && (
                <button
                  onClick={prev}
                  className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
                >
                  <ArrowLeft size={12} />
                  Back
                </button>
              )}
              {isFirst && (
                <button
                  onClick={() => finish()}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
                >
                  Skip tour
                </button>
              )}
              <button
                onClick={next}
                className="flex items-center gap-1 text-xs font-medium text-zinc-900 bg-amber-400 hover:bg-amber-300 transition-colors px-3 py-1.5 rounded-lg"
              >
                {isLast ? "Got it!" : "Next"}
                {!isLast && <ArrowRight size={12} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function getTooltipPosition(
  spotlight: SpotlightRect | null,
): React.CSSProperties {
  if (!spotlight) {
    return {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
    };
  }

  const viewW = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewH = typeof window !== "undefined" ? window.innerHeight : 720;
  const tooltipW = 360;
  const tooltipH = 200;
  const gap = 12;

  const centerX = spotlight.left + spotlight.width / 2;
  const centerY = spotlight.top + spotlight.height / 2;

  const spaceBelow = viewH - (spotlight.top + spotlight.height);
  const spaceAbove = spotlight.top;
  const spaceRight = viewW - (spotlight.left + spotlight.width);
  const spaceLeft = spotlight.left;

  let top: number;
  let left: number;

  if (spaceBelow >= tooltipH + gap) {
    top = spotlight.top + spotlight.height + gap;
    left = centerX - tooltipW / 2;
  } else if (spaceAbove >= tooltipH + gap) {
    top = spotlight.top - tooltipH - gap;
    left = centerX - tooltipW / 2;
  } else if (spaceRight >= tooltipW + gap) {
    top = centerY - tooltipH / 2;
    left = spotlight.left + spotlight.width + gap;
  } else if (spaceLeft >= tooltipW + gap) {
    top = centerY - tooltipH / 2;
    left = spotlight.left - tooltipW - gap;
  } else {
    top = spotlight.top + spotlight.height + gap;
    left = centerX - tooltipW / 2;
  }

  left = Math.max(12, Math.min(left, viewW - tooltipW - 12));
  top = Math.max(12, Math.min(top, viewH - tooltipH - 12));

  return { top, left };
}

export function resetOnboardingTour() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  }
}
