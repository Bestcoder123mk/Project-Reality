"use client";
// L1-5000 / prompts 4456,4514,4568,4606,4644,4682,4720: addressed by this module (duplicates of Section I prompts, originally implemented there).

/**
 * Prompt I-983 / J-4152 — Age gate enforcement.
 *
 * First-launch modal that asks the player to confirm they're 13+
 * (ESRB Teen / PEGI 16 floor). The choice is persisted to
 * localStorage so the modal only shows once per device. The player
 * can re-trigger it from Settings (Privacy → "Reset age gate") if
 * they want to change their answer.
 *
 * If the player self-reports under 13, analytics + crash reporting
 * are gated off (COPPA — see platform/gdpr.ts). The AgeGateOverlay
 * sets a `pr_age_gate_under_13` flag that the analytics + crash-
 * reporting init paths read.
 *
 * Mount once at the root layout (alongside the toaster). The overlay
 * renders null when the player has already confirmed.
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck } from "lucide-react";

const AGE_GATE_KEY = "pr_age_gate_confirmed_v1";
const UNDER_13_KEY = "pr_age_gate_under_13";

export function hasAgeGateConfirmed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(AGE_GATE_KEY) === "1";
}

export function isUnder13(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(UNDER_13_KEY) === "1";
}

export function resetAgeGate(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AGE_GATE_KEY);
  localStorage.removeItem(UNDER_13_KEY);
}

export function AgeGateOverlay() {
  // Hydration-safe pattern: render nothing on server + first client render,
  // then read localStorage in useEffect. This avoids the SSR/client mismatch
  // that framer-motion's AnimatePresence would otherwise cause (server
  // renders closed, client renders open → hydration error).
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    setOpen(!hasAgeGateConfirmed());
  }, []);

  const confirm = (under13: boolean) => {
    localStorage.setItem(AGE_GATE_KEY, "1");
    if (under13) localStorage.setItem(UNDER_13_KEY, "1");
    else localStorage.removeItem(UNDER_13_KEY);
    setOpen(false);
  };

  // Don't render anything until after mount — prevents hydration mismatch.
  if (!mounted) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          role="dialog"
          aria-modal="true"
          aria-label="Age verification"
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#0c0e0a] p-8 text-white shadow-2xl"
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold">Age Verification</h2>
                <p className="text-[11px] text-white/40">
                  ESRB Teen (13+) · PEGI 16
                </p>
              </div>
            </div>
            <p className="mb-5 text-sm leading-relaxed text-white/70">
              This game contains violence, blood, and strong language.
              Please confirm you are old enough to play.
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => confirm(false)}
                className="flex h-11 items-center justify-center rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-6 text-sm font-bold text-black transition-transform hover:scale-[1.02] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]"
              >
                I am 13 or older
              </button>
              <button
                type="button"
                onClick={() => confirm(true)}
                className="flex h-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-6 text-sm font-medium text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]"
              >
                I am under 13
              </button>
            </div>
            <p className="mt-4 text-[10px] leading-relaxed text-white/30">
              Players under 13 will have analytics + crash reporting
              disabled (COPPA). Game progress is unaffected.
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
