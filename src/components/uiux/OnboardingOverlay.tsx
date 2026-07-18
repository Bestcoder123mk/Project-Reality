/**
 * SEC10-UIUX (prompt 80): Onboarding overlay.
 *
 * A compact progress overlay that shows the player's onboarding
 * progress + the next recommended step. Mounts inside TutorialScreen
 * so the tutorial can drive both core-combat steps (the existing
 * tutorial flow) AND the meta-gameplay steps (loadout, gunsmith,
 * economy, battle pass).
 *
 * Wiring: TutorialScreen.tsx imports <OnboardingOverlay /> and renders
 * it alongside its step content. The overlay reads from the
 * onboarding module's localStorage-backed progress tracker.
 */

"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Circle, Lock, ChevronRight } from "lucide-react";
import {
  ONBOARDING_STEPS,
  getOnboardingProgress,
  markOnboardingStepComplete,
  type OnboardingProgress,
  type OnboardingTrack,
} from "@/lib/game/uiux/onboarding";

interface OnboardingOverlayProps {
  /** Player id (defaults to "default" for local-only play). */
  playerId?: string;
  /** Called when the user clicks a step — the parent can navigate to the step's target screen. */
  onStepClick?: (stepId: string, targetScreen: string) => void;
  /** Compact mode — hides the progress ring + only shows the next-step prompt. */
  compact?: boolean;
}

const TRACK_LABELS: Record<OnboardingTrack, string> = {
  core: "Core",
  loadout: "Loadout",
  gunsmith: "Gunsmith",
  economy: "Economy",
  battlepass: "Battle Pass",
};

const TRACK_COLORS: Record<OnboardingTrack, string> = {
  core: "#5dade2",
  loadout: "#4ecdc4",
  gunsmith: "#9b59b6",
  economy: "#ffd23f",
  battlepass: "#ff8c1a",
};

export function OnboardingOverlay({
  playerId = "default",
  onStepClick,
  compact = false,
}: OnboardingOverlayProps) {
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);

  // Refresh progress whenever the overlay mounts.
  useEffect(() => {
    setProgress(getOnboardingProgress(playerId));
  }, [playerId]);

  // Refresh again when the window regains focus (player may have completed
  // a step in another tab/screen).
  useEffect(() => {
    const onFocus = () => setProgress(getOnboardingProgress(playerId));
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [playerId]);

  if (!progress) return null;

  if (compact) {
    return (
      <CompactNextStep
        progress={progress}
        onComplete={(id) => {
          markOnboardingStepComplete(id, playerId);
          setProgress(getOnboardingProgress(playerId));
        }}
      />
    );
  }

  return (
    <div className="space-y-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight text-white/90">Onboarding Progress</h3>
        <div className="flex items-center gap-2">
          <ProgressRing percent={progress.percent} size={36} />
          <span className="font-mono text-xs text-white/50 tabular-nums">{progress.percent}%</span>
        </div>
      </div>

      {/* Per-track breakdown */}
      <div className="space-y-3">
        {(Object.keys(TRACK_LABELS) as OnboardingTrack[]).map((track) => {
          const trackSteps = ONBOARDING_STEPS.filter((s) => s.track === track);
          const completedCount = trackSteps.filter((s) => progress.completed.includes(s.id)).length;
          const isComplete = completedCount === trackSteps.length;
          return (
            <div key={track}>
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: TRACK_COLORS[track] }}
                  />
                  <span className="text-xs font-medium text-white/70">{TRACK_LABELS[track]}</span>
                </div>
                <span className="font-mono text-[10px] text-white/40 tabular-nums">
                  {completedCount}/{trackSteps.length}
                </span>
              </div>
              <div className="space-y-1">
                {trackSteps.map((step) => {
                  const isDone = progress.completed.includes(step.id);
                  const isLocked = progress.locked.includes(step.id);
                  return (
                    <button
                      key={step.id}
                      type="button"
                      disabled={isLocked}
                      onClick={() => !isDone && !isLocked && onStepClick?.(step.id, step.targetScreen)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                        isLocked
                          ? "cursor-not-allowed opacity-40"
                          : isDone
                          ? "cursor-default"
                          : "hover:bg-white/[0.04]"
                      }`}
                    >
                      {isDone ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                      ) : isLocked ? (
                        <Lock className="h-4 w-4 shrink-0 text-white/30" />
                      ) : (
                        <Circle className="h-4 w-4 shrink-0 text-white/30" />
                      )}
                      <span
                        className={`text-xs ${
                          isDone ? "text-white/50 line-through" : "text-white/80"
                        }`}
                      >
                        {step.title}
                      </span>
                      {!isDone && !isLocked && (
                        <ChevronRight className="ml-auto h-3 w-3 text-white/30" />
                      )}
                    </button>
                  );
                })}
              </div>
              {!isComplete && completedCount > 0 && (
                <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${(completedCount / trackSteps.length) * 100}%`,
                      backgroundColor: TRACK_COLORS[track],
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompactNextStep({
  progress,
  onComplete,
}: {
  progress: OnboardingProgress;
  onComplete: (stepId: string) => void;
}) {
  const next = progress.nextStep;
  if (!next) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        <span className="text-xs font-medium text-emerald-300">Onboarding complete</span>
      </div>
    );
  }
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={next.id}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-amber-400/80">
            Next: {TRACK_LABELS[next.track]}
          </div>
          <div className="truncate text-sm font-medium text-white/90">{next.title}</div>
        </div>
        <button
          type="button"
          onClick={() => onComplete(next.id)}
          className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/[0.12]"
        >
          Mark done
        </button>
      </motion.div>
    </AnimatePresence>
  );
}

function ProgressRing({ percent, size = 36 }: { percent: number; size?: number }) {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (percent / 100) * c;
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth={2}
      />
      <motion.circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#ff8c1a"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={c}
        initial={{ strokeDashoffset: c }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      />
    </svg>
  );
}
