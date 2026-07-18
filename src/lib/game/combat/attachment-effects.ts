/**
 * Section B (B3-5000) — attachment effects extension module.
 *
 * Implements prompts 938–1000 (lines 1902–2027 of `5000-IMPROVEMENT-PROMPTS.md`)
 * covering the granular "weapon attachment affect on X" prompts. Each prompt
 * asks for an explicit attachment-driven effect on a single game feel/stat
 * (recoil, spread, damage, range, penetration, tracer visibility, suppressor
 * wear, scope glint/zoom/sway/hold-breath, bipod deploy, laser visibility,
 * flashlight, foregrip recoil, magazine size/reload/type, fire mode/rate,
 * sound/flash/muzzle climb/horizontal recoil/first-shot recoil/recovery/bloom,
 * ADS/hipfire/moving/jump/slide/prone/crouch/lean spread, stamina drain, sway,
 * hold-breath duration, aim assist, scope sensitivity, crosshair, HUD, killcam,
 * minimap, AI detection/suppression, bullet velocity/drop/wind drift/penetration/
 * ricochet/fragmentation/overpenetration, headshot/limb/armor/vehicle/shield/
 * boss/elite/zombie/environmental damage).
 *
 * Most of the underlying tables already exist:
 *   - `sectionB.ts:FOREGRIP_STATS` / `MUZZLE_STATS` / `OPTIC_STATS` /
 *     `AMMO_TYPE_STATS` / `MAGAZINE_STATS` / `FIRE_MODE_STATS` (prior 1000-prompt
 *     mission §B2-weapons-226-300).
 *   - `weapon-depth.ts:attachmentReloadSpeedMod` / `attachmentAdsSpeedMod` /
 *     `attachmentMoveSpeedMod` / `attachmentSwapSpeedMod` (B2-5000 #934–#937).
 *   - `Ballistics.ts:WEAPON_TRACER_COLORS` + `getWeaponTracerColor` (per-weapon
 *     tracer color — overlaps with #1011 ammo-trail-color but distinct).
 *
 * This module adds:
 *   1. A unified `AttachmentEffectLoadout` shape (muzzle + sight + grip +
 *      magazine + ammo + barrel + stock + bipod + laser + flashlight +
 *      fire-mode + bolt) so a single helper can compute every affect from
 *      one input.
 *   2. A `ATTACHMENT_EFFECTS` table that augments the existing tables with
 *      new fields not yet covered (barrel length, bolt weight, suppressor
 *      wear rate, scope sway, hold-breath duration, bipod, laser visibility,
 *      flashlight, first-shot recoil, recovery, bloom, stance spreads, stamina,
 *      sway, aim assist, scope sensitivity, crosshair, HUD, killcam, minimap,
 *      AI detection, AI suppression, bullet velocity/drop/wind-drift/ricochet/
 *      fragmentation/overpenetration, headshot/limb/armor/vehicle/shield/boss/
 *      elite/zombie/environmental damage).
 *   3. A pure helper per prompt (938–1000) that returns the multiplier/effect
 *      for a given loadout. Engine integration: call these helpers from the
 *      relevant system (WeaponSystem for damage/spread/recoil, Ballistics for
 *      velocity/drop/wind, AIEnhancements for detection/suppression, HudSystem
 *      for HUD/killcam/minimap).
 *
 * Pure data + helpers. No engine wiring (engine-wiring territory is the B1
 * ownership of WeaponSystem.ts/Ballistics.ts/etc.).
 *
 * Marker block — search `B3-5000 #NNNN` to find each prompt's helper:
 *   #938 attachmentRecoilMult        (cross-ref #610, foregrip/muzzle vertical+horizontal)
 *   #939 attachmentSpreadMult        (foregrip less, heavy scope more)
 *   #940 attachmentDamageMult        (HP ammo +40%, AP -20%)
 *   #941 attachmentRangeMult         (longer barrel +range, suppressor -range)
 *   #942 attachmentPenetrationMult   (AP ammo +80%, HP -70%)
 *   #943 attachmentTracerVisibility  (tracer ammo every round, subsonic dim)
 *   #944 attachmentSuppressorWear    (rounds-fired × wear-rate per muzzle)
 *   #945 attachmentScopeGlint        (8x+ scope glints; suppressor hides muzzle flash not glint)
 *   #946 attachmentScopeZoom        (scope4x=4, scope8x=8, scope12x=12)
 *   #947 attachmentScopeSwayMult    (heavy scope +sway, bipod -sway)
 *   #948 attachmentHoldBreathMult   (lighter scope +duration, heavy -duration)
 *   #949 attachmentBipodDeploy      (bipod attachment enables auto-deploy)
 *   #950 attachmentLaserVisibility  (laser sight visible to enemies when on)
 *   #951 attachmentFlashlight       (flashlight beam visible)
 *   #952 attachmentForegripRecoil   (vertical=best, angled=medium)
 *   #953 attachmentMagSizeMult      (ext 1.5×, drum 3×)
 *   #954 attachmentReloadSpeedMult  (ext 1.15×, drum 1.4×, quick 0.75×)
 *   #955 attachmentMagazineType     (default/extended/drum/quick_mag)
 *   #956 attachmentFireMode         (burst trigger for burst weapons)
 *   #957 attachmentFireRateMult     (lighter bolt +fire rate)
 *   #958 attachmentSoundMult        (suppressor 0.4×, muzzle_brake 1.05×)
 *   #959 attachmentFlashMult        (flash_hider 0.3×, suppressor 0×)
 *   #960 attachmentMuzzleClimbMult  (compensator less climb)
 *   #961 attachmentHorizontalRecoil (compensator 0.7×)
 *   #962 attachmentFirstShotRecoil  (muzzle_brake -first-shot kick)
 *   #963 attachmentRecoveryMult     (foregrip faster recovery)
 *   #964 attachmentBloomMult        (foregrip less bloom)
 *   #965 attachmentAdsSpreadMult    (laser tighter ADS)
 *   #966 attachmentHipfireSpread    (laser + stubby tighter hip)
 *   #967 attachmentMovingSpread     (foregrip less moving spread)
 *   #968 attachmentJumpSpread       (lighter weapon less jump spread)
 *   #969 attachmentSlideSpread      (lighter weapon less slide spread)
 *   #970 attachmentProneSpread      (bipod prone = tightest)
 *   #971 attachmentCrouchSpread     (foregrip crouch tighter)
 *   #972 attachmentLeanSpread       (foregrip lean tighter)
 *   #973 attachmentStaminaDrain     (heavier attachments more drain)
 *   #974 attachmentSwayMult         (heavier attachments more sway)
 *   #975 attachmentHoldBreathDur    (lighter attachments longer breath)
 *   #976 attachmentAimAssistMult    (laser sight +aim assist)
 *   #977 attachmentScopeSensitivity (high zoom = lower sensitivity)
 *   #978 attachmentCrosshairAddDot  (laser adds center dot)
 *   #979 attachmentHudShowRounds    (extended mag shows remaining rounds)
 *   #980 attachmentKillcamHidden    (suppressor hides victim killcam)
 *   #981 attachmentMinimapHidden    (suppressor hides shooter minimap dot)
 *   #982 attachmentAiDetectionMult  (suppressor harder to detect)
 *   #983 attachmentAiSuppressionMult (suppressor less suppression)
 *   #984 attachmentBulletVelocity   (longer barrel +velocity, suppressor -velocity)
 *   #985 attachmentBulletDrop       (subsonic +drop, AP -drop)
 *   #986 attachmentWindDrift        (lighter bullet +drift)
 *   #987 attachmentPenetrationMult2 (AP more penetration — alias of #942)
 *   #988 attachmentRicochetMult     (HP less ricochet, AP more)
 *   #989 attachmentFragmentationMult (HP more fragmentation)
 *   #990 attachmentOverpenetration  (FMJ more overpenetration)
 *   #991 attachmentHeadshotMult     (HP +headshot)
 *   #992 attachmentLimbMult         (FMJ less limb penalty)
 *   #993 attachmentArmorPenMult     (AP more armor pen — alias of #942)
 *   #994 attachmentArmorDamage      (HP more armor damage)
 *   #995 attachmentVehicleDamage    (AP more vehicle damage)
 *   #996 attachmentShieldDamage     (AP more shield damage)
 *   #997 attachmentBossDamage       (AP more boss damage)
 *   #998 attachmentEliteDamage      (AP more elite damage)
 *   #999 attachmentZombieDamage     (HP more zombie damage)
 *   #1000 attachmentEnvironmentalDamage (incendiary +enviro: barrels/doors)
 */

