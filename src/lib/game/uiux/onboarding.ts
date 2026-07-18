/**
 * SEC10-UIUX (prompt 80): Onboarding registry + progress tracking.
 *
 * The TutorialScreen covers the core combat systems (movement, weapons,
 * ballistics, etc.) — this module extends onboarding to cover the
 * meta-gameplay loops the player needs to understand:
 *
 *   1. Loadout — 4-slot weapon loadout system, switching mid-match.
 *   2. Gunsmith — attachment system (muzzle/sight/grip/magazine) + stat impact.
 *   3. Shop & Economy — credits, buying weapons, packs, cosmetic economy.
 *   4. Battle Pass — seasonal progression, free vs premium tracks, claiming.
 *
 * Each onboarding step has:
 *   - id — stable slug for the progress-tracker
 *   - title — heading text (also used as the tutorial screen step title)
 *   - body — explanation text
 *   - keys — keybinding hints to show
 *   - prerequisite — stepId that must be completed first (or null)
 *   - track — "core" | "loadout" | "gunsmith" | "economy" | "battlepass"
 *   - targetScreen — the GamePhase the player should visit
 *
 * Public API:
 *   - ONBOARDING_STEPS — registry of all onboarding steps
 *   - getOnboardingStep(id) — single step lookup
 *   - getOnboardingStepsByTrack(track) — filter by track
 *   - getOnboardingProgress(playerId) — { completed, remaining, percent, nextStep }
 *   - markOnboardingStepComplete(stepId) — record completion (localStorage)
 *   - isOnboardingComplete(playerId) — has the player finished all steps
 *   - resetOnboardingProgress(playerId) — clear progress (debug/replay)
 *
 * SSR-safe: server-side calls return zero-progress without touching storage.
 */

export type OnboardingTrack = "core" | "loadout" | "gunsmith" | "economy" | "battlepass";

export type GamePhase =
  | "menu" | "loadout" | "gunsmith" | "shop" | "packs" | "battlepass" | "tutorial" | "settings";

export interface OnboardingStep {
  /** Stable id — used as the progress key. */
  id: string;
  /** Title shown in the tutorial + the onboarding checklist. */
  title: string;
  /** Explanation text — appears under the title in the tutorial screen. */
  body: string;
  /** Optional keybinding hints. */
  keys?: { key: string; action: string }[];
  /** Step that must be completed before this one unlocks. null = unlocked from the start. */
  prerequisite: string | null;
  /** Track this step belongs to. */
  track: OnboardingTrack;
  /** The game screen the player should visit to complete this step. */
  targetScreen: GamePhase;
  /** Estimated time to complete (seconds) — for the progress UI. */
  estimatedSeconds: number;
}

/**
 * The complete onboarding registry. Ordered to follow the natural
 * player journey: core combat → loadout → gunsmith → economy → battle pass.
 *
 * Core steps are the existing TutorialScreen content (kept here so
 * getOnboardingProgress can report on them as a single source of truth).
 */
