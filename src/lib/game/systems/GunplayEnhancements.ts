/**
 * §5 Gunplay & Weapons — backlog items 101–125.
 *
 * Self-contained enhancement layer over WeaponSystem, MalfunctionSystem,
 * MeleeSystem, recoil-tuning, and penetration. Adds the §4 backlog's missing
 * mechanics without rewriting those systems.
 *
 * Design: pure functions + named constants + an opt-in registry the engine
 * and menu read. No Three.js mutation here (except where a recoil pattern
 * preview canvas is requested — that's a UI concern, see ShootingRange below).
 */

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// §5 #107 — Ammo types (AP / hollow-point / incendiary)
// ─────────────────────────────────────────────────────────────────────────────

export type AmmoType = "ball" | "ap" | "hollow_point" | "incendiary";

export interface AmmoTypeConfig {
  slug: AmmoType;
  name: string;
  /** Damage multiplier vs unarmored targets. */
  damageMult: number;
  /** Damage multiplier vs armored targets (1 = ignore armor normally). */
  armorMult: number;
  /** Penetration multiplier (material thickness the round can punch through). */
  penetrationMult: number;
  /** Chance to ignite the target on hit (incendiary). 0–1. */
  igniteChance: number;
  /** Whether this ammo type is available in the loadout menu. */
  selectable: boolean;
  /** Designer note. */
  note: string;
}

export const AMMO_TYPES: Record<AmmoType, AmmoTypeConfig> = {
  ball: {
    slug: "ball",
    name: "Ball",
    damageMult: 1.0,
    armorMult: 1.0,
    penetrationMult: 1.0,
    igniteChance: 0,
    selectable: true,
    note: "Standard full-metal-jacket. Balanced. The default.",
  },
  ap: {
    slug: "ap",
    name: "Armor-Piercing",
    damageMult: 0.85, // less tissue damage
    armorMult: 1.8, // punches armor
    penetrationMult: 2.2, // punches walls
    igniteChance: 0,
    selectable: true,
    note: "Reduced raw damage but ignores most armor + punches through cover. Snipers' choice for armored targets.",
  },
  hollow_point: {
    slug: "hollow_point",
    name: "Hollow-Point",
    damageMult: 1.4, // massive tissue damage
    armorMult: 0.4, // stopped by armor
    penetrationMult: 0.5, // doesn't punch walls
    igniteChance: 0,
    selectable: true,
    note: "Devastating vs unarmored. Stopped by armor + doesn't penetrate cover. CQB choice.",
  },
  incendiary: {
    slug: "incendiary",
    name: "Incendiary",
    damageMult: 0.9,
    armorMult: 0.9,
    penetrationMult: 0.7,
    igniteChance: 0.35,
    selectable: true,
    note: "Chance to ignite target on hit (DoT). Reduced direct damage. Area-denial choice.",
  },
};

export function getAmmoType(slug: AmmoType): AmmoTypeConfig {
  return AMMO_TYPES[slug] ?? AMMO_TYPES.ball;
}

/**
 * Compute the effective damage for a hit given the ammo type + target armor.
 * @param baseDamage   Weapon's base damage.
 * @param ammo         Ammo type slug.
 * @param targetArmor  0..1 (0 = unarmored, 1 = fully armored).
 */
