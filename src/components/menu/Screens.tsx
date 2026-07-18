"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Play, Home, RotateCcw, Skull, Trophy, Crosshair, Coins, Zap, Target, Clock, TrendingUp } from "lucide-react";
import { useGameStore } from "@/lib/game/store";
import { useCountUp, EASE_APPLE, EASE_SPRING, EASE_SPRING_GENTLE } from "@/lib/game/anim";
import { useUISound } from "@/lib/game/ui-sound";
import { useEffect } from "react";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]";

// ─────────────────────────────────────────────────────────
// Pause Screen — Apple-level translucent modal
// ─────────────────────────────────────────────────────────
export function PauseScreen({ onResume, onQuit }: { onResume: () => void; onQuit: () => void }) {
  const phase = useGameStore((s) => s.phase);
  const hud = useGameStore((s) => s.hud);
  const open = phase === "paused";
  const sfx = useUISound();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex items-center justify-center bg-[#08090c]/80 backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 10 }}
            transition={EASE_SPRING}
            className="panel-glass-strong w-full max-w-sm rounded-3xl p-7 text-center text-white"
          >
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.04]">
              <Crosshair className="h-6 w-6 text-amber-400" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight">Paused</h2>
            <p className="mt-1 text-sm text-white/40">Mission temporarily suspended</p>

            <div className="my-5 grid grid-cols-3 gap-2">
              <MiniStat label="Wave" value={`${hud.wave}/6`} />
              <MiniStat label="Kills" value={hud.kills} />
              <MiniStat label="Score" value={hud.score.toLocaleString()} />
            </div>

            <div className="space-y-2.5">
              <button
                onClick={() => { sfx.confirm(); onResume(); }}
                onMouseEnter={() => sfx.hover()}
                className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-sm font-bold text-black shadow-[0_0_20px_rgba(255,140,26,0.3)] transition-transform hover:scale-[1.02] active:scale-95 ${FOCUS_RING}`}
              >
                <Play className="h-4 w-4 fill-black" /> Resume
              </button>
              <button
                onClick={() => { sfx.back(); onQuit(); }}
                onMouseEnter={() => sfx.hover()}
                className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] text-sm font-medium text-white transition-colors hover:bg-white/[0.08] ${FOCUS_RING}`}
              >
                <Home className="h-4 w-4" /> Quit to Menu
              </button>
            </div>
            <p className="mt-4 text-[11px] text-white/30">Press ESC or click Resume to continue</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────
// Death Screen — run summary with count-up
// ─────────────────────────────────────────────────────────
export function DeathScreen({ onRetry, onQuit }: { onRetry: () => void; onQuit: () => void }) {
  const phase = useGameStore((s) => s.phase);
  const hud = useGameStore((s) => s.hud);
  const open = phase === "dead";
  const sfx = useUISound();

  // Count-up animations for stats reveal.
  const animatedScore = useCountUp(hud.score, 1000);
  const animatedKills = useCountUp(hud.kills, 800);
  const animatedCredits = useCountUp(hud.credits, 1200);
  const animatedXp = useCountUp(hud.xpGained, 1200);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-gradient-to-b from-rose-950/40 via-[#08090c]/90 to-[#08090c]" />
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={EASE_SPRING_GENTLE}
            className="panel-glass-strong relative w-full max-w-md rounded-3xl p-8 text-center text-white"
          >
            {/* Icon */}
            <motion.div
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.2, ...EASE_SPRING }}
              className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-rose-500/20 bg-rose-500/10"
            >
              <Skull className="h-8 w-8 text-rose-400" />
            </motion.div>

            <h2 className="text-3xl font-bold tracking-tight">You Died</h2>
            <p className="mt-2 text-sm text-white/50">The hostiles overran your position on wave {hud.wave}</p>

            {/* Stats grid with count-up */}
            <div className="my-6 grid grid-cols-3 gap-3">
              <ResultStat label="Score" value={animatedScore.toLocaleString()} accent="text-white" delay={0.4} />
              <ResultStat label="Kills" value={animatedKills} accent="text-emerald-400" delay={0.5} />
              <ResultStat label="Wave" value={`${hud.wave}/6`} accent="text-amber-400" delay={0.6} />
            </div>

            {/* Earnings with count-up */}
            <EarningsStrip credits={animatedCredits} xp={animatedXp} delay={0.8} />

            <div className="space-y-2.5">
              <button
                onClick={() => { sfx.confirm(); onRetry(); }}
                onMouseEnter={() => sfx.hover()}
                className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-sm font-bold text-black shadow-[0_0_20px_rgba(255,140,26,0.3)] transition-transform hover:scale-[1.02] active:scale-95 ${FOCUS_RING}`}
              >
                <RotateCcw className="h-4 w-4" /> Redeploy
              </button>
              <button
                onClick={() => { sfx.back(); onQuit(); }}
                onMouseEnter={() => sfx.hover()}
                className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] text-sm font-medium text-white transition-colors hover:bg-white/[0.08] ${FOCUS_RING}`}
              >
                <Home className="h-4 w-4" /> Main Menu
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────
// Victory Screen — Apple Fitness ring-close style
// ─────────────────────────────────────────────────────────
export function VictoryScreen({ onRetry, onQuit }: { onRetry: () => void; onQuit: () => void }) {
  const phase = useGameStore((s) => s.phase);
  const hud = useGameStore((s) => s.hud);
  const open = phase === "victory";
  const sfx = useUISound();

  // Count-up animations.
  const animatedScore = useCountUp(hud.score, 1200);
  const animatedKills = useCountUp(hud.kills, 1000);
  const animatedCredits = useCountUp(hud.credits, 1400);
  const animatedXp = useCountUp(hud.xpGained, 1400);

  // Play success sound on mount.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => sfx.success(), 300);
      return () => clearTimeout(t);
    }
  }, [open, sfx]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-50 flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-gradient-to-b from-amber-900/20 via-[#08090c]/90 to-[#08090c]" />
          {/* Ambient glow */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_40%,rgba(255,140,26,0.12),transparent_70%)]" />

          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={EASE_SPRING_GENTLE}
            className="panel-glass-strong relative w-full max-w-lg rounded-3xl p-8 text-center text-white"
          >
            {/* Ring-close animation */}
            <RingClose delay={0.2} />

            <motion.h2
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6, duration: 0.5, ease: EASE_APPLE }}
              className="text-3xl font-bold tracking-tight text-gradient-amber"
            >
              Mission Complete
            </motion.h2>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8, duration: 0.5 }}
              className="mt-2 text-sm text-white/50"
            >
              All six waves neutralized. Outstanding work, operator.
            </motion.p>

            {/* Stats grid with count-up + staggered reveal */}
            <div className="my-6 grid grid-cols-3 gap-3">
              <ResultStat label="Score" value={animatedScore.toLocaleString()} accent="text-amber-400" delay={1.0} />
              <ResultStat label="Kills" value={animatedKills} accent="text-emerald-400" delay={1.1} />
              <ResultStat label="Wave" value="6/6" accent="text-sky-400" delay={1.2} />
            </div>

            {/* Bonus breakdown */}
            <BonusBreakdown credits={animatedCredits} xp={animatedXp} delay={1.4} />

            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.8, duration: 0.4 }}
              className="space-y-2.5"
            >
              <button
                onClick={() => { sfx.confirm(); onRetry(); }}
                onMouseEnter={() => sfx.hover()}
                className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 text-sm font-bold text-black shadow-[0_0_24px_rgba(255,140,26,0.4)] transition-shadow hover:shadow-[0_0_32px_rgba(255,140,26,0.6)] active:scale-95 ${FOCUS_RING}`}
              >
                <RotateCcw className="h-4 w-4" /> Play Again
              </button>
              <button
                onClick={() => { sfx.back(); onQuit(); }}
                onMouseEnter={() => sfx.hover()}
                className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] text-sm font-medium text-white transition-colors hover:bg-white/[0.08] ${FOCUS_RING}`}
              >
                <Home className="h-4 w-4" /> Main Menu
              </button>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────