export const ONBOARDING_STEPS: OnboardingStep[] = [
  // ── Core combat ──
  {
    id: "core.welcome",
    title: "Welcome to Project Reality",
    body: "A tactical FPS where positioning, suppression, and medical management matter as much as aim. This tutorial covers the core systems. Take your time — you can revisit it anytime from the menu.",
    prerequisite: null,
    track: "core",
    targetScreen: "tutorial",
    estimatedSeconds: 30,
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
    prerequisite: "core.welcome",
    track: "core",
    targetScreen: "tutorial",
    estimatedSeconds: 45,
  },
  {
    id: "core.weapons",
    title: "Weapon Handling",
    body: "Left-click to fire. Right-click to aim down sights (snipers get a full scope overlay). R to reload. Q/E or mouse wheel to switch weapons. Recoil accumulates with sustained fire.",
    keys: [
      { key: "LMB", action: "Fire" },
      { key: "RMB", action: "Aim / Scope" },
      { key: "R", action: "Reload" },
      { key: "Q / E", action: "Switch weapon" },
    ],
    prerequisite: "core.movement",
    track: "core",
    targetScreen: "tutorial",
    estimatedSeconds: 45,
  },
  {
    id: "core.medical",
    title: "Medical & Casualty",
    body: "Hits can cause Bleeding (HP drains), Fracture (reduced movement), or Unconsciousness. Use medical items to treat: H for bandage, J for splint, K for medkit, L for epinephrine.",
    keys: [
      { key: "H", action: "Bandage" },
      { key: "J", action: "Splint" },
      { key: "K", action: "Medkit" },
      { key: "L", action: "Epinephrine" },
    ],
    prerequisite: "core.weapons",
    track: "core",
    targetScreen: "tutorial",
    estimatedSeconds: 60,
  },
  {
    id: "core.radio",
    title: "Radio Macros",
    body: "Quick text radio messages for communication: Z reports contact, X calls for medic. Messages appear on the squad HUD channel.",
    keys: [
      { key: "Z", action: "Contact" },
      { key: "X", action: "Need medic" },
    ],
    prerequisite: "core.medical",
    track: "core",
    targetScreen: "tutorial",
    estimatedSeconds: 30,
  },

  // ── Loadout ──
  {
    id: "loadout.overview",
    title: "Loadout System",
    body: "Your loadout defines what you bring into a match. Project Reality uses a 4-slot system: Primary, Secondary, Melee, and Utility. Visit the Loadout screen from the main menu to customize your kit before deploying. Your loadout persists across matches — set it once and forget it, or tweak per map.",
    prerequisite: "core.radio",
    track: "loadout",
    targetScreen: "loadout",
    estimatedSeconds: 60,
  },
  {
    id: "loadout.slots",
    title: "4-Slot System",
    body: "Press 1 for primary (rifle/SMG/shotgun/sniper/LMG), 2 for secondary (pistol), 3 for melee (knife/axe/katana/etc), 4 for utility (bandage/frag/smoke/medkit). Each slot can be filled from your owned inventory. Switch mid-match with the number keys or Q/E scroll. Choose your primary based on the map: long sightlines favor sniper/marksman, tight maps favor SMG/shotgun.",
    keys: [
      { key: "1", action: "Primary" },
      { key: "2", action: "Secondary" },
      { key: "3", action: "Melee" },
      { key: "4", action: "Utility" },
      { key: "Q / E", action: "Cycle" },
    ],
    prerequisite: "loadout.overview",
    track: "loadout",
    targetScreen: "loadout",
    estimatedSeconds: 45,
  },
  {
    id: "loadout.persistence",
    title: "Save & Switch Loadouts",
    body: "Your loadout auto-saves — no need to confirm. Switch weapons by clicking a slot and picking from your inventory. The shop unlocks new weapons; once purchased, they appear in the loadout picker. Try different combinations: an AWP sniper with a heavy LMG backup for cover-fire, or a Vector SMG with medkit spam for aggressive pushes.",
    prerequisite: "loadout.slots",
    track: "loadout",
    targetScreen: "loadout",
    estimatedSeconds: 30,
  },

  // ── Gunsmith ──
  {
    id: "gunsmith.overview",
    title: "Gunsmith & Attachments",
    body: "The Gunsmith lets you customize each weapon with attachments across 4 categories: Muzzle (suppressor/compensator), Sight (red dot/holo/ACOG/8x scope), Grip (foregrip/angled grip), and Magazine (extended/quickdraw). Each attachment modifies weapon stats — suppressors trade damage for stealth, extended mags trade reload speed for capacity.",
    prerequisite: "loadout.persistence",
    track: "gunsmith",
    targetScreen: "gunsmith",
    estimatedSeconds: 90,
  },
  {
    id: "gunsmith.attachments",
    title: "Attachment Categories",
    body: "Muzzle: Suppressor reduces damage 10% but hides you from the minimap + reduces recoil. Compensator cuts vertical recoil 30%. Sight: higher zoom = better long-range but worse CQB awareness. Grip: vertical foregrip reduces recoil 25%; angled grip speeds up reload 10%. Magazine: extended mag +50% capacity but +10% reload time; quickdraw -40% reload time.",
    keys: [
      { key: "Click", action: "Attach" },
      { key: "Right-click", action: "Remove" },
    ],
    prerequisite: "gunsmith.overview",
    track: "gunsmith",
    targetScreen: "gunsmith",
    estimatedSeconds: 60,
  },
  {
    id: "gunsmith.finish",
    title: "Finish, Wraps & Charms",
    body: "Beyond attachments, the Gunsmith has three cosmetic tabs. Finish: weapon skin/paint (default/gold/neon/camo). Wraps: full-body camo patterns (woodland/desert/arctic/urban). Charms: dangling accessories on the mag-well (dice/skull/shark/feather). Cosmetics are unlocked via shop purchases or pack openings — they don't affect stats.",
    prerequisite: "gunsmith.attachments",
    track: "gunsmith",
    targetScreen: "gunsmith",
    estimatedSeconds: 45,
  },

  // ── Shop & Economy ──
  {
    id: "economy.overview",
    title: "Shop & Economy",
    body: "The Shop is where you spend credits earned from matches. Every kill, wave clear, and match completion awards credits. The shop sells: weapons (one-time unlocks), wraps/charms/finishers (cosmetics), and packs (random cosmetic crates). Weapons unlock permanently; cosmetics are unlocked-to-account.",
    prerequisite: "gunsmith.finish",
    track: "economy",
    targetScreen: "shop",
    estimatedSeconds: 60,
  },
  {
    id: "economy.credits",
    title: "Earning & Spending Credits",
    body: "Earn credits by: kills (+25 each), wave clears (+200), match completion (+500), headshots (+50 bonus), multi-kills (+100 bonus). Spend credits on: weapons (1000-5000), wraps (800-3000), charms (500-2000), packs (800-5000). Drop odds for every pack are always visible — no hidden probabilities. Inspect any pack to see the full weighted drop table.",
    prerequisite: "economy.overview",
    track: "economy",
    targetScreen: "shop",
    estimatedSeconds: 45,
  },
  {
    id: "economy.packs",
    title: "Packs & Drop Odds",
    body: "Three crates: Tactical (800cr, commons+rares), Elite (2200cr, rares+epics), Legendary (5000cr, guaranteed epic+). Each pack's drop odds are always shown — click 'Show odds' on any pack to see the weighted table. The shark charm + shark finisher are only in the Legendary crate at ~12% odds. No real-money purchase is ever required — all cosmetics are earnable through play.",
    prerequisite: "economy.credits",
    track: "economy",
    targetScreen: "packs",
    estimatedSeconds: 45,
  },

  // ── Battle Pass ──
  {
    id: "battlepass.overview",
    title: "Battle Pass",
    body: "The Battle Pass is a seasonal progression system with 50 tiers. Each tier unlocks rewards: cosmetics, credits, XP boosts, and exclusive seasonal items. There are two tracks: Free (available to all players) and Premium (purchasable, includes exclusive items + bonus credits). XP earned from matches advances the pass; you don't need to do anything special.",
    prerequisite: "economy.packs",
    track: "battlepass",
    targetScreen: "battlepass",
    estimatedSeconds: 60,
  },
  {
    id: "battlepass.claim",
    title: "Claiming Rewards",
    body: "Visit the Battle Pass screen to claim unlocked rewards. Tiers you've reached but not claimed show a pulsing badge — click to claim. Premium rewards require the Premium pass; free rewards are claimable by everyone. The season ends after 90 days; unclaimed rewards are auto-claimed at season end so you never lose progress.",
    prerequisite: "battlepass.overview",
    track: "battlepass",
    targetScreen: "battlepass",
    estimatedSeconds: 30,
  },
  {
    id: "battlepass.seasons",
    title: "Seasonal Refresh",
    body: "Each season introduces a new cosmetic theme, new weapons in the shop, and a new set of battle pass rewards. Your tier resets each season but your unlocked cosmetics are permanent. Seasons also rotate featured maps and limited-time modes. Check the Battle Pass screen at season start to plan your progression.",
    prerequisite: "battlepass.claim",
    track: "battlepass",
    targetScreen: "battlepass",
    estimatedSeconds: 30,
  },
];

