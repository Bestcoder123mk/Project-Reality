"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, ChevronRight, Crosshair, Heart, Wrench, Radio, CloudRain, Backpack, Wrench as WrenchIcon, Coins, Trophy, ArrowLeft } from "lucide-react";
import { useGameStore } from "@/lib/game/store";
import { OnboardingOverlay } from "@/components/uiux/OnboardingOverlay";
import { markOnboardingStepComplete } from "@/lib/game/uiux/onboarding";
// Prompt J-4081 — i18n wiring. The tutorial screen previously hardcoded
// English strings. We import the `t()` function from the i18n module so
// the step titles + bodies can be translated at runtime. The English
// strings stay as the source-of-truth in the STEPS array; t() looks up
// the key in the active locale's dictionary + falls back to English
// (then to the raw string) when no translation exists.
import { tWithFallback } from "@/lib/game/uiux/i18n";

interface TutorialStep {
  id: string;
  title: string;
  body: string;
  keys?: { key: string; action: string }[];
  icon: typeof Crosshair;
}

const STEPS: TutorialStep[] = [
  {
    id: "core.welcome",
    title: "Welcome to Project Reality",
    body: "A tactical FPS where positioning, suppression, and medical management matter as much as aim. This tutorial covers the core systems. Take your time — you can revisit it anytime from the menu.",
    icon: Crosshair,
  },
  {
    id: "core.movement",
    title: "Movement & Stance",
    body: "Use WASD to move. Hold Shift to sprint (forward only). Press C to crouch for lower profile and steadier aim. Space to jump. Press V to toggle third-person view.",
    keys: [
      { key: "WASD", action: "Move" },
      { key: "Shift", action: "Sprint" },
      { key: "C", action: "Crouch" },
      { key: "Space", action: "Jump" },
      { key: "V", action: "3rd person" },
    ],
    icon: Crosshair,
  },
  {
    id: "core.weapons",
    title: "Weapon Handling",
    body: "Left-click to fire. Right-click to aim down sights (snipers get a full scope overlay). R to reload — watch the magazine physically drop out. Q/E or mouse wheel to switch weapons. Recoil accumulates with sustained fire.",
    keys: [
      { key: "LMB", action: "Fire" },
      { key: "RMB", action: "Aim / Scope" },
      { key: "R", action: "Reload" },
      { key: "Q / E", action: "Switch weapon" },
    ],
    icon: Crosshair,
  },
  {
    id: "core.ballistics",
    title: "Ballistics & Penetration",
    body: "Bullets penetrate light cover (wood, drywall, sheet metal) with reduced velocity. Hard cover (concrete, steel) stops rounds. Choose your cover wisely — a wooden crate won't protect you from a rifle. Crates are destructible and will shatter under sustained fire.",
    icon: Crosshair,
  },
  {
    id: "core.suppression",
    title: "Suppression System",
    body: "When enemies fire near you, your suppression meter rises. High suppression increases weapon sway and narrows your audible range. Take cover to let suppression decay. Suppression forces tactical use of covering fire.",
    icon: Heart,
  },
  {
    id: "core.medical",
    title: "Medical & Casualty",
    body: "Hits can cause Bleeding (HP drains), Fracture (reduced movement), or Unconsciousness. Use medical items to treat: H for bandage (stops bleeding), J for splint (fixes fracture), K for medkit (+50 HP), L for epinephrine (revives). Items are channelled — stay safe while applying.",
    keys: [
      { key: "H", action: "Bandage" },
      { key: "J", action: "Splint" },
      { key: "K", action: "Medkit" },
      { key: "L", action: "Epinephrine" },
    ],
    icon: Heart,
  },
  {
    id: "core.weather",
    title: "Dynamic Weather",
    body: "Matches cycle through day and night with changing weather. Night reduces visibility and shifts lighting to moonlight. Rain increases fog and muffles audio. Wind affects projectile drift. Press F1 to fast-forward time. Adapt your tactics to the conditions.",
    keys: [{ key: "F1", action: "Skip time" }],
    icon: CloudRain,
  },
  {
    id: "core.radio",
    title: "Radio Macros",
    body: "Quick text radio messages for communication: Z reports contact, X calls for medic. Messages appear on the squad HUD channel.",
    keys: [
      { key: "Z", action: "Contact" },
      { key: "X", action: "Need medic" },
    ],
    icon: Radio,
  },
  {
    id: "core.audio",
    title: "Audio Realism",
    body: "Distant gunfire produces a crack (supersonic snap) then a boom (muzzle report) — the gap encodes range. Sounds through walls are muffled. Reverb changes by environment (open field vs urban vs interior). Listen carefully — audio reveals enemy positions.",
    icon: Wrench,
  },
  // ── SEC10-UIUX (prompt 80): meta-gameplay onboarding steps ──
  {
    id: "loadout.overview",
    title: "Loadout System",
    body: "Your loadout defines what you bring into a match. Project Reality uses a 4-slot system: Primary, Secondary, Melee, and Utility. Visit the Loadout screen from the main menu to customize your kit before deploying. Your loadout persists across matches — set it once and forget it, or tweak per map.",
    keys: [
      { key: "1", action: "Primary" },
      { key: "2", action: "Secondary" },
      { key: "3", action: "Melee" },
      { key: "4", action: "Utility" },
    ],
    icon: Backpack,
  },
  {
    id: "loadout.slots",
    title: "4-Slot System",
    body: "Press 1 for primary (rifle/SMG/shotgun/sniper/LMG), 2 for secondary (pistol), 3 for melee (knife/axe/katana/etc), 4 for utility (bandage/frag/smoke/medkit). Each slot can be filled from your owned inventory. Switch mid-match with the number keys or Q/E scroll. Choose your primary based on the map: long sightlines favor sniper/marksman, tight maps favor SMG/shotgun.",
    keys: [
      { key: "Q / E", action: "Cycle weapons" },
      { key: "1-4", action: "Direct slot select" },
    ],
    icon: Backpack,
  },
  {
    id: "gunsmith.overview",
    title: "Gunsmith & Attachments",
    body: "The Gunsmith lets you customize each weapon with attachments across 4 categories: Muzzle (suppressor/compensator), Sight (red dot/holo/ACOG/8x scope), Grip (foregrip/angled grip), and Magazine (extended/quickdraw). Each attachment modifies weapon stats — suppressors trade damage for stealth, extended mags trade reload speed for capacity.",
    icon: WrenchIcon,
  },
  {
    id: "gunsmith.finish",
    title: "Finish, Wraps & Charms",
    body: "Beyond attachments, the Gunsmith has three cosmetic tabs. Finish: weapon skin/paint (default/gold/neon/camo). Wraps: full-body camo patterns (woodland/desert/arctic/urban). Charms: dangling accessories on the mag-well (dice/skull/shark/feather). Cosmetics are unlocked via shop purchases or pack openings — they don't affect stats.",
    icon: WrenchIcon,
  },
  {
    id: "economy.overview",
    title: "Shop & Economy",
    body: "The Shop is where you spend credits earned from matches. Every kill, wave clear, and match completion awards credits. The shop sells: weapons (one-time unlocks), wraps/charms/finishers (cosmetics), and packs (random cosmetic crates). Weapons unlock permanently; cosmetics are unlocked-to-account.",
    icon: Coins,
  },
  {
    id: "economy.packs",
    title: "Packs & Drop Odds",
    body: "Three crates: Tactical (800cr, commons+rares), Elite (2200cr, rares+epics), Legendary (5000cr, guaranteed epic+). Each pack's drop odds are always shown — click 'Show odds' on any pack to see the weighted table. The shark charm + shark finisher are only in the Legendary crate at ~12% odds. No real-money purchase is ever required — all cosmetics are earnable through play.",
    icon: Coins,
  },
  {
    id: "battlepass.overview",
    title: "Battle Pass",
    body: "The Battle Pass is a seasonal progression system with 50 tiers. Each tier unlocks rewards: cosmetics, credits, XP boosts, and exclusive seasonal items. There are two tracks: Free (available to all players) and Premium (purchasable, includes exclusive items + bonus credits). XP earned from matches advances the pass automatically.",
    icon: Trophy,
  },
  {
    id: "battlepass.claim",
    title: "Claiming Rewards",
    body: "Visit the Battle Pass screen to claim unlocked rewards. Tiers you've reached but not claimed show a pulsing badge — click to claim. Premium rewards require the Premium pass; free rewards are claimable by everyone. The season ends after 90 days; unclaimed rewards are auto-claimed at season end so you never lose progress.",
    icon: Trophy,
  },
  {
    id: "tutorial.ready",
    title: "Ready to Deploy",
    body: "You now know the core systems + the meta-gameplay loops. Earn credits and XP by eliminating hostiles across 6 waves. Visit the Gunsmith to customize weapons, the Shop to buy gear, and the Battle Pass to claim rewards. Good luck, operator.",
    icon: Check,
  },
];

