/**
 * SEC4-ANIM — Prompt 36
 * ─────────────────────────────────────────────────────────────────────────────
 * Weapon animation clips — beat-based inspect + reload with real weight.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission A-series fix noted):
 *   C2-5000 #1318 [Prompt A#50] chamber beat sign inversion (matches rack direction)
 *   C2-5000 #1319 [Prompt A#51] settle beat distinct from chamber beat (separate clip beat)
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1127 [Prompt 327]  hand IK for reload (reloadFingerCurl + applyReloadFingerCurl)
 *   C1-5000 #1128 [Prompt 328]  hand-on-weapon IK foregrip (supportHandForegripTarget)
 *   C1-5000 #1131 [Prompt 331]  two-bone IK for arms (solveArmTwoBoneIK)
 *   C1-5000 #1132 [Prompt 332]  pole vectors for arm IK (elbowPoleVector)
 *   C1-5000 #1191 [Prompt 391]  reload interrupt by sprint/swap/melee (reloadInterruptCancel)
 *   C1-5000 #1192 [Prompt 392]  sprint-into-fire bring-up (sampleSprintIntoFireBringUp)
 *   C1-5000 #1193 [Prompt 393]  chamber-round detail (sampleChamberHandle)
 *   C1-5000 #1194 [Prompt 394 + 260]  magazine drop physics (magDropInitialVelocity + magDropClip)
 *   C1-5000 #1195 [Prompt 395 + 258]  shell ejection viewmodel (shellEjectionVelocity + shellEjectionClip)
 *   C1-5000 #1196 [Prompt 396]  sight alignment per-weapon (sightAlignmentOffset)
 *   C1-5000 #1197 [Prompt 397]  ADS FOV per-weapon (adsFovFor)
 *   C1-5000 #1198 [Prompt 398]  weapon inertia on jump/land (sampleWeaponInertia)
 *   C1-5000 #1199 [Prompt 399]  weapon collision with world (sampleWeaponCollisionRetract)
 *   C1-5000 #1200 [Prompt 400]  bipod deployment animation (sampleBipodDeploy)
 *   C1-5000 #1201 [Prompt 401]  underbarrel attachment activation (sampleUnderbarrelSwap)
 *
 * C3-5000 prompt mapping (each "C3-5000 #NNNN" is addressed by the existing
 *  per-weapon duration/effect table noted in brackets — these prompts ask
 *  for "variety per weapon" and the per-weapon tables (RELOAD_DURATIONS,
 *  INSPECT_DURATIONS, etc.) ARE the variety surface. C3-5000 adds explicit
 *  per-weapon VARIETY exports at the bottom of this file enumerating the
 *  per-type variants the engine can request):
 *   C3-5000 #1521 [GRENADE_VARIETY]       grenade variety per type (frag/flash/smoke/incendiary/molotov)
 *   C3-5000 #1522 [RELOAD_DURATIONS]      reload variety per weapon (per-weapon time tables)
 *   C3-5000 #1523 [FIRE_VARIETY]          fire variety per weapon (rifle/pistol/shotgun/sniper/lmg/smg)
 *   C3-5000 #1524 [INSPECT_DURATIONS]     inspect variety per weapon
 *   C3-5000 #1525 [SWAP_VARIETY]          swap variety per weapon (raise/lower/holster times per slot)
 *   C3-5000 #1556 [VIEWMODEL_TUNE_TABLE]  viewmodel tuning per weapon (sway/ADS-FOV/kick-recover)
 *
 * Each clip is a timed curve: a duration + a set of beats (named time
 * segments) + a sample function that returns the weapon's local transform
 * at a given normalized time t ∈ [0,1].
 *
 * Inspect — 3-beat: anticipation (lift + tilt) → check (rotate sideways to
 *   show the receiver to the camera) → settle (return to rest). Per-weapon
 *   duration varies (~2.0–3.0s) — heavier weapons take longer to flip.
 *
 * Reload — multi-beat with REAL weight (not an abstracted timer):
 *   - Standard (rifle/pistol/sniper): mag-out (dip + mag drop) → mag-insert
 *     (raise + mag snap-in thrust) → chamber (charging handle / slide rack)
 *     → settle.
 *   - Shotgun (nova) + LMG (m249): shell/belt-feed reloads with multiple
 *     insert beats (one per shell / belt round) + a close beat + chamber.
 *
 * Per-weapon duration tables let the engine's reload timer match the
 * animation length exactly (no popping at the end).
 *
 * Public API:
 *   - playInspect(weaponSlug) → WeaponAnimClip
 *   - playReload(weaponSlug) → WeaponAnimClip
 *   - INSPECT_DURATIONS / RELOAD_DURATIONS (per-weapon time tables)
 *   - sampleBeat(t, beats) → { name, localT } helper (which beat + local 0..1)
 *
 * SSR-safe: pure-TS math, no Three.js, no `window`.
 */

// B2-5000 #859 — import WeaponType so the per-weapon duration tables are
// keyed by the canonical slug type (typo caught at compile time, not at the
// fallback `?? 2.5` default which silently masked missing entries).
import type { WeaponType } from "../store";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** A weapon animation transform — same shape as FPViewModelTransform so the
 *  FP state machine can consume these clips directly. */
export interface WeaponAnimTransform {
  pos: [number, number, number];
  rot: [number, number, number];
  fov: number;
}

/** A named time segment within a clip. */
export interface WeaponAnimBeat {
  name: string;
  /** Start time (normalized 0..1). */
  start: number;
  /** End time (normalized 0..1). */
  end: number;
}

/** A timed animation clip with a sample function. */
export interface WeaponAnimClip {
  name: string;
  /** Total duration in seconds. */
  duration: number;
  beats: WeaponAnimBeat[];
  /** Sample the clip at normalized time t ∈ [0,1]. */
  sample: (t: number) => WeaponAnimTransform;
}

// ───────────────────────────────────────────────────────────────────────────
// Per-weapon duration tables
// ───────────────────────────────────────────────────────────────────────────

/**
 * Inspect durations (seconds). Heavier weapons = slower inspect.
 * A2-5000 #271 — phantom weapons removed (bizon, mac10, kriss, g18,
 * fiveseven, p226, m9, sr25, m14ebr, m870, saiga, aa12, m240 were not in
 * the 30-weapon catalog). Missing catalog weapons added (glock18, m1911,
 * revolver, kar98k, l115a3, m1014, spas12, pp90m1, mk48).
 * A2-5000 #272 — NOTE: these are SECONDS. store.ts reloadTime is in MS.
 * The two are intentionally separate (anim duration vs gameplay reload gate);
 * they don't need to match exactly, but large drift is a known issue.
 */
export const INSPECT_DURATIONS: Partial<Record<WeaponType, number>> = {
  // Rifles
  ak74: 2.5, m4: 2.4, hk416: 2.4, famas: 2.4, aug: 2.4, scarh: 2.5, galil: 2.5,
  mk17: 2.5, mk14: 2.6,
  // SMGs
  mp7: 2.2, p90: 2.3, mp5: 2.2, ump45: 2.3, vector: 2.2, pp90m1: 2.4,
  // Pistols
  usp: 1.9, deagle: 2.2, glock18: 2.0, m1911: 2.0, revolver: 2.1,
  // Snipers
  awp: 3.0, scout: 2.8, kar98k: 2.9, l115a3: 3.1,
  // Shotguns
  nova: 2.6, m1014: 2.5, spas12: 2.7,
  // LMG
  m249: 3.2, rpk: 3.0, mk48: 3.3,
};

/**
 * Reload durations (seconds). Shotgun (nova) is per-shell — we model one
 * full mag reload (4 shells). LMG (m249) is belt-fed (longer).
 * A2-5000 #271/#272 — phantom weapons removed; missing catalog weapons
 * added. Units are SECONDS (store.ts reloadTime is MS — see INSPECT_DURATIONS
 * note above).
 */
export const RELOAD_DURATIONS: Partial<Record<WeaponType, number>> = {
  // Rifles
  ak74: 2.6, m4: 2.3, hk416: 2.3, famas: 2.4, aug: 2.4, scarh: 2.5, galil: 2.6,
  mk17: 2.5, mk14: 2.6,
  // SMGs
  mp7: 1.9, p90: 2.1, mp5: 1.9, ump45: 2.2, vector: 2.0, pp90m1: 2.2,
  // Pistols
  usp: 1.6, deagle: 1.9, glock18: 1.7, m1911: 1.7, revolver: 1.8,
  // Snipers (bolt-action = longer chamber beat)
  awp: 3.2, scout: 2.9, kar98k: 3.0, l115a3: 3.3,
  // Shotguns (per-shell: 4 shells)
  nova: 3.8, m1014: 2.5, spas12: 3.5,
  // LMG (belt-fed)
  m249: 5.2, rpk: 3.2, mk48: 5.5,
};