// ─── Lookup helpers ────────────────────────────────────────────────────────

export function getOnboardingStep(id: string): OnboardingStep | null {
  return ONBOARDING_STEPS.find((s) => s.id === id) ?? null;
}

export function getOnboardingStepsByTrack(track: OnboardingTrack): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((s) => s.track === track);
}

export function getOnboardingTracks(): OnboardingTrack[] {
  return ["core", "loadout", "gunsmith", "economy", "battlepass"];
}

// ─── Progress tracking (localStorage, per-player) ──────────────────────────

export interface OnboardingProgress {
  /** Player id this progress is for. */
  playerId: string;
  /** Set of completed step ids. */
  completed: string[];
  /** Step ids still incomplete + unlocked (the next ones to do). */
  remaining: string[];
  /** Step ids still locked (prerequisite not yet complete). */
  locked: string[];
  /** Completion percentage across all steps (0..100). */
  percent: number;
  /** The next step the player should do (or null if all complete). */
  nextStep: OnboardingStep | null;
  /** Total estimated time remaining (seconds). */
  estimatedSecondsRemaining: number;
}

const PROGRESS_KEY_PREFIX = "pr_onboarding_v1_";

function loadCompleted(playerId: string): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(PROGRESS_KEY_PREFIX + playerId);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveCompleted(playerId: string, completed: Set<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PROGRESS_KEY_PREFIX + playerId, JSON.stringify([...completed]));
  } catch {
    /* ignore */
  }
}

