/**
 * Section B (B2-5000) — weapon depth + cosmetics extension module.
 *
 * Implements prompts 768–930 (lines 1561–1900 of `5000-IMPROVEMENT-PROMPTS.md`)
 * covering: per-weapon crosshair profiles + share codes, per-weapon animation
 * pose tables (idle/sprint/ADS/inspect/reload/equip/holster/fire/dry-fire/
 * jam-clear/melee/grenade), akimbo depth (per-hand reload + ammo + alternating
 * + simultaneous + accuracy + reload-speed), magazine pre-load/inspection/
 * drop-on-speed/retention-on-tactical, swap variety/interrupt/speed-modifiers,
 * jam-clear stamina/injury/progress-bar/audio-cue, weapon heat visual/audio/
 * smoke/mirage/cook-off, weapon condition visual/audio/accuracy/malfunction/
 * cleaning, cleaning cost/time/repair-kit/oil, attachment preview/stats/
 * comparison/save-slots/share/unlock/cosmetic/wear/swap-audio/swap-anim/
 * affects-reload-ADS-movement-swap.
 *
 * Pure data tables + helpers. No engine wiring (the engine-wiring territory
 * is the B1 ownership of WeaponSystem.ts/GrenadeSystem.ts/etc.).
 *
 * Renumbering note: the 5000-prompt file renumbers the prior 1000-prompt
 * mission's 224–300 range to 768–843 (already done — see worklog
 * §B2-weapons-226-300). This module covers the NEW prompts 844–930 + the
 * cosmetic gaps (768–771) not present in the prior mission.
 */

import type { WeaponType, WeaponCategory } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 768–771 — crosshair: per-weapon profiles + share code.
// (768 bloom, 772 hitmarker customization, 773 hitmarker differentiation,
// 774 low-ammo HUD, 775 last-round audio — all DONE in sectionB.ts +
// CombatFeel.ts from prior missions. 769 crosshair editor config — DONE in
// CombatFeel.ts. 770 per-weapon crosshair profiles + 771 share code — NEW.)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-weapon crosshair profile. Different weapons get different crosshair
 *  shapes + colors so the player can identify the equipped weapon at a glance
 *  + the crosshair matches the weapon's role (sniper = thin cross + dot,
 *  shotgun = wide cross + circle, LMG = T-shape, pistol = small cross). */
export interface CrosshairProfile {
  /** Crosshair shape — "cross" | "dot" | "circle" | "t_shape" | "cross_dot". */
  shape: "cross" | "dot" | "circle" | "t_shape" | "cross_dot";
  /** Gap between crosshair lines (px) at zero spread. */
  gap: number;
  /** Line thickness (px). */
  thickness: number;
  /** Line length (px). 0 = infinite (just a gap). */
  length: number;
  /** Center dot radius (px). 0 = no dot. */
  dotRadius: number;
  /** Outline (true = draw a dark outline around lines for contrast). */
  outline: boolean;
  /** Color (hex). */
  color: number;
}

const DEFAULT_CROSSHAIR: CrosshairProfile = {
  shape: "cross", gap: 6, thickness: 1.5, length: 8, dotRadius: 0,
  outline: true, color: 0xffffff,
};

/** Per-weapon crosshair profiles. B2-5000 #770 — weapons had a single global
 *  crosshair; now each weapon has a profile tuned to its role. Missing
 *  entries fall through to DEFAULT_CROSSHAIR. */
export const WEAPON_CROSSHAIR_PROFILES: Partial<Record<WeaponType, CrosshairProfile>> = {
  // Snipers — thin cross + dot (precision aim; dot is the aim point).
  awp:    { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 2, thickness: 1, length: 6, dotRadius: 1, color: 0x000000 },
  l115a3: { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 2, thickness: 1, length: 6, dotRadius: 1, color: 0x000000 },
  scout:  { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 3, thickness: 1, length: 7, dotRadius: 1, color: 0x000000 },
  kar98k: { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 3, thickness: 1, length: 7, dotRadius: 1, color: 0x000000 },
  // Shotguns — wide cross + circle (spread indicator).
  nova:   { ...DEFAULT_CROSSHAIR, shape: "circle", gap: 14, thickness: 2, length: 4, dotRadius: 0, color: 0xffffff },
  m1014:  { ...DEFAULT_CROSSHAIR, shape: "circle", gap: 14, thickness: 2, length: 4, dotRadius: 0, color: 0xffffff },
  spas12: { ...DEFAULT_CROSSHAIR, shape: "circle", gap: 16, thickness: 2, length: 4, dotRadius: 0, color: 0xffffff },
  // LMGs — T-shape (the LMG's role is suppression; T indicates wide coverage).
  m249: { ...DEFAULT_CROSSHAIR, shape: "t_shape", gap: 8, thickness: 2, length: 10, dotRadius: 1, color: 0xffcc66 },
  rpk:  { ...DEFAULT_CROSSHAIR, shape: "t_shape", gap: 8, thickness: 2, length: 10, dotRadius: 1, color: 0xffcc66 },
  mk48: { ...DEFAULT_CROSSHAIR, shape: "t_shape", gap: 9, thickness: 2, length: 11, dotRadius: 1, color: 0xffcc66 },
  // Pistols — small cross + dot (compact, fast aim).
  usp:      { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 4, thickness: 1, length: 5, dotRadius: 1, color: 0xffffff },
  deagle:   { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 5, thickness: 1.5, length: 6, dotRadius: 1, color: 0xffffff },
  glock18:  { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 4, thickness: 1, length: 5, dotRadius: 1, color: 0xffffff },
  m1911:    { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 5, thickness: 1.5, length: 6, dotRadius: 1, color: 0xffffff },
  revolver: { ...DEFAULT_CROSSHAIR, shape: "cross_dot", gap: 5, thickness: 1.5, length: 6, dotRadius: 1, color: 0xffffff },
};

