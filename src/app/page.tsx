"use client";

// This page is entirely driven by client-side auth state (Firebase Auth)
// and in-memory game state — there's no meaningful static version of it
// to prerender. Forcing dynamic rendering skips build-time prerendering
// of "/" altogether, which is the correct choice architecturally (this
// screen is never the same twice — it depends on who's signed in) and
// also sidesteps a prerender-time crash that traced back to this route.
export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import nextDynamic from "next/dynamic";
import { useGameStore } from "@/lib/game/store";
import { useProfile } from "@/lib/game/useProfile";
import { GameErrorBoundary } from "@/components/game/GameErrorBoundary";
import { initErrorTracking } from "@/lib/errorTracking";
import { initAnalytics, track } from "@/lib/analytics";
import { onAuthChange, type FirebaseUser } from "@/lib/auth";
import { SignInScreen } from "@/components/auth/SignInScreen";

const GameCanvas = nextDynamic(
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

const MainMenu = nextDynamic(
  () => import("@/components/menu/MainMenu").then((m) => m.MainMenu),
  { ssr: false }
);
const LoadoutPicker = nextDynamic(
  () => import("@/components/menu/LoadoutPicker").then((m) => m.LoadoutPicker),
  { ssr: false }
);
const MapSelection = nextDynamic(
  () => import("@/components/menu/MapSelection").then((m) => m.MapSelection),
  { ssr: false }
);
const SettingsPanel = nextDynamic(
  () => import("@/components/menu/SettingsPanel").then((m) => m.SettingsPanel),
  { ssr: false }
);
const GunsmithScreen = nextDynamic(
  () => import("@/components/menu/GunsmithScreen").then((m) => m.GunsmithScreen),
  { ssr: false }
);
const ShopScreen = nextDynamic(
  () => import("@/components/menu/ShopScreen").then((m) => m.ShopScreen),
  { ssr: false }
);
const PackScreen = nextDynamic(
  () => import("@/components/menu/PackScreen").then((m) => m.PackScreen),
  { ssr: false }
);
const BattlePassScreen = nextDynamic(
  () => import("@/components/menu/BattlePassScreen").then((m) => m.BattlePassScreen),
  { ssr: false }
);
const TutorialScreen = nextDynamic(
  () => import("@/components/menu/TutorialScreen").then((m) => m.TutorialScreen),
  { ssr: false }
);
const OperatorScreen = nextDynamic(
  () => import("@/components/menu/OperatorScreen").then((m) => m.OperatorScreen),
  { ssr: false }
);
const PerfOverlay = nextDynamic(
  () => import("@/components/game/PerfOverlay").then((m) => m.PerfOverlay),
  { ssr: false }
);

export default function Home() {
  const phase = useGameStore((s) => s.phase);
  const { refresh } = useProfile();

const [authState, setAuthState] = useState
    "loading" | "signed-out" | "signed-in"
  >("loading");
  const [, setAuthUser] = useState<FirebaseUser | null>(null);

  useEffect(() => {
    initErrorTracking();
    initAnalytics();
  }, []);

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

      <GameErrorBoundary label="game">
        <GameCanvas />
      </GameErrorBoundary>

      <PerfOverlay />
    </main>
  );
}
