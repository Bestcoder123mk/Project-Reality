"use client";

/**
 * SignInScreen — the Firebase Authentication entry point.
 *
 * Section I (Firebase & Backend) — the user explicitly requested Google
 * Sign-in. This is the screen players see before the main menu when
 * they're not yet authenticated.
 *
 * Features:
 *   - Official Google Sign-in button (Google brand colors + the
 *     standardized "G" logo mark — meets Google's branding guidelines).
 *   - "Continue as guest" — Firebase anonymous auth (preserves cloud
 *     save; the player can link a Google account later).
 *   - Loading + error states (popup blocked, network error, etc.).
 *   - Game logo + tagline (matches the MainMenu dark tactical theme).
 *   - Server config check — if Remote Config has `maintenance_mode=true`,
 *     the screen shows a maintenance notice instead of the buttons.
 *
 * The screen is mounted in `src/app/page.tsx` when the auth state is
 * `null` (signed out). Once the user signs in (Google or anonymous),
 * the parent swaps to the MainMenu.
 */

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Crosshair as CrosshairIcon,
  Loader2,
  AlertCircle,
  ShieldCheck,
  Lock,
  User,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";

import {
  signInWithGoogle,
  signInAnonymously,
  type FirebaseUser,
} from "@/lib/auth";
import { track } from "@/lib/analytics";
import { initRemoteConfig, getRemoteConfigBool } from "@/lib/remote-config";

const EASE_APPLE: [number, number, number, number] = [0.16, 1, 0.3, 1];
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:ring-offset-4 focus-visible:ring-offset-[#08090c]";

type Mode = "google" | "guest" | null;
type ScreenState = "loading" | "ready" | "error" | "maintenance";

export interface SignInScreenProps {
  /** Called when a sign-in flow succeeds. */
  onSignedIn?: (user: FirebaseUser) => void;
}

export function SignInScreen({ onSignedIn }: SignInScreenProps) {
  const [mode, setMode] = useState<Mode>(null);
  const [state, setState] = useState<ScreenState>("loading");
  const [error, setError] = useState<string | null>(null);

  // Boot: init Remote Config + check maintenance mode.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        initRemoteConfig();
        // Check maintenance mode. Remote Config falls back to false when
        // not configured, so this is safe in dev.
        const maintenance = getRemoteConfigBool("maintenance_mode");
        if (cancelled) return;
        setState(maintenance ? "maintenance" : "ready");
      } catch {
        if (!cancelled) setState("ready");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGoogle = useCallback(async () => {
    setMode("google");
    setError(null);
    track("screen_view" as never, { auth_attempt: "google" } as never);
    const result = await signInWithGoogle();
    setMode(null);
    if (result.ok && result.user) {
      toast.success(`Signed in as ${result.user.displayName ?? "Operator"}`);
      onSignedIn?.(result.user);
    } else {
      const msg =
        result.code === "auth/popup-closed-by-user"
          ? "Sign-in cancelled"
          : result.error ?? "Google sign-in failed";
      setError(msg);
      setState("error");
      toast.error(msg);
    }
  }, [onSignedIn]);

  const handleGuest = useCallback(async () => {
    setMode("guest");
    setError(null);
    track("screen_view" as never, { auth_attempt: "guest" } as never);
    const result = await signInAnonymously();
    setMode(null);
    if (result.ok && result.user) {
      toast.success("Continuing as guest");
      onSignedIn?.(result.user);
    } else {
      setError(result.error ?? "Guest sign-in failed");
      setState("error");
      toast.error(result.error ?? "Guest sign-in failed");
    }
  }, [onSignedIn]);

  // Maintenance mode — show a notice instead of the buttons.
  if (state === "maintenance") {
    return (
      <Backdrop>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: EASE_APPLE }}
          className="w-full max-w-md rounded-2xl border border-amber-500/20 bg-amber-500/5 p-8 text-center"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-400">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h2 className="mb-2 text-lg font-semibold text-white">
            Server Maintenance
          </h2>
          <p className="text-sm text-white/60">
            Project Reality is temporarily offline for scheduled maintenance.
            Please check back shortly.
          </p>
        </motion.div>
      </Backdrop>
    );
  }

  return (
    <Backdrop>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: EASE_APPLE }}
        className="w-full max-w-md"
      >
        {/* Logo + title */}
        <div className="mb-10 text-center">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.1, ease: EASE_APPLE }}
            className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 shadow-[0_0_32px_rgba(255,140,26,0.4)]"
          >
            <CrosshairIcon className="h-8 w-8 text-black" />
          </motion.div>
          <h1 className="font-display text-3xl font-bold tracking-tight text-white">
            Project Reality
          </h1>
          <p className="mt-1.5 text-[13px] font-medium uppercase tracking-[0.2em] text-amber-400/70">
            Tactical FPS · Browser
          </p>
          <p className="mx-auto mt-4 max-w-sm text-[13px] leading-relaxed text-white/50">
            Sign in to sync your loadout, battle pass, and stats across
            devices. Six waves. One operator.
          </p>
        </div>

        {/* Sign-in buttons */}
        <div className="flex flex-col gap-3">
          <GoogleSignInButton
            onClick={handleGoogle}
            loading={mode === "google"}
            disabled={mode !== null}
          />

          <GuestButton
            onClick={handleGuest}
            loading={mode === "guest"}
            disabled={mode !== null}
          />

          {/* Error display */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5 text-[12px] text-red-300"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="leading-relaxed">{error}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Trust signals */}
        <div className="mt-8 flex items-center justify-center gap-4 text-[10px] uppercase tracking-[0.15em] text-white/30">
          <span className="flex items-center gap-1">
            <Lock className="h-3 w-3" /> Encrypted
          </span>
          <span className="flex items-center gap-1">
            <ShieldCheck className="h-3 w-3" /> GDPR
          </span>
          <span className="flex items-center gap-1">
            <User className="h-3 w-3" /> Cross-Device
          </span>
        </div>

        <p className="mt-6 text-center text-[10px] leading-relaxed text-white/30">
          By continuing you agree to the Terms of Service + Privacy Policy.
          Guest progress can be linked to a Google account later.
        </p>
      </motion.div>
    </Backdrop>
  );
}

