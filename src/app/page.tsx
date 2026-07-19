"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useGameStore } from "@/lib/game/store";
import { useProfile } from "@/lib/game/useProfile";
import { GameErrorBoundary } from "@/components/game/GameErrorBoundary";
import { initErrorTracking } from "@/lib/errorTracking";
import { initAnalytics, track } from "@/lib/analytics";
import { onAuthChange, type FirebaseUser } from "@/lib/auth";
import { SignInScreen } from "@/components/auth/SignInScreen";

// Lazy-load ALL game components so the initial compile only includes
// the auth gate + SignInScreen. This keeps the initial webpack/turbopack
// compilation memory low enough for 4GB environments. Each screen is
// compiled on-demand when first navigated to.
const GameCanvas = dynamic(
  () => import("@/components/game/GameCanvas").then((m) => m.GameCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 grid place-items-center bg-black text-white/60 text-xs">
        Loading engine…
      </div>
    ),
  }
);

const MainMenu = dynamic(
  () => import("@/components/menu/MainMenu").then((m) => m.MainMenu),
  { ssr: false }
);
const LoadoutPicker = dynamic(
  () => import("@/components/menu/LoadoutPicker").then((m) => m.LoadoutPicker),
  { ssr: false }
);
const MapSelection = dynamic(
  () => import("@/components/menu/MapSelection").then((m) => m.MapSelection),
  { ssr: false }
);
const SettingsPanel = dynamic(
  () => import("@/components/menu/SettingsPanel").then((m) => m.SettingsPanel),
  { ssr: false }
);
const GunsmithScreen = dynamic(
  () => import("@/components/menu/GunsmithScreen").then((m) => m.GunsmithScreen),
  { ssr: false }
);
const ShopScreen = dynamic(
  () => import("@/components/menu/ShopScreen").then((m) => m.ShopScreen),
  { ssr: false }
);
const PackScreen = dynamic(
  () => import("@/components/menu/PackScreen").then((m) => m.PackScreen),
  { ssr: false }
);
const BattlePassScreen = dynamic(
  () => import("@/components/menu/BattlePassScreen").then((m) => m.BattlePassScreen),
  { ssr: false }
);
const TutorialScreen = dynamic(
  () => import("@/components/menu/TutorialScreen").then((m) => m.TutorialScreen),
  { ssr: false }
);
const OperatorScreen = dynamic(
  () => import("@/components/menu/OperatorScreen").then((m) => m.OperatorScreen),
  { ssr: false }
);
const PerfOverlay = dynamic(
  () => import("@/components/game/PerfOverlay").then((m) => m.PerfOverlay),
  { ssr: false }
);

export default function Home() {
  const phase = useGameStore((s) => s.phase);
  const { refresh } = useProfile();

  // Section I (Firebase & Backend) — auth gate.
  //
  // Three states:
  //   - "loading"  — auth state not yet known (show nothing / spinner).
  //   - "signed-out" — show SignInScreen.
  //   - "signed-in"  — show the game (MainMenu + canvas).
  const [authState, setAuthState] = useState
    "loading" | "signed-out" | "signed-in"
  >("loading");
  const [, setAuthUser] = useState<FirebaseUser | null>(null);

  // One-time init: crash reporting + analytics (prompt 3 + prompt 4).
  useEffect(() => {
    initErrorTracking();
    initAnalytics();
  }, []);

  // Subscribe to Firebase Auth state. The callback fires immediately
  // with the current user (null when signed out) + on every sign-in /
  // sign-out. The unsubscribe is cleaned up on unmount.
  //
  // Defensive timeout: onAuthStateChanged should fire almost instantly,
  // but if Firebase Auth ever fails to initialize (blocked network,
  // storage access denied, misconfiguration) the callback could be
  // delayed indefinitely — falling back to "signed-out" after a few
  // seconds means the player sees the sign-in screen instead of a
  // permanent spinner.
  useEffect(() => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        console.warn(
          "[auth] onAuthStateChanged did not fire within 8s — falling back to signed-out."
        );
        setAuthState("signed-out");
      }
    }, 8000);

    const unsub = onAuthChange((user) => {
      settled = true;
      clearTimeout(timeout);
      setAuthUser(user);
      setAuthState(user ? "signed-in" : "signed-out");
      if (user) {
        // Persist the player id so the existing analytics pipeline
        // (which reads `pr_player_id` from localStorage) keeps working.
        try {
          window.localStorage.setItem("pr_player_id", user.uid);
        } catch {
          /* localStorage may be blocked — non-fatal */
        }
        track("session_start");
      }
    });
    return () => {
      clearTimeout(timeout);
      unsub();
    };
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (phase === "menu") refresh();
    track("screen_view", { phase });
  }, [phase, refresh]);

  // Auth gate — show the sign-in screen until the user signs in.
  // The game (menu + canvas) only mounts after auth so the first
  // paint isn't wasted on a DOM the user will navigate away from.
  if (authState === "loading") {
    return (
      <main className="relative h-screen w-screen overflow-hidden bg-black text-white">
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 text-white/50">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-500" />
            <span className="text-xs uppercase tracking-[0.2em]">
              Authenticating
            </span>
          </div>
        </div>
      </main>
    );
  }

  if (authState === "signed-out") {
    return <SignInScreen onSignedIn={() => setAuthState("signed-in")} />;
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-black text-white">
      {phase === "menu" && <MainMenu />}
      {phase === "loadout" && <LoadoutPicker />}
      {phase === "mapselect" && <MapSelection />}
      {phase === "operator" && <OperatorScreen />}

      {phase === "gunsmith" && <GunsmithScreen />}
      {phase === "shop" && <ShopScreen />}
      {phase === "packs" && <PackScreen onClose={() => useGameStore.getState().setPhase("shop")} />}
      {phase === "battlepass" && <BattlePassScreen />}
      {phase === "tutorial" && <TutorialScreen />}

      <SettingsPanel />

      {/* Crash reporting (prompt 3): a WebGL/runtime crash reports the
          stack instead of white-screening. */}
      <GameErrorBoundary label="game">
        <GameCanvas />
      </GameErrorBoundary>

      {/* Dev-only perf budget dashboard (prompt 7). Hidden unless
          ?perf=1 or localStorage pr_perf_overlay=1. */}
      <PerfOverlay />
    </main>
  );
}