import type { WeaponType } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Unified attachment-effect loadout shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * B3-5000 #938–#1000 — the complete attachment loadout used by every
 * attachment-effect helper. All fields are string-typed (loose union) so the
 * engine can pass through whatever slugs the loadout UI produces without a
 * type-cast at every call-site. Helpers fall back to neutral ("none" / "fmj"
 * / "default") when an unknown slug arrives.
 */
export interface AttachmentEffectLoadout {
  /** Muzzle device — "none" | "suppressor" | "flash_hider" | "compensator" | "muzzle_brake". */
  muzzle: string;
  /** Optic/sight — "none" | "red_dot" | "holo" | "acog" | "scope4x" | "scope8x" | "scope12x". */
  sight: string;
  /** Foregrip — "none" | "vertical" | "angled" | "stubby". */
  grip: string;
  /** Magazine — "default" | "extended" | "drum" | "quick_mag". */
  magazine: string;
  /** Ammo type — "fmj" | "hp" | "ap" | "subsonic" | "tracer" | "incendiary". */
  ammo: string;
  /** Barrel length variant — "short" | "standard" | "long" | "suppressed".
   *  "suppressed" overlaps with muzzle="suppressor" but is tracked separately
   *  because internal-suppressor weapons (e.g. MP5-SD) don't show a muzzle
   *  attachment but still get the velocity/sound penalties. */
  barrel: string;
  /** Stock — "default" | "lightweight" | "heavy" | "collapsible". */
  stock: string;
  /** Bipod — "none" | "folding" | "deployable". */
  bipod: string;
  /** Laser sight — "none" | "visible" | "ir". */
  laser: string;
  /** Flashlight — "none" | "steady" | "strobe". */
  flashlight: string;
  /** Bolt carrier group — "default" | "lightweight" | "heavy". */
  bolt: string;
}

/** Sensible default loadout — every attachment is "none" / "fmj" / "standard".
 *  Returned by `attachmentEffectLoadoutFromUnknown()` when the engine passes
 *  a partial/undefined loadout (the legacy single-weapon-config path). */
export const DEFAULT_ATTACHMENT_EFFECT_LOADOUT: AttachmentEffectLoadout = {
  muzzle: "none", sight: "none", grip: "none", magazine: "default",
  ammo: "fmj", barrel: "standard", stock: "default", bipod: "none",
  laser: "none", flashlight: "none", bolt: "default",
};

/** Coerce a partial/unknown loadout into a full AttachmentEffectLoadout.
 *  Missing fields fall back to the neutral default. */