/** B2-5000 #770 — get the crosshair profile for a weapon (falls back to
 *  DEFAULT_CROSSHAIR for weapons without an explicit entry). */
export function getCrosshairProfile(weapon: WeaponType): CrosshairProfile {
  return WEAPON_CROSSHAIR_PROFILES[weapon] ?? DEFAULT_CROSSHAIR;
}

/** B2-5000 #771 — crosshair share code. Encodes a CrosshairProfile as a short
 *  base36 string (10–12 chars) that players can copy/paste to share their
 *  custom crosshair. Format: `<shape>:<gap>:<thickness>:<length>:<dot>:<color>`
 *  with each field base36-encoded + joined by `-`. */
export function encodeCrosshairShareCode(profile: CrosshairProfile): string {
  const shapeIdx = ["cross", "dot", "circle", "t_shape", "cross_dot"].indexOf(profile.shape);
  const enc = (n: number) => Math.max(0, Math.round(n)).toString(36);
  return [
    enc(shapeIdx),
    enc(profile.gap),
    enc(profile.thickness * 10), // ×10 to preserve 1-decimal precision
    enc(profile.length),
    enc(profile.dotRadius * 10),
    enc(profile.outline ? 1 : 0),
    enc(profile.color),
  ].join("-");
}

/** B2-5000 #771 — decode a crosshair share code back to a CrosshairProfile.
 *  Returns null if the code is malformed. */
