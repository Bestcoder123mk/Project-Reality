/**
 * Section B — comprehensive combat extension module.
 *
 * Implements prompts 207–280 covering: attachments (bipod, underbarrel GL,
 * laser, flashlight, strobe, foregrip variants, suppressor variants, optic
 * variants, scope glint, zeroing), ADS balance (FOV, sight alignment, sens),
 * HUD/cosmetics (crosshair bloom/editor, hitmarker variants, low ammo,
 * last-round cue, weapon FOV, inspect, case-hardened, charms, wraps, kill
 * etching, mastery camos, stats page, comparison, firing range, attachment
 * balance, level unlocks, prestige), ammo/magazine types, fire modes
 * (bolt/semi/auto/burst, trigger discipline), weapon swap speed, quick-scope,
 * no-scope penalty, sway-stance coupling, bipod auto-deploy, weapon collision,
 * sprint lowering, idle lowering, sprint-into-fire delay, shell ejection,
 * casing world physics, mag drop physics, charging handle, bolt hold-open,
 * bolt release, hammer cock, safety switch, brass-to-face, weapon weight
 * (movement/jump/slide), two-weapon carry, weapon throw/pickup, ammo resupply,
 * shared ammo pool, tracer-only, incendiary/slug/buckshot for shotguns, LMG
 * overheat/belt visualization, sniper bolt cycle, pistol slide lock, akimbo,
 * revolver reloads, weapon jam clear mini-game (already in MalfunctionSystem),
 * weapon condition, kill/headshot/accuracy trackers, daily challenges, mastery
 * camos, feel pass.
 *
 * This module provides the data tables + pure helpers. Targeted edits in the
 * existing systems (WeaponSystem, MeleeSystem, GrenadeSystem, etc.) wire the
 * helpers into the live game loop.
 */

import type { WeaponType, WeaponCategory, WeaponConfig } from "../store";
import { WEAPONS } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 207 — bipod deployment for LMGs (m249, rpk, mk48).
// ─────────────────────────────────────────────────────────────────────────────

export type BipodWeapon = "m249" | "rpk" | "mk48";

/** Weapons that support bipod deployment. */
export const BIPOD_WEAPONS: ReadonlySet<WeaponType> = new Set<BipodWeapon>(["m249", "rpk", "mk48"]) as unknown as ReadonlySet<WeaponType>;

/**
 * Prompt 207 — bipod deployment state. When deployed (prone or resting on
 * cover), the LMG has 60% less recoil + sustained fire is enabled (no
 * accuracy degradation from heat). The system checks prone + cover-rest.
 */
export interface BipodState {
  /** True if the bipod is currently deployed. */
  deployed: boolean;
  /** "prone" = player is prone; "cover" = player is resting on cover. */
  mode: "none" | "prone" | "cover";
}

/**
 * Prompt 207 — bipod recoil multiplier. When deployed, recoil is reduced 60%.
 */
export function bipodRecoilMult(state: BipodState): number {
  return state.deployed ? 0.4 : 1.0;
}

/**
 * Prompt 207 — should the bipod auto-deploy? Per spec #253, prone + stationary
 * auto-deploys the bipod. Returns the new bipod state.
 */