// ─── Google Sign-in button (official Google branding) ─────────────────────

function GoogleSignInButton({
  onClick,
  loading,
  disabled,
}: {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group relative flex h-12 w-full items-center justify-center gap-3 overflow-hidden rounded-xl bg-white px-6 text-[14px] font-semibold text-[#1f1f1f] shadow-lg transition-all hover:bg-white/95 hover:shadow-xl active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`}
      aria-label="Sign in with Google"
    >
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-[#1f1f1f]" />
      ) : (
        <>
          {/* Official Google "G" logo (SVG, colors per Google brand guidelines). */}
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          <span>Sign in with Google</span>
          <ChevronRight className="ml-1 h-4 w-4 opacity-0 transition-opacity group-hover:opacity-60" />
        </>
      )}
    </button>
  );
}

// ─── Guest button ──────────────────────────────────────────────────────────

function GuestButton({
  onClick,
  loading,
  disabled,
}: {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-6 text-[13px] font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS_RING}`}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <User className="h-4 w-4" />
      )}
      {loading ? "Continuing…" : "Continue as guest"}
    </button>
  );
}

// ─── Backdrop (matches the MainMenu dark tactical theme) ──────────────────

function Backdrop({ children }: { children: React.ReactNode }) {
  return (
    <main className="absolute inset-0 z-[60] flex items-center justify-center overflow-hidden bg-[#08090c] text-white noise-overlay">
      {/* Base gradient. */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#0c0e0a] via-[#08090c] to-[#050607]" />
      {/* Warm key light. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_70%_25%,rgba(255,140,26,0.10),transparent_60%)]" />
      {/* Olive undertone. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_55%_45%_at_18%_82%,rgba(59,74,47,0.22),transparent_60%)]" />
      {/* Steel fill. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_45%_38%_at_85%_75%,rgba(106,112,104,0.12),transparent_60%)]" />
      {/* Grid. */}
      <div
        className="absolute inset-0 opacity-[0.045]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(201,176,138,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(201,176,138,0.5) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 80%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, black 30%, transparent 80%)",
        }}
      />
      {/* Content. */}
      <div className="relative z-10 flex h-full w-full items-center justify-center p-6">
        {children}
      </div>
    </main>
  );
}