export function TutorialScreen() {
  const setPhase = useGameStore((s) => s.setPhase);
  const [step, setStep] = useState(0);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Prompt J-4082 — step verification. The previous `advance()` marked a
  // step complete unconditionally as soon as the player clicked Next.
  // Now the player must check "I understand" before Next unlocks. This is
  // a lightweight verify — not a skills test — but it ensures the player
  // at least acknowledged each step rather than button-mashing through.
  const [verified, setVerified] = useState(false);
  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  // Reset the verify checkbox whenever the step changes.
  useEffect(() => { setVerified(false); }, [step]);

  // Mark the step complete as the player advances past it.
  const advance = (next: number) => {
    if (next > step) {
      // Prompt J-4082 — only mark complete if the player verified.
      if (!verified) return;
      markOnboardingStepComplete(current.id);
    }
    setStep(next);
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#141416] p-7 text-white"
      >
        <div className="mb-4 flex items-center justify-between">
          <button
            onClick={() => setPhase("menu")}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
            aria-label="Back to menu"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? "w-6 bg-white" : i < step ? "w-1.5 bg-white/40" : "w-1.5 bg-white/15"
                }`}
              />
            ))}
          </div>
          <span className="text-xs text-white/40 tabular-nums">
            {step + 1}/{STEPS.length}
          </span>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
              <Icon className="h-6 w-6 text-white/80" />
            </div>
            <h2 className="text-xl font-bold tracking-tight">{tWithFallback(`tutorial.${current.id}.title`, current.title)}</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">{tWithFallback(`tutorial.${current.id}.body`, current.body)}</p>

            {current.keys && (
              <div className="mt-4 grid grid-cols-2 gap-2">
                {current.keys.map((k) => (
                  <div
                    key={k.key}
                    className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2"
                  >
                    <kbd className="rounded bg-white/15 px-2 py-0.5 text-[10px] font-bold text-white">
                      {k.key}
                    </kbd>
                    <span className="text-xs text-white/60">{k.action}</span>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {/* Onboarding progress overlay (collapsible) */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowOnboarding((v) => !v)}
            className="text-[11px] uppercase tracking-wider text-white/40 transition-colors hover:text-white/60"
            aria-expanded={showOnboarding}
          >
            {showOnboarding ? "Hide" : "Show"} onboarding progress
          </button>
          <AnimatePresence>
            {showOnboarding && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 overflow-hidden"
              >
                <OnboardingOverlay
                  onStepClick={(stepId) => {
                    // Jump to the matching tutorial step.
                    const idx = STEPS.findIndex((s) => s.id === stepId);
                    if (idx >= 0) setStep(idx);
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-6 flex gap-2">
          {step > 0 && (
            <button
              onClick={() => advance(step - 1)}
              className="flex h-11 items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-5 text-sm font-medium text-white hover:bg-white/10"
            >
              Back
            </button>
          )}
          {/* Prompt J-4082 — verify checkbox. The player must check this
              before the Next/Complete button unlocks. */}
          {!isLast && (
            <label className="flex flex-1 cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 text-xs text-white/60 hover:bg-white/[0.04]">
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
                className="h-3.5 w-3.5 accent-amber-500"
              />
              <span>I understand — advance to next step</span>
            </label>
          )}
          {!isLast ? (
            <button
              onClick={() => advance(step + 1)}
              disabled={!verified}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-black transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={() => {
                markOnboardingStepComplete(current.id);
                setPhase("menu");
              }}
              disabled={!verified}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-black transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
            >
              <Check className="h-4 w-4" /> Complete
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