export function attachmentEffectLoadoutFromUnknown(
  partial: Partial<AttachmentEffectLoadout> | undefined | null,
): AttachmentEffectLoadout {
  if (!partial) return { ...DEFAULT_ATTACHMENT_EFFECT_LOADOUT };
  return { ...DEFAULT_ATTACHMENT_EFFECT_LOADOUT, ...partial };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-attachment effect tables (the new fields not in sectionB.ts/MUZZLE_STATS/etc.)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #941 — barrel length → range multiplier.
 *  Longer barrel = more effective range (bullet stabilizes + retains velocity).
 *  Suppressed barrel = slightly reduced range (baffle drag). */
export const BARREL_RANGE_MULT: Record<string, number> = {
  short: 0.85, standard: 1.0, long: 1.2, suppressed: 0.9,
};

/** B3-5000 #984 — barrel length → bullet velocity multiplier.
 *  Longer barrel = higher muzzle velocity (more powder burn time).
 *  Suppressed = slight velocity loss (baffle drag). */
export const BARREL_VELOCITY_MULT: Record<string, number> = {
  short: 0.85, standard: 1.0, long: 1.15, suppressed: 0.92,
};

/** B3-5000 #957 — bolt weight → fire rate multiplier.
 *  Lighter bolt cycles faster (higher ROF); heavier bolt cycles slower. */
export const BOLT_FIRE_RATE_MULT: Record<string, number> = {
  default: 1.0, lightweight: 1.1, heavy: 0.85,
};

/** B3-5000 #944 — suppressor wear rate per round fired. Steel baffles wear
 *  slowly; the user-replaceable wipes on legacy suppressors wear fast.
 *  The MalfunctionSystem multiplies the round count by this rate to compute
 *  accumulated suppressor wear (0..1). 0 = no wear (no suppressor). */
export const SUPPRESSOR_WEAR_PER_ROUND: Record<string, number> = {
  none: 0.0,
  suppressor: 0.00005,     // 1.0 wear = 20,000 rounds
  flash_hider: 0.0,
  compensator: 0.0,
  muzzle_brake: 0.0,
};

/** B3-5000 #947 — scope sway multiplier (per optic + bipod combo).
 *  Heavy scopes sway more (the player's hands shake under the weight);
 *  bipod deployed = 0.3× sway (locked down). */
export function attachmentScopeSwayMult(loadout: AttachmentEffectLoadout, bipodDeployed = false): number {
  if (bipodDeployed) return 0.3;
  let mult = 1.0;
  switch (loadout.sight) {
    case "scope8x":  mult = 1.4; break;
    case "scope12x": mult = 1.6; break;
    case "scope4x":  mult = 1.15; break;
    case "acog":     mult = 1.0; break;
    case "holo":     mult = 0.9; break;
    case "red_dot":  mult = 0.85; break;
  }
  // Heavy stock counterbalances sway slightly.
  if (loadout.stock === "heavy") mult *= 0.95;
  if (loadout.stock === "lightweight") mult *= 1.05;
  return mult;
}

/** B3-5000 #948 — hold-breath duration multiplier. Lighter scopes let the
 *  player hold breath longer; heavy scopes shorten the hold. */
export function attachmentHoldBreathMult(loadout: AttachmentEffectLoadout): number {
  let mult = 1.0;
  switch (loadout.sight) {
    case "scope12x": mult = 0.7; break;
    case "scope8x":  mult = 0.85; break;
    case "scope4x":  mult = 0.95; break;
    case "holo":     mult = 1.05; break;
    case "red_dot":  mult = 1.1; break;
  }
  if (loadout.stock === "lightweight") mult *= 1.05;
  if (loadout.stock === "heavy") mult *= 0.95;
  return mult;
}

/** B3-5000 #949 — bipod deploy capability. Returns true if the loadout has
 *  a deployable bipod attachment (auto-deploys when prone + stationary —
 *  see sectionB.ts:autoDeployBipod for the state machine). */
export function attachmentBipodDeploy(loadout: AttachmentEffectLoadout): boolean {
  return loadout.bipod === "deployable" || loadout.bipod === "folding";
}

/** B3-5000 #950 — laser visibility. Visible lasers emit a beam enemies can
 *  see (risk/reward: tighter hip spread but reveals position). IR lasers are
 *  invisible to the naked eye but visible through NVDs. */
export function attachmentLaserVisibility(loadout: AttachmentEffectLoadout): "none" | "visible" | "ir" {
  if (loadout.laser === "visible") return "visible";
  if (loadout.laser === "ir") return "ir";
  return "none";
}

/** B3-5000 #951 — flashlight beam visibility. Returns the beam mode
 *  ("steady" / "strobe" / "none"). Strobe disorients AI (#211). */
export function attachmentFlashlight(loadout: AttachmentEffectLoadout): "none" | "steady" | "strobe" {
  if (loadout.flashlight === "steady") return "steady";
  if (loadout.flashlight === "strobe") return "strobe";
  return "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// Core recoil/spread/recovery/bloom helpers (938, 939, 952, 960, 961, 962, 963, 964)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #938 — total recoil multiplier (vertical × horizontal combined).
 *  Reads from sectionB.ts:FOREGRIP_STATS + MUZZLE_STATS (existing tables);
 *  this helper composes them into a single multiplier the RecoilSystem can
 *  apply to the recoil-vector magnitude. */
export function attachmentRecoilMult(loadout: AttachmentEffectLoadout, bipodDeployed = false): number {
  let vMult = 1.0;
  // Foregrip vertical reduction.
  switch (loadout.grip) {
    case "vertical": vMult *= 0.75; break;
    case "angled":   vMult *= 0.9; break;
    case "stubby":   vMult *= 0.9; break;
  }
  // Muzzle vertical reduction.
  switch (loadout.muzzle) {
    case "suppressor":   vMult *= 0.85; break;
    case "muzzle_brake": vMult *= 0.8; break;
    case "compensator":  vMult *= 1.0; break;  // comp is horizontal-only
  }
  if (bipodDeployed) vMult *= 0.4;
  return vMult;
}

/** B3-5000 #939 — spread multiplier (general). Heavy scopes increase spread
 *  when not ADS; foregrip reduces spread across the board. */
export function attachmentSpreadMult(loadout: AttachmentEffectLoadout): number {
  let mult = 1.0;
  switch (loadout.grip) {
    case "vertical": mult *= 0.95; break;
    case "angled":   mult *= 0.95; break;
    case "stubby":   mult *= 0.85; break; // stubby = best general spread
  }
  switch (loadout.sight) {
    case "scope8x":  mult *= 1.1; break;  // heavy scope = harder to hold steady
    case "scope12x": mult *= 1.15; break;
  }
  if (loadout.muzzle === "suppressor") mult *= 0.98; // suppressor adds mass = slight stability
  return mult;
}

/** B3-5000 #952 — foregrip recoil multiplier (vertical grip best). Aliases
 *  to the foregrip-only portion of #938. */
export function attachmentForegripRecoil(grip: string): number {
  switch (grip) {
    case "vertical": return 0.75;
    case "angled":   return 0.9;
    case "stubby":   return 0.9;
    default:         return 1.0;
  }
}

/** B3-5000 #960 — muzzle climb multiplier (compensator reduces climb).
 *  Climb = the upward vertical recoil component specifically; the muzzle_brake
 *  also reduces climb but at the cost of louder sound (#958). */
export function attachmentMuzzleClimbMult(muzzle: string): number {
  switch (muzzle) {
    case "compensator":  return 0.7;
    case "muzzle_brake": return 0.8;
    case "suppressor":   return 0.85;
    default:             return 1.0;
  }
}

/** B3-5000 #961 — horizontal recoil multiplier (compensator reduces horizontal).
 *  The compensator's whole job is to tame horizontal muzzle flip. */
export function attachmentHorizontalRecoil(muzzle: string): number {
  switch (muzzle) {
    case "compensator":  return 0.7;
    case "suppressor":   return 0.9;
    case "muzzle_brake": return 1.0; // brake does nothing for horizontal
    default:             return 1.0;
  }
}

/** B3-5000 #962 — first-shot recoil multiplier (muzzle_brake reduces the
 *  initial kick — the brake redirects propellant gases to counter recoil on
 *  the first round of a burst). Subsequent rounds use the normal recoil. */
export function attachmentFirstShotRecoil(muzzle: string): number {
  switch (muzzle) {
    case "muzzle_brake": return 0.6;
    case "compensator":  return 0.85;
    default:             return 1.0;
  }
}

/** B3-5000 #963 — recovery speed multiplier (foregrip recovers faster — the
 *  grip gives the player more leverage to bring the muzzle back down). */
export function attachmentRecoveryMult(grip: string): number {
  switch (grip) {
    case "vertical": return 1.2; // 20% faster recovery
    case "angled":   return 1.1;
    case "stubby":   return 1.15;
    default:         return 1.0;
  }
}

/** B3-5000 #964 — bloom multiplier (foregrip blooms less under sustained fire
 *  — the grip stabilizes the muzzle so successive shots cluster tighter). */
export function attachmentBloomMult(grip: string): number {
  switch (grip) {
    case "vertical": return 0.85;
    case "angled":   return 0.9;
    case "stubby":   return 0.75; // stubby = best bloom control
    default:         return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stance spreads (965–972)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #965 — ADS spread multiplier. Laser sight tightens ADS spread
 *  (the visible dot gives a precise aim reference under the reticle). */
export function attachmentAdsSpreadMult(loadout: AttachmentEffectLoadout): number {
  let mult = 1.0;
  if (loadout.laser === "visible" || loadout.laser === "ir") mult *= 0.85;
  if (loadout.grip === "vertical") mult *= 0.95;
  return mult;
}

/** B3-5000 #966 — hipfire spread multiplier. Laser + stubby grip tighten
 *  hipfire (the stubby's whole role is hipfire control). */
export function attachmentHipfireSpread(loadout: AttachmentEffectLoadout): number {
  let mult = 1.0;
  if (loadout.laser === "visible" || loadout.laser === "ir") mult *= 0.8;
  switch (loadout.grip) {
    case "stubby":   mult *= 0.7; break;
    case "vertical": mult *= 1.0; break; // vertical is for ADS, not hip
    case "angled":   mult *= 0.95; break;
  }
  return mult;
}

/** B3-5000 #967 — moving spread multiplier. Foregrip reduces the moving
 *  spread penalty (the player can keep the muzzle stable while walking). */
export function attachmentMovingSpread(grip: string): number {
  switch (grip) {
    case "vertical": return 0.85;
    case "angled":   return 0.9;
    case "stubby":   return 0.9;
    default:         return 1.0;
  }
}

/** B3-5000 #968 — jump spread multiplier. Heavier weapons spread more
 *  when jumping (harder to control in the air); lighter weapons spread less.
 *  `weaponWeight` is the weapon's base weight in kg (0.5..8). */
export function attachmentJumpSpread(loadout: AttachmentEffectLoadout, weaponWeightKg: number): number {
  // Lighter weapon = less jump spread. 1.0 at 3kg, 1.4 at 8kg, 0.7 at 0.5kg.
  const weightMult = 1.0 + (weaponWeightKg - 3.0) * 0.08;
  return Math.max(0.7, Math.min(1.4, weightMult));
}

/** B3-5000 #969 — slide spread multiplier. Same weight logic as #968 but
 *  slightly less aggressive (sliding is more stable than jumping). */
export function attachmentSlideSpread(loadout: AttachmentEffectLoadout, weaponWeightKg: number): number {
  const weightMult = 1.0 + (weaponWeightKg - 3.0) * 0.05;
  return Math.max(0.8, Math.min(1.3, weightMult));
}

/** B3-5000 #970 — prone spread multiplier. Bipod prone = tightest possible
 *  (the weapon is locked to the ground). */
export function attachmentProneSpread(loadout: AttachmentEffectLoadout, bipodDeployed = false): number {
  if (bipodDeployed && (loadout.bipod === "deployable" || loadout.bipod === "folding")) {
    return 0.1; // 90% reduction — bipod prone is a sniper's nest
  }
  // Prone without bipod is still ~50% better than standing.
  return 0.5;
}

/** B3-5000 #971 — crouch spread multiplier. Foregrip + crouch combine for
 *  tighter spread (the player is braced + the grip stabilizes). */
export function attachmentCrouchSpread(grip: string): number {
  let mult = 0.75; // base crouch bonus
  if (grip === "vertical" || grip === "angled") mult *= 0.95;
  return mult;
}

/** B3-5000 #972 — lean spread multiplier. Foregrip helps when leaning
 *  around a corner (the player can brace against the wall). */
export function attachmentLeanSpread(grip: string): number {
  let mult = 0.85; // base lean bonus
  if (grip === "vertical") mult *= 0.95;
  return mult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stamina + sway + hold-breath + aim assist + sensitivity (973–977)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #973 — stamina drain multiplier. Heavier attachments drain more
 *  stamina per shot (ADS-hold + movement). Returns the per-shot drain mult.
 *  `weaponWeightKg` is the weapon's base weight; attachments add to it. */
export function attachmentStaminaDrain(loadout: AttachmentEffectLoadout, weaponWeightKg: number): number {
  let effectiveWeight = weaponWeightKg;
  if (loadout.magazine === "drum") effectiveWeight += 1.2;
  if (loadout.magazine === "extended") effectiveWeight += 0.4;
  if (loadout.sight === "scope8x") effectiveWeight += 0.5;
  if (loadout.sight === "scope12x") effectiveWeight += 0.8;
  if (loadout.muzzle === "suppressor") effectiveWeight += 0.4;
  // 1.0 drain at 3kg, scales 0.1 per kg above/below.
  return Math.max(0.7, Math.min(1.8, 1.0 + (effectiveWeight - 3.0) * 0.1));
}

/** B3-5000 #974 — sway multiplier (general, not just scope). Heavier
 *  attachments sway more. */
export function attachmentSwayMult(loadout: AttachmentEffectLoadout, weaponWeightKg: number): number {
  let mult = attachmentScopeSwayMult(loadout);
  // Weight penalty.
  mult *= 1.0 + (weaponWeightKg - 3.0) * 0.04;
  return Math.max(0.8, Math.min(1.6, mult));
}

/** B3-5000 #975 — hold-breath duration multiplier (alias of #948 for
 *  stance-aware callers — the breath-duration is the same field, but this
 *  helper takes the weapon weight into account too). */
export function attachmentHoldBreathDur(loadout: AttachmentEffectLoadout, weaponWeightKg: number): number {
  let mult = attachmentHoldBreathMult(loadout);
  // Lighter weapon = longer breath hold.
  mult *= 1.0 - (weaponWeightKg - 3.0) * 0.03;
  return Math.max(0.5, Math.min(1.4, mult));
}

/** B3-5000 #976 — aim-assist multiplier. Visible/IR laser adds aim assist
 *  (the system can snap the reticle onto the laser-dot's target). */
export function attachmentAimAssistMult(loadout: AttachmentEffectLoadout): number {
  if (loadout.laser === "visible") return 1.25; // 25% more aim assist
  if (loadout.laser === "ir") return 1.15;
  return 1.0;
}

/** B3-5000 #977 — scope sensitivity multiplier. Higher zoom = lower
 *  sensitivity (so the player can make fine adjustments at high zoom).
 *  Returns the multiplier applied to the player's base sensitivity. */
export function attachmentScopeSensitivity(sight: string): number {
  switch (sight) {
    case "scope12x": return 0.15;
    case "scope8x":  return 0.25;
    case "scope4x":  return 0.5;
    case "acog":     return 0.7;
    case "holo":     return 0.9;
    case "red_dot":  return 1.0;
    default:         return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Crosshair + HUD + killcam + minimap + AI detection (978–983)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #978 — crosshair dot add. A laser sight adds a center dot to
 *  the crosshair (the laser dot is visible at the aim point). */
export function attachmentCrosshairAddDot(loadout: AttachmentEffectLoadout): boolean {
  return loadout.laser === "visible" || loadout.laser === "ir";
}

/** B3-5000 #979 — HUD show-remaining-rounds. Extended + drum mags show the
 *  remaining rounds as a numeric counter near the crosshair (the player can
 *  track ammo without glancing at the corner HUD). */
export function attachmentHudShowRounds(magazine: string): boolean {
  return magazine === "extended" || magazine === "drum";
}

/** B3-5000 #980 — killcam hidden. Suppressed weapons hide the killer from
 *  the victim's killcam (the player has to find the shooter the hard way). */
export function attachmentKillcamHidden(muzzle: string): boolean {
  return muzzle === "suppressor";
}

/** B3-5000 #981 — minimap hidden. Suppressed weapons hide the shooter's
 *  red dot on the minimap for the duration of the shot (the report doesn't
 *  ping the radar). */
export function attachmentMinimapHidden(muzzle: string): boolean {
  return muzzle === "suppressor";
}

/** B3-5000 #982 — AI detection multiplier. Suppressed fire is harder for
 *  AI to detect (the report doesn't carry as far). Returns the multiplier
 *  applied to the AI's hearing range. */
export function attachmentAiDetectionMult(muzzle: string): number {
  switch (muzzle) {
    case "suppressor":  return 0.3;  // 70% reduction in AI hearing range
    case "flash_hider": return 0.9;
    default:            return 1.0;
  }
}

/** B3-5000 #983 — AI suppression multiplier. Suppressed fire causes less
 *  AI suppression (the AI doesn't pin as easily from a quiet shooter).
 *  Returns the multiplier applied to the suppression-per-hit value. */
export function attachmentAiSuppressionMult(muzzle: string): number {
  switch (muzzle) {
    case "suppressor":  return 0.5;
    case "flash_hider": return 0.95;
    default:            return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bullet ballistics (984–990) — velocity, drop, wind drift, ricochet,
// fragmentation, overpenetration. Reads from sectionB.ts:AMMO_TYPE_STATS
// where possible (existing velocityMult/dropMult/armorPenMult fields).
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #984 — bullet velocity multiplier. Composed of barrel length +
 *  ammo type (subsonic = 0.7×). */
export function attachmentBulletVelocity(loadout: AttachmentEffectLoadout): number {
  let mult = BARREL_VELOCITY_MULT[loadout.barrel] ?? 1.0;
  switch (loadout.ammo) {
    case "subsonic":   mult *= 0.7; break;
    case "ap":         mult *= 1.05; break;
    case "hp":         mult *= 0.95; break;
    case "incendiary": mult *= 0.9; break;
  }
  if (loadout.muzzle === "suppressor") mult *= 0.95; // suppressor drag
  return mult;
}

/** B3-5000 #985 — bullet drop multiplier. Subsonic drops more; AP drops less
 *  (flatter trajectory). */
export function attachmentBulletDrop(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "subsonic":   return 1.4;
    case "ap":         return 0.95;
    case "hp":         return 1.05;
    case "incendiary": return 1.1;
    default:           return 1.0;
  }
}

/** B3-5000 #986 — wind drift multiplier. Lighter bullets drift more.
 *  HP/incendiary have lighter projectiles (they expand, so they're less
 *  dense); AP is denser (tungsten core) so drifts less. */
export function attachmentWindDrift(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "hp":         return 1.2;
    case "incendiary": return 1.15;
    case "ap":         return 0.85;
    case "subsonic":   return 1.5; // slow + light = drifts most
    default:           return 1.0;
  }
}

/** B3-5000 #987 / #993 — penetration multiplier (AP ammo). This is the
 *  ammo-armor-penetration multiplier (armor_pen). Aliases the existing
 *  sectionB.ts:AMMO_TYPE_STATS.armorPenMult for callers using the unified
 *  AttachmentEffectLoadout shape. */
export function attachmentPenetrationMult(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "ap":         return 1.8;
    case "hp":         return 0.3;
    case "subsonic":   return 0.9;
    case "incendiary": return 0.5;
    default:           return 1.0; // FMJ / tracer
  }
}

/** B3-5000 #988 — ricochet multiplier. Hollow points ricochet less (they
 *  expand on impact + deform); AP ricochets more (the hard core bounces
 *  off hard surfaces). */
export function attachmentRicochetMult(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "hp":         return 0.4;
    case "ap":         return 1.3;
    case "incendiary": return 0.6;
    default:           return 1.0;
  }
}

/** B3-5000 #989 — fragmentation multiplier. Hollow points fragment more
 *  (the expansion splits the jacket); AP fragments less (solid core). */
export function attachmentFragmentationMult(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "hp":         return 2.0;
    case "ap":         return 0.3;
    case "incendiary": return 1.5;
    default:           return 1.0;
  }
}

/** B3-5000 #990 — overpenetration multiplier. FMJ overpenetrates more
 *  (the bullet holds together); HP stops in the target (expands). */
export function attachmentOverpenetration(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "fmj":        return 1.5;
    case "ap":         return 1.4;
    case "hp":         return 0.3;
    case "incendiary": return 0.5;
    default:           return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Damage-type multipliers (991–1000) — headshot, limb, armor, vehicle,
// shield, boss, elite, zombie, environmental. Reads #940 (damageMult) too.
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #940 — base damage multiplier (HP ammo +40%, AP -20%). */
export function attachmentDamageMult(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "hp":         return 1.4;
    case "ap":         return 0.8;
    case "incendiary": return 1.2;
    case "subsonic":   return 0.9;
    default:           return 1.0;
  }
}

/** B3-5000 #991 — headshot damage multiplier. Hollow points get +50%
 *  headshot bonus (the expansion makes the headshot more lethal); AP gets
 *  less (the round overpenetrates the head without dumping all energy). */
export function attachmentHeadshotMult(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "hp":         return 1.5;
    case "ap":         return 0.85;
    case "incendiary": return 1.2;
    default:           return 1.0;
  }
}

/** B3-5000 #992 — limb damage multiplier. FMJ has less limb penalty (the
 *  round doesn't deform so it dumps more energy into the limb); HP gets
 *  a bigger limb penalty (the expansion is wasted on a non-vital area). */
export function attachmentLimbMult(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "fmj":        return 1.15; // less limb penalty
    case "ap":         return 1.05;
    case "hp":         return 0.85; // more limb penalty
    default:           return 1.0;
  }
}

/** B3-5000 #994 — armor damage multiplier. Hollow points deal more damage
 *  to armor plates (the expansion spreads the impact over more surface area).
 *  Note: HP *penetrates* armor worse (#942) but damages the armor itself more. */
export function attachmentArmorDamage(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "hp":         return 1.4;
    case "incendiary": return 1.2;
    case "ap":         return 0.7;
    default:           return 1.0;
  }
}

/** B3-5000 #995 — vehicle damage multiplier. AP rounds deal more damage to
 *  vehicles (they punch through light armor); HP barely scratches paint. */
export function attachmentVehicleDamage(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "ap":         return 1.6;
    case "incendiary": return 1.3;
    case "hp":         return 0.4;
    default:           return 1.0;
  }
}