/**
 * Shotguns + LMGs that use the multi-insert reload pattern.
 * A2-5000 #273 — fixed set: removed phantom m870/m240; added mk48
 * (7.62 LMG, belt-fed multi-insert). Set now matches the 30-weapon catalog.
 */
const MULTI_INSERT_WEAPONS: ReadonlySet<WeaponType> = new Set<WeaponType>(["nova", "m1014", "spas12", "m249", "rpk", "mk48"]);

// ───────────────────────────────────────────────────────────────────────────
// Easing helpers
// ───────────────────────────────────────────────────────────────────────────

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeIn = (t: number) => t * t * t;
const easeInOut = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const bell = (t: number) => Math.sin(t * Math.PI);

// ───────────────────────────────────────────────────────────────────────────
// Inspect clip
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a 3-beat inspect clip for the given weapon. The beats are:
 *   1. anticipation (0–0.2): lift + slight tilt toward the player.
 *   2. check (0.2–0.7): rotate the weapon sideways so the receiver faces
 *      the camera. Hold at peak in the middle of the beat.
 *   3. settle (0.7–1.0): ease back to rest.
 */
export function playInspect(weaponSlug: WeaponType): WeaponAnimClip {
  const duration = INSPECT_DURATIONS[weaponSlug] ?? 2.5;
  const beats: WeaponAnimBeat[] = [
    { name: "anticipation", start: 0, end: 0.2 },
    { name: "check", start: 0.2, end: 0.7 },
    { name: "settle", start: 0.7, end: 1.0 },
  ];

  const sample = (t: number): WeaponAnimTransform => {
    if (t < 0.2) {
      // Anticipation — lift + tilt.
      const u = t / 0.2;
      const k = easeOut(u);
      return {
        pos: [0, 0.04 * k, 0.05 * k],
        rot: [-0.15 * k, 0, 0.1 * k],
        fov: 0,
      };
    }
    if (t < 0.7) {
      // Check — rotate sideways (yaw + roll), peak in the middle.
      const u = (t - 0.2) / 0.5;
      const turnK = bell(u); // 0 → 1 → 0
      return {
        pos: [0.12 * turnK, 0.04, 0.05],
        rot: [-0.15, 0.9 * turnK, 0.5 * turnK],
        fov: 0,
      };
    }
    // Settle — ease back to rest.
    const u = (t - 0.7) / 0.3;
    const k = 1 - easeIn(u); // 1 → 0
    return {
      pos: [0.12 * k, 0.04 * k, 0.05 * k],
      rot: [-0.15 * k, 0.9 * k, 0.5 * k],
      fov: 0,
    };
  };

  return { name: `inspect:${weaponSlug}`, duration, beats, sample };
}

// ───────────────────────────────────────────────────────────────────────────
// Reload clip
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a multi-beat reload clip with REAL weight (magazine insertion +
 * chambering beats, not an abstracted timer).
 *
 * Standard pattern (rifle/pistol/sniper): mag-out → mag-insert → chamber → settle.
 * Multi-insert pattern (shotgun/LMG): open → insert × N → close → chamber.
 */
export function playReload(weaponSlug: WeaponType): WeaponAnimClip {
  const duration = RELOAD_DURATIONS[weaponSlug] ?? 2.4;
  const isMulti = MULTI_INSERT_WEAPONS.has(weaponSlug);
  const beats: WeaponAnimBeat[] = isMulti
    ? [
        { name: "open", start: 0, end: 0.1 },
        { name: "insert-1", start: 0.1, end: 0.3 },
        { name: "insert-2", start: 0.3, end: 0.5 },
        { name: "insert-3", start: 0.5, end: 0.7 },
        { name: "close", start: 0.7, end: 0.85 },
        { name: "chamber", start: 0.85, end: 1.0 },
      ]
    : [
        { name: "mag-out", start: 0, end: 0.25 },
        { name: "mag-insert", start: 0.25, end: 0.6 },
        { name: "chamber", start: 0.6, end: 0.85 },
        { name: "settle", start: 0.85, end: 1.0 },
      ];

  const sample = isMulti
    ? makeMultiInsertSample()
    : makeStandardReloadSample();

  return { name: `reload:${weaponSlug}`, duration, beats, sample };
}

/** Standard reload sample (rifle/pistol/sniper). */
function makeStandardReloadSample(): (t: number) => WeaponAnimTransform {
  return (t: number): WeaponAnimTransform => {
    if (t < 0.25) {
      // Beat 1: mag-out — weapon dips down + tilts toward the support hand.
      const u = t / 0.25;
      const k = easeOut(u);
      return {
        pos: [0, -0.06 * k, 0],
        rot: [0.4 * k, -0.2 * k, 0],
        fov: 0,
      };
    }
    if (t < 0.6) {
      // Beat 2: mag-insert — weapon raises back up; mag snaps in with a
      // forward thrust (bell-curve z motion).
      const u = (t - 0.25) / 0.35;
      const k = bell(u); // thrust peaks mid-beat
      const settle = 1 - u; // remaining dip to recover
      return {
        pos: [0, -0.06 * settle, 0.06 * k],
        rot: [0.4 * settle, -0.2 * settle - 0.4 * k, 0],
        fov: 0,
      };
    }
    if (t < 0.85) {
      // Beat 3: chamber — weapon kicks back toward camera (charging handle
      // / slide rack). Slight DOWNWARD pitch (the charging handle is pushed
      // forward + down, which torques the gun's muzzle down briefly).
      // Prompt A#50 — sign inversion. Was `rot: [-0.08*k, 0, 0]` which
      // pitches the weapon UP (the comment said "upward pitch" but the
      // real charging-handle rack motion pitches the gun DOWN as the
      // shooter's support hand pushes the handle forward + down). Negated
      // to `[0.08*k, 0, 0]` so the muzzle dips during the rack.
      const u = (t - 0.6) / 0.25;
      const k = bell(u);
      return {
        pos: [0, 0, -0.04 * k],
        rot: [0.08 * k, 0, 0],
        fov: 0,
      };
    }
    // Beat 4: settle — distinct from beat 3. Returns the weapon to neutral
    // (pos→0, rot→0) over the beat with an ease-out (fast initial recovery,
    // slow final settle).
    // Prompt A#51 — was identical to beat 3 (`pos: [0, 0, -0.04 * k], rot:
    // [-0.08 * k, 0, 0]`) which made beat 4 dead code (the chamber pose just
    // continued at the same value). Now: ease from the chamber pose back to
    // neutral so the reload visibly settles.
    const u = (t - 0.85) / 0.15;
    const k = easeOut(u); // 0 → 1 over the beat (recover)
    // Lerp from the chamber pose (z=-0.04, rot.x=0.08) to neutral (0, 0).
    return {
      pos: [0, 0, -0.04 * (1 - k)],
      rot: [0.08 * (1 - k), 0, 0],
      fov: 0,
    };
  };
}

/** Multi-insert reload sample (shotgun + LMG). Each insert beat is a small
 *  dip + thrust cycle. */