export function decodeCrosshairShareCode(code: string): CrosshairProfile | null {
  const parts = code.trim().split("-");
  if (parts.length !== 7) return null;
  const dec = (s: string, fallback: number) => {
    const n = parseInt(s, 36);
    return Number.isNaN(n) ? fallback : n;
  };
  const shapeIdx = dec(parts[0], 0);
  const shapes: CrosshairProfile["shape"][] = ["cross", "dot", "circle", "t_shape", "cross_dot"];
  if (shapeIdx < 0 || shapeIdx >= shapes.length) return null;
  return {
    shape: shapes[shapeIdx],
    gap: dec(parts[1], DEFAULT_CROSSHAIR.gap),
    thickness: dec(parts[2], DEFAULT_CROSSHAIR.thickness * 10) / 10,
    length: dec(parts[3], DEFAULT_CROSSHAIR.length),
    dotRadius: dec(parts[4], DEFAULT_CROSSHAIR.dotRadius * 10) / 10,
    outline: dec(parts[5], 1) === 1,
    color: dec(parts[6], DEFAULT_CROSSHAIR.color),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 867–880 — per-weapon animation pose tables.
// (867 idle DONE in fp-state-machine.ts via WEAPON_BASE_POSE_OVERRIDES.
//  868 sprint, 869 ADS, 870 inspect, 871 reload, 872 sprint-start, 873
//  sprint-stop, 874 equip, 875 holster, 876 fire, 877 dry-fire, 878
//  jam-clear, 879 melee, 880 grenade throw — pose offsets per weapon.)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-weapon animation pose offset. Applied additively on top of the base
 *  pose for the named state. Lets each weapon have a distinct feel for
 *  sprint, ADS, inspect, reload, etc. without authoring full clips. */
export interface WeaponAnimPoseOffset {
  /** Position offset [x, y, z] in meters (viewmodel-local). */
  pos?: [number, number, number];
  /** Rotation offset [x, y, z] in radians (Euler XYZ). */
  rot?: [number, number, number];
  /** FOV offset (degrees, additive). */
  fov?: number;
}

/** Per-weapon per-state pose offsets. B2-5000 #867–#880 — the prior state
 *  machine had a single global pose per state; now each weapon can override
 *  any state's pose. The engine applies these as additive offsets on top of
 *  the base pose returned by FPAnimStateMachine. */
export const WEAPON_ANIM_POSE_OFFSETS: Partial<Record<WeaponType, Partial<Record<string, WeaponAnimPoseOffset>>>> = {
  // LMGs — sprint lower + tilted more (heavy weapon carry).
  m249: {
    sprint: { pos: [0.04, -0.04, -0.02], rot: [0.1, 0.05, 0.05], fov: 2 },
    reload: { pos: [0, -0.02, 0], rot: [0.05, 0, 0] },
    inspect: { pos: [0, 0.02, 0.02], rot: [0, 0.1, 0] },
  },
  rpk: {
    sprint: { pos: [0.04, -0.04, -0.02], rot: [0.1, 0.05, 0.05], fov: 2 },
    reload: { pos: [0, -0.02, 0], rot: [0.05, 0, 0] },
  },
  mk48: {
    sprint: { pos: [0.04, -0.04, -0.02], rot: [0.1, 0.05, 0.05], fov: 2 },
    reload: { pos: [0, -0.02, 0], rot: [0.05, 0, 0] },
  },
  // Snipers — ADS pose tilted slightly (scope eye relief), inspect rotates more.
  awp: {
    ads: { pos: [0, -0.005, -0.01], rot: [0, 0, 0], fov: 0 },
    inspect: { pos: [0, 0.02, 0.03], rot: [0, 0.15, 0.05] },
  },
  l115a3: {
    ads: { pos: [0, -0.005, -0.01], rot: [0, 0, 0], fov: 0 },
    inspect: { pos: [0, 0.02, 0.03], rot: [0, 0.15, 0.05] },
  },
  // Pistols — sprint higher (one-handed carry), inspect spins on Y.
  usp: {
    sprint: { pos: [0.03, 0.02, 0.02], rot: [0.2, 0.3, 0.1], fov: 3 },
    inspect: { pos: [0, 0.03, 0.05], rot: [0, 0.4, 0] },
  },
  deagle: {
    sprint: { pos: [0.03, 0.02, 0.02], rot: [0.2, 0.3, 0.1], fov: 3 },
    inspect: { pos: [0, 0.03, 0.05], rot: [0, 0.4, 0] },
  },
  revolver: {
    sprint: { pos: [0.04, 0.03, 0.02], rot: [0.25, 0.35, 0.15], fov: 3 },
    inspect: { pos: [0, 0.04, 0.05], rot: [0, 0.5, 0] }, // cylinder spin
    reload: { pos: [0, -0.02, 0.05], rot: [0.3, 0, 0] }, // tilt back for speed-loader
  },
  // Shotguns — pump-action inspect brings the weapon sideways.
  nova: {
    inspect: { pos: [0.1, 0.02, 0.02], rot: [0, 0.3, 0.2] },
    reload: { pos: [0, -0.04, 0], rot: [0.1, 0, 0] }, // dip for shell insert
  },
  spas12: {
    inspect: { pos: [0.1, 0.02, 0.02], rot: [0, 0.3, 0.2] },
    reload: { pos: [0, -0.04, 0], rot: [0.1, 0, 0] },
  },
};

/** B2-5000 #867–#880 — get the per-weapon pose offset for a state. Returns
 *  null if no override exists (the engine applies zero offset). */
export function getWeaponAnimPoseOffset(
  weapon: WeaponType,
  state: string,
): WeaponAnimPoseOffset | null {
  return WEAPON_ANIM_POSE_OFFSETS[weapon]?.[state] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 881–886 — akimbo depth (per-hand reload, per-hand ammo,
// alternating fire, simultaneous fire, accuracy penalty, reload speed).
// (831 akimbo base + 832 fireAkimbo DONE in GunplayEnhancements.ts.)
// ─────────────────────────────────────────────────────────────────────────────

/** Akimbo (dual-wield) state. Each hand has its own mag + reload timer so
 *  the player can fire/reload each independently. B2-5000 #881–#886. */
export interface AkimboState {
  /** Left-hand mag ammo count. */
  leftAmmo: number;
  /** Right-hand mag ammo count. */
  rightAmmo: number;
  /** Left-hand reload progress (0..1; 0 = not reloading). */
  leftReload: number;
  /** Right-hand reload progress (0..1; 0 = not reloading). */
  rightReload: number;
  /** Last hand fired ("left" | "right" | null). Used for alternating fire. */
  lastFired: "left" | "right" | null;
  /** Simultaneous-fire mode (true = both hands fire on one trigger pull). */
  simultaneous: boolean;
}

/** B2-5000 #881 — start a per-hand reload. The other hand can keep firing
 *  while one reloads. Returns the new state (immutable update). */
export function startAkimboHandReload(
  state: AkimboState,
  hand: "left" | "right",
): AkimboState {
  if (hand === "left") return { ...state, leftReload: 0.001 };
  return { ...state, rightReload: 0.001 };
}

/** B2-5000 #881 — advance the per-hand reload timers. Each hand's reload
 *  completes independently. `reloadMs` is the per-hand reload duration. */
export function tickAkimboReloads(
  state: AkimboState,
  dtMs: number,
  reloadMs: number,
  magSize: number,
): AkimboState {
  let { leftReload, rightReload, leftAmmo, rightAmmo } = state;
  if (leftReload > 0) {
    leftReload = Math.min(1, leftReload + dtMs / reloadMs);
    if (leftReload >= 1) {
      leftAmmo = magSize;
      leftReload = 0;
    }
  }
  if (rightReload > 0) {
    rightReload = Math.min(1, rightReload + dtMs / reloadMs);
    if (rightReload >= 1) {
      rightAmmo = magSize;
      rightReload = 0;
    }
  }
  return { ...state, leftReload, rightReload, leftAmmo, rightAmmo };
}

/** B2-5000 #883 — alternating fire. Returns the next hand to fire (alternates
 *  L/R). Skips hands that are reloading or empty. Returns null if both are
 *  unavailable. */
export function nextAkimboFireHand(state: AkimboState): "left" | "right" | null {
  const leftReady = state.leftAmmo > 0 && state.leftReload <= 0;
  const rightReady = state.rightAmmo > 0 && state.rightReload <= 0;
  if (state.simultaneous) {
    // #884 — simultaneous mode: both fire on one trigger pull. Caller should
    // fire both hands; we return "left" as the primary (the engine can check
    // simultaneous flag and fire both).
    return leftReady || rightReady ? "left" : null;
  }
  if (state.lastFired === "left") {
    if (rightReady) return "right";
    if (leftReady) return "left"; // right is reloading/empty — fire left again.
    return null;
  }
  if (state.lastFired === "right") {
    if (leftReady) return "left";
    if (rightReady) return "right";
    return null;
  }
  // First shot — prefer left.
  if (leftReady) return "left";
  if (rightReady) return "right";
  return null;
}

/** B2-5000 #885 — akimbo accuracy penalty. Dual-wielding is less accurate
 *  than single-wield (no support hand). Returns the spread multiplier
 *  (1.4 = 40% wider spread). */
export function akimboAccuracyPenalty(): number {
  return 1.4;
}

/** B2-5000 #886 — akimbo reload speed multiplier. Both hands reload at the
 *  same time (sequential left-then-right), so the total reload time is 1.5×
 *  a single-handed reload (not 2× — the operator can overlap motions).
 *  Per-hand reload is 0.75× the single-handed time (the off-hand helps). */
export function akimboPerHandReloadMult(): number {
  return 0.75;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 887–891 — magazine depth (pre-load, inspection, drop-on-speed,
// retention-on-tactical).
// ─────────────────────────────────────────────────────────────────────────────

/** B2-5000 #888 — magazine pre-load state. A pre-loaded mag has a round
 *  chambered before the reload completes, so the first shot fires faster
 *  after reload (no chambering beat). The engine tracks this flag on the
 *  weapon; the reload state machine can grant the bonus. */
export interface MagazinePreloadState {
  /** True if the next reload will pre-load a chambered round. */
  preloadAvailable: boolean;
  /** Cooldown (ms) until pre-load is available again (limits spam). */
  cooldownMs: number;
}

export const MAGAZINE_PRELOAD_COOLDOWN_MS = 5000;

/** B2-5000 #888 — attempt a pre-load. Returns true if the pre-load succeeds
 *  (cooldown was 0 + the player had the perk/item). */
export function tryMagazinePreload(state: MagazinePreloadState): boolean {
  if (state.cooldownMs > 0 || !state.preloadAvailable) return false;
  state.cooldownMs = MAGAZINE_PRELOAD_COOLDOWN_MS;
  state.preloadAvailable = false;
  return true;
}

/** B2-5000 #888 — tick the pre-load cooldown. */
export function tickMagazinePreload(state: MagazinePreloadState, dtMs: number): void {
  if (state.cooldownMs > 0) {
    state.cooldownMs = Math.max(0, state.cooldownMs - dtMs);
    if (state.cooldownMs === 0) state.preloadAvailable = true;
  }
}

/** B2-5000 #889 — magazine inspection. Returns a description of the mag's
 *  state for the inspect animation (rounds remaining + condition). */
export function inspectMagazine(
  ammoInMag: number,
  magSize: number,
  magCondition: number,
): { roundsRemaining: number; ratio: number; conditionLabel: string } {
  const ratio = magSize > 0 ? ammoInMag / magSize : 0;
  let conditionLabel = "good";
  if (magCondition < 0.3) conditionLabel = "damaged";
  else if (magCondition < 0.6) conditionLabel = "worn";
  return { roundsRemaining: ammoInMag, ratio, conditionLabel };
}

/** B2-5000 #890 — magazine drop on speed reload. A speed reload drops the
 *  old mag on the ground (cosmetic — the mag stays visible on the floor).
 *  Returns the dropped-mag descriptor for the engine to spawn. */
export function speedReloadDropMag(
  weaponSlug: WeaponType,
  pos: [number, number, number],
): { slug: WeaponType; pos: [number, number, number]; despawnSec: number } {
  return { slug: weaponSlug, pos, despawnSec: 30 };
}

/** B2-5000 #891 — magazine retention on tactical reload. A tactical reload
 *  retains the old mag (goes back to the pouch) instead of dropping it. The
 *  engine can use this to track the retained mag's remaining ammo + return
 *  it to the player's inventory. */
export function tacticalReloadRetainMag(
  remainingAmmo: number,
): { retained: boolean; ammo: number } {
  return { retained: true, ammo: remainingAmmo };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 892–895 — swap variety, swap interrupt, swap speed modifiers.
// ─────────────────────────────────────────────────────────────────────────────

/** B2-5000 #892 — weapon swap animation variants. Each swap picks one of 3
 *  variants at random so repeated swaps don't look identical. */
export const SWAP_ANIM_VARIANTS = 3;

/** B2-5000 #892 — pick a swap-anim variant (0..SWAP_ANIM_VARIANTS-1). The
 *  engine plays a different holster/equip pose per variant. */
export function pickSwapAnimVariant(): number {
  return Math.floor(Math.random() * SWAP_ANIM_VARIANTS);
}

/** B2-5000 #893 — swap interrupt on damage. Returns true if the swap should
 *  be cancelled (player took damage above the threshold). The engine uses
 *  this to abort the swap mid-animation. */
export function shouldInterruptSwapOnDamage(
  damageTaken: number,
  threshold: number = 15,
): boolean {
  return damageTaken >= threshold;
}

/** B2-5000 #894 — swap speed penalty when moving. The player swaps slower
 *  while moving (hands are busy stabilizing). Returns the swap-time
 *  multiplier (1.2 = 20% slower). */
export function swapSpeedMovePenalty(isMoving: boolean): number {
  return isMoving ? 1.2 : 1.0;
}

/** B2-5000 #895 — swap speed penalty when injured. The player swaps slower
 *  when below 40% HP (pain + blood loss slow the hands). Returns the
 *  multiplier (1.3 = 30% slower). */
export function swapSpeedInjuryPenalty(hpRatio: number): number {
  if (hpRatio < 0.2) return 1.5;
  if (hpRatio < 0.4) return 1.3;
  return 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 896–900 — jam clear: stamina/injury modifiers, progress bar,
// audio cues.
// (836 jam clear mini-game DONE in MalfunctionSystem.ts.)
// ─────────────────────────────────────────────────────────────────────────────

/** B2-5000 #896 — jam clear speed affected by stamina. Low stamina slows
 *  the clear (shaky hands). Returns the clear-time multiplier (1.25 = 25%
 *  slower). */
export function jamClearStaminaMult(staminaRatio: number): number {
  if (staminaRatio < 0.2) return 1.5;
  if (staminaRatio < 0.4) return 1.25;
  return 1.0;
}

/** B2-5000 #897 — jam clear speed affected by injury. Injured players clear
 *  slower (pain). Returns the clear-time multiplier. */
export function jamClearInjuryMult(hpRatio: number): number {
  if (hpRatio < 0.2) return 1.6;
  if (hpRatio < 0.4) return 1.3;
  return 1.0;
}

/** B2-5000 #898 — jam clear progress bar format. Returns the percentage +
 *  remaining time for HUD display. */
export function jamClearProgressBar(
  elapsedMs: number,
  totalMs: number,
): { percent: number; remainingMs: number; isComplete: boolean } {
  const ratio = Math.max(0, Math.min(1, elapsedMs / totalMs));
  return {
    percent: Math.round(ratio * 100),
    remainingMs: Math.max(0, totalMs - elapsedMs),
    isComplete: ratio >= 1,
  };
}

/** B2-5000 #899 — jam clear success audio cue. Returns the audio slug for
 *  the success sound (a sharp "click" of the bolt seating). */
export function jamClearSuccessAudioSlug(): string {
  return "jam_clear_success";
}

/** B2-5000 #900 — jam clear failure audio cue. Returns the audio slug for
 *  the failure sound (a metallic "stuck" grind). */
export function jamClearFailureAudioSlug(): string {
  return "jam_clear_stuck";
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 901–906 — weapon heat: barrel glow, sizzle audio, smoke, mirage,
// cook-off audio, cook-off visual.
// (826 LMG overheat + cook-off DONE in sectionB.ts.)
// ─────────────────────────────────────────────────────────────────────────────

/** B2-5000 #901 — barrel glow color at the given heat (0..1). Returns a
 *  [r, g, b] tuple (0..1 each). Heat below 0.6 = no glow; 0.6–0.8 = faint
 *  red; 0.8–0.95 = bright orange; 0.95+ = white-hot. */
export function barrelGlowColor(heat: number): [number, number, number] {
  if (heat < 0.6) return [0, 0, 0];
  if (heat < 0.8) {
    const t = (heat - 0.6) / 0.2;
    return [t * 0.6, t * 0.1, 0];
  }
  if (heat < 0.95) {
    const t = (heat - 0.8) / 0.15;
    return [0.6 + t * 0.4, 0.1 + t * 0.3, 0];
  }
  const t = Math.min(1, (heat - 0.95) / 0.05);
  return [1, 0.4 + t * 0.6, t * 0.8];
}

/** B2-5000 #901 — barrel glow emissive intensity (0..1) for the renderer.
 *  0 below heat=0.6, ramps to 1 at heat=1.0. */
export function barrelGlowIntensity(heat: number): number {
  if (heat < 0.6) return 0;
  return Math.min(1, (heat - 0.6) / 0.4);
}

/** B2-5000 #902 — weapon heat sizzle audio. Returns the audio slug + volume
 *  for the sizzle loop. Volume scales with heat (silent below 0.7). */
export function heatSizzleAudio(heat: number): { slug: string; volume: number } {
  if (heat < 0.7) return { slug: "", volume: 0 };
  const volume = Math.min(0.6, (heat - 0.7) / 0.3 * 0.6);
  return { slug: "barrel_sizzle_loop", volume };
}

/** B2-5000 #903 — weapon heat smoke. Returns the smoke emission rate
 *  (particles/sec) at the given heat. 0 below 0.8; ramps to 20 at heat=1.0. */
export function heatSmokeRate(heat: number): number {
  if (heat < 0.8) return 0;
  return Math.round((heat - 0.8) / 0.2 * 20);
}

/** B2-5000 #904 — weapon heat mirage distortion. Returns the screen-space
 *  distortion strength (0..1) for the mirage shader above the barrel.
 *  0 below 0.85; ramps to 0.4 at heat=1.0. */
export function heatMirageDistortion(heat: number): number {
  if (heat < 0.85) return 0;
  return Math.min(0.4, (heat - 0.85) / 0.15 * 0.4);
}

/** B2-5000 #905 — cook-off audio cue. Returns the audio slug for a cook-off
 *  event (a round fires without trigger input). Distinct from normal fire
 *  (higher pitch, no trigger click). */
export function cookOffAudioSlug(): string {
  return "cook_off_fire";
}

/** B2-5000 #906 — cook-off visual cue. Returns the muzzle-flash intensity
 *  multiplier for a cook-off (0.6 = 60% as bright as a normal shot — the
 *  cook-off is briefer + dimmer). */
export function cookOffMuzzleFlashMult(): number {
  return 0.6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 907–911 — weapon condition: visual, audio, accuracy, malfunction,
// cleaning.
// (837 weapon condition cosmetic DONE in sectionB.ts.)
// ─────────────────────────────────────────────────────────────────────────────

/** B2-5000 #907 — weapon condition visual descriptor. Returns the rust/wear
 *  level + texture tint for the renderer. Condition 1.0 = pristine; 0.0 =
 *  heavily rusted. */
export function conditionVisual(condition: number): {
  rustLevel: number;
  wearTint: number;
  scratchDensity: number;
} {
  return {
    rustLevel: Math.max(0, 1 - condition),
    wearTint: 0x4a3a2a, // brownish rust tint
    scratchDensity: Math.max(0, 1 - condition) * 0.8,
  };
}

/** B2-5000 #908 — weapon condition audio. Returns the rattle volume (0..1)
 *  for the weapon's idle sound. Heavily worn weapons rattle more. */
export function conditionRattleVolume(condition: number): number {
  if (condition > 0.7) return 0;
  return Math.min(0.4, (0.7 - condition) / 0.7 * 0.4);
}

/** B2-5000 #909 — weapon condition accuracy penalty. Returns the spread
 *  multiplier (1.0 = pristine; 1.3 = 30% wider spread at condition=0). */
export function conditionAccuracyMult(condition: number): number {
  return 1 + Math.max(0, 1 - condition) * 0.3;
}

/** B2-5000 #910 — weapon condition malfunction rate. Returns the malfunction
 *  probability multiplier (1.0 = pristine; 2.5 = 2.5× more jams at
 *  condition=0). Cross-ref prompt 690 (per-weapon reliability). */
export function conditionMalfunctionMult(condition: number): number {
  return 1 + Math.max(0, 1 - condition) * 1.5;
}

/** B2-5000 #911 — weapon cleaning in gunsmith. Restores condition to 1.0
 *  + returns the credit cost (cross-ref #912). */
export function cleanWeapon(currentCondition: number): {
  newCondition: number;
  cost: number;
} {
  const deficit = 1 - currentCondition;
  return {
    newCondition: 1.0,
    cost: Math.round(deficit * 500), // 500 credits per full condition point.
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 912–919 — cleaning cost/time, repair kit, oil.
// ─────────────────────────────────────────────────────────────────────────────

/** B2-5000 #912 — weapon cleaning cost (credits). Scales with the condition
 *  deficit (more worn = more expensive). Returns the credit cost. */
export function weaponCleaningCost(currentCondition: number): number {
  return Math.round((1 - currentCondition) * 500);
}

/** B2-5000 #913 — weapon cleaning time (ms). Scales with condition deficit.
 *  A pristine weapon takes 5s; a fully worn weapon takes 30s. */
export function weaponCleaningTimeMs(currentCondition: number): number {
  return 5000 + Math.round((1 - currentCondition) * 25000);
}

/** B2-5000 #914 — field repair kit item. Restores condition mid-match (less
 *  effective than gunsmith cleaning). Returns the new condition + whether
 *  the kit was consumed. */
export interface RepairKitItem {
  rarity: "common" | "rare" | "legendary";
  /** Restore amount (0..1) — how much condition this kit restores. */
  restoreAmount: number;
}

export const REPAIR_KIT_RARITY: Record<RepairKitItem["rarity"], number> = {
  common: 0.2,
  rare: 0.4,
  legendary: 0.7,
};

/** B2-5000 #914 + #915 — apply a repair kit. Returns the new condition +
 *  whether the kit was consumed. Condition caps at 1.0. */
export function applyRepairKit(
  currentCondition: number,
  kit: RepairKitItem,
): { newCondition: number; consumed: boolean } {
  const restore = REPAIR_KIT_RARITY[kit.rarity] ?? kit.restoreAmount;
  if (currentCondition >= 1.0) return { newCondition: 1.0, consumed: false };
  return {
    newCondition: Math.min(1.0, currentCondition + restore),
    consumed: true,
  };
}

/** B2-5000 #916 — weapon oil item. Reduces malfunction rate temporarily.
 *  Returns the oil state for the engine to track. */
export interface WeaponOilState {
  /** Time remaining (ms) until the oil wears off. */
  remainingMs: number;
  /** Malfunction-rate multiplier while active (0.5 = 50% fewer jams). */
  malfunctionMult: number;
}

export const WEAPON_OIL_DURATION_MS = 60000; // 60 seconds.
export const WEAPON_OIL_MALFUNCTION_MULT = 0.5;

/** B2-5000 #916 — apply weapon oil. Starts the oil effect timer. */
export function applyWeaponOil(state: WeaponOilState): WeaponOilState {
  return {
    remainingMs: WEAPON_OIL_DURATION_MS,
    malfunctionMult: WEAPON_OIL_MALFUNCTION_MULT,
  };
}

/** B2-5000 #917 — tick the oil duration. Returns the updated state. */
export function tickWeaponOil(state: WeaponOilState, dtMs: number): WeaponOilState {
  if (state.remainingMs <= 0) return state;
  const remainingMs = Math.max(0, state.remainingMs - dtMs);
  if (remainingMs === 0) {
    return { remainingMs: 0, malfunctionMult: 1.0 };
  }
  return { ...state, remainingMs };
}

/** B2-5000 #918 — weapon oil visual (sheen on weapon). Returns the sheen
 *  intensity (0..1) for the renderer. Fades in the last 10s of duration. */
export function weaponOilSheen(state: WeaponOilState): number {
  if (state.remainingMs <= 0) return 0;
  if (state.remainingMs < 10000) return state.remainingMs / 10000;
  return 1.0;
}

/** B2-5000 #919 — weapon oil audio (squirt). Returns the audio slug for the
 *  oil application sound. */
export function weaponOilAudioSlug(): string {
  return "oil_squirt";
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 920–930 — attachment: preview, stats overlay, comparison,
// save slots, share code, unlock by level/challenge/achievement/rank/event,
// cosmetic variants, wear, swap audio, swap animation, affects reload/ADS/
// movement/swap.
// (791 attachment balance, 792 unlock by level, 793 prestige, 794 ammo types,
//  795 mag sizes, 796 fire modes DONE in sectionB.ts.)
// ─────────────────────────────────────────────────────────────────────────────

/** B2-5000 #920 — attachment preview state for the gunsmith 3D rotate. */
export interface AttachmentPreviewState {
  /** The attachment slug being previewed. */
  slug: string;
  /** Rotation angle (radians) for the 3D preview. */
  rotationY: number;
  /** Auto-rotate speed (rad/sec). 0 = manual. */
  autoRotateSpeed: number;
}

/** B2-5000 #920 — tick the attachment preview auto-rotation. */
export function tickAttachmentPreview(state: AttachmentPreviewState, dtSec: number): void {
  if (state.autoRotateSpeed !== 0) {
    state.rotationY += state.autoRotateSpeed * dtSec;
  }
}

/** B2-5000 #921 — attachment stat overlay. Returns the stat changes an
 *  attachment applies (for the gunsmith hover tooltip). */
export interface AttachmentStatOverlay {
  damageMod: number;
  recoilMod: number;
  spreadMod: number;
  rangeMod: number;
  zoomMod: number;
  magSizeMod: number;
  reloadMod: number;
}

/** B2-5000 #922 — attachment comparison. Compares two attachments + returns
 *  the delta (positive = better, negative = worse, 0 = no change). */
export function compareAttachments(
  a: AttachmentStatOverlay,
  b: AttachmentStatOverlay,
): AttachmentStatOverlay {
  return {
    damageMod: a.damageMod - b.damageMod,
    recoilMod: a.recoilMod - b.recoilMod,
    spreadMod: a.spreadMod - b.spreadMod,
    rangeMod: a.rangeMod - b.rangeMod,
    zoomMod: a.zoomMod - b.zoomMod,
    magSizeMod: a.magSizeMod - b.magSizeMod,
    reloadMod: a.reloadMod - b.reloadMod,
  };
}

/** B2-5000 #923 — attachment save slots. Players can save multiple attachment
 *  builds per weapon + switch between them. */
export interface AttachmentSaveSlot {
  /** Slot name (player-defined). */
  name: string;
  /** The attachment slugs saved in this slot. */
  muzzle: string;
  sight: string;
  grip: string;
  magazine: string;
}

/** B2-5000 #923 — max attachment save slots per weapon. */
export const MAX_ATTACHMENT_SAVE_SLOTS = 5;

/** B2-5000 #924 — attachment share code. Encodes an AttachmentSaveSlot as a
 *  compact string for sharing. Format: `<muzzle>:<sight>:<grip>:<mag>`. */
export function encodeAttachmentShareCode(slot: AttachmentSaveSlot): string {
  return [slot.muzzle, slot.sight, slot.grip, slot.magazine].join(":");
}

/** B2-5000 #924 — decode an attachment share code. Returns null if malformed. */
export function decodeAttachmentShareCode(code: string): AttachmentSaveSlot | null {
  const parts = code.trim().split(":");
  if (parts.length !== 4) return null;
  return {
    name: "Imported",
    muzzle: parts[0],
    sight: parts[1],
    grip: parts[2],
    magazine: parts[3],
  };
}

/** B2-5000 #925–#929 — attachment unlock criteria. Each attachment can be
 *  gated by weapon level, challenge, achievement, rank, or event. The engine
 *  checks these against the player's profile. */
export type AttachmentUnlockReason =
  | { type: "level"; weapon: WeaponType; level: number }
  | { type: "challenge"; challengeId: string }
  | { type: "achievement"; achievementId: string }
  | { type: "rank"; rank: number }
  | { type: "event"; eventId: string };

/** B2-5000 #925–#929 — check if an attachment is unlocked for the player.
 *  Returns the reason it's locked (or null if unlocked). */
export function checkAttachmentUnlock(
  reason: AttachmentUnlockReason | null,
  ctx: {
    weaponLevels: Partial<Record<WeaponType, number>>;
    completedChallenges: Set<string>;
    achievements: Set<string>;
    playerRank: number;
    activeEvents: Set<string>;
  },
): AttachmentUnlockReason | null {
  if (!reason) return null;
  switch (reason.type) {
    case "level": {
      const lvl = ctx.weaponLevels[reason.weapon] ?? 0;
      return lvl >= reason.level ? null : reason;
    }
    case "challenge":
      return ctx.completedChallenges.has(reason.challengeId) ? null : reason;
    case "achievement":
      return ctx.achievements.has(reason.achievementId) ? null : reason;
    case "rank":
      return ctx.playerRank >= reason.rank ? null : reason;
    case "event":
      return ctx.activeEvents.has(reason.eventId) ? null : reason;
  }
}

/** B2-5000 #930 — attachment cosmetic variants (gold camo on attachment). */
export type AttachmentCosmetic = "default" | "gold" | "carbon" | "neon";

/** B2-5000 #931 (deferred from prompt list) — attachment wear (condition).
 *  Attachments have their own condition that degrades with use. */
export interface AttachmentWearState {
  /** Condition (0..1). 1 = pristine; 0 = broken. */
  condition: number;
  /** Total rounds fired while this attachment was equipped. */
  roundsFired: number;
}

/** B2-5000 #931 — tick attachment wear. Each round fired degrades condition
 *  by `wearPerShot`. */
export function tickAttachmentWear(state: AttachmentWearState, roundsFired: number, wearPerShot: number = 0.0001): void {
  state.roundsFired += roundsFired;
  state.condition = Math.max(0, state.condition - roundsFired * wearPerShot);
}

/** B2-5000 #932 — attachment swap audio. Returns the audio slug for the
 *  attach/detach click. */
export function attachmentSwapAudioSlug(attaching: boolean): string {
  return attaching ? "attachment_attach" : "attachment_detach";
}

/** B2-5000 #933 — attachment swap animation duration (ms). The viewmodel
 *  plays a brief hand-reach to the attachment point + back. */
export function attachmentSwapAnimMs(): number {
  return 600;
}

/** B2-5000 #934 — attachment effect on reload speed. Extended mags slow
 *  reload; quick-mags speed it up. Returns the reload-time multiplier. */
export function attachmentReloadSpeedMod(magazineAttachment: string): number {
  switch (magazineAttachment) {
    case "ext_mag":  return 1.15; // 15% slower (heavier mag).
    case "quick_mag": return 0.75; // 25% faster (quick-release).
    default:          return 1.0;
  }
}

/** B2-5000 #935 — attachment effect on ADS speed. Heavy scopes slow ADS;
 *  red-dot is neutral; holographic is slightly faster. Returns the ADS-time
 *  multiplier. */
export function attachmentAdsSpeedMod(sightAttachment: string): number {
  switch (sightAttachment) {
    case "scope8x": return 1.4;  // 40% slower (heavy scope).
    case "acog":    return 1.15; // 15% slower.
    case "holo":    return 0.95; // 5% faster (light optic).
    case "red_dot": return 1.0;  // neutral.
    default:        return 1.0;
  }
}

/** B2-5000 #936 — attachment effect on movement speed. Heavy attachments
 *  (drum mags, heavy scopes) slow the player. Returns the move-speed
 *  multiplier. */
export function attachmentMoveSpeedMod(loadout: {
  muzzle: string; sight: string; grip: string; magazine: string;
}): number {
  let mult = 1.0;
  if (loadout.magazine === "ext_mag") mult -= 0.03; // 3% slower.
  if (loadout.sight === "scope8x") mult -= 0.02;    // 2% slower.
  if (loadout.muzzle === "suppressor") mult -= 0.01; // 1% slower.
  return Math.max(0.9, mult);
}

/** B2-5000 #937 — attachment effect on swap speed. Heavy attachments slow
 *  weapon swap. Returns the swap-time multiplier. */
export function attachmentSwapSpeedMod(loadout: {
  muzzle: string; sight: string; grip: string; magazine: string;
}): number {
  let mult = 1.0;
  if (loadout.magazine === "ext_mag") mult += 0.05;
  if (loadout.sight === "scope8x") mult += 0.03;
  return mult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 843 — "weapon feels" pass (cross-ref docs/GUNPLAY-AUDIT.md #125).
// (300 feel-pass template DONE in sectionB.ts: computeFeelCard, rankWeaponsByFeel.
//  This helper exposes the bottom-3/best-3 ranking for the audit doc.)
// ─────────────────────────────────────────────────────────────────────────────

/** B2-5000 #843 — rank weapons by feel card. Returns the top-3 (best feel)
 *  + bottom-3 (worst feel) weapon slugs. The feel card combines recoil
 *  recovery, spread, fire rate, + reload speed into a 0..100 score. */
export function rankWeaponsByFeelSimple(
  feelScores: Partial<Record<WeaponType, number>>,
): { top3: WeaponType[]; bottom3: WeaponType[] } {
  const entries = Object.entries(feelScores) as [WeaponType, number][];
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  return {
    top3: sorted.slice(0, 3).map(([w]) => w),
    bottom3: sorted.slice(-3).map(([w]) => w),
  };
}