/** B3-5000 #996 — shield damage multiplier. AP rounds deal more damage to
 *  player/enemy energy shields (the high velocity + hard core disrupt the
 *  shield's deflection field). */
export function attachmentShieldDamage(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "ap":         return 1.5;
    case "incendiary": return 1.2;
    case "hp":         return 0.5;
    default:           return 1.0;
  }
}

/** B3-5000 #997 — boss damage multiplier. AP rounds deal more damage to
 *  bosses (bosses have heavy armor that only AP can punch through). */
export function attachmentBossDamage(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "ap":         return 1.4;
    case "incendiary": return 1.15;
    case "hp":         return 0.6;
    default:           return 1.0;
  }
}

/** B3-5000 #998 — elite damage multiplier. AP rounds deal more damage to
 *  elite enemies (elites wear better armor than regulars). */
export function attachmentEliteDamage(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "ap":         return 1.3;
    case "incendiary": return 1.1;
    case "hp":         return 0.7;
    default:           return 1.0;
  }
}

/** B3-5000 #999 — zombie damage multiplier. Hollow points deal more damage
 *  to zombies (the expansion tears flesh; zombies have no armor to defeat). */
export function attachmentZombieDamage(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "hp":         return 1.6;
    case "incendiary": return 1.8; // zombies fear fire
    case "ap":         return 0.7;
    default:           return 1.0;
  }
}