export function computeAmmoAdjustedDamage(
  baseDamage: number,
  ammo: AmmoType,
  targetArmor: number,
): number {
  const cfg = getAmmoType(ammo);
  const armorReduction = 1 - targetArmor * (1 - cfg.armorMult);
  // A2-5000 #246 — cap armorReduction at 1.0 (was no ceiling; AP ammo with
  // armorMult=1.8 + targetArmor=2 → armorReduction=2.6 → 2.34× base damage,
  // over-buffing AP vs super-armored targets). Cap at 1.0 means AP ignores
  // armor (full damage) but never amplifies beyond base. Floor 0.1 preserved.
  const armorReductionClamped = Math.max(0.1, Math.min(1.0, armorReduction));
  return baseDamage * cfg.damageMult * armorReductionClamped;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #104 — Dry-fire click + animation when firing on empty
// ─────────────────────────────────────────────────────────────────────────────

export interface DryFireState {
  /** Timestamp of the last dry-fire click (ms). Used to throttle the sound. */
  lastClickMs: number;
}

export function createDryFireState(): DryFireState {
  return { lastClickMs: 0 };
}

/** Minimum interval between dry-fire clicks (ms). Prevents audio spam. */
const DRY_FIRE_THROTTLE_MS = 200;

/**
 * Should a dry-fire click play? Call when the player pulls the trigger on an
 * empty magazine. Returns true if the click should sound (throttled).
 */
export function shouldDryFire(state: DryFireState, now: number): boolean {
  if (now - state.lastClickMs < DRY_FIRE_THROTTLE_MS) return false;
  state.lastClickMs = now;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #105 — Tactical vs empty reload animation distinction
// ─────────────────────────────────────────────────────────────────────────────

export type ReloadKind = "tactical" | "empty" | "partial";

/**
 * Determine the reload kind from the magazine state.
 * - `tactical`: round still chambered (mag > 0) — faster (no bolt-rack needed).
 * - `empty`: mag is 0 — slower (need to rack the bolt/slide).
 * - `partial`: between — same as tactical but with a partial mag.
 *
 * @param roundsInMag   Current rounds in the magazine.
 * @param magSize       Magazine capacity.
 */
export function classifyReload(roundsInMag: number, magSize: number): ReloadKind {
  if (roundsInMag <= 0) return "empty";
  if (roundsInMag < magSize) return "partial";
  return "tactical"; // full mag — shouldn't reload, but classify anyway
}

/**
 * Compute the effective reload time given the reload kind.
 * Empty reloads take longer (bolt-rack animation adds ~0.3–0.5s).
 */
export function effectiveReloadTime(
  baseReloadTime: number,
  kind: ReloadKind,
): number {
  switch (kind) {
    case "empty":
      return baseReloadTime * 1.25; // +25% for bolt-rack
    case "tactical":
    case "partial":
    default:
      return baseReloadTime;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #108 — Weapon jam-clearing interactive action
// ─────────────────────────────────────────────────────────────────────────────

export interface JamClearState {
  /** Whether a jam-clear is in progress. */
  clearing: boolean;
  /** Timestamp the clear started. */
  startMs: number;
  /** Required duration (ms). */
  durationMs: number;
}

export function createJamClearState(): JamClearState {
  return { clearing: false, startMs: 0, durationMs: 1200 };
}

/**
 * Start a jam-clear. Returns true if it began (false if already clearing).
 * The MalfunctionSystem calls this when the player presses the clear key
 * (default R while jammed — same as reload, but MalfunctionSystem intercepts).
 */
export function startJamClear(state: JamClearState, now: number): boolean {
  if (state.clearing) return false;
  state.clearing = true;
  state.startMs = now;
  return true;
}

/**
 * Update the jam-clear. Returns progress 0..1, or 1 if complete (and resets).
 */
export function updateJamClear(state: JamClearState, now: number): number {
  if (!state.clearing) return 0;
  const elapsed = now - state.startMs;
  if (elapsed >= state.durationMs) {
    state.clearing = false;
    return 1;
  }
  return elapsed / state.durationMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #110 — Shooting range / test-fire mode
// ─────────────────────────────────────────────────────────────────────────────

export interface ShootingRangeTarget {
  /** World position. */
  pos: THREE.Vector3;
  /** Target radius (m). */
  radius: number;
  /** Whether this target is currently up (true) or knocked down (false). */
  up: boolean;
  /** Timestamp it was last hit (ms). */
  lastHitMs: number;
  /** Distance label (precomputed for the HUD). */
  distanceLabel: string;
}

export interface ShootingRangeState {
  targets: ShootingRangeTarget[];
  /** Total shots fired in this range session. */
  shotsFired: number;
  /** Total hits. */
  hits: number;
  /** Session start (ms). */
  startMs: number;
}

/**
 * Spawn a standard shooting range layout: 5 targets at 5m, 10m, 15m, 25m, 50m.
 */
export function createShootingRange(spawnPos: THREE.Vector3): ShootingRangeState {
  const distances = [5, 10, 15, 25, 50];
  const targets: ShootingRangeTarget[] = distances.map((d) => ({
    pos: new THREE.Vector3(spawnPos.x, spawnPos.y + 1.0, spawnPos.z - d),
    radius: d <= 15 ? 0.3 : 0.5, // farther = bigger (easier to see)
    up: true,
    lastHitMs: 0,
    distanceLabel: `${d}m`,
  }));
  return { targets, shotsFired: 0, hits: 0, startMs: performance.now() };
}

/**
 * Record a shot in the shooting range. Mutates state.
 */
export function recordRangeShot(state: ShootingRangeState): void {
  state.shotsFired++;
}

/**
 * Attempt to register a hit on a range target. Returns the hit target (or null).
 * Mutates state if hit.
 */
export function registerRangeHit(
  state: ShootingRangeState,
  impactPos: THREE.Vector3,
  now: number,
): ShootingRangeTarget | null {
  for (const t of state.targets) {
    if (!t.up) continue;
    if (t.pos.distanceTo(impactPos) <= t.radius) {
      t.up = false;
      t.lastHitMs = now;
      state.hits++;
      return t;
    }
  }
  return null;
}

/**
 * Reset all targets to "up" (e.g., after a "reset range" button press).
 */
export function resetRangeTargets(state: ShootingRangeState): void {
  for (const t of state.targets) t.up = true;
}

/**
 * Compute the range accuracy summary.
 */
export function rangeAccuracy(state: ShootingRangeState): {
  accuracy: number;
  hitCount: number;
  shotCount: number;
} {
  return {
    accuracy: state.shotsFired > 0 ? state.hits / state.shotsFired : 0,
    hitCount: state.hits,
    shotCount: state.shotsFired,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #111 — Recoil pattern visualization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sample a recoil pattern into a list of (x, y) points for UI visualization.
 * The Gunsmith screen renders these as a spray-pattern preview canvas.
 *
 * @param pattern   Array of {x, y} recoil offsets per shot (from recoil-tuning.ts).
 * @param maxShots  Cap the number of samples (default 30 = a typical mag).
 * @returns         Array of {x, y} points normalized to -1..1 for canvas plotting.
 */
export function sampleRecoilPatternForViz(
  pattern: Array<{ x: number; y: number }>,
  maxShots = 30,
): Array<{ x: number; y: number; shot: number }> {
  const slice = pattern.slice(0, maxShots);
  // Find max absolute value for normalization.
  let maxAbs = 0.001;
  for (const p of slice) {
    maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
  }
  return slice.map((p, i) => ({
    x: p.x / maxAbs,
    y: p.y / maxAbs,
    shot: i,
  }));
}

/**
 * Render a recoil pattern to an HTMLCanvasElement (for the Gunsmith UI).
 * Returns the canvas. Caller owns it.
 * A2-5000 #254 — SSR guard: returns null on the server (was unconditional
 * `document.createElement` which threw during SSR / Next.js prerender).
 */
export function renderRecoilPatternToCanvas(
  pattern: Array<{ x: number; y: number }>,
  canvas: HTMLCanvasElement,
  options: { color?: string; dotRadius?: number; size?: number } = {},
): HTMLCanvasElement | null {
  // A2-5000 #254 — SSR guard. typeof document check is cheap + safe.
  if (typeof document === "undefined") return null;
  const { color = "#22d3ee", dotRadius = 3, size = 200 } = options;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, size, size);
  // Crosshair center.
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
  // Pattern points.
  const samples = sampleRecoilPatternForViz(pattern);
  const scale = size * 0.4;
  ctx.fillStyle = color;
  for (const s of samples) {
    const cx = size / 2 + s.x * scale;
    const cy = size / 2 - s.y * scale; // invert Y (canvas Y grows down)
    ctx.beginPath();
    ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  // Connect with faint lines to show the spray path.
  ctx.strokeStyle = "rgba(34,211,238,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const cx = size / 2 + samples[i].x * scale;
    const cy = size / 2 - samples[i].y * scale;
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.stroke();
  return canvas;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #112 — Per-weapon melee (bayonet/rifle-butt)
// ─────────────────────────────────────────────────────────────────────────────

export type WeaponMeleeKind = "rifle_butt" | "bayonet" | "pistol_whip" | "none";

export interface WeaponMeleeConfig {
  kind: WeaponMeleeKind;
  /** Damage. */
  damage: number;
  /** Range (m). */
  range: number;
  /** Knockback impulse. */
  knockback: number;
  /** Cooldown (ms). */
  cooldownMs: number;
}

export const WEAPON_MELEE_DEFAULTS: Record<WeaponMeleeKind, WeaponMeleeConfig> = {
  rifle_butt: {
    kind: "rifle_butt",
    damage: 35,
    range: 1.8,
    knockback: 6,
    cooldownMs: 600,
  },
  bayonet: {
    kind: "bayonet",
    damage: 60,
    range: 2.2,
    knockback: 4,
    cooldownMs: 800,
  },
  pistol_whip: {
    kind: "pistol_whip",
    damage: 25,
    range: 1.5,
    knockback: 5,
    cooldownMs: 500,
  },
  none: {
    kind: "none",
    damage: 0,
    range: 0,
    knockback: 0,
    cooldownMs: 0,
  },
};

/**
 * Get the per-weapon melee config. Default is rifle_butt for longarms,
 * pistol_whip for sidearms. Bayonet is an attachment that overrides.
 */
export function getWeaponMelee(
  weaponCategory: "RIFLE" | "SMG" | "PISTOL" | "SNIPER" | "SHOTGUN" | "LMG",
  hasBayonet = false,
): WeaponMeleeConfig {
  if (hasBayonet) return WEAPON_MELEE_DEFAULTS.bayonet;
  if (weaponCategory === "PISTOL") return WEAPON_MELEE_DEFAULTS.pistol_whip;
  return WEAPON_MELEE_DEFAULTS.rifle_butt;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #113 — Suppressor heat/sound-profile interaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the barrel-heat cooling rate multiplier given a suppressor.
 * Suppressors retain heat (cool slower) — a hot suppressor can cook off
 * rounds + mirage-ghost the scope picture.
 *
 * @param hasSuppressor Whether a suppressor is attached.
 * @param shotsFired    Shots fired in the current burst (affects suppressor temp).
 */
export function suppressorCoolingRateMult(
  hasSuppressor: boolean,
  shotsFired: number,
): number {
  if (!hasSuppressor) return 1.0; // normal cooling
  // Suppressor retains heat. More shots = slower cooling (heat soak).
  const soak = Math.min(1, shotsFired / 30);
  return 0.6 - 0.3 * soak; // 0.6× → 0.3× cooling as suppressor heats up
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #114 — Weapon inspect animation
// ─────────────────────────────────────────────────────────────────────────────

export interface InspectState {
  /** Whether an inspect animation is playing. */
  inspecting: boolean;
  /** Timestamp it started (ms). */
  startMs: number;
  /** Duration (ms). */
  durationMs: number;
}

export function createInspectState(): InspectState {
  return { inspecting: false, startMs: 0, durationMs: 2200 };
}

/**
 * Trigger an inspect animation (hold-a-button detail animation).
 * Returns true if it started.
 */
export function startInspect(state: InspectState, now: number): boolean {
  if (state.inspecting) return false;
  state.inspecting = true;
  state.startMs = now;
  return true;
}

/**
 * Update the inspect animation. Returns progress 0..1, or 1 if complete.
 */
export function updateInspect(state: InspectState, now: number): number {
  if (!state.inspecting) return 0;
  const elapsed = now - state.startMs;
  if (elapsed >= state.durationMs) {
    state.inspecting = false;
    return 1;
  }
  return elapsed / state.durationMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #117 — Akimbo / dual-wield (pistols)
// ─────────────────────────────────────────────────────────────────────────────

export interface AkimboState {
  /** Left-hand weapon mag. */
  leftMag: number;
  /** Right-hand weapon mag. */
  rightMag: number;
  /** Whether the next shot fires from left (alternating). */
  nextIsLeft: boolean;
  /** Independent reload states. */
  leftReloading: boolean;
  rightReloading: boolean;
}

export function createAkimboState(magSize: number): AkimboState {
  return {
    leftMag: magSize,
    rightMag: magSize,
    nextIsLeft: true,
    leftReloading: false,
    rightReloading: false,
  };
}

/**
 * Fire one shot from the akimbo pair (alternates left/right).
 * Returns which hand fired, or null if both empty.
 */
export function fireAkimbo(
  state: AkimboState,
): "left" | "right" | null {
  // Prefer the next-is-left hand; if empty, try the other.
  const tryLeft = state.nextIsLeft;
  if (tryLeft && state.leftMag > 0 && !state.leftReloading) {
    state.leftMag--;
    state.nextIsLeft = false;
    return "left";
  }
  if (!tryLeft && state.rightMag > 0 && !state.rightReloading) {
    state.rightMag--;
    state.nextIsLeft = true;
    return "right";
  }
  // Fallback: the other hand.
  if (state.leftMag > 0 && !state.leftReloading) {
    state.leftMag--;
    state.nextIsLeft = false;
    return "left";
  }
  if (state.rightMag > 0 && !state.rightReloading) {
    state.rightMag--;
    state.nextIsLeft = true;
    return "right";
  }
  return null;
}

/**
 * A2-5000 #249 — reload one hand of the akimbo pair. Returns the hand that
 * reloaded, or null if both mags were full / already reloading. The engine
 * wires this to the reload key when the akimbo state is active.
 */
export function reloadAkimbo(
  state: AkimboState,
  magSize: number,
  hand: "left" | "right" | "auto" = "auto",
): "left" | "right" | null {
  const tryLeft = hand === "auto" ? state.nextIsLeft : hand === "left";
  if (tryLeft && !state.leftReloading && state.leftMag < magSize) {
    state.leftReloading = true;
    state.leftMag = magSize;
    state.leftReloading = false;
    return "left";
  }
  if (!tryLeft && !state.rightReloading && state.rightMag < magSize) {
    state.rightReloading = true;
    state.rightMag = magSize;
    state.rightReloading = false;
    return "right";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #121 — Grenade fuse-timer visual + audio cue (cook-off)
//
// A2-5000 #257 — DEPRECATED. This state is parallel to GrenadeSystem's
// internal cook state (GrenadeSystem.startCook / getCookState). The two
// were never consolidated in the original implementation. New code should
// use GrenadeSystem.startCook() / getCookState() directly; this struct is
// kept for backward-compat with any code that still reads it. The
// GrenadeSystem path is the source of truth (it owns the actual fuse +
// explode-in-hand logic).
// ─────────────────────────────────────────────────────────────────────────────

export interface GrenadeCookState {
  /** Whether the grenade is currently being cooked. */
  cooking: boolean;
  /** Timestamp the cook started (ms). */
  startMs: number;
  /** Fuse duration (ms). */
  fuseMs: number;
}

export function createGrenadeCookState(fuseMs = 4000): GrenadeCookState {
  return { cooking: false, startMs: 0, fuseMs };
}

/**
 * Start cooking a grenade. Returns true if it began.
 */
export function startGrenadeCook(state: GrenadeCookState, now: number): boolean {
  if (state.cooking) return false;
  state.cooking = true;
  state.startMs = now;
  return true;
}

/**
 * Get the remaining fuse time (ms). Returns 0 if not cooking or expired.
 */
export function grenadeFuseRemaining(state: GrenadeCookState, now: number): number {
  if (!state.cooking) return 0;
  const elapsed = now - state.startMs;
  return Math.max(0, state.fuseMs - elapsed);
}

/**
 * Get the cook-off tick intensity 0..1 for the audio cue (ticking speeds up
 * as the fuse runs down).
 */
export function grenadeTickIntensity(state: GrenadeCookState, now: number): number {
  if (!state.cooking) return 0;
  const remaining = grenadeFuseRemaining(state, now);
  if (remaining <= 0) return 1;
  // Intensity ramps from 0.3 → 1.0 as the fuse runs down.
  const progress = 1 - remaining / state.fuseMs;
  return 0.3 + 0.7 * progress;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #122 — Underwater/wet-weapon malfunction interaction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the malfunction chance multiplier given weapon wetness.
 * Wet weapons (from rain/swim) have an elevated chance to misfire.
 *
 * @param wetness  0..1 (0 = dry, 1 = soaked).
 * @param baseMult The weapon's base malfunction multiplier.
 */
export function wetWeaponMalfunctionMult(wetness: number, baseMult = 1): number {
  // Up to 4× malfunction chance when fully soaked.
  return baseMult * (1 + 3 * Math.max(0, Math.min(1, wetness)));
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #123 — Crosshair dynamic bloom tied to actual spread cone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the crosshair bloom radius (px) given the current spread + viewport.
 * The Crosshair.tsx component reads this to size its dynamic bloom.
 *
 * @param currentSpread  Current spread cone (radians, from WeaponSystem).
 * @param fov            Vertical FOV (radians).
 * @param screenHeight   Screen height (px).
 * @param minPx          Minimum bloom radius (px) — the idle crosshair size.
 */
export function crosshairBloomRadius(
  currentSpread: number,
  fov: number,
  screenHeight: number,
  minPx = 8,
): number {
  // Spread (radians) → screen pixels. A spread of `s` radians at distance d
  // covers `2 * d * tan(s/2)` meters. On screen, that maps to
  // `2 * (screenHeight/2) * (s / (fov/2))` px ≈ `screenHeight * s / fov`.
  const bloomPx = (screenHeight * currentSpread) / Math.max(0.1, fov);
  return Math.max(minPx, bloomPx);
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #124 — Per-caliber penetration through multiple targets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate a round passing through multiple targets in a line.
 * Returns the exit velocity + which targets were hit.
 *
 * @param entryVelocity  Round velocity at first impact (m/s).
 * @param targets        Array of {thickness, armorClass} for each target in line.
 * @param ammo           Ammo type.
 */
export function penetrateMultipleTargets(
  entryVelocity: number,
  targets: Array<{ thickness: number; armorClass: number }>,
  ammo: AmmoType,
): { exitVelocity: number; penetrated: number; stoppedAtIndex: number | null } {
  const cfg = getAmmoType(ammo);
  let v = entryVelocity;
  let penetrated = 0;
  let stoppedAtIndex: number | null = null;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    // Each target reduces velocity by (thickness * armorClass / penetrationMult).
    const reduction = t.thickness * (1 + t.armorClass) / cfg.penetrationMult;
    v -= reduction * 50; // scale to m/s
    if (v <= 0) {
      stoppedAtIndex = i;
      break;
    }
    penetrated++;
  }
  return { exitVelocity: Math.max(0, v), penetrated, stoppedAtIndex };
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 #101, #102, #103, #106, #109, #115, #116, #117, #118, #119, #120, #125
// — documented verifications + remaining polish items
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_5_STATUS = {
  // Verifications (spot-check existing implementations):
  soundProfileAudit: "doc — spot-check 5 random WeaponSoundProfile entries (see docs/GUNPLAY-AUDIT.md)",
  adsFovZoomReview: "doc — scoped weapons have distinct ADS FOV/zoom (verified in WEAPONS table; documented in docs/GUNPLAY-AUDIT.md)",
  weaponSwitchSpeedStat: "code — weaponSwitchMs added to EffectiveWeaponStats, surfaced in LoadoutPicker UI",
  attachmentSocketVisual: "doc — AttachmentSockets renders across all combos (verified; flagged combos in docs/GUNPLAY-AUDIT.md)",
  malfunctionRateScaling: "code — Difficulty.ts now scales malfunction rate (lower on easy, higher on hard)",
  weaponModelLod: "doc — weaponModel.ts LOD swap verified no visible pop at medium distance",
  magazineVisual: "code — see-through mag / round counter added to weaponModel.ts (cosmetic, opt-in per skin)",
  weaponDegradation: "code — barrel heat/condition resets between matches (confirmed design in docs/GUNPLAY-AUDIT.md)",

  // New mechanics (code):
  ammoTypes: "code (AMMO_TYPES + computeAmmoAdjustedDamage; loadout menu opt-in)",
  dryFire: "code (DryFireState + shouldDryFire; WeaponSystem fires dry-click on empty trigger)",
  tacticalReload: "code (classifyReload + effectiveReloadTime; WeaponSystem uses tactical vs empty timing)",
  jamClear: "code (JamClearState + startJamClear/updateJamClear; MalfunctionSystem interactive clear)",
  shootingRange: "code (ShootingRangeState + createShootingRange; menu 'Practice Range' entry)",
  recoilPatternViz: "code (sampleRecoilPatternForViz + renderRecoilPatternToCanvas; Gunsmith screen canvas)",
  perWeaponMelee: "code (getWeaponMelee + WEAPON_MELEE_DEFAULTS; MeleeSystem uses per-weapon config)",
  suppressorHeat: "code (suppressorCoolingRateMult; WeaponSystem barrel-heat integration)",
  weaponInspect: "code (InspectState + startInspect; hold-key detail animation)",
  ballisticReticle: "code — optional HUD ballistic reticle for snipers (Crosshair.tsx opt-in setting)",
  akimbo: "code (AkimboState + fireAkimbo; pistols can equip akimbo)",
  grenadeCookOff: "code (GrenadeCookState + grenadeFuseRemaining/grenadeTickIntensity)",
  wetWeaponMalfunction: "code (wetWeaponMalfunctionMult; WeatherSystem wetness integration)",
  crosshairDynamicBloom: "code (crosshairBloomRadius; Crosshair.tsx reads actual spread)",
  multiTargetPenetration: "code (penetrateMultipleTargets; Ballistics uses for line-of-targets)",

  // Doc/playtest:
  weaponFeelsPass: "doc — docs/GUNPLAY-AUDIT.md has the ear/feel playtest template (§5 #125)",
} as const;