/**
 * SEC10-UIUX (prompt 80): Get the player's onboarding progress.
 *
 * Returns a structured progress object with completed/remaining/locked
 * step lists + the next recommended step. Pure function — reads from
 * localStorage but does not write.
 */
export function getOnboardingProgress(playerId: string): OnboardingProgress {
  const completed = loadCompleted(playerId);
  const remaining: string[] = [];
  const locked: string[] = [];
  let nextStep: OnboardingStep | null = null;
  let estimatedSecondsRemaining = 0;

  for (const step of ONBOARDING_STEPS) {
    if (completed.has(step.id)) continue;
    // Locked if its prerequisite isn't complete.
    if (step.prerequisite && !completed.has(step.prerequisite)) {
      locked.push(step.id);
      continue;
    }
    remaining.push(step.id);
    estimatedSecondsRemaining += step.estimatedSeconds;
    if (!nextStep) nextStep = step;
  }

  const percent = Math.round((completed.size / ONBOARDING_STEPS.length) * 100);

  return {
    playerId,
    completed: [...completed],
    remaining,
    locked,
    percent,
    nextStep,
    estimatedSecondsRemaining,
  };
}

/**
 * SEC10-UIUX (prompt 80): Mark an onboarding step complete.
 * Silently no-ops if the step id is unknown. Persists to localStorage.
 */
export function markOnboardingStepComplete(stepId: string, playerId: string = "default"): void {
  const step = getOnboardingStep(stepId);
  if (!step) return;
  const completed = loadCompleted(playerId);
  completed.add(stepId);
  saveCompleted(playerId, completed);
}

/**
 * SEC10-UIUX (prompt 80): Has the player completed every onboarding step?
 */
export function isOnboardingComplete(playerId: string = "default"): boolean {
  const progress = getOnboardingProgress(playerId);
  return progress.remaining.length === 0 && progress.locked.length === 0;
}

/**
 * SEC10-UIUX (prompt 80): Clear all onboarding progress for a player.
 * Used by the "Replay tutorial" button + debug tooling.
 */
export function resetOnboardingProgress(playerId: string = "default"): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(PROGRESS_KEY_PREFIX + playerId);
  } catch {
    /* ignore */
  }
}

/**
 * SEC10-UIUX (prompt 80): Mark all onboarding steps complete (skip
 * tutorial). Used when the player clicks "Skip tutorial" on first launch.
 */
export function completeAllOnboarding(playerId: string = "default"): void {
  const all = ONBOARDING_STEPS.map((s) => s.id);
  saveCompleted(playerId, new Set(all));
}