/** B3-5000 #1000 — environmental damage multiplier. Incendiary rounds deal
 *  more damage to environmental objects (barrels, doors, wooden barricades)
 *  because they ignite them. AP punches through but doesn't damage the
 *  object itself as much. */
export function attachmentEnvironmentalDamage(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "incendiary": return 2.0; // barrels explode, doors burn
    case "ap":         return 1.2; // punches through doors but doesn't damage them
    case "hp":         return 0.8;
    default:           return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Already-DONE aliases — these prompts were implemented in prior missions.
// The helpers below expose the existing tables via the unified loadout shape
// for callers that want a single import.
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #942 — alias of #987 (armor penetration). Kept as a separate
 *  export because the prompt file lists them as distinct acceptance criteria. */
export function attachmentArmorPenMult(loadout: AttachmentEffectLoadout): number {
  return attachmentPenetrationMult(loadout);
}

/** B3-5000 #943 — tracer visibility. Tracer ammo = every round visible;
 *  subsonic = dim tracer (the slower bullet doesn't heat the tracer compound
 *  as brightly). Returns 0..1 visibility multiplier. */
export function attachmentTracerVisibility(loadout: AttachmentEffectLoadout): number {
  switch (loadout.ammo) {
    case "tracer":     return 1.0;
    case "subsonic":   return 0.4;
    case "incendiary": return 0.7; // incendiary trails are visible
    default:           return 0.2; // every 5th round (FMJ standard)
  }
}

/** B3-5000 #945 — scope glint. 8x+ scopes glint when pointed at the sun.
 *  See sectionB.ts:scopeGlintIntensity for the angle-based calculation;
 *  this helper is the per-loadout gate (does this loadout glint at all?). */
export function attachmentScopeGlint(sight: string): boolean {
  return sight === "scope8x" || sight === "scope12x";
}

/** B3-5000 #946 — scope zoom. Aliases sectionB.ts:OPTIC_STATS.zoom. */
export function attachmentScopeZoom(sight: string): number {
  switch (sight) {
    case "scope12x": return 12.0;
    case "scope8x":  return 8.0;
    case "scope4x":  return 4.0;
    case "acog":     return 2.5;
    case "holo":     return 1.3;
    case "red_dot":  return 1.2;
    default:         return 1.0;
  }
}

/** B3-5000 #944 — suppressor wear-per-round. Returns the wear accumulated
 *  for `roundsFired` rounds through the equipped muzzle device. The
 *  MalfunctionSystem tracks this on the weapon's AttachmentWearState. */
export function attachmentSuppressorWear(muzzle: string, roundsFired: number): number {
  const rate = SUPPRESSOR_WEAR_PER_ROUND[muzzle] ?? 0;
  return rate * roundsFired;
}

/** B3-5000 #953 — magazine size multiplier. Aliases sectionB.ts:MAGAZINE_STATS.sizeMult. */
export function attachmentMagSizeMult(magazine: string): number {
  switch (magazine) {
    case "extended": return 1.5;
    case "drum":     return 3.0;
    case "quick_mag": return 0.9; // quick-mag trades capacity for speed
    default:          return 1.0;
  }
}

/** B3-5000 #954 — reload-speed multiplier. Aliases
 *  sectionB.ts:MAGAZINE_STATS.reloadTimeMult + weapon-depth.ts:attachmentReloadSpeedMod. */
export function attachmentReloadSpeedMult(magazine: string): number {
  switch (magazine) {
    case "extended": return 1.1;
    case "drum":     return 1.4;
    case "quick_mag": return 0.75;
    default:          return 1.0;
  }
}

/** B3-5000 #955 — magazine type label. Returns the canonical type slug
 *  the HUD + gunsmith display. */
export function attachmentMagazineType(magazine: string): "default" | "extended" | "drum" | "quick_mag" {
  switch (magazine) {
    case "extended": return "extended";
    case "drum":     return "drum";
    case "quick_mag": return "quick_mag";
    default:          return "default";
  }
}

/** B3-5000 #956 — fire mode. Burst-fire weapons get a burst trigger; this
 *  helper returns the fire-mode slug given the weapon + loadout. (The actual
 *  burst-fire timing is in sectionB.ts:FIRE_MODE_STATS — this is just the
 *  loadout → fire-mode gate.) */
export function attachmentFireMode(weapon: WeaponType, _loadout: AttachmentEffectLoadout): "bolt" | "semi" | "auto" | "burst" {
  // Bolt-action snipers.
  if (weapon === "awp" || weapon === "l115a3" || weapon === "kar98k") return "bolt";
  // Burst-capable (sectionB.ts:BURST_WEAPONS).
  if (weapon === "famas" || weapon === "m4" || weapon === "hk416") return "burst";
  return "auto";
}

/** B3-5000 #957 — fire-rate multiplier. Aliases BOLT_FIRE_RATE_MULT (above). */
export function attachmentFireRateMult(bolt: string): number {
  return BOLT_FIRE_RATE_MULT[bolt] ?? 1.0;
}

/** B3-5000 #958 — sound multiplier. Aliases sectionB.ts:MUZZLE_STATS.soundMult. */
export function attachmentSoundMult(muzzle: string): number {
  switch (muzzle) {
    case "suppressor":  return 0.4;
    case "muzzle_brake": return 1.05;
    default:             return 1.0;
  }
}

/** B3-5000 #959 — flash multiplier. Aliases sectionB.ts:MUZZLE_STATS.flashMult. */
export function attachmentFlashMult(muzzle: string): number {
  switch (muzzle) {
    case "suppressor":  return 0.0;
    case "flash_hider": return 0.3;
    default:             return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composed "effective stats" helper — single entry point for the engine to
// compute every attachment effect in one call. Returns the multipliers the
// WeaponSystem / Ballistics / HUD systems apply.
// ─────────────────────────────────────────────────────────────────────────────

/** Composed attachment-effect summary. Returned by
 *  `computeAttachmentEffects(loadout, weaponWeightKg, bipodDeployed)`.
 *  Every field is a multiplier (1.0 = no effect). The engine multiplies the
 *  base weapon stat by these multipliers to get the effective stat. */
export interface AttachmentEffectSummary {
  recoilMult: number;
  spreadMult: number;
  damageMult: number;
  rangeMult: number;
  penetrationMult: number;
  tracerVisibility: number;
  scopeGlint: boolean;
  scopeZoom: number;
  scopeSwayMult: number;
  holdBreathMult: number;
  bipodDeploy: boolean;
  laserVisibility: "none" | "visible" | "ir";
  flashlight: "none" | "steady" | "strobe";
  magSizeMult: number;
  reloadSpeedMult: number;
  magazineType: "default" | "extended" | "drum" | "quick_mag";
  fireRateMult: number;
  soundMult: number;
  flashMult: number;
  muzzleClimbMult: number;
  horizontalRecoil: number;
  firstShotRecoil: number;
  recoveryMult: number;
  bloomMult: number;
  adsSpreadMult: number;
  hipfireSpread: number;
  movingSpread: number;
  jumpSpread: number;
  slideSpread: number;
  proneSpread: number;
  crouchSpread: number;
  leanSpread: number;
  staminaDrain: number;
  swayMult: number;
  holdBreathDur: number;
  aimAssistMult: number;
  scopeSensitivity: number;
  crosshairAddDot: boolean;
  hudShowRounds: boolean;
  killcamHidden: boolean;
  minimapHidden: boolean;
  aiDetectionMult: number;
  aiSuppressionMult: number;
  bulletVelocity: number;
  bulletDrop: number;
  windDrift: number;
  ricochetMult: number;
  fragmentationMult: number;
  overpenetration: number;
  headshotMult: number;
  limbMult: number;
  armorDamage: number;
  vehicleDamage: number;
  shieldDamage: number;
  bossDamage: number;
  eliteDamage: number;
  zombieDamage: number;
  environmentalDamage: number;
}

/** Compute every attachment effect in one call. The engine can call this
 *  on loadout change + cache the result. Individual helpers above can be
 *  called directly for callers that only need one field (avoids the
 *  recomputation cost when only one stat is needed). */
export function computeAttachmentEffects(
  loadout: AttachmentEffectLoadout,
  weaponWeightKg = 3.0,
  bipodDeployed = false,
): AttachmentEffectSummary {
  return {
    recoilMult:          attachmentRecoilMult(loadout, bipodDeployed),
    spreadMult:          attachmentSpreadMult(loadout),
    damageMult:          attachmentDamageMult(loadout),
    rangeMult:           BARREL_RANGE_MULT[loadout.barrel] ?? 1.0,
    penetrationMult:     attachmentPenetrationMult(loadout),
    tracerVisibility:    attachmentTracerVisibility(loadout),
    scopeGlint:          attachmentScopeGlint(loadout.sight),
    scopeZoom:           attachmentScopeZoom(loadout.sight),
    scopeSwayMult:       attachmentScopeSwayMult(loadout, bipodDeployed),
    holdBreathMult:      attachmentHoldBreathMult(loadout),
    bipodDeploy:         attachmentBipodDeploy(loadout),
    laserVisibility:     attachmentLaserVisibility(loadout),
    flashlight:          attachmentFlashlight(loadout),
    magSizeMult:         attachmentMagSizeMult(loadout.magazine),
    reloadSpeedMult:     attachmentReloadSpeedMult(loadout.magazine),
    magazineType:        attachmentMagazineType(loadout.magazine),
    fireRateMult:        attachmentFireRateMult(loadout.bolt),
    soundMult:           attachmentSoundMult(loadout.muzzle),
    flashMult:           attachmentFlashMult(loadout.muzzle),
    muzzleClimbMult:     attachmentMuzzleClimbMult(loadout.muzzle),
    horizontalRecoil:    attachmentHorizontalRecoil(loadout.muzzle),
    firstShotRecoil:     attachmentFirstShotRecoil(loadout.muzzle),
    recoveryMult:        attachmentRecoveryMult(loadout.grip),
    bloomMult:           attachmentBloomMult(loadout.grip),
    adsSpreadMult:       attachmentAdsSpreadMult(loadout),
    hipfireSpread:       attachmentHipfireSpread(loadout),
    movingSpread:        attachmentMovingSpread(loadout.grip),
    jumpSpread:          attachmentJumpSpread(loadout, weaponWeightKg),
    slideSpread:         attachmentSlideSpread(loadout, weaponWeightKg),
    proneSpread:         attachmentProneSpread(loadout, bipodDeployed),
    crouchSpread:        attachmentCrouchSpread(loadout.grip),
    leanSpread:          attachmentLeanSpread(loadout.grip),
    staminaDrain:        attachmentStaminaDrain(loadout, weaponWeightKg),
    swayMult:            attachmentSwayMult(loadout, weaponWeightKg),
    holdBreathDur:       attachmentHoldBreathDur(loadout, weaponWeightKg),
    aimAssistMult:       attachmentAimAssistMult(loadout),
    scopeSensitivity:    attachmentScopeSensitivity(loadout.sight),
    crosshairAddDot:     attachmentCrosshairAddDot(loadout),
    hudShowRounds:       attachmentHudShowRounds(loadout.magazine),
    killcamHidden:       attachmentKillcamHidden(loadout.muzzle),
    minimapHidden:       attachmentMinimapHidden(loadout.muzzle),
    aiDetectionMult:     attachmentAiDetectionMult(loadout.muzzle),
    aiSuppressionMult:   attachmentAiSuppressionMult(loadout.muzzle),
    bulletVelocity:      attachmentBulletVelocity(loadout),
    bulletDrop:          attachmentBulletDrop(loadout),
    windDrift:           attachmentWindDrift(loadout),
    ricochetMult:        attachmentRicochetMult(loadout),
    fragmentationMult:   attachmentFragmentationMult(loadout),
    overpenetration:     attachmentOverpenetration(loadout),
    headshotMult:        attachmentHeadshotMult(loadout),
    limbMult:            attachmentLimbMult(loadout),
    armorDamage:         attachmentArmorDamage(loadout),
    vehicleDamage:       attachmentVehicleDamage(loadout),
    shieldDamage:        attachmentShieldDamage(loadout),
    bossDamage:          attachmentBossDamage(loadout),
    eliteDamage:         attachmentEliteDamage(loadout),
    zombieDamage:        attachmentZombieDamage(loadout),
    environmentalDamage: attachmentEnvironmentalDamage(loadout),
  };
}