// Ring Close — Apple Fitness-style animated ring
// ─────────────────────────────────────────────────────────
function RingClose({ delay }: { delay: number }) {
  return (
    <div className="relative mx-auto mb-5 h-20 w-20">
      <svg width="80" height="80" viewBox="0 0 80 80" className="absolute inset-0">
        {/* Background ring */}
        <circle cx="40" cy="40" r="32" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
        {/* Progress ring — animates from 0 to full */}
        <motion.circle
          cx="40" cy="40" r="32" fill="none"
          stroke="url(#ringGradient)" strokeWidth="4" strokeLinecap="round"
          transform="rotate(-90 40 40)"
          initial={{ strokeDasharray: "0 201" }}
          animate={{ strokeDasharray: "201 201" }}
          transition={{ delay, duration: 1.0, ease: EASE_APPLE }}
        />
        <defs>
          <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#ffb04a" />
            <stop offset="50%" stopColor="#ff8c1a" />
            <stop offset="100%" stopColor="#d4af37" />
          </linearGradient>
        </defs>
      </svg>
      {/* Center icon */}
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: delay + 0.5, type: "spring", stiffness: 200, damping: 15 }}
        className="absolute inset-0 flex items-center justify-center"
      >
        <Trophy className="h-8 w-8 text-amber-400" />
      </motion.div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Bonus Breakdown — credits + XP with icons
// ─────────────────────────────────────────────────────────
function BonusBreakdown({ credits, xp, delay }: { credits: number; xp: number; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: EASE_APPLE }}
      className="mb-6 space-y-2"
    >
      <div className="flex items-center justify-between rounded-xl border border-amber-500/15 bg-amber-500/[0.04] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-amber-400" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-white/50">Credits Earned</span>
        </div>
        <span className="text-lg font-bold tabular text-amber-300">+{credits.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between rounded-xl border border-sky-500/15 bg-sky-500/[0.04] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-sky-400" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-white/50">XP Gained</span>
        </div>
        <span className="text-lg font-bold tabular text-sky-300">+{xp.toLocaleString()}</span>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────
// Shared sub-components
// ─────────────────────────────────────────────────────────
function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-2.5">
      <div className="text-[9px] font-medium uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-base font-bold tabular-nums text-white">{value}</div>
    </div>
  );
}

function ResultStat({ label, value, accent, delay }: { label: string; value: string | number; accent: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.4, ease: EASE_APPLE }}
      className="rounded-2xl border border-white/[0.06] bg-white/[0.03] py-4"
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-white/40">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${accent}`}>{value}</div>
    </motion.div>
  );
}

function EarningsStrip({ credits, xp, delay }: { credits: number; xp: number; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay }}
      className="mb-6 flex items-center justify-center gap-4 rounded-2xl border border-amber-500/15 bg-amber-500/[0.04] px-5 py-3"
    >
      <div className="flex items-center gap-2">
        <Coins className="h-4 w-4 text-amber-400" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-white/40">Earned</span>
        <span className="text-base font-bold tabular-nums text-amber-300">+{credits.toLocaleString()}</span>
      </div>
      <div className="h-5 w-px bg-white/10" />
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-sky-400" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-white/40">XP</span>
        <span className="text-base font-bold tabular-nums text-sky-300">+{xp.toLocaleString()}</span>
      </div>
    </motion.div>
  );
}

export { Target, Clock, TrendingUp };