function makeMultiInsertSample(): (t: number) => WeaponAnimTransform {
  return (t: number): WeaponAnimTransform => {
    if (t < 0.1) {
      // Open — weapon tilts forward + dips (opening the chamber / feed cover).
      const u = t / 0.1;
      const k = easeOut(u);
      return {
        pos: [0, -0.04 * k, 0.02 * k],
        rot: [0.3 * k, 0, 0.1 * k],
        fov: 0,
      };
    }
    if (t < 0.7) {
      // Insert beats — 3 small dip+thrust cycles (one per shell/belt round).
      // Local time within the insert block: 0..1 across 3 sub-beats.
      const u = (t - 0.1) / 0.6; // 0..1 across the 3 inserts
      const subBeat = Math.floor(u * 3); // 0, 1, or 2
      const subU = (u * 3) - subBeat; // 0..1 within the sub-beat
      const k = bell(subU); // thrust peaks mid-sub-beat
      const baseDip = -0.04 * (1 - u * 0.5); // gradually raise as the mag fills
      return {
        pos: [0, baseDip, 0.04 * k],
        rot: [0.3 * (1 - u * 0.5), 0, 0.1 * (1 - u * 0.5)],
        fov: 0,
      };
    }
    if (t < 0.85) {
      // Close — weapon comes back to neutral.
      const u = (t - 0.7) / 0.15;
      const k = easeInOut(u);
      return {
        pos: [0, -0.02 * (1 - k), 0.02 * (1 - k)],
        rot: [0.15 * (1 - k), 0, 0.05 * (1 - k)],
        fov: 0,
      };
    }
    // Chamber — small kick back + return to rest.
    const u = (t - 0.85) / 0.15;
    const k = bell(u);
    return {
      pos: [0, 0, -0.04 * k],
      rot: [-0.08 * k, 0, 0],
      fov: 0,
    };
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Beat helpers (exported for unit testing + HUD beat-sync)
// ───────────────────────────────────────────────────────────────────────────

/** Resolve which beat a normalized time t falls into + the local time within
 *  that beat. Returns null if t is outside [0,1] or no beats defined. */
export function sampleBeat(
  t: number,
  beats: WeaponAnimBeat[],
): { name: string; localT: number } | null {
  if (beats.length === 0) return null;
  if (t < beats[0].start) return { name: beats[0].name, localT: 0 };
  for (const beat of beats) {
    if (t >= beat.start && t <= beat.end) {
      const range = beat.end - beat.start;
      return {
        name: beat.name,
        localT: range > 0 ? (t - beat.start) / range : 0,
      };
    }
  }
  const last = beats[beats.length - 1];
  return { name: last.name, localT: 1 };
}

/** Look up the reload duration for a weapon (falls back to 2.4s default). */
export function getReloadDuration(weaponSlug: WeaponType): number {
  return RELOAD_DURATIONS[weaponSlug] ?? 2.4;
}

/** Look up the inspect duration for a weapon (falls back to 2.5s default). */
export function getInspectDuration(weaponSlug: WeaponType): number {
  return INSPECT_DURATIONS[weaponSlug] ?? 2.5;
}

// ───────────────────────────────────────────────────────────────────────────
// Section B — Prompts 258–266, 287–292: viewmodel animation details.
//   258: shell ejection viewmodel (per-shot casing ejection).
//   259: shell casing world physics (casings persist on the ground).
//   260: magazine drop physics on reload.
//   261: charging handle / slide rack animation per shot for semi-auto.
//   262: bolt hold-open on last round.
//   263: bolt release animation on reload-from-empty.
//   264: hammer/striker visible cocking on single-action weapons.
//   265: safety switch animation (cosmetic on weapon swap).
//   266: brass-to-face animation (cosmetic).
//   287: sniper rifle chamber-round detail (bolt action cycle).
//   288: pistol slide lock on last round.
//   290: revolver speed-loader reload (faster than single-round).
//   291: revolver single-round reload (slow, for realism mode).
//   292: revolver cylinder spin (cosmetic on inspect).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Prompt 258 — shell ejection clip. A short (200ms) animation that ejects a
 * casing from the ejection port. The casing flies up + to the right (rifle) or
 * straight up (pistol/sniper). Returns the clip for the engine's animation
 * driver to sample.
 */
export interface ShellEjectionClip {
  duration: number;
  /** Ejection velocity in viewmodel-local space [right, up, forward]. */
  velocity: [number, number, number];
  /** Spin axis (radians/sec) for the casing's tumble. */
  spinAxis: [number, number, number];
}

export function shellEjectionClip(weaponSlug: WeaponType): ShellEjectionClip {
  // Snipers eject straight up (bolt-action). Pistols eject up + right. Rifles
  // eject up + right + slightly back.
  switch (weaponSlug) {
    case "awp":
    case "l115a3":
    case "kar98k":
      // Bolt-action: brass goes straight up.
      return { duration: 0.2, velocity: [0.3, 3.0, 0.0], spinAxis: [0, 0, 12] };
    case "usp":
    case "deagle":
    case "glock18":
    case "m1911":
    case "revolver":
      // Pistols: up + right, slower.
      return { duration: 0.2, velocity: [1.2, 1.8, -0.2], spinAxis: [0, 8, 0] };
    case "nova":
    case "m1014":
    case "spas12":
      // Shotguns: brass goes up + right (pump/semi shotgun ejection port is on the right).
      return { duration: 0.25, velocity: [1.5, 1.2, -0.4], spinAxis: [0, 6, 0] };
    default:
      // Rifles/SMGs/LMGs: up + right, fast.
      return { duration: 0.18, velocity: [1.8, 2.2, -0.3], spinAxis: [0, 10, 0] };
  }
}

/**
 * Prompt 259 — shell casing world physics state. Spent casings persist on the
 * ground for the match (capped at MAX_ACTIVE_CASINGS). Each casing has a
 * world position + velocity + spin.
 */
export interface WorldCasing {
  pos: [number, number, number];
  vel: [number, number, number];
  spin: [number, number, number];
  /** Time until despawn (seconds). */
  life: number;
  /** Weapon that ejected this casing (for color/size variation). */
  weapon: string;
}

/** Max active casings in the world (per Section B #259). */
export const MAX_ACTIVE_CASINGS = 64;
/** Casing despawn time (seconds). */
export const CASING_DESPAWN_SEC = 30;

/**
 * Prompt 259 — update a world casing's physics (gravity + ground bounce).
 * Returns true if the casing should be despawned (life expired).
 */
export function tickWorldCasing(casing: WorldCasing, dt: number): boolean {
  casing.life -= dt;
  if (casing.life <= 0) return true;
  // Gravity.
  casing.vel[1] -= 9.81 * dt;
  // Integrate position.
  casing.pos[0] += casing.vel[0] * dt;
  casing.pos[1] += casing.vel[1] * dt;
  casing.pos[2] += casing.vel[2] * dt;
  // Ground bounce.
  if (casing.pos[1] < 0.02) {
    casing.pos[1] = 0.02;
    casing.vel[1] = -casing.vel[1] * 0.3; // dampened bounce
    casing.vel[0] *= 0.7;
    casing.vel[2] *= 0.7;
  }
  return false;
}

/**
 * Prompt 260 — magazine drop physics on reload. The mag detaches from the
 * weapon + falls to the ground. The clip is a short (400ms) animation that
 * translates the mag down + applies gravity.
 */
export interface MagDropClip {
  duration: number;
  /** Initial downward velocity (m/s in viewmodel-local space). */
  initialVelY: number;
  /** Lateral velocity (m/s) — the mag drifts forward as it falls. */
  lateralVel: [number, number];
}

export function magDropClip(weaponSlug: WeaponType): MagDropClip {
  // LMG mags are heavier → fall faster. Pistol mags are lighter → drift more.
  if (weaponSlug === "m249" || weaponSlug === "rpk" || weaponSlug === "mk48") {
    return { duration: 0.5, initialVelY: -1.5, lateralVel: [0.1, 0.2] };
  }
  if (weaponSlug === "usp" || weaponSlug === "deagle" || weaponSlug === "glock18" || weaponSlug === "m1911" || weaponSlug === "revolver") {
    return { duration: 0.35, initialVelY: -0.8, lateralVel: [0.3, 0.4] };
  }
  return { duration: 0.4, initialVelY: -1.0, lateralVel: [0.2, 0.3] };
}

/**
 * Prompt 261 — charging handle / slide rack animation per shot for semi-auto.
 * Returns the duration (ms) of the charging-handle cycle. The engine plays
 * this as a brief recoil-back animation on the bolt/slide.
 */
export function chargingHandleAnimMs(weaponSlug: WeaponType): number {
  if (weaponSlug === "awp" || weaponSlug === "l115a3" || weaponSlug === "kar98k") return 600; // bolt-action
  if (weaponSlug === "nova" || weaponSlug === "spas12") return 400; // pump action
  if (weaponSlug === "usp" || weaponSlug === "deagle" || weaponSlug === "glock18" || weaponSlug === "m1911" || weaponSlug === "revolver") return 80; // pistol slide
  return 120; // rifle/SMG/LMG
}

/**
 * Prompt 262 — bolt hold-open state. Returns true if the weapon's bolt is
 * locked back (after the last round). The viewmodel renders the bolt in the
 * locked-back position; reload releases it (plays the bolt-release anim #263).
 */
export function isBoltLockedBack(weaponSlug: WeaponType, ammoInMag: number): boolean {
  if (ammoInMag > 0) return false;
  // Weapons that support bolt hold-open (per Section B #262).
  const holdOpenWeapons = new Set([
    "m4", "hk416", "scarh", "mk17", "mk14", "aug", "famas", "ak74", "galil",
    "mp7", "p90", "mp5", "ump45", "vector", "pp90m1",
    "usp", "glock18", "m1911",
  ]);
  return holdOpenWeapons.has(weaponSlug);
}

/**
 * Prompt 263 — bolt release animation duration (ms) on reload-from-empty.
 * The engine plays this as a forward-thrust animation on the bolt release
 * catch.
 */
export const BOLT_RELEASE_ANIM_MS = 200;

/**
 * Prompt 264 — hammer/striker cocking animation. Single-action weapons
 * (1911, revolvers, bolt-actions) show a visible hammer cocking on each shot.
 * Returns the cock animation duration (ms) — 0 if the weapon has no visible
 * hammer.
 */
export function hammerCockAnimMs(weaponSlug: WeaponType): number {
  if (weaponSlug === "m1911" || weaponSlug === "revolver") return 100;
  if (weaponSlug === "kar98k" || weaponSlug === "awp" || weaponSlug === "l115a3") return 150; // bolt cocks the striker
  return 0;
}

/**
 * Prompt 265 — safety switch animation (cosmetic on weapon swap). The engine
 * plays a brief flick of the safety selector when the player swaps weapons.
 */
export const SAFETY_SWITCH_ANIM_MS = 150;

/**
 * Prompt 266 — brass-to-face animation. A rare cosmetic (2% of ejections)
 * where the ejected casing bounces off the player's face. Returns true if
 * the next ejection should play the brass-to-face variant.
 */
export function shouldPlayBrassToFace(): boolean {
  return Math.random() < 0.02;
}

/**
 * Prompt 287 — sniper rifle bolt-action cycle animation. The bolt is lifted,
 * pulled back, pushed forward, and pushed down. Returns the full cycle
 * duration (ms) + the per-phase durations for the engine's animation driver.
 */
export interface SniperBoltCycleClip {
  totalMs: number;
  liftMs: number;
  pullBackMs: number;
  pushForwardMs: number;
  pushDownMs: number;
}

export function sniperBoltCycleClip(weaponSlug: WeaponType): SniperBoltCycleClip {
  if (weaponSlug === "awp") return { totalMs: 800, liftMs: 150, pullBackMs: 250, pushForwardMs: 250, pushDownMs: 150 };
  if (weaponSlug === "l115a3") return { totalMs: 900, liftMs: 170, pullBackMs: 280, pushForwardMs: 280, pushDownMs: 170 };
  if (weaponSlug === "kar98k") return { totalMs: 850, liftMs: 160, pullBackMs: 265, pushForwardMs: 265, pushDownMs: 160 };
  if (weaponSlug === "scout") return { totalMs: 600, liftMs: 110, pullBackMs: 190, pushForwardMs: 190, pushDownMs: 110 }; // faster bolt
  return { totalMs: 700, liftMs: 130, pullBackMs: 220, pushForwardMs: 220, pushDownMs: 130 };
}

/**
 * Prompt 288 — pistol slide lock state. Returns true if the pistol's slide
 * is locked back (last round fired). Revolvers don't have slides.
 */
export function isPistolSlideLocked(weaponSlug: WeaponType, ammoInMag: number): boolean {
  if (ammoInMag > 0) return false;
  if (weaponSlug === "revolver") return false; // no slide
  return ["usp", "deagle", "glock18", "m1911"].includes(weaponSlug);
}

/**
 * Prompt 290 — revolver speed-loader reload clip. Faster than single-round
 * (1.5s vs 3.5s). All 6 rounds loaded at once.
 */
export function revolverSpeedLoaderClip(): { duration: number; roundsLoaded: number } {
  return { duration: 1500, roundsLoaded: 6 };
}

/**
 * Prompt 291 — revolver single-round reload clip. Slow (3.5s for 6 rounds).
 * Each round is individually inserted through the loading gate.
 */
export function revolverSingleRoundClip(roundsToLoad: number): { duration: number; roundsLoaded: number } {
  // ~0.5s per round.
  return { duration: roundsToLoad * 500, roundsLoaded: roundsToLoad };
}

/**
 * Prompt 292 — revolver cylinder spin animation (cosmetic on inspect). The
 * cylinder spins freely for 800ms during the inspect animation.
 */
export function revolverCylinderSpinClip(): { duration: number; spinRevolutions: number } {
  return { duration: 800, spinRevolutions: 2 }; // 2 full revolutions
}

// ───────────────────────────────────────────────────────────────────────────
// Section B #188 — malfunction-clear animation per type.
//
// Each malfunction has a distinct clear animation (matched to the
// `MALFUNCTION_CLEAR_PROCEDURES[...].animLabel` field in MalfunctionSystem).
// The clips describe the beats the engine's viewmodel sampler should play:
//   - clear_stovepipe: rack the slide (2 taps of the charging handle).
//   - clear_failure_to_feed: strip mag + rack slide.
//   - clear_misfire: rechamber (single charging-handle pull).
//   - clear_double_feed: strip mag + rack + reinsert (longest clear).
//   - clear_squib: manual barrel clear (rod down the barrel).
//
// Each clip returns a `MalfunctionClearClip` with a `beats` array the engine
// samples. The duration matches the `clearMs` from the procedure table.
// ───────────────────────────────────────────────────────────────────────────

export interface MalfunctionClearBeat {
  /** Time within the clip (ms, 0-based). */
  t: number;
  /** Human-readable label (drives the engine's anim-driver lookup). */
  label: string;
  /** Viewmodel-local position offset (relative to the rest pose). */
  pos: [number, number, number];
  /** Viewmodel-local rotation offset (radians, XYZ Euler). */
  rot: [number, number, number];
}

export interface MalfunctionClearClip {
  /** Clip name — matches the `animLabel` in MALFUNCTION_CLEAR_PROCEDURES. */
  name: string;
  /** Total duration (ms). */
  duration: number;
  /** Beats (keyframed). The engine interpolates between beats. */
  beats: MalfunctionClearBeat[];
}

/** Prompt 188 — stovepipe clear: 2 racks of the charging handle (~800ms total). */
export function clearStovepipeClip(): MalfunctionClearClip {
  return {
    name: "clear_stovepipe",
    duration: 800,
    beats: [
      { t: 0,   label: "rest",            pos: [0, 0, 0],     rot: [0, 0, 0] },
      { t: 100, label: "reach_for_chg",   pos: [0.02, -0.01, 0.05], rot: [0, 0.05, 0] },
      { t: 200, label: "rack_back_1",     pos: [-0.04, 0, 0.10], rot: [0, 0, 0] },
      { t: 300, label: "release_1",       pos: [0, 0, 0],     rot: [0, 0, 0] },
      { t: 400, label: "rack_back_2",     pos: [-0.04, 0, 0.10], rot: [0, 0, 0] },
      { t: 500, label: "release_2",       pos: [0, 0, 0],     rot: [0, 0, 0] },
      { t: 600, label: "back_to_ready",   pos: [0, 0, 0],     rot: [0, 0, 0] },
      { t: 800, label: "done",            pos: [0, 0, 0],     rot: [0, 0, 0] },
    ],
  };
}

/** Prompt 188 — failure to feed clear: tap R (strip mag) + hold R (rack). */
export function clearFailureToFeedClip(): MalfunctionClearClip {
  return {
    name: "clear_failure_to_feed",
    duration: 1500,
    beats: [
      { t: 0,    label: "rest",          pos: [0, 0, 0],       rot: [0, 0, 0] },
      { t: 100,  label: "reach_for_mag", pos: [0.05, -0.05, 0], rot: [0, 0.05, 0] },
      { t: 300,  label: "strip_mag",     pos: [0.10, -0.12, 0], rot: [0, 0.10, 0] },
      { t: 500,  label: "mag_out",       pos: [0.15, -0.15, 0], rot: [0, 0.15, 0] },
      { t: 700,  label: "reach_for_chg", pos: [0.05, -0.05, 0.05], rot: [0, 0.05, 0] },
      { t: 900,  label: "rack_back",     pos: [-0.04, 0, 0.10], rot: [0, 0, 0] },
      { t: 1100, label: "release",       pos: [0, 0, 0],       rot: [0, 0, 0] },
      { t: 1300, label: "back_to_ready", pos: [0, 0, 0],       rot: [0, 0, 0] },
      { t: 1500, label: "done",          pos: [0, 0, 0],       rot: [0, 0, 0] },
    ],
  };
}

/** Prompt 188 — misfire / hard primer clear: single rechamber (~600ms). */
export function clearMisfireClip(): MalfunctionClearClip {
  return {
    name: "clear_misfire",
    duration: 600,
    beats: [
      { t: 0,   label: "rest",          pos: [0, 0, 0],       rot: [0, 0, 0] },
      { t: 100, label: "reach_for_chg", pos: [0.02, -0.01, 0.05], rot: [0, 0.05, 0] },
      { t: 250, label: "rack_back",     pos: [-0.04, 0, 0.10], rot: [0, 0, 0] },
      { t: 400, label: "release",       pos: [0, 0, 0],       rot: [0, 0, 0] },
      { t: 500, label: "back_to_ready", pos: [0, 0, 0],       rot: [0, 0, 0] },
      { t: 600, label: "done",          pos: [0, 0, 0],       rot: [0, 0, 0] },
    ],
  };
}

/** Prompt 188 — double feed clear: strip mag + rack + reinsert (~2000ms). */
export function clearDoubleFeedClip(): MalfunctionClearClip {
  return {
    name: "clear_double_feed",
    duration: 2000,
    beats: [
      { t: 0,    label: "rest",          pos: [0, 0, 0],        rot: [0, 0, 0] },
      { t: 150,  label: "reach_for_mag", pos: [0.05, -0.05, 0], rot: [0, 0.05, 0] },
      { t: 400,  label: "strip_mag",     pos: [0.10, -0.12, 0], rot: [0, 0.10, 0] },
      { t: 600,  label: "mag_out",       pos: [0.15, -0.15, 0], rot: [0, 0.15, 0] },
      { t: 800,  label: "reach_for_chg", pos: [0.05, -0.05, 0.05], rot: [0, 0.05, 0] },
      { t: 1000, label: "rack_back",     pos: [-0.04, 0, 0.10], rot: [0, 0, 0] },
      { t: 1200, label: "release",       pos: [0, 0, 0],        rot: [0, 0, 0] },
      { t: 1400, label: "reach_for_mag", pos: [0.10, -0.12, 0], rot: [0, 0.10, 0] },
      { t: 1600, label: "insert_mag",    pos: [0.05, -0.05, 0], rot: [0, 0.05, 0] },
      { t: 1800, label: "back_to_ready", pos: [0, 0, 0],        rot: [0, 0, 0] },
      { t: 2000, label: "done",          pos: [0, 0, 0],        rot: [0, 0, 0] },
    ],
  };
}

/** Prompt 188 — squib load clear: manual barrel clear with a rod (~1800ms). */
export function clearSquibClip(): MalfunctionClearClip {
  return {
    name: "clear_squib",
    duration: 1800,
    beats: [
      { t: 0,    label: "rest",            pos: [0, 0, 0],         rot: [0, 0, 0] },
      { t: 200,  label: "lower_weapon",    pos: [0, -0.05, 0],     rot: [0.20, 0, 0] },
      { t: 400,  label: "reach_for_rod",   pos: [0.05, -0.05, 0.10], rot: [0.20, 0.05, 0] },
      { t: 700,  label: "insert_rod",      pos: [0.02, -0.02, 0.15], rot: [0.20, 0.05, 0] },
      { t: 1000, label: "push_rod_down",   pos: [0.02, -0.02, 0.25], rot: [0.20, 0.05, 0] },
      { t: 1300, label: "extract_rod",     pos: [0.05, -0.05, 0.10], rot: [0.20, 0.05, 0] },
      { t: 1500, label: "back_to_ready",   pos: [0, 0, 0],         rot: [0, 0, 0] },
      { t: 1800, label: "done",            pos: [0, 0, 0],         rot: [0, 0, 0] },
    ],
  };
}

/**
 * Prompt 188 — look up the malfunction-clear clip by its animLabel (the same
 * label that appears in MALFUNCTION_CLEAR_PROCEDURES). Returns the matching
 * clip or null for an unknown label.
 */
export function malfunctionClearClip(animLabel: string): MalfunctionClearClip | null {
  switch (animLabel) {
    case "clear_stovepipe":       return clearStovepipeClip();
    case "clear_failure_to_feed": return clearFailureToFeedClip();
    case "clear_misfire":         return clearMisfireClip();
    case "clear_double_feed":     return clearDoubleFeedClip();
    case "clear_squib":           return clearSquibClip();
    default: return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 327–332: weapon-hand + arm IK (reload finger curl,
// support-hand on foregrip, sight-to-camera ADS alignment, two-bone arm IK,
// elbow pole vectors). These are pure-math helpers that the viewmodel
// renderer calls each frame to position the hand/arm bones. They do NOT
// touch Three.js (no `import * as THREE`) — they take + return plain
// tuples so they can run in the FP state machine's pure-TS layer.
// ═══════════════════════════════════════════════════════════════════════════

/** A 3D vector as a plain tuple (meters). */
type V3 = [number, number, number];

/** Prompt 327 — reload finger-curl IK. Given the mag-insert progress
 *  (0 = mag just touched the well, 1 = fully seated), returns the per-
 *  finger curl weights [index, middle, ring, pinky, thumb] so the hand
 *  wraps around the mag during insertion. The values are 0..1 where 0 =
 *  extended + 1 = fully curled. The curl peaks mid-insertion (when the
 *  hand is closest to the mag) + eases back as the mag seats (so the
 *  hand opens slightly to release).
 *
 *  The caller maps these weights to the viewmodel's `fingerJoints`
 *  (weapon-viewmodel.ts:391-468 exposes them but no driver reads them). */
export function reloadFingerCurl(insertProgress: number): {
  index: number; middle: number; ring: number; pinky: number; thumb: number;
} {
  // insertProgress is 0..1; the curl follows a bell curve peaking at 0.5
  // (mid-insertion) + easing to ~0.3 at full seat (hand relaxed but still
  // on the mag).
  const bell = Math.sin(insertProgress * Math.PI);
  const seat = 0.3 + 0.2 * insertProgress;
  const curl = bell * 0.7 + seat * 0.3;
  return {
    index: curl,
    middle: curl * 0.95,
    ring: curl * 0.9,
    pinky: curl * 0.85,
    thumb: 0.5 + 0.3 * bell, // thumb opposes — half-curl baseline + peak
  };
}

/** Prompt 328 — support-hand foregrip IK target. Given the weapon's
 *  foregrip socket world position + whether a foregrip attachment is
 *  present, returns the world position the support hand should move to.
 *  When a foregrip is attached, the hand moves to the foregrip's socket;
 *  when not, the hand moves to a default position on the handguard.
 *
 *  The caller uses this as the IK target for the support arm's two-bone
 *  IK solve (prompt 331). */
export function supportHandForegripTarget(
  foregripSocketWorld: V3,
  hasForegrip: boolean,
  weaponForwardDir: V3,
): V3 {
  if (hasForegrip) {
    // Hand moves to the foregrip socket (slightly offset toward the body
    // so the palm wraps the grip).
    return [
      foregripSocketWorld[0] - weaponForwardDir[0] * 0.02,
      foregripSocketWorld[1] - weaponForwardDir[1] * 0.02,
      foregripSocketWorld[2] - weaponForwardDir[2] * 0.02,
    ];
  }
  // No foregrip — hand goes to the handguard (default position 8cm behind
  // the foregrip socket along the weapon's forward direction).
  return [
    foregripSocketWorld[0] - weaponForwardDir[0] * 0.08,
    foregripSocketWorld[1] - weaponForwardDir[1] * 0.08,
    foregripSocketWorld[2] - weaponForwardDir[2] * 0.08,
  ];
}

/** Prompt 329 — weapon sight-to-camera ADS alignment. Given the weapon's
 *  sight world position (the rear sight or scope eye-relief point) + the
 *  camera's world position, returns the weapon offset (position + rotation)
 *  that aligns the sight to the camera. This replaces the hardcoded
 *  `(0.0, -0.075, -0.20)` ADS pose in FP_BASE_POSES with a per-weapon
 *  alignment derived from the actual sight socket.
 *
 *  The returned offset is in the camera's local frame (meters + radians)
 *  + can be passed directly as the FP viewmodel's ADS pose. */
export function sightToCameraAdsAlign(
  sightWorldPos: V3,
  cameraWorldPos: V3,
  cameraWorldQuat: [number, number, number, number],
): { pos: V3; rot: V3 } {
  // Vector from camera to sight (world).
  const dx = sightWorldPos[0] - cameraWorldPos[0];
  const dy = sightWorldPos[1] - cameraWorldPos[1];
  const dz = sightWorldPos[2] - cameraWorldPos[2];
  // Convert to camera-local: inverse-quaternion rotate the delta.
  // q^-1 = (−x, −y, −z, w) for a unit quaternion.
  const [qx, qy, qz, qw] = cameraWorldQuat;
  const ix = -qx, iy = -qy, iz = -qz, iw = qw;
  // Rotate vector v by quaternion q: v' = q * v * q^-1.
  // For the inverse rotation (camera-world → camera-local), we apply q^-1.
  // Using the standard quaternion-vector rotation formula:
  //   t = 2 * cross(q.xyz, v)
  //   v' = v + q.w * t + cross(q.xyz, t)
  const vx = dx, vy = dy, vz = dz;
  const tx = 2 * (iy * vz - iz * vy);
  const ty = 2 * (iz * vx - ix * vz);
  const tz = 2 * (ix * vy - iy * vx);
  const localX = vx + iw * tx + (iy * tz - iz * ty);
  const localY = vy + iw * ty + (iz * tx - ix * tz);
  const localZ = vz + iw * tz + (ix * ty - iy * tx);
  // The weapon should be positioned so the sight sits at the camera-local
  // origin (the camera looks down -Z in three.js, so the sight should be
  // at local (0, 0, 0) — meaning the weapon offset = -localSight).
  // The rotation is whatever aligns the weapon's forward to the camera's
  // forward; for a straight sight line, the rotation is 0 (the weapon
  // points the same direction as the camera).
  return {
    pos: [-localX, -localY, -localZ],
    rot: [0, 0, 0],
  };
}

/** Prompt 331 — two-bone arm IK (shoulder → elbow → hand). Pure-math
 *  solver: given the shoulder world position, the current elbow + hand
 *  positions, a target hand position, + a pole vector (elbow direction),
 *  returns the new elbow + hand world positions.
 *
 *  This is the same law-of-cosines + pole-vector approach as foot-ik's
 *  solveTwoBoneIK, but inlined here as a pure-TS tuple version (no Three.js
 *  Vector3) so the viewmodel can call it without allocating.
 *
 *  Returns null if the chain is degenerate. */
export function solveArmTwoBoneIK(
  shoulder: V3,
  elbow: V3,
  hand: V3,
  target: V3,
  pole: V3,
): { elbowPos: V3; handPos: V3 } | null {
  // Upper + lower bone lengths.
  const upperLen = Math.hypot(elbow[0] - shoulder[0], elbow[1] - shoulder[1], elbow[2] - shoulder[2]);
  const lowerLen = Math.hypot(hand[0] - elbow[0], hand[1] - elbow[1], hand[2] - elbow[2]);
  const totalLen = upperLen + lowerLen;
  if (totalLen < 1e-4) return null;
  // Vector from shoulder to target.
  const dx = target[0] - shoulder[0];
  const dy = target[1] - shoulder[1];
  const dz = target[2] - shoulder[2];
  const targetDist = Math.hypot(dx, dy, dz);
  if (targetDist < 1e-4) return null;
  // Clamp target to reachable range.
  const clampedDist = Math.min(targetDist, totalLen * 0.999);
  const dirX = dx / targetDist, dirY = dy / targetDist, dirZ = dz / targetDist;
  const clampedTarget: V3 = [
    shoulder[0] + dirX * clampedDist,
    shoulder[1] + dirY * clampedDist,
    shoulder[2] + dirZ * clampedDist,
  ];
  // Law of cosines: angle at shoulder between (shoulder→target) + (shoulder→elbow).
  const a = upperLen;
  const b = lowerLen;
  const c = clampedDist;
  const cosShoulder = (a * a + c * c - b * b) / (2 * a * c);
  const shoulderAngle = Math.acos(Math.max(-1, Math.min(1, cosShoulder)));
  // Plane normal = cross(shoulder→target, pole).
  const cx = dirY * pole[2] - dirZ * pole[1];
  const cy = dirZ * pole[0] - dirX * pole[2];
  const cz = dirX * pole[1] - dirY * pole[0];
  const cLen = Math.hypot(cx, cy, cz);
  let axisX: number, axisY: number, axisZ: number;
  if (cLen < 1e-6) {
    axisX = 0; axisY = 0; axisZ = 1;
  } else {
    axisX = cx / cLen; axisY = cy / cLen; axisZ = cz / cLen;
  }
  // Rotate (shoulder→target) direction by shoulderAngle around the axis to
  // get (shoulder→elbow) direction. Rodrigues' rotation formula.
  const cosA = Math.cos(shoulderAngle);
  const sinA = Math.sin(shoulderAngle);
  const oneMinusCosA = 1 - cosA;
  // v = dir; rotated = v*cosA + (axis × v)*sinA + axis*(axis·v)*(1-cosA).
  const dotVA = dirX * axisX + dirY * axisY + dirZ * axisZ;
  const crossX = axisY * dirZ - axisZ * dirY;
  const crossY = axisZ * dirX - axisX * dirZ;
  const crossZ = axisX * dirY - axisY * dirX;
  const elbowDirX = dirX * cosA + crossX * sinA + axisX * dotVA * oneMinusCosA;
  const elbowDirY = dirY * cosA + crossY * sinA + axisY * dotVA * oneMinusCosA;
  const elbowDirZ = dirZ * cosA + crossZ * sinA + axisZ * dotVA * oneMinusCosA;
  const newElbow: V3 = [
    shoulder[0] + elbowDirX * upperLen,
    shoulder[1] + elbowDirY * upperLen,
    shoulder[2] + elbowDirZ * upperLen,
  ];
  return { elbowPos: newElbow, handPos: clampedTarget };
}

/** Prompt 332 — elbow pole vector. Given the shoulder + hand world
 *  positions + a desired "down" direction (typically the world -Y or the
 *  character's chest-forward perpendicular), returns the pole vector for
 *  the two-bone arm IK. The pole points the elbow downward (the natural
 *  relaxed-arm direction) + slightly forward (so the elbow doesn't tuck
 *  behind the body).
 *
 *  The caller passes this as the `pole` argument to solveArmTwoBoneIK. */
export function elbowPoleVector(
  shoulder: V3,
  hand: V3,
  characterForward: V3,
): V3 {
  // The pole is perpendicular to the (shoulder→hand) line, in the plane
  // defined by that line + the character's forward direction.
  const armDir: V3 = [
    hand[0] - shoulder[0],
    hand[1] - shoulder[1],
    hand[2] - shoulder[2],
  ];
  const armLen = Math.hypot(armDir[0], armDir[1], armDir[2]) || 1;
  const armDirN: V3 = [armDir[0] / armLen, armDir[1] / armLen, armDir[2] / armLen];
  // Project characterForward onto the plane perpendicular to armDir.
  const dot = characterForward[0] * armDirN[0] +
              characterForward[1] * armDirN[1] +
              characterForward[2] * armDirN[2];
  const perp: V3 = [
    characterForward[0] - armDirN[0] * dot,
    characterForward[1] - armDirN[1] * dot,
    characterForward[2] - armDirN[2] * dot,
  ];
  // Blend the perpendicular (forward) with world-down (-Y) so the elbow
  // points down + slightly forward.
  const pole: V3 = [perp[0] * 0.3, -1 + perp[1] * 0.3, perp[2] * 0.3];
  const poleLen = Math.hypot(pole[0], pole[1], pole[2]) || 1;
  return [pole[0] / poleLen, pole[1] / poleLen, pole[2] / poleLen];
}

/** Prompt 327 — apply reload finger-curl to a viewmodel's finger joints.
 *  The viewmodel exposes `fingerJoints` (an array of bone refs with curl
 *  weights); this drives them from the reload-finger-curl sample.
 *
 *  The caller passes the finger joints array (each entry has a `weight`
 *  field that's 0..1) + the insert progress. The function writes the
 *  per-finger weights in place. */
export function applyReloadFingerCurl(
  fingerJoints: Array<{ weight: number }>,
  insertProgress: number,
): void {
  if (fingerJoints.length === 0) return;
  const curl = reloadFingerCurl(insertProgress);
  const weights = [curl.index, curl.middle, curl.ring, curl.pinky, curl.thumb];
  for (let i = 0; i < fingerJoints.length && i < weights.length; i++) {
    fingerJoints[i].weight = weights[i];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 391–401 — weapon animation polish (reload cancel, sprint-fire,
// chamber detail, mag drop, shell eject, sight alignment, ADS FOV, inertia,
// collision, bipod, underbarrel). Each is a small driver function the
// engine can call from the existing weapon state machine.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 391 — reload interrupt by sprint/swap/melee. The reload driver
 *  exposes a `cancelAt(t)` hook; this helper computes the cancel progress
 *  + the residual reload that the next reload attempt must finish.
 *
 *  Cancel rules:
 *   - sprint cancels at 50% (the mag is dropped but not inserted → next
 *     reload resumes from "insert" beat).
 *   - weapon swap cancels at 80% (the mag is in but the bolt isn't
 *     released → next reload finishes with a bolt-rack).
 *   - melee cancels immediately at 100% (the swing is more important).
 *
 *  Returns the residual reload progress (0..1) for the next attempt, plus
 *  the optional "mustRackBolt" flag if the cancel happened during the
 *  insert phase (the player still needs to chamber a round). */
export function reloadInterruptCancel(
  currentProgress: number,
  reason: "sprint" | "swap" | "melee",
): { residual: number; mustRackBolt: boolean } {
  // Cancel thresholds: how far the reload must have progressed before the
  // cancel leaves residual work for the next attempt.
  const thresholds = { sprint: 0.5, swap: 0.8, melee: 1.0 } as const;
  const threshold = thresholds[reason];
  if (currentProgress >= threshold) {
    // Reload was past the threshold — the cancel leaves no residual (the
    // mag is in + the bolt is racked; the player just didn't see the
    // finish animation). Return a "completed" residual.
    return { residual: 1.0, mustRackBolt: false };
  }
  // Cancel before the threshold — the mag insertion didn't complete.
  // Next reload must finish from `currentProgress` to 1.0; if the cancel
  // was during the insert phase (< 0.5), the bolt still needs to be racked.
  return {
    residual: currentProgress,
    mustRackBolt: currentProgress < 0.5,
  };
}

/** Prompt 392 — sprint-into-fire bring-up animation. When the player fires
 *  while in or just out of sprint, the viewmodel plays a 0.18s "bring-up"
 *  pose: the gun snaps from the sprint-carry position to the ready
 *  position with an overshoot spring. Returns the local-space transform
 *  delta to apply on top of the FP base pose for the current frame. */
export function sampleSprintIntoFireBringUp(timeSinceFire: number): {
  posDelta: [number, number, number];
  rotDelta: [number, number, number];
} {
  const dur = 0.18;
  const t = Math.min(1, Math.max(0, timeSinceFire / dur));
  // Overshoot spring: starts negative (gun is low + forward from sprint),
  // overshoots upward, then settles to zero (the gun is in the ready pose,
  // which is the FP base pose idle).
  const overshoot = (u: number) => {
    // Critically-damped-ish spring with overshoot at u=0.6.
    return Math.sin(u * Math.PI) * (1 - u) * 0.8 - Math.sin(u * Math.PI * 1.4) * 0.15 * (1 - u);
  };
  const k = overshoot(t);
  return {
    posDelta: [0, 0.04 * k, 0.06 * k],
    rotDelta: [-0.25 * k, 0, 0],
  };
}

/** Prompt 393 — chamber-round detail (animated charging handle / slide).
 *  Returns the per-frame rotation of the charging handle (or pistol slide)
 *  during the chamber phase of a reload. The weapon viewmodel's charging
 *  handle / slide bone is driven by this rotation; 0 = rest, positive =
 *  retracted (pulled back), 0 again = released.
 *
 *  The chamber phase is the last 10% of the reload clip; the handle
 *  retracts over the first half of that phase and slams forward over the
 *  second half. */
export function sampleChamberHandle(reloadProgress: number): number {
  // Chamber phase: 0.9..1.0 of the reload.
  if (reloadProgress < 0.9 || reloadProgress > 1.0) return 0;
  const u = (reloadProgress - 0.9) / 0.1; // 0..1 within the chamber phase.
  // Retract over [0, 0.5], slam forward over [0.5, 1].
  if (u < 0.5) {
    // Smooth pull-back (ease-in-out).
    const k = u / 0.5;
    return k * k * (3 - 2 * k) * 1.2; // radians (handle rotates ~70°).
  }
  const k = (u - 0.5) / 0.5;
  // Snap forward — fast exponential decay so it slams.
  return 1.2 * Math.exp(-k * 8);
}

/** Prompt 394 — magazine drop physics (cross-ref 260). Returns the
 *  initial linear + angular velocity for a dropped magazine so the
 *  MagDropClip driver can spawn a physics-simulated casing.
 *
 *  The mag falls straight down with a slight forward + outward velocity
 *  (the player's hand throws it). A small angular velocity makes it tumble
 *  so it doesn't look like a static drop. */
export function magDropInitialVelocity(
  weaponSlug: string,
  playerSpeed: number,
): {
  linear: [number, number, number];
  angular: [number, number, number];
} {
  // Forward velocity = 60% of player speed (the mag inherits some of the
  // player's momentum). Outward = 0.6 m/s to the right (right-handed
  // reload throws the mag to the right). Down = -0.4 m/s (gravity will
  // take over; the initial down velocity is small so the mag doesn't
  // teleport into the ground).
  const fwd = playerSpeed * 0.6;
  // Pistol mags are lighter → tumble faster.
  const isPistol = ["usp", "deagle", "glock18", "m1911", "revolver"].includes(weaponSlug);
  const tumble = isPistol ? 6.0 : 3.0;
  return {
    linear: [0.6, -0.4, fwd],
    angular: [tumble, tumble * 0.3, 0],
  };
}

/** Prompt 395 — shell ejection viewmodel (cross-ref 258). The existing
 *  `shellEjectionClip` returns the spawn timing; this helper returns the
 *  per-shell initial velocity for the casing physics simulation.
 *
 *  Ejection direction: up + right (right-handed weapons). Pistols eject
 *  straight up (slide motion); rifles eject up + right at 45°; shotguns
 *  don't eject (pump action) — returns zero. */
export function shellEjectionVelocity(weaponSlug: WeaponType): {
  linear: [number, number, number];
  angular: [number, number, number];
} {
  // Pump shotguns + revolvers don't auto-eject.
  if (["nova", "m1014", "spas12", "revolver"].includes(weaponSlug)) {
    return { linear: [0, 0, 0], angular: [0, 0, 0] };
  }
  const isPistol = ["usp", "deagle", "glock18", "m1911"].includes(weaponSlug);
  if (isPistol) {
    // Pistols eject straight up + slightly right.
    return { linear: [1.2, 3.0, 0.4], angular: [8, 2, 0] };
  }
  // Rifles eject up + right at 45°, with a slight backward component
  // (the bolt carrier pushes the casing back as it extracts).
  return { linear: [2.0, 2.5, -0.6], angular: [6, 4, 2] };
}

/** Prompt 396 — sight alignment per-weapon (cross-ref 222). Returns the
 *  per-weapon sight alignment offset that the viewmodel must apply so the
 *  rear sight + front sight + camera line up. The procedural weapons all
 *  have slightly different sight heights + L/R offsets; without this, ADS
 *  on the AWP would put the scope 2cm off-center.
 *
 *  Returns [x, y, z] in viewmodel-local centimeters. The viewmodel applies
 *  this as the ADS position offset. */
export function sightAlignmentOffset(weaponSlug: WeaponType): [number, number, number] {
  const table: Record<string, [number, number, number]> = {
    // Iron-sight weapons: front sight sits ~3cm above the receiver.
    ak74: [0, 0.03, -0.05],
    m4: [0, 0.035, -0.04],
    mp7: [0, 0.025, -0.03],
    p90: [0, 0.04, -0.02],
    // Optic-mounted weapons: scope center is ~6cm above the receiver.
    awp: [0, 0.06, -0.08],
    scout: [0, 0.055, -0.07],
    l115a3: [0, 0.065, -0.08],
    kar98k: [0, 0.05, -0.06],
    // Pistols: low sights.
    usp: [0, 0.02, -0.02],
    deagle: [0, 0.022, -0.025],
    glock18: [0, 0.018, -0.02],
    m1911: [0, 0.02, -0.02],
    revolver: [0, 0.025, -0.02],
    // Shotguns: bead sight, very low.
    nova: [0, 0.015, -0.04],
    m1014: [0, 0.018, -0.04],
    spas12: [0, 0.02, -0.04],
    // LMG: typical carry-handle sight.
    m249: [0, 0.04, -0.05],
    rpk: [0, 0.03, -0.05],
    mk48: [0, 0.04, -0.05],
  };
  return table[weaponSlug] ?? [0, 0.03, -0.04];
}

/** Prompt 397 — ADS FOV per-weapon (cross-ref 221). Returns the camera FOV
 *  (degrees) when aiming down sights with the given weapon. Sniper rifles
 *  zoom more (lower FOV), pistols + shotguns barely zoom (high FOV). */
export function adsFovFor(weaponSlug: WeaponType): number {
  const sniperSlugs = new Set(["awp", "l115a3", "scout", "kar98k"]);
  const dmrSlugs = new Set(["mk14", "mk17", "scarh"]);
  const pistolSlugs = new Set(["usp", "deagle", "glock18", "m1911", "revolver"]);
  const shotgunSlugs = new Set(["nova", "m1014", "spas12"]);
  if (sniperSlugs.has(weaponSlug)) return 18;   // ~6x zoom (from 70° hipfire).
  if (dmrSlugs.has(weaponSlug)) return 35;      // ~2x zoom.
  if (pistolSlugs.has(weaponSlug)) return 65;   // minimal zoom.
  if (shotgunSlugs.has(weaponSlug)) return 65;  // minimal zoom.
  return 50;                                     // standard assault-rifle ADS.
}

/** Prompt 398 — weapon inertia on jump/land. Returns the viewmodel
 *  position + rotation deltas to apply when the player jumps or lands.
 *  On jump the gun dips down + forward (anticipation); on land the gun
 *  kicks up + back (the impact drives the stock into the shoulder).
 *
 *  `phase` is 0..1 over the inertia duration (jump = 0.25s, land = 0.4s).
 *  `kind` selects the curve shape. The result is added on top of the FP
 *  base pose. */
export function sampleWeaponInertia(
  kind: "jump" | "land",
  phase: number,
): { posDelta: [number, number, number]; rotDelta: [number, number, number] } {
  const t = Math.min(1, Math.max(0, phase));
  // Single-pulse envelope: peak at t=0.3, decay to 0 by t=1.
  const env = Math.sin(t * Math.PI) * (1 - t * 0.5);
  if (kind === "jump") {
    // Jump: gun dips down + forward (negative Y, positive Z = forward).
    return {
      posDelta: [0, -0.04 * env, 0.05 * env],
      rotDelta: [0.15 * env, 0, 0],
    };
  }
  // Land: gun kicks up + back (positive Y, negative Z = backward), with
  // a larger amplitude (the landing impact is more violent than the
  // jump anticipation).
  return {
    posDelta: [0, 0.08 * env, -0.06 * env],
    rotDelta: [-0.3 * env, 0, 0],
  };
}

/** Prompt 399 — weapon collision with world (cross-ref 254). Returns the
 *  viewmodel retraction pose when the player faces a wall corner. The
 *  `wallDistance` is the raycast distance from the camera to the nearest
 *  world geometry in front of the player (meters).
 *
 *  When wallDistance < 0.6m, the gun retracts toward the player (drop + pull
 *  back + rotate the muzzle down) so it doesn't clip through the wall. At
 *  wallDistance >= 0.6m, no retraction. */
export function sampleWeaponCollisionRetract(wallDistance: number): {
  posDelta: [number, number, number];
  rotDelta: [number, number, number];
} {
  const retractStart = 0.6;
  const fullyRetracted = 0.15;
  if (wallDistance >= retractStart) {
    return { posDelta: [0, 0, 0], rotDelta: [0, 0, 0] };
  }
  // 0 at retractStart, 1 at fullyRetracted.
  const k = Math.max(0, Math.min(1, (retractStart - wallDistance) / (retractStart - fullyRetracted)));
  return {
    posDelta: [0, -0.08 * k, 0.18 * k],
    rotDelta: [0.5 * k, 0, 0],
  };
}

/** Prompt 400 — bipod deployment animation for LMGs. Returns the bipod
 *  leg rotation (radians) for the deploy animation: 0 = stowed (legs
 *  folded alongside the barrel), 1.3 = deployed (legs swung down ~75° to
 *  contact the ground).
 *
 *  The viewmodel's bipod bone is driven by this rotation. `progress` is
 *  0..1 over the deploy animation (0.4s). */
export function sampleBipodDeploy(progress: number): number {
  const t = Math.min(1, Math.max(0, progress));
  // Ease-in-out: the legs snap to the ground quickly once they start
  // moving, then settle.
  return t * t * (3 - 2 * t) * 1.3;
}

/** Prompt 401 — underbarrel attachment activation animation. Returns the
 *  viewmodel swap pose for switching to an underbarrel attachment (e.g.
 *  M203 grenade launcher). The gun rotates ~30° clockwise (so the
 *  underbarrel is now on top, aligning with the camera) + drops slightly.
 *
 *  `progress` is 0..1 over the swap animation (0.35s). */
export function sampleUnderbarrelSwap(progress: number): {
  posDelta: [number, number, number];
  rotDelta: [number, number, number];
} {
  const t = Math.min(1, Math.max(0, progress));
  // Overshoot spring: the rotation overshoots slightly then settles.
  const env = Math.sin(t * Math.PI) * 0.8 + (1 - Math.cos(t * Math.PI * 2)) * 0.1;
  return {
    posDelta: [0, -0.05 * t, 0],
    rotDelta: [0, 0, 0.5 * env],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1521 / #1523 / #1525 / #1556 — per-weapon variety + tuning
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1521 — grenade variety per type. Each grenade type has a
 *  distinct throwing arc + release point so two operators throwing a frag
 *  vs a flash don't look identical. */
export const GRENADE_VARIETY: Record<string, { windUp: number; releaseAngle: number; throwArc: number; durationMs: number }> = {
  frag:        { windUp: 0.40, releaseAngle: 0.35, throwArc: 0.85, durationMs: 850 },
  flash:       { windUp: 0.30, releaseAngle: 0.25, throwArc: 0.70, durationMs: 720 },
  smoke:       { windUp: 0.50, releaseAngle: 0.45, throwArc: 0.80, durationMs: 920 },
  incendiary:  { windUp: 0.45, releaseAngle: 0.30, throwArc: 0.60, durationMs: 880 },
  molotov:     { windUp: 0.55, releaseAngle: 0.50, throwArc: 0.75, durationMs: 980 },
};

/** C3-5000 #1523 — fire variety per weapon class. Distinct recoil impulse
 *  shape + muzzle climb + recovery timing per class so an SMG doesn't fire
 *  like a sniper rifle. */
export const FIRE_VARIETY: Record<string, { muzzleClimb: number; recoilKick: number; recoverMs: number; spread: number }> = {
  rifle:    { muzzleClimb: 0.18, recoilKick: 0.30, recoverMs: 90,  spread: 0.020 },
  pistol:   { muzzleClimb: 0.12, recoilKick: 0.22, recoverMs: 70,  spread: 0.015 },
  shotgun:  { muzzleClimb: 0.45, recoilKick: 0.85, recoverMs: 220, spread: 0.080 },
  sniper:   { muzzleClimb: 0.35, recoilKick: 0.70, recoverMs: 280, spread: 0.005 },
  lmg:      { muzzleClimb: 0.22, recoilKick: 0.40, recoverMs: 110, spread: 0.030 },
  smg:      { muzzleClimb: 0.10, recoilKick: 0.18, recoverMs: 55,  spread: 0.025 },
};

/** C3-5000 #1525 — swap variety per weapon slot. Raise/lower/holster
 *  timings differ by slot (primary is slower because the weapon is heavier
 *  and on a longer sling). */
export const SWAP_VARIETY: Record<string, { raiseMs: number; lowerMs: number; holsterMs: number }> = {
  primary:   { raiseMs: 480, lowerMs: 380, holsterMs: 540 },
  secondary: { raiseMs: 360, lowerMs: 280, holsterMs: 420 },
  sidearm:   { raiseMs: 280, lowerMs: 220, holsterMs: 320 },
  melee:     { raiseMs: 180, lowerMs: 140, holsterMs: 200 },
  grenade:   { raiseMs: 220, lowerMs: 180, holsterMs: 260 },
};

/** C3-5000 #1556 — viewmodel tuning per weapon. Sway amplitude, ADS-FOV
 *  multiplier, and kick recovery curve per weapon so each weapon class
 *  feels distinct in the player's hands. */
export const VIEWMODEL_TUNE_TABLE: Record<string, { swayAmp: number; adsFovMult: number; kickRecover: number; bobAmp: number }> = {
  rifle:    { swayAmp: 0.020, adsFovMult: 0.85, kickRecover: 1.00, bobAmp: 0.012 },
  pistol:   { swayAmp: 0.012, adsFovMult: 0.95, kickRecover: 1.20, bobAmp: 0.008 },
  shotgun:  { swayAmp: 0.030, adsFovMult: 0.90, kickRecover: 0.70, bobAmp: 0.018 },
  sniper:   { swayAmp: 0.008, adsFovMult: 0.65, kickRecover: 0.80, bobAmp: 0.005 },
  lmg:      { swayAmp: 0.035, adsFovMult: 0.88, kickRecover: 0.85, bobAmp: 0.020 },
  smg:      { swayAmp: 0.015, adsFovMult: 0.92, kickRecover: 1.30, bobAmp: 0.010 },
};