export function autoDeployBipod(
  weapon: WeaponType,
  isProne: boolean,
  isStationary: boolean,
  coverDetected: boolean,
): BipodState {
  if (!BIPOD_WEAPONS.has(weapon)) {
    return { deployed: false, mode: "none" };
  }
  if (isProne && isStationary) return { deployed: true, mode: "prone" };
  if (coverDetected) return { deployed: true, mode: "cover" };
  return { deployed: false, mode: "none" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 208 — underbarrel grenade launcher (M203).
// ─────────────────────────────────────────────────────────────────────────────

/** Weapons that support the M203 underbarrel GL. */
export const UNDERBARREL_GL_WEAPONS: ReadonlySet<WeaponType> = new Set(["m4", "hk416", "scarh"] as WeaponType[]);

/** M203 40mm grenade stats. */
export const M203_GRENADE = {
  /** Muzzle velocity (m/s). */
  velocity: 76,
  /** Explosion radius (m). */
  explosionRadius: 6,
  /** Base damage. */
  baseDamage: 100,
  /** Fuse time (seconds) — 40mm grenades detonate on impact, but have a
   *  minimum arming distance of 14m (real M203 safety). Below that they bounce. */
  armDistanceM: 14,
  /** Max carry ammo for the M203. */
  maxAmmo: 6,
};

/**
 * Prompt 208 — underbarrel GL state. The weapon's fire mode switches to
 * "gl" when the M203 is selected; firing launches a 40mm projectile with
 * its own ballistics (slow + heavy arc). The ProjectileSystem treats the
 * 40mm as a grenade (it explodes on impact), not a bullet.
 */
export interface UnderbarrelGLState {
  /** True if the M203 is currently the active fire mode. */
  active: boolean;
  /** 40mm rounds remaining. */
  ammo: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 209–211 — laser sight, flashlight, strobe.
// ─────────────────────────────────────────────────────────────────────────────

export interface LaserSightState {
  enabled: boolean;
  /** Visible to enemies (risk/reward). */
  visibleToEnemies: boolean;
}

export interface FlashlightState {
  enabled: boolean;
  /** "steady" or "strobe". Strobe disorients AI (#211). */
  mode: "steady" | "strobe";
  /** Visible to enemies (reveals position). */
  visibleToEnemies: boolean;
}

/**
 * Prompt 211 — strobe disorientation effect. AI in CQB strobed by a tactical
 * flashlight have their accuracy degraded by 40% for 2s. Returns the AI
 * accuracy multiplier to apply (1.0 = no effect, 0.6 = 40% degraded).
 */
export function strobeAccuracyMult(timeSinceStrobeSec: number): number {
  if (timeSinceStrobeSec >= 2.0) return 1.0;
  // Linear recovery from 0.6 to 1.0 over 2s.
  return 0.6 + 0.4 * (timeSinceStrobeSec / 2.0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 212–213 — foregrip + muzzle device variants.
// ─────────────────────────────────────────────────────────────────────────────

export type ForegripVariant = "none" | "vertical" | "angled" | "stubby";

export interface ForegripStats {
  /** Recoil vertical multiplier (vertical grip = best). */
  verticalRecoilMult: number;
  /** ADS transition speed multiplier (angled = best). */
  adsSpeedMult: number;
  /** Hipfire spread multiplier (stubby = best). */
  hipfireSpreadMult: number;
}

/** Per-foregrip stats. Each has a distinct pro + con (per #240 attachment balance). */
export const FOREGRIP_STATS: Record<ForegripVariant, ForegripStats> = {
  none:    { verticalRecoilMult: 1.0, adsSpeedMult: 1.0, hipfireSpreadMult: 1.0 },
  vertical:{ verticalRecoilMult: 0.75, adsSpeedMult: 0.95, hipfireSpreadMult: 1.0 }, // 25% less vertical, 5% slower ADS
  angled:  { verticalRecoilMult: 0.9, adsSpeedMult: 1.2, hipfireSpreadMult: 1.0 },   // 20% faster ADS, 10% less vertical
  stubby:  { verticalRecoilMult: 0.9, adsSpeedMult: 1.0, hipfireSpreadMult: 0.7 },   // 30% tighter hipfire, 10% less vertical
};

export type MuzzleVariant = "none" | "suppressor" | "flash_hider" | "compensator" | "muzzle_brake";

export interface MuzzleStats {
  /** Sound signature multiplier (suppressor = 0.4, others = 1.0). */
  soundMult: number;
  /** Flash visibility (suppressor = 0, flash_hider = 0.3, others = 1.0). */
  flashMult: number;
  /** Vertical recoil multiplier (brake = 0.8, comp = 1.0, supp = 0.85). */
  verticalRecoilMult: number;
  /** Horizontal recoil multiplier (comp = 0.7, brake = 1.0, supp = 0.9). */
  horizontalRecoilMult: number;
  /** Range multiplier (suppressor reduces range; others = 1.0). */
  rangeMult: number;
}

/** Per-muzzle-device stats. */
export const MUZZLE_STATS: Record<MuzzleVariant, MuzzleStats> = {
  none:         { soundMult: 1.0,  flashMult: 1.0, verticalRecoilMult: 1.0,  horizontalRecoilMult: 1.0,  rangeMult: 1.0 },
  suppressor:   { soundMult: 0.4,  flashMult: 0.0, verticalRecoilMult: 0.85, horizontalRecoilMult: 0.9,  rangeMult: 0.85 },
  flash_hider:  { soundMult: 1.0,  flashMult: 0.3, verticalRecoilMult: 1.0,  horizontalRecoilMult: 1.0,  rangeMult: 1.0 },
  compensator:  { soundMult: 1.0,  flashMult: 1.0, verticalRecoilMult: 1.0,  horizontalRecoilMult: 0.7,  rangeMult: 1.0 },
  muzzle_brake: { soundMult: 1.05, flashMult: 1.0, verticalRecoilMult: 0.8,  horizontalRecoilMult: 1.0,  rangeMult: 1.0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 214–215 — optic variants + scope glint.
// ─────────────────────────────────────────────────────────────────────────────

export type OpticVariant = "none" | "red_dot" | "holo" | "acog" | "scope4x" | "scope8x" | "scope12x";

export interface OpticStats {
  /** Zoom multiplier (1.0 = no zoom, 12.0 = scope12x). */
  zoom: number;
  /** ADS transition time multiplier (higher = slower ADS). */
  adsTimeMult: number;
  /** True if the optic should produce a scope glint (#215). */
  producesGlint: boolean;
}

/** Per-optic stats. */
export const OPTIC_STATS: Record<OpticVariant, OpticStats> = {
  none:     { zoom: 1.0,  adsTimeMult: 1.0,  producesGlint: false },
  red_dot:  { zoom: 1.2,  adsTimeMult: 0.9,  producesGlint: false },
  holo:     { zoom: 1.3,  adsTimeMult: 0.9,  producesGlint: false },
  acog:     { zoom: 2.5,  adsTimeMult: 1.1,  producesGlint: false },
  scope4x:  { zoom: 4.0,  adsTimeMult: 1.3,  producesGlint: false },
  scope8x:  { zoom: 8.0,  adsTimeMult: 1.5,  producesGlint: true },
  scope12x: { zoom: 12.0, adsTimeMult: 1.7,  producesGlint: true },
};

/**
 * Prompt 215 — should the scope glint be visible right now?
 *
 * A sun-facing 8x+ scope emits a glint visible to enemies. The glint intensity
 * scales with the angle between the scope's forward direction and the sun
 * direction. When the scope points toward the sun, the glint is at full
 * intensity (1.0); when the scope points away, the glint is 0.
 */
export function scopeGlintIntensity(
  optic: OpticVariant,
  scopeForwardDotSun: number,
): number {
  const stats = OPTIC_STATS[optic];
  if (!stats.producesGlint) return 0;
  // Glint scales with the dot product (1 = scope points at sun, 0 = perpendicular).
  // Below 0 (scope points away), no glint.
  return Math.max(0, scopeForwardDotSun);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 216 — zeroing adjustment for scoped weapons.
// ─────────────────────────────────────────────────────────────────────────────

export type ZeroDistance = 100 | 200 | 300 | 400 | 500;

/**
 * Prompt 216 — compute the POI offset (meters) for a given zero distance +
 * actual range. The scope's BDC reticle is calibrated for the zero distance;
 * shooting at a different range requires holdover (above for closer, below
 * for farther).
 *
 * Returns the vertical POI offset in meters (positive = high, negative = low).
 * The caller adds this to the bullet's drop to compute the actual impact point.
 */
export function zeroingPoiOffsetM(
  zeroDistanceM: number,
  actualRangeM: number,
  bulletVelocity: number,
): number {
  // Drop at the zero distance is the baseline. Drop at the actual range is
  // the actual. The difference is the POI offset (positive = impact high).
  const g = 9.81;
  const tZero = zeroDistanceM / bulletVelocity;
  const tActual = actualRangeM / bulletVelocity;
  const dropZero = 0.5 * g * tZero * tZero;
  const dropActual = 0.5 * g * tActual * tActual;
  // If actual range > zero, the bullet drops more → impact is LOW (negative).
  return dropZero - dropActual;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 230 — weapon-specific viewmodel FOV (separate from camera FOV).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default viewmodel FOV (degrees). Distinct from the camera FOV (75°) so the
 * viewmodel can be framed independently — a tighter viewmodel FOV makes the
 * weapon look larger/heavier without changing the world view.
 */
export const DEFAULT_VIEWMODEL_FOV = 65;

/** Per-category viewmodel FOV (degrees). Heavier weapons frame tighter. */
const VIEWMODEL_FOV_BY_CATEGORY: Record<WeaponCategory, number> = {
  RIFLE: 65, SMG: 68, PISTOL: 70, SNIPER: 60, SHOTGUN: 64, LMG: 58,
};

/** Player-configurable viewmodel FOV offset (±10°). */
export interface ViewmodelFovSettings {
  /** Offset added to the per-category base (-10..+10). */
  offset: number;
}

export const DEFAULT_VIEWMODEL_FOV_SETTINGS: ViewmodelFovSettings = { offset: 0 };

/**
 * Prompt 230 — viewmodel FOV for a given weapon category + player settings.
 * The camera FOV stays at its own setting (75° default); this returns the
 * independent viewmodel FOV. Clamped to [40, 90].
 */
export function viewmodelFovDeg(
  weapon: WeaponType,
  settings: ViewmodelFovSettings = DEFAULT_VIEWMODEL_FOV_SETTINGS,
): number {
  const cfg = WEAPONS[weapon];
  const base = cfg ? (VIEWMODEL_FOV_BY_CATEGORY[cfg.category] ?? DEFAULT_VIEWMODEL_FOV) : DEFAULT_VIEWMODEL_FOV;
  return Math.max(40, Math.min(90, base + (settings.offset ?? 0)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 221–223 — per-weapon ADS FOV, sight alignment, ADS sensitivity.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 221 — per-weapon ADS FOV. Snipers zoom more than pistols.
 * Returns the ADS FOV (degrees) for the given weapon category + optic.
 */
export function adsFovFor(category: WeaponCategory, optic: OpticVariant): number {
  const baseFov: Record<WeaponCategory, number> = {
    RIFLE: 65, SMG: 70, PISTOL: 75, SNIPER: 50, SHOTGUN: 70, LMG: 60,
  };
  const base = baseFov[category] ?? 65;
  const zoom = OPTIC_STATS[optic]?.zoom ?? 1.0;
  // FOV = base / zoom. A 4x scope narrows the FOV by 4×.
  return Math.max(15, base / zoom);
}

/**
 * Prompt 222 — per-weapon ADS sight alignment offset. Different weapons have
 * different sight heights; the ADS pose must align the sight to the camera.
 * Returns the [x, y, z] position offset for the viewmodel in ADS.
 */
export function adsSightAlignment(weapon: WeaponType): [number, number, number] {
  // Default ADS pose: weapon centered + raised.
  const defaultPose: [number, number, number] = [0.0, -0.075, -0.20];
  // Per-weapon sight-height offsets. Snipers have taller scopes → larger Y.
  const offsets: Partial<Record<WeaponType, [number, number, number]>> = {
    awp:     [0.0, -0.090, -0.22], // tall scope
    l115a3:  [0.0, -0.095, -0.22],
    scout:   [0.0, -0.085, -0.21],
    kar98k:  [0.0, -0.080, -0.21],
    m249:    [0.0, -0.070, -0.22], // low iron sights
    rpk:     [0.0, -0.072, -0.21],
    mk48:    [0.0, -0.075, -0.21],
    usp:     [0.0, -0.065, -0.18], // pistol — closer
    deagle:  [0.0, -0.065, -0.18],
    m1911:   [0.0, -0.065, -0.18],
    revolver:[0.0, -0.065, -0.18],
    glock18: [0.0, -0.065, -0.18],
    mp7:     [0.0, -0.070, -0.19],
    p90:     [0.0, -0.075, -0.20],
    mp5:     [0.0, -0.070, -0.19],
  };
  return offsets[weapon] ?? defaultPose;
}

/**
 * Prompt 223 — ADS sensitivity scaling. Mouse sensitivity reduces proportionally
 * to zoom so scoped aim feels consistent. Returns the sensitivity multiplier.
 */
export function adsSensitivityMult(hipFov: number, adsFov: number): number {
  if (hipFov <= 0 || adsFov <= 0) return 1.0;
  // The multiplier is the ratio of FOVs (a 4x zoom → 0.25× sensitivity).
  return Math.max(0.1, adsFov / hipFov);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 224–227 — crosshair bloom + editor + hitmarker.
// ─────────────────────────────────────────────────────────────────────────────

/** Crosshair configuration (editable per #225). */
export interface CrosshairConfig {
  color: number;
  thickness: number;
  gap: number;
  dot: boolean;
  outline: boolean;
  outlineColor: number;
}

export const DEFAULT_CROSSHAIR: CrosshairConfig = {
  color: 0x00ff00,
  thickness: 2,
  gap: 6,
  dot: false,
  outline: true,
  outlineColor: 0x000000,
};

/**
 * Prompt 224 — crosshair bloom. The hipfire crosshair expands while moving/
 * firing + contracts when still. Returns the gap multiplier (1.0 = base).
 */
export function crosshairBloomGapMult(
  isMoving: boolean,
  isFiring: boolean,
  spread: number,
): number {
  let mult = 1.0;
  if (isMoving) mult += 0.5;
  if (isFiring) mult += 0.8;
  // Scale with the weapon's base spread (high-spread weapons bloom more).
  mult += spread * 5;
  return mult;
}

/** Prompt 226 — hitmarker config. */
export interface HitmarkerConfig {
  color: number;
  headshotColor: number;
  killColor: number;
  size: number;
  sound: boolean;
}

export const DEFAULT_HITMARKER: HitmarkerConfig = {
  color: 0xffffff,
  headshotColor: 0xff5555,
  killColor: 0xff3333,
  size: 12,
  sound: true,
};

/**
 * Prompt 227 — hitmarker variant. Returns the color + size for the given hit type.
 */
export function hitmarkerVariant(
  hitType: "hit" | "headshot" | "kill",
  config: HitmarkerConfig = DEFAULT_HITMARKER,
): { color: number; size: number } {
  switch (hitType) {
    case "headshot": return { color: config.headshotColor, size: config.size * 1.3 };
    case "kill":     return { color: config.killColor,     size: config.size * 1.5 };
    case "hit":
    default:         return { color: config.color,         size: config.size };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 228–229 — low ammo HUD + last-round audio cue.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 228 — low ammo HUD color. Below 25% mag, the ammo counter turns red.
 * Returns the color (0xff3333 = red, 0xffffff = white).
 */
export function ammoHudColor(currentAmmo: number, magSize: number): number {
  if (magSize <= 0) return 0xffffff;
  const ratio = currentAmmo / magSize;
  if (ratio <= 0.25) return 0xff3333; // red
  if (ratio <= 0.5) return 0xffaa33;  // amber
  return 0xffffff;                    // white
}

/**
 * Prompt 229 — last-round audio cue. The last round in a mag has a distinct
 * sound so the player knows to reload without looking. Returns true if this
 * shot is the last round.
 */
export function isLastRoundInMag(currentAmmo: number): boolean {
  return currentAmmo === 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 219–220 — BDC reticle + scoped aim-punch.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 219 — Bullet Drop Compensator (BDC) reticle marks. A scope reticle
 * with BDC marks for 200/300/400/500m. The marks are vertical offsets (mrad)
 * the player aligns with the target's known range to compensate for bullet
 * drop without dialing the zero.
 *
 * Returns an array of { rangeM, dropMrad } for the standard marks. The reticle
 * renderer draws a horizontal stadia at each offset below the crosshair.
 */
export interface BDCMark {
  /** Range (meters) the mark is calibrated for. */
  rangeM: number;
  /** Vertical offset below the crosshair (milliradians). */
  dropMrad: number;
}

/**
 * Prompt 219 — compute the BDC marks for the given zero distance + bullet
 * velocity. The marks represent the bullet drop at each range, expressed as a
 * mrad offset (1 mrad = 1 m at 1000 m = 10 cm at 100 m).
 *
 * Drop is computed with the standard kinematic formula (0.5·g·t²) and the
 * zero-distance drop subtracted (the crosshair already accounts for it).
 */
export function bdcReticleMarks(
  zeroDistanceM: number,
  bulletVelocityMs: number,
  rangesM: number[] = [200, 300, 400, 500],
): BDCMark[] {
  const g = 9.81;
  const tZero = zeroDistanceM / bulletVelocityMs;
  const dropZero = 0.5 * g * tZero * tZero;
  return rangesM.map((r) => {
    const t = r / bulletVelocityMs;
    const drop = 0.5 * g * t * t;
    // mrad = (drop - zero) / range * 1000 (small-angle).
    const dropMrad = ((drop - dropZero) / r) * 1000;
    return { rangeM: r, dropMrad };
  });
}

/**
 * Prompt 220 — scoped aim-punch on damage. A hit while scoped throws the
 * scope off target. The punch magnitude scales with the damage fraction
 * (a 20-HP hit = 0.20 → 4° punch). The punch decays over the recovery window
 * (250 ms, fast-attack slow-decay).
 */
export const SCOPE_AIM_PUNCH_RECOVERY_MS = 250;
export const SCOPE_AIM_PUNCH_ATTACK_MS = 30;
/** Punch magnitude per unit of damage (degrees per 1.0 HP/MaxHP ratio). */
export const SCOPE_AIM_PUNCH_DEG_PER_HP_RATIO = 20;

/**
 * Prompt 220 — compute the scoped aim-punch magnitude (degrees) for a hit
 * dealing `damageFraction` of max HP (0..1). Returns the peak punch in degrees
 * (the recovery envelope is sin(π·t) — caller handles the decay).
 */
export function scopedAimPunchDeg(damageFraction: number): number {
  const f = Math.max(0, Math.min(1, damageFraction));
  return f * SCOPE_AIM_PUNCH_DEG_PER_HP_RATIO;
}

/**
 * Prompt 220 — sample the scoped aim-punch envelope at the given elapsed time.
 * Fast-attack (sin(π·t/attackMs)) to peak, then sin(π·(1-t)) decay to 0 over
 * recoveryMs. Returns the punch magnitude in degrees at time `elapsedMs`.
 */
export function scopedAimPunchSample(
  punchDeg: number,
  elapsedMs: number,
  attackMs: number = SCOPE_AIM_PUNCH_ATTACK_MS,
  recoveryMs: number = SCOPE_AIM_PUNCH_RECOVERY_MS,
): number {
  if (elapsedMs <= 0 || punchDeg <= 0) return 0;
  if (elapsedMs < attackMs) {
    const t = elapsedMs / attackMs;
    return punchDeg * Math.sin(t * Math.PI * 0.5); // ease-out to peak
  }
  const decayT = (elapsedMs - attackMs) / recoveryMs;
  if (decayT >= 1) return 0;
  return punchDeg * Math.sin((1 - decayT) * Math.PI);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 225 — crosshair editor helpers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 225 — merge a partial crosshair config override with the default.
 * Used by the settings panel: the player edits one field (e.g. color) without
 * having to re-specify the others. Returns a normalized CrosshairConfig.
 */
export function mergeCrosshairConfig(
  overrides: Partial<CrosshairConfig>,
  base: CrosshairConfig = DEFAULT_CROSSHAIR,
): CrosshairConfig {
  return {
    color: overrides.color ?? base.color,
    thickness: Math.max(1, Math.min(10, overrides.thickness ?? base.thickness)),
    gap: Math.max(0, Math.min(40, overrides.gap ?? base.gap)),
    dot: overrides.dot ?? base.dot,
    outline: overrides.outline ?? base.outline,
    outlineColor: overrides.outlineColor ?? base.outlineColor,
  };
}

/**
 * Prompt 225 — validate a crosshair config. Returns a list of field errors
 * (empty array = valid). Used by the settings panel before persisting.
 */
export function validateCrosshairConfig(cfg: CrosshairConfig): string[] {
  const errors: string[] = [];
  if (typeof cfg.color !== "number" || cfg.color < 0 || cfg.color > 0xffffff) {
    errors.push("color must be a 0..0xffffff hex number");
  }
  if (typeof cfg.thickness !== "number" || cfg.thickness < 1 || cfg.thickness > 10) {
    errors.push("thickness must be 1..10");
  }
  if (typeof cfg.gap !== "number" || cfg.gap < 0 || cfg.gap > 40) {
    errors.push("gap must be 0..40");
  }
  if (typeof cfg.dot !== "boolean") errors.push("dot must be boolean");
  if (typeof cfg.outline !== "boolean") errors.push("outline must be boolean");
  if (typeof cfg.outlineColor !== "number" || cfg.outlineColor < 0 || cfg.outlineColor > 0xffffff) {
    errors.push("outlineColor must be a 0..0xffffff hex number");
  }
  return errors;
}

/**
 * Prompt 225 — crosshair editor presets. Quick-select options the player can
 * cycle through. Each preset is a full CrosshairConfig the editor applies
 * atomically.
 */
export const CROSSHAIR_PRESETS: Record<string, CrosshairConfig> = {
  default:   { ...DEFAULT_CROSSHAIR },
  dot:       { color: 0x00ff00, thickness: 2, gap: 0,  dot: true,  outline: true,  outlineColor: 0x000000 },
  cross:     { color: 0xffffff, thickness: 1, gap: 4,  dot: false, outline: false, outlineColor: 0x000000 },
  tactical:  { color: 0x00ffff, thickness: 2, gap: 6,  dot: true,  outline: true,  outlineColor: 0x000000 },
  circle:    { color: 0xffaa00, thickness: 2, gap: 10, dot: false, outline: true,  outlineColor: 0x000000 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 232–236 — cosmetics: case-hardened, charms, wraps, kill etching,
// mastery camos.
// ─────────────────────────────────────────────────────────────────────────────

export type WearTier = "factory_new" | "minimal_wear" | "field_tested" | "well_worn" | "battle_scarred";

export interface WeaponCosmetic {
  /** Case-hardened / wear pattern variant. */
  wear: WearTier;
  /** Charm slug (per Charms.ts). */
  charm?: string;
  /** Wrap/camo slug (per Wraps.ts). */
  wrap?: string;
  /** Kill-count etching (cosmetic). */
  killCount: number;
  /** Mastery camo slug (unlocked at kill milestones). */
  masteryCamo?: "none" | "gold" | "platinum" | "diamond" | "conspiracy";
}

/**
 * Prompt 232 — wear pattern visual parameters. Each wear tier tints the
 * weapon differently (factory_new = clean, battle_scarred = rust + scratches).
 */
export const WEAR_TIER_VISUALS: Record<WearTier, { colorTint: number; scratchDensity: number; rustAmount: number }> = {
  factory_new:    { colorTint: 0xffffff, scratchDensity: 0.0, rustAmount: 0.0 },
  minimal_wear:   { colorTint: 0xf8f8f8, scratchDensity: 0.1, rustAmount: 0.0 },
  field_tested:   { colorTint: 0xe0e0e0, scratchDensity: 0.3, rustAmount: 0.05 },
  well_worn:      { colorTint: 0xc0c0c0, scratchDensity: 0.6, rustAmount: 0.15 },
  battle_scarred: { colorTint: 0xa0a0a0, scratchDensity: 0.9, rustAmount: 0.3 },
};

/**
 * Prompt 235 — kill-count etching tiers. Weapons with 1000+ kills show
 * etched marks on the receiver.
 */
export function killEtchingTier(killCount: number): "none" | "bronze" | "silver" | "gold" | "platinum" {
  if (killCount >= 5000) return "platinum";
  if (killCount >= 2500) return "gold";
  if (killCount >= 1000) return "silver";
  if (killCount >= 500) return "bronze";
  return "none";
}

/**
 * Prompt 236 — mastery camo unlock thresholds.
 */
export function masteryCamoForKills(killCount: number): WeaponCosmetic["masteryCamo"] {
  if (killCount >= 10000) return "conspiracy";
  if (killCount >= 5000) return "diamond";
  if (killCount >= 2500) return "platinum";
  if (killCount >= 500) return "gold";
  return "none";
}

/**
 * Prompt 299 — mastery camo by headshot count (alternative unlock path).
 */
export function masteryCamoForHeadshots(headshotCount: number): WeaponCosmetic["masteryCamo"] {
  if (headshotCount >= 2500) return "diamond";
  if (headshotCount >= 1000) return "platinum";
  if (headshotCount >= 500) return "gold";
  return "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 237–239 — gunsmith stats page, comparison, firing range.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 237 — radar-chart stats for the gunsmith stats page. */
export interface WeaponRadarStats {
  damage: number;     // 0..100
  range: number;      // 0..100
  fireRate: number;   // 0..100
  mobility: number;   // 0..100
  control: number;    // 0..100 (recoil inverse)
  accuracy: number;   // 0..100 (spread inverse)
}

/**
 * Prompt 237 — compute the radar-chart stats for a weapon. Scales the raw
 * WeaponConfig values to 0..100 for the radar chart.
 */
export function weaponRadarStats(cfg: WeaponConfig): WeaponRadarStats {
  // Normalize each stat to 0..100 using category-relative scaling.
  return {
    damage:   Math.min(100, cfg.damage * 2),
    range:    Math.min(100, cfg.range / 10),
    fireRate: Math.min(100, 10000 / Math.max(50, cfg.fireRate)),
    mobility: Math.min(100, 100 - cfg.recoil * 20),
    control:  Math.min(100, 100 - cfg.recoil * 25),
    accuracy: Math.min(100, 1 / Math.max(0.001, cfg.spread) * 10),
  };
}

/**
 * Prompt 238 — compare two weapons side-by-side. Returns the per-stat delta
 * (A - B, positive = A is better).
 */
export function compareWeapons(a: WeaponConfig, b: WeaponConfig): WeaponRadarStats {
  const ra = weaponRadarStats(a);
  const rb = weaponRadarStats(b);
  return {
    damage:   ra.damage - rb.damage,
    range:    ra.range - rb.range,
    fireRate: ra.fireRate - rb.fireRate,
    mobility: ra.mobility - rb.mobility,
    control:  ra.control - rb.control,
    accuracy: ra.accuracy - rb.accuracy,
  };
}

/**
 * Prompt 239 — firing range test-fire session state.
 */
export interface FiringRangeSession {
  /** Weapon being tested. */
  weapon: WeaponType;
  /** Targets hit / shots fired. */
  shotsFired: number;
  shotsHit: number;
  /** Total damage dealt. */
  totalDamage: number;
  /** Average TTK (seconds). */
  avgTtk: number;
}

/** Prompt 239 — record a shot in the firing range. */
export function recordFiringRangeShot(
  session: FiringRangeSession,
  hit: boolean,
  damage: number,
): void {
  session.shotsFired++;
  if (hit) {
    session.shotsHit++;
    session.totalDamage += damage;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 240 — attachment balance: each attachment has a pro + a con.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttachmentBalanceEntry {
  slug: string;
  pro: string;
  con: string;
}

/**
 * Prompt 240 — per-attachment pro/con table. No attachment is strictly better.
 * The gunsmith UI shows these so the player understands the trade-off.
 */
export const ATTACHMENT_BALANCE: Record<string, AttachmentBalanceEntry> = {
  suppressor:   { slug: "suppressor",   pro: "Quiet + no flash + 15% less recoil", con: "15% less range + visible to enemies at close range" },
  flash_hider:  { slug: "flash_hider",  pro: "Hides muzzle flash",                  con: "No recoil reduction" },
  compensator:  { slug: "compensator",  pro: "30% less horizontal recoil",          con: "5% louder + no vertical reduction" },
  muzzle_brake: { slug: "muzzle_brake", pro: "20% less vertical recoil",            con: "5% louder + slight flash increase" },
  vertical:     { slug: "vertical",     pro: "25% less vertical recoil",            con: "5% slower ADS" },
  angled:       { slug: "angled",       pro: "20% faster ADS",                      con: "10% less vertical reduction than vertical" },
  stubby:       { slug: "stubby",       pro: "30% tighter hipfire",                 con: "No recoil reduction" },
  red_dot:      { slug: "red_dot",      pro: "Cleaner sight picture + 10% faster ADS", con: "Slight zoom only (1.2×)" },
  holo:         { slug: "holo",         pro: "Wide FOV sight + 10% faster ADS",     con: "Slight zoom only (1.3×)" },
  acog:         { slug: "acog",         pro: "2.5× zoom",                           con: "10% slower ADS" },
  scope4x:      { slug: "scope4x",      pro: "4× zoom",                             con: "30% slower ADS + scope sway" },
  scope8x:      { slug: "scope8x",      pro: "8× zoom",                             con: "50% slower ADS + scope glint + scope sway" },
  scope12x:     { slug: "scope12x",     pro: "12× zoom",                            con: "70% slower ADS + scope glint + heavy scope sway" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 241–242 — weapon level unlocks + prestige.
// ─────────────────────────────────────────────────────────────────────────────

export interface WeaponProgress {
  /** Current weapon level (0..maxLevel). */
  level: number;
  /** Current XP. */
  xp: number;
  /** Total kills with this weapon. */
  totalKills: number;
  /** Total headshots. */
  totalHeadshots: number;
  /** Prestige tier (0 = not prestiged). */
  prestige: number;
}

export const MAX_WEAPON_LEVEL = 50;
export const PRESTIGE_MAX = 5;

/** XP per kill. */
export const XP_PER_KILL = 100;
/** XP per headshot (bonus). */
export const XP_PER_HEADSHOT = 50;

/** Prompt 241 — weapon level for a given XP amount. */
export function weaponLevelForXp(xp: number): number {
  // Linear: 1000 XP per level. 50 levels = 50,000 XP.
  return Math.min(MAX_WEAPON_LEVEL, Math.floor(xp / 1000));
}

/** Prompt 241 — attachments unlock at specific levels. */
export const ATTACHMENT_UNLOCK_LEVELS: Record<string, number> = {
  red_dot: 5,
  holo: 8,
  acog: 15,
  scope4x: 25,
  scope8x: 35,
  scope12x: 45,
  suppressor: 20,
  flash_hider: 10,
  compensator: 18,
  muzzle_brake: 22,
  vertical: 12,
  angled: 16,
  stubby: 14,
};

/** Prompt 242 — prestige the weapon (reset progress for a cosmetic). */
export function prestigeWeapon(progress: WeaponProgress): WeaponProgress {
  if (progress.level < MAX_WEAPON_LEVEL) return progress; // can't prestige
  if (progress.prestige >= PRESTIGE_MAX) return progress; // maxed
  return {
    level: 0,
    xp: 0,
    totalKills: progress.totalKills, // kills persist for cosmetics
    totalHeadshots: progress.totalHeadshots,
    prestige: progress.prestige + 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 243–244 — ammo type selection + magazine variants.
// ─────────────────────────────────────────────────────────────────────────────

export type AmmoTypeSlug = "fmj" | "hp" | "ap" | "subsonic" | "tracer" | "incendiary";

/**
 * Prompt 243 — per-ammo-type ballistics stats. Each ammo type changes
 * ballistics (per spec "ammo type changes ballistics"). The loadout selects
 * one ammo type per weapon; the WeaponSystem + Ballistics modules consume
 * these multipliers when computing damage, drop, and penetration.
 */
export interface AmmoTypeStats {
  /** Damage multiplier vs unarmored (HP = best, AP = worst). */
  damageMult: number;
  /** Armor penetration multiplier (AP = best, HP = worst). */
  armorPenMult: number;
  /** Muzzle velocity multiplier (subsonic = 0.7, others = 1.0). */
  velocityMult: number;
  /** Bullet drop multiplier (subsonic drops more; AP drops less). */
  dropMult: number;
  /** Sound signature multiplier (subsonic + suppressor = quietest). */
  soundMult: number;
  /** Tracer frequency (0 = no tracers, 1 = every round, 0.2 = every 5th). */
  tracerFrequency: number;
}

export const AMMO_TYPE_STATS: Record<AmmoTypeSlug, AmmoTypeStats> = {
  fmj:        { damageMult: 1.0,  armorPenMult: 1.0,  velocityMult: 1.0,  dropMult: 1.0,  soundMult: 1.0,  tracerFrequency: 0.2 },
  hp:         { damageMult: 1.4,  armorPenMult: 0.3,  velocityMult: 0.95, dropMult: 1.05, soundMult: 1.0,  tracerFrequency: 0.2 }, // hollow point — high damage, no armor pen
  ap:         { damageMult: 0.8,  armorPenMult: 1.8,  velocityMult: 1.05, dropMult: 0.95, soundMult: 1.0,  tracerFrequency: 0.2 }, // armor piercing — low damage, high pen
  subsonic:   { damageMult: 0.9,  armorPenMult: 0.9,  velocityMult: 0.7,  dropMult: 1.4,  soundMult: 0.5,  tracerFrequency: 0.2 }, // subsonic — quiet + heavy drop
  tracer:     { damageMult: 1.0,  armorPenMult: 1.0,  velocityMult: 1.0,  dropMult: 1.0,  soundMult: 1.0,  tracerFrequency: 1.0 }, // all-tracer meme loadout (#277)
  incendiary: { damageMult: 1.2,  armorPenMult: 0.5,  velocityMult: 0.9,  dropMult: 1.1,  soundMult: 1.05, tracerFrequency: 0.5 }, // dragon's breath #278
};

/**
 * Prompt 243 — lookup an ammo type's stats. Falls back to FMJ if unknown.
 */
export function ammoTypeStats(slug: AmmoTypeSlug): AmmoTypeStats {
  return AMMO_TYPE_STATS[slug] ?? AMMO_TYPE_STATS.fmj;
}

/** Prompt 244 — magazine size variants. */
export type MagazineVariant = "default" | "extended" | "drum";

export interface MagazineStats {
  /** Multiplier on the base mag size. */
  sizeMult: number;
  /** Multiplier on the reload time (drum = slower). */
  reloadTimeMult: number;
  /** Multiplier on movement speed (drum = heavier = slower). */
  moveSpeedMult: number;
}

export const MAGAZINE_STATS: Record<MagazineVariant, MagazineStats> = {
  default:  { sizeMult: 1.0,  reloadTimeMult: 1.0,  moveSpeedMult: 1.0 },
  extended: { sizeMult: 1.5,  reloadTimeMult: 1.1,  moveSpeedMult: 0.97 },
  drum:     { sizeMult: 3.0,  reloadTimeMult: 1.4,  moveSpeedMult: 0.90 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 245–247 — fire modes (bolt/semi/auto/burst + trigger discipline).
// ─────────────────────────────────────────────────────────────────────────────

export type FireMode = "bolt" | "semi" | "auto" | "burst";

export interface FireModeStats {
  /** Shots per trigger pull (burst = 3, others = 1). */
  shotsPerPull: number;
  /** Minimum delay between shots (ms). */
  minDelayMs: number;
  /** True if the weapon can hold-fire (auto). */
  canHold: boolean;
}

/** Per-fire-mode stats. */
export const FIRE_MODE_STATS: Record<FireMode, FireModeStats> = {
  bolt:  { shotsPerPull: 1, minDelayMs: 800, canHold: false }, // bolt-action cycle
  semi:  { shotsPerPull: 1, minDelayMs: 80,  canHold: false }, // semi-auto
  auto:  { shotsPerPull: 1, minDelayMs: 0,   canHold: true },  // full-auto
  burst: { shotsPerPull: 3, minDelayMs: 200, canHold: false }, // 3-round burst
};

/**
 * Prompt 245 — per-weapon default fire mode. Snipers are bolt-action, most
 * rifles are auto, M16/FAMAS are burst-capable (#246).
 */
export function defaultFireModeFor(weapon: WeaponType): FireMode {
  // Bolt-action snipers.
  if (weapon === "awp" || weapon === "l115a3" || weapon === "kar98k") return "bolt";
  // Burst-fire weapons.
  if (weapon === "famas") return "burst";
  // Default: auto for rifles/SMGs/LMGs/shotguns, semi for pistols/DMRs.
  const cfg = WEAPONS[weapon];
  if (!cfg) return "semi";
  if (cfg.category === "PISTOL") return "semi";
  if (weapon === "mk14" || weapon === "scout") return "semi";
  return "auto";
}

/**
 * Prompt 246 — weapons that support burst fire mode (M16, FAMAS).
 */
export const BURST_WEAPONS: ReadonlySet<WeaponType> = new Set<WeaponType>(["famas", "m4", "hk416"] as WeaponType[]);

/**
 * Prompt 247 — trigger discipline. On an auto weapon, a light tap fires a
 * single shot; a hold fires full-auto. The system uses the input hold time
 * to decide: < 100ms = single tap, >= 100ms = auto.
 */
export function shouldFireSingleShot(holdTimeMs: number): boolean {
  return holdTimeMs < 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 248 — weapon swap speed (weight + holster position).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 248 — weapon swap time (ms) based on weight + holster position.
 * Pistols swap fast (holster on hip), LMGs swap slow (slung on a long strap).
 */
export function weaponSwapTimeMs(weapon: WeaponType): number {
  const cfg = WEAPONS[weapon];
  if (!cfg) return 500;
  // Per-category base swap times.
  const baseByCat: Record<WeaponCategory, number> = {
    PISTOL: 250,  // holster on hip — fastest
    SMG: 400,     // 1-point sling
    RIFLE: 500,   // 2-point sling
    SHOTGUN: 550,
    SNIPER: 600,  // long gun + scope
    LMG: 800,     // heavy + bulky
  };
  return baseByCat[cfg.category] ?? 500;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 249–250 — quick-scope bonus + no-scope penalty.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 249 — quick-scope bonus. ADS + fire within 200ms = bonus accuracy
 * (spread reduced by 50%). Returns the spread multiplier.
 */
export function quickScopeSpreadMult(timeSinceAdsStartMs: number): number {
  if (timeSinceAdsStartMs > 200) return 1.0;
  // Bonus scales from 0.5 (instant) to 1.0 (at 200ms).
  return 0.5 + 0.5 * (timeSinceAdsStartMs / 200);
}

/**
 * Prompt 250 — no-scope penalty. Hipfire on a sniper has huge spread.
 * Returns the spread multiplier for a no-scope sniper shot.
 */
export function noScopeSpreadMult(isSniper: boolean, isAiming: boolean): number {
  if (!isSniper) return 1.0;
  if (isAiming) return 1.0;
  // Snipers hipfire with 5× the base spread.
  return 5.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 251–252 — sway stance coupling + lean stabilization.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 251 — sway multiplier based on stance. Crouch reduces sway 30%,
 * prone 60%.
 */
export function stanceSwayMult(isCrouching: boolean, isProne: boolean): number {
  if (isProne) return 0.4;
  if (isCrouching) return 0.7;
  return 1.0;
}

/**
 * Prompt 252 — lean stabilization. While leaning, the weapon rests on the wall,
 * reducing sway by 50%.
 */
export function leanSwayMult(isLeaning: boolean): number {
  return isLeaning ? 0.5 : 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 254–257 — weapon collision, sprint lowering, idle lowering,
// sprint-into-fire delay.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 254 — weapon retraction IK. When the viewmodel is pushed into a wall,
 * retract it. Returns the retraction amount (0..1, 0 = no retraction, 1 = full).
 */
export function weaponRetractionAmount(distanceToWallM: number): number {
  if (distanceToWallM >= 0.5) return 0;
  // Linear retraction from 0 at 0.5m to 1 at 0m.
  return 1 - distanceToWallM / 0.5;
}

/**
 * Prompt 255 — sprint-to-fire delay (ms). The weapon lowers in sprint; bringing
 * it up takes time.
 */
export const SPRINT_TO_FIRE_DELAY_MS = 250;

/**
 * Prompt 256 — idle-with-no-ammo lowering. After 5s of no firing + 0 ammo,
 * the weapon lowers to a rest pose.
 */
export const IDLE_LOW_AMMO_LOWERING_SEC = 5;

/**
 * Prompt 257 — sprint-into-fire animation length (ms). Matches SPRINT_TO_FIRE_DELAY_MS.
 */
export const SPRINT_INTO_FIRE_ANIM_MS = SPRINT_TO_FIRE_DELAY_MS;

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 258–266 — viewmodel animation details.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 258 — shell ejection viewmodel. Per-shot shell casing ejection from
 * the viewmodel's ejection port. Returns the ejection velocity (m/s) in
 * viewmodel-local space [right, up, forward].
 */
export function shellEjectionVelocity(weapon: WeaponType): [number, number, number] {
  const cfg = WEAPONS[weapon];
  if (!cfg) return [1.5, 2.0, -0.3];
  // Pistols eject slower than rifles; bolt-actions eject straight up.
  if (cfg.category === "PISTOL") return [1.2, 1.5, -0.2];
  if (cfg.category === "SNIPER") return [0.5, 3.0, 0.0]; // bolt-action: brass straight up
  if (cfg.category === "SHOTGUN") return [0.8, 1.2, -0.5];
  return [1.8, 2.2, -0.3]; // rifle/SMG/LMG
}

/**
 * Prompt 259 — shell casing world physics. Spent casings persist on the ground
 * for the match. Cap the active casing count to avoid perf issues.
 */
export const MAX_ACTIVE_CASINGS = 64;
export const CASING_DESPAWN_SEC = 30;

/**
 * Prompt 260 — magazine drop physics on reload. The mag detaches + falls to
 * the ground. Cap the active dropped-mag count.
 */
export const MAX_ACTIVE_DROPPED_MAGS = 8;
export const DROPPED_MAG_DESPAWN_SEC = 10;

/**
 * Prompt 261 — charging handle / slide rack animation duration per shot for
 * semi-auto weapons. Returns ms.
 */
export function chargingHandleAnimMs(weapon: WeaponType): number {
  const cfg = WEAPONS[weapon];
  if (!cfg) return 120;
  if (cfg.category === "SNIPER") return 600; // bolt-action: long cycle
  if (cfg.category === "PISTOL") return 80;
  if (cfg.category === "SHOTGUN") return 400; // pump action
  return 120; // rifle/SMG/LMG
}

/**
 * Prompt 262 — bolt hold-open on last round. Weapons that support it lock the
 * bolt back after the last round; reload releases it.
 */
export const BOLT_HOLD_OPEN_WEAPONS: ReadonlySet<WeaponType> = new Set<WeaponType>([
  "m4", "hk416", "scarh", "mk17", "mk14", "aug", "famas", "ak74", "galil",
  "mp7", "p90", "mp5", "ump45", "vector", "pp90m1",
  "usp", "glock18", "m1911",
] as WeaponType[]);

/**
 * Prompt 263 — bolt release animation duration (ms) on reload-from-empty.
 */
export const BOLT_RELEASE_ANIM_MS = 200;

/**
 * Prompt 264 — hammer/striker visible cocking on single-action weapons.
 * Returns true if the weapon has a visible hammer (1911, revolvers).
 */
export function hasVisibleHammer(weapon: WeaponType): boolean {
  return weapon === "m1911" || weapon === "revolver" || weapon === "kar98k";
}

/**
 * Prompt 265 — safety switch animation duration (ms) on weapon swap.
 */
export const SAFETY_SWITCH_ANIM_MS = 150;

/**
 * Prompt 266 — brass-to-face animation probability (rare cosmetic).
 */
export const BRASS_TO_FACE_PROBABILITY = 0.02; // 2% of ejections

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 267–269 — weapon weight affecting movement/jump/slide.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 267 — movement speed multiplier based on weapon weight. Heavier
 * weapons slow the player.
 */
export function weaponMoveSpeedMult(weapon: WeaponType): number {
  const cfg = WEAPONS[weapon];
  if (!cfg) return 1.0;
  const baseByCat: Record<WeaponCategory, number> = {
    PISTOL: 1.05, SMG: 1.02, RIFLE: 1.0, SHOTGUN: 0.98, SNIPER: 0.97, LMG: 0.88,
  };
  return baseByCat[cfg.category] ?? 1.0;
}

/** Prompt 268 — jump height multiplier based on weapon weight. */
export function weaponJumpHeightMult(weapon: WeaponType): number {
  const cfg = WEAPONS[weapon];
  if (!cfg) return 1.0;
  const baseByCat: Record<WeaponCategory, number> = {
    PISTOL: 1.0, SMG: 1.0, RIFLE: 0.98, SHOTGUN: 0.95, SNIPER: 0.94, LMG: 0.85,
  };
  return baseByCat[cfg.category] ?? 1.0;
}

/** Prompt 269 — slide distance multiplier based on weapon weight. */
export function weaponSlideDistMult(weapon: WeaponType): number {
  const cfg = WEAPONS[weapon];
  if (!cfg) return 1.0;
  const baseByCat: Record<WeaponCategory, number> = {
    PISTOL: 1.1, SMG: 1.05, RIFLE: 1.0, SHOTGUN: 0.95, SNIPER: 0.92, LMG: 0.80,
  };
  return baseByCat[cfg.category] ?? 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 270–276 — carry limit, weapon throw/pickup, case drops, ammo resupply,
// ammo matching, shared ammo pool.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 270 — two-weapon carry limit + sidearm slot. Player carries:
 *   - 1 primary (rifle/SMG/shotgun/sniper/LMG)
 *   - 1 secondary (pistol or alternative primary)
 *   - 1 sidearm (pistol)
 */
export const CARRY_SLOTS = ["primary", "secondary", "sidearm", "melee", "utility"] as const;

/** Carry slot type (per #270). */
export type CarrySlot = typeof CARRY_SLOTS[number];

/**
 * Prompt 270 — can a weapon be equipped in the given carry slot? Enforces
 * the two-weapon + sidearm limit: primary holds rifles/SMGs/shotguns/snipers/
 * LMGs; secondary holds a second primary OR a pistol; sidearm holds a pistol.
 */
export function canEquipInSlot(weapon: WeaponType, slot: CarrySlot): boolean {
  const cfg = WEAPONS[weapon];
  if (!cfg) return false;
  const isPistol = cfg.category === "PISTOL";
  switch (slot) {
    case "primary":   return !isPistol;                       // any non-pistol
    case "secondary": return true;                            // any weapon (second primary OR alt pistol)
    case "sidearm":   return isPistol;                        // pistol only
    case "melee":     return false;                           // melee slot is separate
    case "utility":   return false;                           // grenade/utility slot
    default:          return false;
  }
}

/** Prompt 271 — dropped weapon entity. */
export interface DroppedWeapon {
  weapon: WeaponType;
  pos: import("three").Vector3;
  /** Reserve ammo in the dropped weapon's mag. */
  reserveAmmo: number;
  /** Time until despawn (seconds). */
  despawnSec: number;
}

/**
 * Prompt 271 — spawn a dropped weapon on death. The weapon retains its
 * reserve ammo so the picker-up gets the ammo too (per #272).
 * Default despawn is 30 seconds (long enough to be looted mid-match).
 */
export function dropWeaponOnDeath(
  weapon: WeaponType,
  pos: import("three").Vector3,
  reserveAmmo: number,
  despawnSec: number = 30,
): DroppedWeapon {
  return { weapon, pos: pos.clone(), reserveAmmo, despawnSec };
}

/**
 * Prompt 272 — pickup a dropped weapon. The picker inherits the dropped
 * weapon's reserve ammo (per spec). Returns the new (weapon, reserveAmmo)
 * tuple for the picker's loadout. Also enforces #275 ammo-type matching: if
 * the dropped weapon's ammo doesn't match the picker's slot's caliber, the
 * reserve is dropped to 0 (the picker gets the gun but must find ammo).
 */
export function pickupDroppedWeapon(
  dropped: DroppedWeapon,
  currentSlotWeapon: WeaponType | null,
): { weapon: WeaponType; reserveAmmo: number } {
  // If the current slot has a weapon that doesn't share ammo, the reserve is 0.
  if (currentSlotWeapon && !ammoTypeMatches(currentSlotWeapon, dropped.weapon)) {
    return { weapon: dropped.weapon, reserveAmmo: 0 };
  }
  return { weapon: dropped.weapon, reserveAmmo: dropped.reserveAmmo };
}

/** Prompt 273 — weapon case delivery crate. */
export interface WeaponCase {
  pos: import("three").Vector3;
  /** Weapons inside the case. */
  weapons: WeaponType[];
  /** True once opened. */
  opened: boolean;
}

/**
 * Prompt 273 — spawn a weapon case at a position. Cases contain 2-3 random
 * weapons from the catalog. Per spec, cases spawn periodically mid-match.
 */
export function spawnWeaponCase(
  pos: import("three").Vector3,
  weapons: WeaponType[],
): WeaponCase {
  return { pos: pos.clone(), weapons: [...weapons], opened: false };
}

/**
 * Prompt 273 — open a weapon case. Returns the weapons inside + marks opened.
 * The caller (PickupSystem) drops them as DroppedWeapon entities for pickup.
 */
export function openWeaponCase(wc: WeaponCase): WeaponType[] {
  if (wc.opened) return [];
  wc.opened = true;
  return wc.weapons;
}

/** Prompt 274 — ammo resupply from crates. Returns the amount to add to reserve. */
export function ammoResupplyAmount(weapon: WeaponType): number {
  const cfg = WEAPONS[weapon];
  if (!cfg) return 30;
  return cfg.magSize * 2;
}

/**
 * Prompt 275 — ammo type matching. Can't pick up 9mm for a 5.56 weapon.
 * Returns true if the ammo types match.
 */
export function ammoTypeMatches(weaponA: WeaponType, weaponB: WeaponType): boolean {
  // Each weapon has a category-derived ammo type. Weapons in the same category
  // share ammo (with exceptions — see SHARED_AMMO_POOL).
  const cfgA = WEAPONS[weaponA];
  const cfgB = WEAPONS[weaponB];
  if (!cfgA || !cfgB) return false;
  return cfgA.category === cfgB.category;
}

/**
 * Prompt 276 — shared ammo pool for weapons of the same caliber. Two 5.56
 * weapons share the reserve ammo. Returns the shared-ammo group key.
 */
export function sharedAmmoGroup(weapon: WeaponType): string {
  // Group by cartridge, not category (5.45 AK + 5.45 RPK share; 5.56 M4 + 7.62 SCAR-H don't).
  const cartridgeByWeapon: Partial<Record<WeaponType, string>> = {
    ak74: "5.45x39", rpk: "5.45x39",
    m4: "5.56x45", hk416: "5.56x45", famas: "5.56x45", aug: "5.56x45", galil: "5.56x45", m249: "5.56x45",
    scarh: "7.62x51", mk17: "7.62x51", mk14: "7.62x51", mk48: "7.62x51", scout: "7.62x51",
    awp: "338lapua", l115a3: "338lapua",
    kar98k: "7.92x57",
    mp7: "4.6x30", p90: "5.7x28",
    mp5: "9x19", ump45: "45acp", vector: "45acp", pp90m1: "9x19",
    usp: "45acp", deagle: "50ae", glock18: "9x19", m1911: "45acp", revolver: "50cal",
    nova: "12ga", m1014: "12ga", spas12: "12ga",
  };
  return cartridgeByWeapon[weapon] ?? weapon;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 277–280 — ammo loadouts (tracer-only, incendiary shotgun, slug, buckshot).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 277 — tracer-only ammo loadout. Every round is a tracer (meme loadout).
 * The ParticleSystem renders every shot as a bright tracer.
 */
export function isTracerOnlyLoadout(ammoType: AmmoTypeSlug): boolean {
  return ammoType === "tracer";
}

/**
 * Prompt 278 — incendiary ammo for shotguns (dragon's breath). Sets targets
 * on fire. Returns the fire-zone duration for a hit.
 */
export function dragonsBreathFireDurationSec(): number {
  return 3.0; // 3s of fire per hit
}

/** Prompt 279 — shotgun ammo types. */
export type ShotgunAmmoType = "buckshot" | "birdshot" | "slug";

export interface ShotgunAmmoStats {
  /** Pellet count (buckshot=8, birdshot=20, slug=1). */
  pelletCount: number;
  /** Per-pellet damage multiplier. */
  damageMult: number;
  /** Spread multiplier (slug=0.1, buckshot=1.0, birdshot=1.5). */
  spreadMult: number;
  /** Range multiplier (slug=2.0, buckshot=1.0, birdshot=0.5). */
  rangeMult: number;
}

export const SHOTGUN_AMMO_STATS: Record<ShotgunAmmoType, ShotgunAmmoStats> = {
  buckshot: { pelletCount: 8,  damageMult: 1.0,  spreadMult: 1.0,  rangeMult: 1.0 },
  birdshot: { pelletCount: 20, damageMult: 0.4,  spreadMult: 1.5,  rangeMult: 0.5 },
  slug:     { pelletCount: 1,  damageMult: 2.5,  spreadMult: 0.1,  rangeMult: 2.0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 281–283 — shotgun pellet pattern + count + choke.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 281 — fixed 8-pellet pattern with slight jitter. The pattern is
 * reproducible + readable (not random). Returns the 8 (x, y) spread offsets
 * for the pellets.
 */
export const FIXED_PELLET_PATTERN_8: Array<[number, number]> = [
  [ 0.00,  0.00],
  [ 0.10,  0.05],
  [-0.10,  0.05],
  [ 0.05, -0.10],
  [-0.05, -0.10],
  [ 0.15, -0.05],
  [-0.15, -0.05],
  [ 0.00,  0.15],
];

/**
 * Prompt 282 — per-weapon pellet count (m1014=8, sawed-off=6, saiga=10).
 */
export function shotgunPelletCount(weapon: WeaponType): number {
  if (weapon === "nova") return 8;
  if (weapon === "m1014") return 8;
  if (weapon === "spas12") return 9;
  return 8; // default
}

/**
 * Prompt 283 — shotgun choke variants. Full = tightest spread, improved
 * cylinder = widest.
 */
export type ShotgunChoke = "full" | "modified" | "improved_cylinder";

export function chokeSpreadMult(choke: ShotgunChoke): number {
  switch (choke) {
    case "full":               return 0.5;
    case "modified":           return 0.75;
    case "improved_cylinder":  return 1.0;
    default:                   return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 284–285 — LMG overheat + belt visualization.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 284 — LMG overheat. Sustained fire heats the barrel (uses the existing
 * barrelHeat). At heat=1.0, the LMG cook-offs (next shot fires automatically).
 * Returns true if a cook-off should trigger.
 */
export function shouldCookOff(barrelHeat: number, isFiring: boolean): boolean {
  return barrelHeat >= 1.0 && isFiring;
}

/**
 * Prompt 285 — LMG belt visualization. The visible belt length = remaining
 * ammo. Returns the belt-length multiplier (1.0 = full belt, 0.0 = empty).
 */
export function lmgBeltLengthMult(currentAmmo: number, magSize: number): number {
  if (magSize <= 0) return 0;
  return Math.max(0, currentAmmo / magSize);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 287–292 — sniper bolt cycle, pistol slide lock, akimbo, revolver reloads.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 287 — sniper bolt cycle animation duration (ms). */
export function sniperBoltCycleMs(weapon: WeaponType): number {
  if (weapon === "awp") return 800;
  if (weapon === "l115a3") return 900;
  if (weapon === "kar98k") return 850;
  if (weapon === "scout") return 600; // faster bolt throw
  return 700;
}

/** Prompt 288 — pistol slide lock on last round. Returns true if the weapon
 *  locks the slide back on the last round. */
export function pistolSlideLockOnLastRound(weapon: WeaponType): boolean {
  const cfg = WEAPONS[weapon];
  if (!cfg) return false;
  if (cfg.category !== "PISTOL") return false;
  // Revolvers don't lock open (no slide).
  if (weapon === "revolver") return false;
  return true;
}

/**
 * Prompt 289 — pistol akimbo (Akimbo perk). Two pistols fire independently.
 * Returns the fire-rate multiplier (akimbo = 2× because two guns fire).
 */
export function akimboFireRateMult(isAkimbo: boolean): number {
  return isAkimbo ? 2.0 : 1.0;
}

/** Prompt 290 — revolver speed-loader reload (faster than single-round). */
export function revolverSpeedLoaderReloadMs(): number {
  return 1500; // 1.5s vs 3.5s for single-round
}

/** Prompt 291 — revolver single-round reload (slow, for realism mode). */
export function revolverSingleRoundReloadMs(): number {
  return 3500; // 3.5s — 6 rounds at ~0.5s each
}

/** Prompt 292 — revolver cylinder spin on inspect (cosmetic). Returns the
 *  spin duration (ms) for the inspect animation. */
export function revolverCylinderSpinMs(): number {
  return 800;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 294–299 — weapon condition, kill/headshot/accuracy trackers,
// daily challenges, mastery camos.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 294 — weapon condition (cosmetic wear based on total rounds fired
 * across matches). Returns the wear tier.
 */
export function weaponConditionTier(totalRoundsFired: number): WearTier {
  if (totalRoundsFired >= 50000) return "battle_scarred";
  if (totalRoundsFired >= 20000) return "well_worn";
  if (totalRoundsFired >= 5000)  return "field_tested";
  if (totalRoundsFired >= 1000)  return "minimal_wear";
  return "factory_new";
}

/** Prompts 295–297 — per-weapon trackers. */
export interface WeaponTracker {
  kills: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
}

/** Prompt 295 — record a kill. */
export function recordKill(tracker: WeaponTracker): void {
  tracker.kills++;
}

/** Prompt 296 — record a headshot. */
export function recordHeadshot(tracker: WeaponTracker): void {
  tracker.headshots++;
}

/** Prompt 297 — record a shot (hit or miss). */
export function recordShot(tracker: WeaponTracker, hit: boolean): void {
  tracker.shotsFired++;
  if (hit) tracker.shotsHit++;
}

/** Prompt 297 — compute the accuracy percentage. */
export function weaponAccuracy(tracker: WeaponTracker): number {
  if (tracker.shotsFired === 0) return 0;
  return (tracker.shotsHit / tracker.shotsFired) * 100;
}

/** Prompt 298 — daily weapon challenge. */
export interface WeaponDailyChallenge {
  weapon: WeaponType;
  goal: "kills" | "headshots" | "accuracy";
  target: number;
  progress: number;
  reward: { xp: number; credits: number };
}

/** Prompt 298 — check if a daily challenge is complete. */
export function isDailyChallengeComplete(challenge: WeaponDailyChallenge): boolean {
  return challenge.progress >= challenge.target;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 300 — feel-pass template per docs/GUNPLAY-AUDIT.md #125.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 300 — per-weapon "feel card" for the feel pass. */
export interface WeaponFeelCard {
  weapon: WeaponType;
  /** TTK against a 100 HP target (seconds). */
  ttk: number;
  /** "Lethality" — how fast the weapon drops a target (0..1, 1 = instakill). */
  lethality: number;
  /** "Controllability" — how easy the recoil is to manage (0..1, 1 = laser). */
  controllability: number;
  /** "Mobility" — how much the weapon affects movement (0..1, 1 = no penalty). */
  mobility: number;
  /** "Feel score" — composite. */
  feelScore: number;
}

/** Prompt 300 — compute the feel card for a weapon. */
export function computeFeelCard(weapon: WeaponType): WeaponFeelCard {
  const cfg = WEAPONS[weapon];
  if (!cfg) {
    return { weapon, ttk: 1, lethality: 0, controllability: 0, mobility: 0, feelScore: 0 };
  }
  const dps = cfg.damage / (cfg.fireRate / 1000);
  const ttk = 100 / dps;
  const lethality = Math.max(0, Math.min(1, 1 - ttk / 2)); // 1 if instakill, 0 if 2s TTK
  const controllability = Math.max(0, Math.min(1, 1 - cfg.recoil / 5));
  const mobility = weaponMoveSpeedMult(weapon);
  // Composite feel score: 40% lethality, 30% controllability, 30% mobility.
  const feelScore = lethality * 0.4 + controllability * 0.3 + mobility * 0.3;
  return { weapon, ttk, lethality, controllability, mobility, feelScore };
}

/**
 * Prompt 300 — rank all weapons by feel score. Returns the top 3 + bottom 3
 * for the tuning pass.
 */
export function rankWeaponsByFeel(): {
  top3: WeaponFeelCard[];
  bottom3: WeaponFeelCard[];
  all: WeaponFeelCard[];
} {
  const all = Object.keys(WEAPONS)
    .map((w) => computeFeelCard(w as WeaponType))
    .sort((a, b) => b.feelScore - a.feelScore);
  return {
    top3: all.slice(0, 3),
    bottom3: all.slice(-3).reverse(),
    all,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 158, 175 — weapon weight affecting ADS + see-through mags.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 158 — weapon weight affecting ADS transition speed. Scale the base
 * ADS tau by a per-weapon weight factor. AWP is slow, pistol is fast.
 */
export function weaponWeightAdsTauMult(weapon: WeaponType): number {
  const cfg = WEAPONS[weapon];
  if (!cfg) return 1.0;
  const baseByCat: Record<WeaponCategory, number> = {
    PISTOL: 0.6,  // fast ADS
    SMG: 0.8,
    RIFLE: 1.0,
    SHOTGUN: 1.1,
    SNIPER: 1.6,  // slow ADS
    LMG: 1.8,     // slowest ADS
  };
  return baseByCat[cfg.category] ?? 1.0;
}

/**
 * Prompt 175 — see-through mags for ALL skins (not just tactical/chrome).
 * Returns true if the weapon should render its mag with see-through ammo
 * visibility. Default: true (per the spec — every weapon shows round count
 * through the mag).
 */
export function hasSeeThroughMag(_weapon: WeaponType): boolean {
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 159, 176–181 — WeaponSystem reload mechanics.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 159 — fire-rate cap bypass on rapid weapon swap. The fire-rate gate
 * should be weapon-instance-scoped, not player-scoped. Returns the key to use
 * for the per-weapon lastShotTime map.
 */
export function fireRateGateKey(weapon: WeaponType, slot: string): string {
  return `${weapon}:${slot}`;
}

/**
 * Prompt 177 — reload-from-partial vs reload-from-empty. Empty reload takes
 * longer (chamber round needed).
 */
export function reloadTimeMs(
  weapon: WeaponType,
  isEmpty: boolean,
  staminaRatio: number = 1.0,
  hpRatio: number = 1.0,
): number {
  const cfg = WEAPONS[weapon];
  if (!cfg) return 2000;
  // Base reload time from the weapon config.
  let base = cfg.reloadTime;
  // Empty reload adds a chamber beat (~400ms).
  if (isEmpty) base += 400;
  // Prompt 178 — stamina coupling. Low stamina = 1.2× reload time.
  const staminaMult = 1 + (1 - Math.max(0, Math.min(1, staminaRatio))) * 0.2;
  base *= staminaMult;
  // Prompt 179 — injury coupling. Below 40% HP, 1.3× slower + chance to fumble.
  if (hpRatio < 0.4) {
    base *= 1.3;
  }
  return base;
}

/**
 * Prompt 179 — reload fumble chance. Below 40% HP, chance to fumble (drop mag).
 * Returns true if the reload fumbles.
 */
export function shouldReloadFumble(hpRatio: number): boolean {
  if (hpRatio >= 0.4) return false;
  // 15% fumble chance below 40% HP.
  return Math.random() < 0.15;
}

/** Prompt 180 — tactical vs speed reload (hold vs tap R). */
export type ReloadType = "tactical" | "speed";

export interface ReloadTypeStats {
  /** Multiplier on the base reload time. */
  timeMult: number;
  /** True if the mag is retained (tactical = retained, speed = dropped). */
  retainsMag: boolean;
}

export const RELOAD_TYPE_STATS: Record<ReloadType, ReloadTypeStats> = {
  tactical: { timeMult: 1.0,  retainsMag: true  }, // slower, retains mag
  speed:    { timeMult: 0.7,  retainsMag: false }, // faster, drops mag (loses spare)
};

/** Prompt 181 — check-ammo hold duration (ms) before triggering the check anim. */
export const CHECK_AMMO_HOLD_MS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// B1-5000 — Prompts 651 (visible-round mag geometry per weapon), 653 (mag drop
// audio per surface), 656 (shell casing audio on ejection + bounce), 678
// (reload progress HUD — already wired via pushHud({reloadProgress})),
// 679 (reload completion audio cue), 680 (reload failure on low stamina +
// injury — already covered by shouldReloadFumble).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 651 — per-weapon visible-round mag geometry spec. Each weapon's mag
 * has a distinct bullet-mesh layout the viewmodel renders when the mag is
 * see-through (per #175). Returns the geometry parameters the viewmodel uses
 * to build the bullet stack inside the mag.
 */
export interface MagVisibleRoundGeometry {
  /** Weapon slug. */
  slug: WeaponType;
  /** Number of visible rounds rendered in the mag (capped for perf). */
  visibleRounds: number;
  /** Round spacing (m) — vertical distance between rounds in the stack. */
  roundSpacing: number;
  /** Round radius (m) — for the cylindrical bullet mesh. */
  roundRadius: number;
  /** Round length (m) — for the cylindrical bullet mesh. */
  roundLength: number;
  /** Mag orientation — "vertical" (rifle/SMG), "horizontal" (pistol), "drum" (LMG). */
  magOrientation: "vertical" | "horizontal" | "drum";
}

/** Per-weapon mag visible-round geometry. Tuned to approximate the real mag
 *  shape (vertical stick for rifles, horizontal stick for pistols, drum for
 *  LMGs with high-capacity belts). */
export const MAG_VISIBLE_ROUND_GEOMETRY: Partial<Record<WeaponType, MagVisibleRoundGeometry>> = {
  // ── RIFLES (vertical stick mags) ──
  ak74:    { slug: "ak74",    visibleRounds: 5, roundSpacing: 0.022, roundRadius: 0.0055, roundLength: 0.030, magOrientation: "vertical" },
  m4:      { slug: "m4",      visibleRounds: 5, roundSpacing: 0.022, roundRadius: 0.0050, roundLength: 0.030, magOrientation: "vertical" },
  hk416:   { slug: "hk416",   visibleRounds: 5, roundSpacing: 0.022, roundRadius: 0.0050, roundLength: 0.030, magOrientation: "vertical" },
  famas:   { slug: "famas",   visibleRounds: 5, roundSpacing: 0.022, roundRadius: 0.0050, roundLength: 0.030, magOrientation: "vertical" },
  aug:     { slug: "aug",     visibleRounds: 5, roundSpacing: 0.022, roundRadius: 0.0050, roundLength: 0.028, magOrientation: "vertical" },
  scarh:   { slug: "scarh",   visibleRounds: 5, roundSpacing: 0.025, roundRadius: 0.0060, roundLength: 0.035, magOrientation: "vertical" },
  galil:   { slug: "galil",   visibleRounds: 5, roundSpacing: 0.022, roundRadius: 0.0055, roundLength: 0.030, magOrientation: "vertical" },
  mk17:    { slug: "mk17",    visibleRounds: 5, roundSpacing: 0.025, roundRadius: 0.0060, roundLength: 0.035, magOrientation: "vertical" },
  mk14:    { slug: "mk14",    visibleRounds: 5, roundSpacing: 0.025, roundRadius: 0.0060, roundLength: 0.035, magOrientation: "vertical" },
  // ── SMGs (vertical or horizontal stick) ──
  mp7:     { slug: "mp7",     visibleRounds: 4, roundSpacing: 0.018, roundRadius: 0.0045, roundLength: 0.025, magOrientation: "vertical" },
  p90:     { slug: "p90",     visibleRounds: 8, roundSpacing: 0.012, roundRadius: 0.0040, roundLength: 0.022, magOrientation: "horizontal" }, // P90 box mag
  mp5:     { slug: "mp5",     visibleRounds: 4, roundSpacing: 0.018, roundRadius: 0.0048, roundLength: 0.025, magOrientation: "vertical" },
  ump45:   { slug: "ump45",   visibleRounds: 4, roundSpacing: 0.020, roundRadius: 0.0055, roundLength: 0.028, magOrientation: "vertical" },
  vector:  { slug: "vector",  visibleRounds: 4, roundSpacing: 0.020, roundRadius: 0.0055, roundLength: 0.028, magOrientation: "vertical" },
  pp90m1:  { slug: "pp90m1",  visibleRounds: 4, roundSpacing: 0.018, roundRadius: 0.0048, roundLength: 0.025, magOrientation: "vertical" },
  // ── PISTOLS (horizontal stick — magwell in the grip) ──
  usp:     { slug: "usp",     visibleRounds: 3, roundSpacing: 0.020, roundRadius: 0.0057, roundLength: 0.028, magOrientation: "horizontal" },
  deagle:  { slug: "deagle",  visibleRounds: 3, roundSpacing: 0.025, roundRadius: 0.0065, roundLength: 0.035, magOrientation: "horizontal" },
  glock18: { slug: "glock18", visibleRounds: 4, roundSpacing: 0.018, roundRadius: 0.0048, roundLength: 0.022, magOrientation: "horizontal" },
  m1911:   { slug: "m1911",   visibleRounds: 3, roundSpacing: 0.022, roundRadius: 0.0057, roundLength: 0.028, magOrientation: "horizontal" },
  revolver:{ slug: "revolver",visibleRounds: 5, roundSpacing: 0.000, roundRadius: 0.0065, roundLength: 0.030, magOrientation: "drum" }, // cylinder
  // ── SNIPERS (internal box mags, low visibility) ──
  awp:     { slug: "awp",     visibleRounds: 3, roundSpacing: 0.025, roundRadius: 0.0065, roundLength: 0.040, magOrientation: "horizontal" },
  scout:   { slug: "scout",   visibleRounds: 3, roundSpacing: 0.025, roundRadius: 0.0060, roundLength: 0.035, magOrientation: "horizontal" },
  kar98k:  { slug: "kar98k",  visibleRounds: 5, roundSpacing: 0.020, roundRadius: 0.0060, roundLength: 0.035, magOrientation: "horizontal" }, // stripper clip
  l115a3:  { slug: "l115a3",  visibleRounds: 3, roundSpacing: 0.025, roundRadius: 0.0065, roundLength: 0.040, magOrientation: "horizontal" },
  // ── SHOTGUNS (tubular) ──
  nova:    { slug: "nova",    visibleRounds: 4, roundSpacing: 0.025, roundRadius: 0.0075, roundLength: 0.045, magOrientation: "horizontal" },
  m1014:   { slug: "m1014",   visibleRounds: 4, roundSpacing: 0.025, roundRadius: 0.0075, roundLength: 0.045, magOrientation: "horizontal" },
  spas12:  { slug: "spas12",  visibleRounds: 4, roundSpacing: 0.025, roundRadius: 0.0075, roundLength: 0.045, magOrientation: "horizontal" },
  // ── LMGs (drum/belt) ──
  m249:    { slug: "m249",    visibleRounds: 8, roundSpacing: 0.022, roundRadius: 0.0050, roundLength: 0.030, magOrientation: "drum" }, // belt
  rpk:     { slug: "rpk",     visibleRounds: 8, roundSpacing: 0.022, roundRadius: 0.0055, roundLength: 0.030, magOrientation: "drum" },
  mk48:    { slug: "mk48",    visibleRounds: 8, roundSpacing: 0.025, roundRadius: 0.0060, roundLength: 0.035, magOrientation: "drum" },
};

/** Prompt 651 — get the mag visible-round geometry for a weapon. Falls back to
 *  a default vertical-stick mag for unknown weapons. */
export function getMagVisibleRoundGeometry(slug: WeaponType): MagVisibleRoundGeometry {
  return MAG_VISIBLE_ROUND_GEOMETRY[slug] ?? {
    slug,
    visibleRounds: 4,
    roundSpacing: 0.022,
    roundRadius: 0.0055,
    roundLength: 0.030,
    magOrientation: "vertical",
  };
}

/**
 * Prompt 653 — magazine drop audio per surface. The mag-dropped-on-reload
 * sound varies with the surface the mag lands on. Returns the audio slug for
 * the given surface.
 */
export function magDropAudioSlug(surface: string): string {
  switch (surface) {
    case "concrete":    return "mag_drop_concrete";
    case "wood":        return "mag_drop_wood";
    case "sheet_metal":
    case "steel_plate": return "mag_drop_metal";
    case "glass":       return "mag_drop_glass";
    case "earth":       return "mag_drop_earth";
    case "water":       return "mag_drop_water";
    case "sandbag":     return "mag_drop_sandbag";
    default:            return "mag_drop_default";
  }
}

/**
 * Prompt 656 — shell casing audio on ejection + bounce. The per-shot casing
 * ejects with a distinct "tink" sound (per-caliber), then a second "bounce"
 * sound when it hits the ground. This function returns the ejection + bounce
 * audio slugs for a weapon category.
 */
export function shellCasingAudioSlugs(category: WeaponCategory): {
  ejectionSlug: string;
  bounceSlug: string;
} {
  switch (category) {
    case "RIFLE":   return { ejectionSlug: "shell_eject_rifle",   bounceSlug: "shell_bounce_rifle" };
    case "SMG":     return { ejectionSlug: "shell_eject_smg",     bounceSlug: "shell_bounce_smg" };
    case "PISTOL":  return { ejectionSlug: "shell_eject_pistol",  bounceSlug: "shell_bounce_pistol" };
    case "SNIPER":  return { ejectionSlug: "shell_eject_sniper",  bounceSlug: "shell_bounce_sniper" };
    case "SHOTGUN": return { ejectionSlug: "shell_eject_shotgun", bounceSlug: "shell_bounce_shotgun" };
    case "LMG":     return { ejectionSlug: "shell_eject_lmg",     bounceSlug: "shell_bounce_lmg" };
    default:        return { ejectionSlug: "shell_eject_rifle",   bounceSlug: "shell_bounce_rifle" };
  }
}

/**
 * Prompt 678 — reload progress HUD update. The existing reload state machine
 * already pushes `reloadProgress` (0..1) via `ctx.pushHud({ reloadProgress })`.
 * This helper formats the reload progress for the HUD bar (returns the
 * integer percentage 0..100 for display + a flag for the "ready to fire"
 * state at 100%).
 */
export function formatReloadProgressHud(progress: number): {
  percent: number;
  readyToFire: boolean;
} {
  const clamped = Math.max(0, Math.min(1, progress));
  return {
    percent: Math.round(clamped * 100),
    readyToFire: clamped >= 1.0,
  };
}

/**
 * Prompt 679 — reload completion audio cue. Plays a distinct "mag seated" /
 * "bolt release" sound when the reload completes. Returns the audio slug for
 * the engine to play. The slug depends on whether the reload was from empty
 * (bolt-release sound) or partial (mag-seat click).
 */
export function reloadCompletionAudioSlug(
  weapon: WeaponType,
  isEmptyReload: boolean,
): string {
  if (isEmptyReload) {
    // Empty reload → bolt release / chamber round.
    return `bolt_release_${weapon}`;
  }
  // Partial reload → mag-seat click.
  return `mag_seat_${weapon}`;
}

/**
 * Prompt 680 — reload failure (drop mag) on low stamina + injury. The existing
 * `shouldReloadFumble` covers the HP-side fumble; this adds a stamina-side
 * fumble check. Returns true if the reload should fail (drop the mag) due to
 * low stamina + low HP combined.
 *
 * The fumble chance scales with both stamina + HP deficits — a player at 0%
 * stamina + 20% HP has a ~25% fumble chance; a player at 50% stamina + 50%
 * HP has a ~5% fumble chance. Below 40% HP, the existing shouldReloadFumble
 * path (15% chance) applies; this method layers an additional stamina check.
 */
export function shouldReloadFumbleStamina(
  staminaRatio: number,
  hpRatio: number,
): boolean {
  // Only fumble when both stamina + HP are low.
  if (staminaRatio > 0.3 || hpRatio > 0.4) return false;
  // Chance scales with the combined deficit. 0.25 at (0,0), 0 at (0.3, 0.4).
  const staminaDeficit = 1 - Math.max(0, Math.min(1, staminaRatio)) / 0.3;
  const hpDeficit = 1 - Math.max(0, Math.min(1, hpRatio)) / 0.4;
  const combined = (staminaDeficit + hpDeficit) / 2;
  const chance = combined * 0.25;
  return Math.random() < chance;
}
