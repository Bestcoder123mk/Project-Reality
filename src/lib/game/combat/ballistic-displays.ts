/**
 * Section B (B3-5000) — ballistic displays + wind + bullet trails + impact
 * VFX + whiz-by + ricochet/fragmentation/overpenetration/deflection +
 * transonic/subsonic helpers.
 *
 * Implements prompts 1001–1050 (lines 2028–2126 of `5000-IMPROVEMENT-PROMPTS.md`).
 *
 * Most primitives already exist:
 *   - `Ballistics.ts:computeDrop` / `computeWindDrift` / `applyBallisticDrop`
 *     (drop + wind drift math — covers the #1003/#1004 raw values).
 *   - `Ballistics.ts:gustWindSpeed` (#1005 wind gust envelope).
 *   - `Ballistics.ts:coriolisDriftM` + `magnusSpinDriftM` (#1045/#1046 raw values).
 *   - `Ballistics.ts:transonicDragMult` + `producesSonicCrack` (#1047/#1028/#1050).
 *   - `Ballistics.ts:WEAPON_TRACER_COLORS` (per-weapon tracer color — overlaps
 *     with #1011 ammo-trail-color but is per-weapon, not per-ammo).
 *   - `Ballistics.ts:computeRicochet` + `RICOCHET_DAMAGE_MULT` (#1044 ricochet
 *     damage reduction + #1033/#1034 ricochet audio/spark entry point).
 *   - `ProjectileSystem.ts:382-405` (#1027 whiz-by).
 *   - `ProjectileSystem.ts:344-373` (#1028 supersonic crack VFX).
 *   - `ProjectileSystem.ts:599-610` (#1040 exit-hole decal on penetration).
 *   - `ProjectileSystem.ts:632-634` (#1034 ricochet spark VFX).
 *   - `ParticleSystem/tracers.ts:SURFACE_VFX` (#1019-#1024 per-surface spark/
 *     debris/smoke/decal/color/scale — DONE in prior mission).
 *
 * This module adds:
 *   1. HUD display formatters (#1001–#1004) — pure functions that format the
 *      raw ballistics values into the strings/objects the HUD renders in
 *      scoped ADS (TOF / velocity / drop / wind).
 *   2. Wind effect helpers (#1005–#1010) — `WindEffectState` + per-system
 *      tick functions for audio/vegetation/smoke/ragdoll/particle drift.
 *   3. Bullet-trail visual property table (#1011–#1018) — per-ammo trail
 *      color/thickness/length/opacity/fade-out/glow/refraction/trailing-spark.
 *   4. Surface impact audio slug + distance attenuation + occlusion helpers
 *      (#1019–#1026) — the VFX half is already DONE in ParticleSystem; this
 *      module adds the audio-half (per-surface audio slug + attenuation +
 *      occlusion filter).
 *   5. Whiz-by per-caliber audio slug (#1027) — alias of ProjectileSystem's
 *      existing whiz-by, but with per-caliber pitch so a 9mm whiz sounds
 *      different from a .50cal whiz.
 *   6. Bullet crack directional/proximity/cooldown helpers (#1028–#1031).
 *   7. Penetration/ricochet/fragmentation/overpenetration/deflection audio +
 *      visual entry points (#1032–#1044).
 *   8. Spin drift / Coriolis / transonic / subsonic visual + audio helpers
 *      (#1045–#1050).
 *
 * Pure data + helpers. No engine wiring (engine-wiring territory is the
 * B1 ownership of WeaponSystem.ts/ProjectileSystem.ts/Ballistics.ts/HudSystem.ts).
 *
 * Marker block — search `B3-5000 #NNNN` to find each prompt's helper.
 */

import type { WeaponType, WeaponCategory } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// #1001–#1004 — scoped-ADS HUD display formatters
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1001 — bullet time-of-flight (rangefinder) display. Returns the
 *  formatted TOF string for the scoped-ADS HUD (e.g. "0.18s @ 350m"). */
export function formatBulletTof(distanceM: number, muzzleVelocityMs: number): string {
  if (muzzleVelocityMs <= 0 || distanceM < 0) return "—";
  const tof = distanceM / muzzleVelocityMs;
  // Show 2 decimal places for close range, 1 for far range (precision tradeoff).
  if (tof < 1.0) return `${tof.toFixed(2)}s @ ${Math.round(distanceM)}m`;
  return `${tof.toFixed(1)}s @ ${Math.round(distanceM)}m`;
}

/** B3-5000 #1002 — bullet velocity HUD display. Returns the formatted
 *  velocity string for the corner HUD (e.g. "910 m/s"). */
export function formatBulletVelocity(velocityMs: number): string {
  return `${Math.round(velocityMs)} m/s`;
}

/** B3-5000 #1003 — bullet drop display in scoped ADS. Returns the formatted
 *  drop string (e.g. "DROP 1.2 MIL @ 350m" — mils are the sniper's unit).
 *  1 mil ≈ 10 cm at 100m, so mils = drop_m / (distance_m / 1000). */
export function formatBulletDrop(distanceM: number, dropM: number): string {
  if (distanceM <= 0) return "DROP —";
  const mils = dropM / (distanceM / 1000);
  return `DROP ${mils.toFixed(1)} MIL @ ${Math.round(distanceM)}m`;
}

/** B3-5000 #1004 — wind speed/direction display in scoped ADS. Returns the
 *  formatted wind string (e.g. "WIND 4 m/s ← 270°"). The direction is the
 *  compass bearing the wind is blowing FROM. */
export function formatWindDisplay(windSpeedMs: number, windDirectionDeg: number): string {
  if (windSpeedMs <= 0.05) return "WIND CALM";
  const arrow = windDirectionArrow(windDirectionDeg);
  return `WIND ${windSpeedMs.toFixed(1)} m/s ${arrow} ${Math.round(windDirectionDeg)}°`;
}

/** Convert a compass bearing (0..360°, wind-from direction) to an ASCII
 *  arrow for the HUD. 0°=N (↑), 90°=E (→), 180°=S (↓), 270°=W (←). */
function windDirectionArrow(deg: number): string {
  const arrows = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
  const idx = Math.round(deg / 45) % 8;
  return arrows[idx];
}

// ─────────────────────────────────────────────────────────────────────────────
// #1005–#1010 — wind effects on audio + vegetation + smoke + ragdolls +
// particles + mic
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1005–#1010 — shared wind-effect state. The WeatherSystem ticks
 *  this each frame; the audio + VFX + ragdoll + particle systems read the
 *  fields to apply wind drift to their respective elements.
 *
 *  Cross-references:
 *    - #1005 audio gust whoosh → AudioEngine reads `gustIntensity`.
 *    - #1006 vegetation sway → VegetationSystem reads `windSpeedMs`.
 *    - #1007 smoke grenade drift → GrenadeSystem reads `windSpeedMs` +
 *      `windDirectionRad`.
 *    - #1008 ragdoll drift → RagdollSystem reads `ragdollDriftAccel`.
 *    - #1009 particle drift → ParticleSystem reads `particleDriftAccel`.
 *    - #1010 wind-in-mic audio → AudioEngine reads `micRumbleLevel`
 *      (cross-ref G-814 — the ambient mic picks up wind noise).
 */
export interface WindEffectState {
  /** Current wind speed (m/s). */
  windSpeedMs: number;
  /** Current wind direction (radians, 0 = +X, π/2 = +Z). */
  windDirectionRad: number;
  /** Gust envelope (0..1) — ramps 0→1→0 over the gust period. AudioEngine
   *  uses this for the whoosh intensity; the particle system uses it for
   *  burst-of-debris events. */
  gustIntensity: number;
  /** Per-element drift acceleration (m/s²). Pre-multiplied for the consumer
   *  system so they don't have to recompute mass/drag. */
  vegetationSwayRad: number;
  smokeDriftAccel: number;
  ragdollDriftAccel: number;
  particleDriftAccel: number;
  /** Mic rumble level (0..1) — how loud the wind-in-mic ambient layer is. */
  micRumbleLevel: number;
}

const DEFAULT_WIND_EFFECT: WindEffectState = {
  windSpeedMs: 0,
  windDirectionRad: 0,
  gustIntensity: 0,
  vegetationSwayRad: 0,
  smokeDriftAccel: 0,
  ragdollDriftAccel: 0,
  particleDriftAccel: 0,
  micRumbleLevel: 0,
};

/** B3-5000 #1005–#1010 — tick the wind-effect state. Updates every drift
 *  field from the base wind speed + direction. The caller (WeatherSystem)
 *  passes the current wind speed + direction + gust envelope (from
 *  Ballistics.ts:gustWindSpeed); this helper computes the per-system drift.
 *
 *  Tuning rationale:
 *    - Vegetation sway scales linearly with wind speed (0..0.3 rad at 10 m/s).
 *    - Smoke drift accel = windSpeed × 0.5 (smoke is very light).
 *    - Ragdoll drift = windSpeed × 0.05 (ragdolls are heavy; only extreme
 *      wind moves them).
 *    - Particle drift = windSpeed × 0.3 (sparks/dust are medium-light).
 *    - Mic rumble = windSpeed / 10 (caps at 1.0 around 10 m/s). */
export function tickWindEffect(
  state: WindEffectState,
  windSpeedMs: number,
  windDirectionRad: number,
  gustIntensity: number,
): WindEffectState {
  state.windSpeedMs = windSpeedMs;
  state.windDirectionRad = windDirectionRad;
  state.gustIntensity = Math.max(0, Math.min(1, gustIntensity));
  state.vegetationSwayRad = Math.min(0.3, windSpeedMs * 0.03);
  state.smokeDriftAccel = windSpeedMs * 0.5;
  state.ragdollDriftAccel = windSpeedMs * 0.05;
  state.particleDriftAccel = windSpeedMs * 0.3;
  state.micRumbleLevel = Math.min(1.0, windSpeedMs / 10);
  return state;
}

/** B3-5000 #1005 — wind audio slug. Returns the AudioEngine slug for the
 *  current wind layer. The AudioEngine crossfades between layers based on
 *  the wind speed: calm → light → moderate → strong → storm. */
export function windAudioSlug(state: WindEffectState): string {
  const s = state.windSpeedMs;
  if (s < 1) return "wind_calm";
  if (s < 4) return "wind_light";
  if (s < 8) return "wind_moderate";
  if (s < 12) return "wind_strong";
  return "wind_storm";
}

/** B3-5000 #1005 — wind gust whoosh audio slug. Played when gustIntensity
 *  crosses a threshold (e.g. 0.5). The AudioEngine plays the whoosh once
 *  per gust peak. */
export function windGustWhooshSlug(): string {
  return "wind_gust_whoosh";
}

/** B3-5000 #1008 — ragdoll drift acceleration (m/s²) for a ragdoll of the
 *  given mass. Lighter ragdolls drift more (the wind has more effect on a
 *  light zombie than a heavy soldier). */
export function ragdollWindDriftAccel(state: WindEffectState, ragdollMassKg: number): number {
  // Base drift from the wind state, then divide by mass (F = ma → a = F/m).
  const baseForce = state.ragdollDriftAccel * 10; // tune
  return baseForce / Math.max(20, ragdollMassKg);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1011–#1018 — bullet trail visual properties per ammo type
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1011–#1018 — bullet trail visual properties. The ProjectileSystem
 *  reads these per-projectile to set the tracer line's color/thickness/length/
 *  opacity + the trailing-spark + glow + refraction shader uniforms. */
export interface BulletTrailVisual {
  /** Trail color (hex). #1011. */
  color: number;
  /** Trail thickness (px / world-units — depends on render mode). #1012. */
  thickness: number;
  /** Trail length (m). #1013. */
  lengthM: number;
  /** Trail opacity (0..1). #1014. */
  opacity: number;
  /** Fade-out duration (ms). #1015. */
  fadeOutMs: number;
  /** Glow intensity (0..1, additive bloom). #1016. */
  glow: number;
  /** Refraction (heat-haze) intensity (0..1). #1017. */
  refraction: number;
  /** Trailing sparks (true = spawn sparks along the trail). #1018. */
  trailingSparks: boolean;
}

/** B3-5000 #1011–#1018 — per-ammo-type trail visual properties. Each ammo
 *  type gets a distinctive trail so the player can identify incoming fire
 *  by the trail color + thickness.
 *
 *  - FMJ: standard yellow-orange, medium thickness, no glow.
 *  - HP: bright orange (expansion visible), thicker, no glow.
 *  - AP: dim red (hard core doesn't heat as brightly), thin, no glow.
 *  - Subsonic: NO tracer (the slow bullet doesn't heat the compound) —
 *    color=0, opacity=0. Cross-ref #1049 (subsonic visual = no tracer).
 *  - Tracer: bright yellow, every round visible, full glow.
 *  - Incendiary: bright orange-red, very thick, full glow + trailing sparks
 *    (the incendiary compound sheds sparks as it flies). */
export const BULLET_TRAIL_VISUALS: Record<string, BulletTrailVisual> = {
  fmj:        { color: 0xffaa44, thickness: 0.5, lengthM: 4, opacity: 0.6, fadeOutMs: 80,  glow: 0.0, refraction: 0.0, trailingSparks: false },
  hp:         { color: 0xff8833, thickness: 0.7, lengthM: 4, opacity: 0.7, fadeOutMs: 80,  glow: 0.2, refraction: 0.0, trailingSparks: false },
  ap:         { color: 0xcc4422, thickness: 0.4, lengthM: 4, opacity: 0.5, fadeOutMs: 80,  glow: 0.0, refraction: 0.0, trailingSparks: false },
  subsonic:   { color: 0x000000, thickness: 0.0, lengthM: 0, opacity: 0.0, fadeOutMs: 0,   glow: 0.0, refraction: 0.0, trailingSparks: false },
  tracer:     { color: 0xffee66, thickness: 0.6, lengthM: 6, opacity: 0.9, fadeOutMs: 120, glow: 0.8, refraction: 0.0, trailingSparks: false },
  incendiary: { color: 0xff5522, thickness: 0.9, lengthM: 5, opacity: 0.85,fadeOutMs: 150, glow: 1.0, refraction: 0.2, trailingSparks: true },
};

/** B3-5000 #1011–#1018 — lookup a bullet trail visual by ammo slug. Falls
 *  back to FMJ for unknown slugs. */
export function bulletTrailVisual(ammoSlug: string): BulletTrailVisual {
  return BULLET_TRAIL_VISUALS[ammoSlug] ?? BULLET_TRAIL_VISUALS.fmj;
}

/** B3-5000 #1015 — bullet trail fade-out progress (0..1, 1 = full opacity,
 *  0 = gone). Returns the alpha multiplier given the time since the trail
 *  was emitted. */
export function bulletTrailFadeAlpha(timeSinceEmitMs: number, fadeOutMs: number): number {
  if (fadeOutMs <= 0) return 0;
  return Math.max(0, 1 - timeSinceEmitMs / fadeOutMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1019–#1026 — bullet impact audio per surface + distance attenuation +
// occlusion. (The VFX half — spark/debris/smoke/decal per surface — is
// already DONE in ParticleSystem/tracers.ts:SURFACE_VFX.)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1024 — bullet impact audio slug per surface. The AudioEngine
 *  plays this slug at the impact point. Distinct from the VFX slug —
 *  AudioEngine routes by slug, ParticleSystem routes by SURFACE_VFX table. */
export function bulletImpactAudioSlug(surface: string): string {
  switch (surface) {
    case "concrete":    return "impact_concrete";
    case "wood":        return "impact_wood";
    case "sheet_metal": return "impact_metal_thin";
    case "brick":       return "impact_brick";
    case "sandbag":     return "impact_sand";
    case "glass":       return "impact_glass";
    case "earth":       return "impact_dirt";
    case "drywall":     return "impact_drywall";
    case "steel_plate": return "impact_metal_thick";
    case "flesh":       return "impact_flesh";
    case "foliage":     return "impact_foliage";
    default:            return "impact_generic";
  }
}

/** B3-5000 #1025 — bullet impact audio distance attenuation. Returns the
 *  volume multiplier (0..1) for an impact at `distanceM` from the listener.
 *  Uses an inverse-distance model (1 / (1 + d/attenuationScale)) which
 *  gives a smooth fade without the singularity at d=0. */
export function bulletImpactAudioAttenuation(distanceM: number, attenuationScale = 20): number {
  if (distanceM < 0) return 0;
  return 1 / (1 + distanceM / attenuationScale);
}

/** B3-5000 #1026 — bullet impact audio occlusion. Returns the low-pass
 *  filter cutoff (Hz) for an impact occluded by `occluderCount` walls.
 *  0 walls = full-range (22050 Hz); each wall halves the cutoff. */
export function bulletImpactAudioOcclusion(occluderCount: number): number {
  if (occluderCount <= 0) return 22050;
  // Halve per occluder, floor at 200 Hz (sub-bass rumble only).
  return Math.max(200, 22050 / Math.pow(2, occluderCount));
}

// ─────────────────────────────────────────────────────────────────────────────
// #1027 — bullet whiz-by per caliber
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1027 — bullet whiz-by audio slug per caliber. The base whiz-by
 *  logic is in ProjectileSystem.ts:382-405 (one cue per bullet lifetime
 *  when it passes within 2m of the listener's head). This helper picks the
 *  slug based on the bullet's caliber so a 9mm whiz sounds different from
 *  a .50cal whiz (lower pitch + longer doppler for heavier rounds).
 *
 *  Cross-ref A-127 (caliber-specific audio). */
export function bulletWhizByAudioSlug(category: WeaponCategory, weapon?: WeaponType): string {
  // Special-case the .50cal / .338 Lapua snipers for the deep-boom whiz.
  if (weapon === "awp" || weapon === "l115a3") return "whiz_50cal";
  if (weapon === "deagle" || weapon === "revolver") return "whiz_50cal";
  switch (category) {
    case "SNIPER":  return "whiz_308cal";
    case "LMG":     return "whiz_556cal";
    case "RIFLE":   return "whiz_556cal";
    case "SMG":     return "whiz_9mm";
    case "SHOTGUN": return "whiz_pellet";
    case "PISTOL":  return "whiz_9mm";
    default:        return "whiz_generic";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #1028–#1031 — bullet crack (supersonic) directional + proximity + cooldown
// (The base crack VFX is in ProjectileSystem.ts:344-373; the gating logic
//  is in Ballistics.ts:producesSonicCrack. These helpers add the
//  directional audio + volume scaling + cooldown.)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1028 — bullet crack audio slug. Returns the AudioEngine slug
 *  for the supersonic crack. Only played if `producesSonicCrack` returns
 *  true (Ballistics.ts:663). */
export function bulletCrackAudioSlug(): string {
  return "bullet_crack_supersonic";
}

/** B3-5000 #1029 — bullet crack directional panning. Returns the stereo
 *  pan (-1 = full left, +1 = full right, 0 = center) for a crack at the
 *  given angle relative to the listener's facing direction.
 *  `angleRad` is the angle between the listener's forward vector and the
 *  vector from listener to the crack origin. */
export function bulletCrackPan(angleRad: number): number {
  // Map angle to pan: 0° (in front) = center, ±90° (sides) = full pan,
  // 180° (behind) = center (muffled, but panned center).
  // Use sin(angle) for a smooth pan curve.
  return Math.max(-1, Math.min(1, Math.sin(angleRad)));
}

/** B3-5000 #1030 — bullet crack volume scaling with proximity. Returns the
 *  volume multiplier (0..1) for a crack at `distanceM` from the listener.
 *  Cracks are louder when the bullet passes closer (the shockwave is
 *  stronger near the bullet path). */
export function bulletCrackVolume(distanceM: number): number {
  if (distanceM < 0) return 0;
  // 1.0 at 1m, 0.5 at 5m, 0.1 at 20m, inaudible beyond 30m.
  return Math.max(0, 1 / (1 + distanceM * 0.2));
}

/** B3-5000 #1031 — bullet crack cooldown. The system should not play a
 *  crack more often than this (ms) to avoid spamming when multiple bullets
 *  pass close in the same frame. Returns the cooldown in ms. */
export function bulletCrackCooldownMs(): number {
  return 80; // max ~12 cracks/second — enough for a 30-round mag pass-by
}

// ─────────────────────────────────────────────────────────────────────────────
// #1032 — bullet penetration audio (muffled thump through wall)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1032 — bullet penetration audio slug. Returns the AudioEngine
 *  slug for the muffled thump when a bullet passes through a wall. The
 *  AudioEngine applies a low-pass filter based on the surface's density
 *  (the denser the wall, the lower the cutoff). */
export function bulletPenetrationAudioSlug(surface: string): string {
  return `penetrate_${surface}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// #1033–#1035 — bullet ricochet audio + spark + trail
// (The base ricochet spark VFX is in ProjectileSystem.ts:632-634.)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1033 — bullet ricochet audio slug. Played at the ricochet
 *  point — a sharp metallic ping off hard surfaces, a softer thud off
 *  softer ones. */
export function bulletRicochetAudioSlug(surface: string): string {
  switch (surface) {
    case "steel_plate": return "ricochet_metal_ping";
    case "sheet_metal": return "ricochet_metal_ping";
    case "concrete":    return "ricochet_concrete";
    case "brick":       return "ricochet_brick";
    case "glass":       return "ricochet_glass";
    default:            return "ricochet_generic";
  }
}

/** B3-5000 #1034 — bullet ricochet spark VFX slug. Aliases the existing
 *  ProjectileSystem spark-spawn (line 632-634) — the spark surface is
 *  passed through to spawnBulletImpact which reads SURFACE_VFX.sparkColor +
 *  sparkCount. This helper returns the surface slug for callers that don't
 *  already have it. */
export function bulletRicochetSparkSurface(surface: string): string {
  // The ricochet spark uses the same surface as the impact surface — the
  // SURFACE_VFX table already tunes spark color + count per surface.
  return surface;
}

/** B3-5000 #1035 — bullet ricochet trail visual. After a ricochet, the
 *  deflected bullet continues with a slightly dimmer trail (the ricocheted
 *  round is destabilized + losing velocity, so the tracer compound burns
 *  less brightly). Returns the visual config for the post-ricochet trail. */
export function bulletRicochetTrailVisual(ammoSlug: string): BulletTrailVisual {
  const base = bulletTrailVisual(ammoSlug);
  // Dim the ricocheted trail by 50%, halve the length (the round is slowing).
  return {
    ...base,
    opacity: base.opacity * 0.5,
    lengthM: base.lengthM * 0.5,
    glow: base.glow * 0.5,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #1036–#1038 — bullet fragmentation audio + spark + damage cone
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1036 — bullet fragmentation audio slug. Played when a hollow
 *  point fragments on impact — a distinctive "crack + spray" sound. */
export function bulletFragmentationAudioSlug(): string {
  return "bullet_fragment";
}

/** B3-5000 #1037 — bullet fragmentation spark VFX slug. The fragmentation
 *  spawns a cone of sparks (the jacket fragments fly outward). Returns the
 *  VFX slug the ParticleSystem reads. */
export function bulletFragmentationSparkSlug(): string {
  return "fragment_spray";
}

/** B3-5000 #1038 — bullet fragmentation damage cone. Returns the cone
 *  parameters (half-angle + range + damage falloff) for the fragmentation
 *  pattern when a hollow point hits a target. The fragments spread in a
 *  cone forward from the impact point, dealing reduced damage to anything
 *  in the cone.
 *
 *  Tuning:
 *    - Half-angle: 25° (typical HP fragment cone).
 *    - Range: 1.5m (fragments lose energy fast).
 *    - Damage falloff: 0.4 (fragments deal 40% of the parent bullet's damage).
 *    - Fragment count: 8 (jacket splits into ~8 pieces). */
export interface FragmentationCone {
  halfAngleRad: number;
  rangeM: number;
  damageFalloff: number;
  fragmentCount: number;
}

export function bulletFragmentationCone(): FragmentationCone {
  return {
    halfAngleRad: (25 * Math.PI) / 180,
    rangeM: 1.5,
    damageFalloff: 0.4,
    fragmentCount: 8,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #1039–#1041 — bullet overpenetration audio + visual (exit hole) + trail
// (The exit-hole decal VFX is already DONE in ProjectileSystem.ts:599-610.)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1039 — bullet overpenetration audio slug. Played when a bullet
 *  passes through a target (the distinct "thwip" of an exit wound +
 *  residual velocity). */
export function bulletOverpenetrationAudioSlug(): string {
  return "bullet_overpenetrate";
}

/** B3-5000 #1040 — bullet overpenetration visual slug (exit-hole decal).
 *  Aliases the existing ProjectileSystem.ts:599-610 exit-hole spawn. The
 *  decal is placed at the computed exit point with the entry-side surface
 *  normal. */
export function bulletOverpenetrationExitHoleSlug(): string {
  return "exit_hole_decal";
}

/** B3-5000 #1041 — bullet overpenetration trail. After a bullet passes
 *  through a target, the trail continues (dimmer — the round lost energy
 *  + the jacket may have deformed). Returns the visual config for the
 *  post-penetration trail. */
export function bulletOverpenetrationTrailVisual(ammoSlug: string): BulletTrailVisual {
  const base = bulletTrailVisual(ammoSlug);
  // Dim by 30%, shorten by 25% (the round is slower + destabilized).
  return {
    ...base,
    opacity: base.opacity * 0.7,
    lengthM: base.lengthM * 0.75,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #1042–#1044 — bullet deflection visual + audio + damage reduction
// (Distinct from ricochet: deflection is the bullet yawing inside a soft
//  target — e.g. a hollow point deflecting off a bone. The bullet doesn't
//  bounce off the surface; it changes angle inside the medium.)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1042 — bullet deflection visual. Returns the deflection angle
 *  (radians) the bullet should yaw when it hits a deflection surface (bone
 *  inside flesh, dense wood grain, etc.). The ProjectileSystem applies this
 *  as a small angle change to the bullet's travel direction inside the medium.
 *
 *  Tuning:
 *    - Bone: ±10° (the bullet yaws when it hits the hard bone).
 *    - Wood grain: ±5° (the bullet follows the grain slightly).
 *    - Sheet metal (thin): ±3° (the bullet yaws as it punches through).
 *    - Other: 0° (no deflection). */
export function bulletDeflectionAngleRad(surface: string): number {
  switch (surface) {
    case "bone":        return (Math.random() - 0.5) * (20 * Math.PI / 180);
    case "wood":        return (Math.random() - 0.5) * (10 * Math.PI / 180);
    case "sheet_metal": return (Math.random() - 0.5) * (6  * Math.PI / 180);
    default:            return 0;
  }
}

/** B3-5000 #1043 — bullet deflection audio slug. Played when a bullet
 *  deflects inside a target — a low "thump" (the bullet tumbling inside
 *  the medium). */
export function bulletDeflectionAudioSlug(): string {
  return "bullet_deflect";
}

/** B3-5000 #1044 — bullet deflection damage reduction. A deflected bullet
 *  loses damage (the deflection absorbs energy as the bullet yaws). Returns
 *  the damage multiplier (0..1). */
export function bulletDeflectionDamageMult(deflectionAngleRad: number): number {
  // 0° = 1.0 (no loss), 10° = 0.85, 20° = 0.7, 30°+ = 0.5.
  const deg = Math.abs(deflectionAngleRad) * 180 / Math.PI;
  if (deg < 1) return 1.0;
  return Math.max(0.5, 1.0 - deg * 0.015);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1045–#1050 — spin drift / Coriolis / transonic / subsonic visual + audio
// (The raw values are in Ballistics.ts:magnusSpinDriftM / coriolisDriftM /
//  transonicDragMult / producesSonicCrack. These helpers are the visual +
//  audio entry points the HUD/VFX/audio systems read.)
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1045 — bullet spin drift visual offset (m). The bullet curves
 *  slightly to the right (for right-hand-twist barrels) due to the Magnus
 *  effect. Aliases Ballistics.ts:magnusSpinDriftM — this helper is the
 *  HUD/VFX entry point (returns the lateral offset to display as a small
 *  windage adjustment in scoped ADS). */
export function bulletSpinDriftVisualM(rangeM: number): number {
  // Delegates to the existing Ballistics.ts:magnusSpinDriftM formula:
  // ~0.04m at 100m, ~0.16m at 200m, ~0.36m at 300m, ~0.64m at 400m.
  return 0.04 * Math.pow(rangeM / 100, 2);
}

/** B3-5000 #1046 — bullet Coriolis visual offset (m). The bullet drifts
 *  laterally due to the Earth's rotation. Aliases Ballistics.ts:coriolisDriftM.
 *  This helper returns the lateral offset to display in scoped ADS at the
 *  given latitude + range. */
export function bulletCoriolisVisualM(rangeM: number, latitudeDeg = 45, directionDeg = 0): number {
  // Coriolis drift is maximal at the poles, zero at the equator. The drift
  // is to the right in the northern hemisphere, left in the southern.
  // Simplified: ~0.06m at 1000m, latitude 45°, firing east/west.
  // Scale linearly with range (the effect accumulates over flight time).
  const lat = Math.abs(Math.sin(latitudeDeg * Math.PI / 180));
  // Direction matters: firing east/west = full effect; north/south = reduced.
  const dirFactor = Math.abs(Math.sin(directionDeg * Math.PI / 180));
  return rangeM * 0.00006 * lat * dirFactor;
}

/** B3-5000 #1047 — bullet transonic visual wobble. When the bullet's
 *  velocity drops into the transonic band (Mach 0.85–1.15), the bullet
 *  wobbles visibly (the shockwave detaches + re-attaches, destabilizing the
 *  bullet). Returns the wobble amplitude (radians) the ProjectileSystem
 *  should apply to the bullet's orientation.
 *
 *  Aliases Ballistics.ts:transonicDragMult for the gating (returns >1.0
 *  in the transonic band); this helper converts the drag multiplier into a
 *  visual wobble amplitude. */
export function bulletTransonicWobbleRad(velocityMs: number, speedOfSound = 343): number {
  const mach = velocityMs / speedOfSound;
  if (mach < 0.85 || mach > 1.15) return 0;
  // Peak wobble at Mach 1.0; falls off at the band edges.
  const peak = 1.0 - Math.abs(mach - 1.0) / 0.15;
  // Max wobble = 0.06 rad (~3.4° — matches Ballistics.ts:TRANSONIC_SCATTER_DEGREES).
  return Math.max(0, peak) * 0.06;
}

/** B3-5000 #1048 — bullet transonic audio pitch shift. When the bullet
 *  transitions through the transonic band, the doppler pitch shifts (the
 *  shockwave detaches + re-attaches, modulating the perceived pitch).
 *  Returns the pitch multiplier (1.0 = no shift, >1 = higher, <1 = lower). */
export function bulletTransonicPitchShift(velocityMs: number, speedOfSound = 343): number {
  const mach = velocityMs / speedOfSound;
  if (mach < 0.85 || mach > 1.15) return 1.0;
  // Pitch dips as the bullet slows through Mach 1.0 (the shockwave
  // detachment lowers the perceived frequency).
  const dip = (1.0 - Math.abs(mach - 1.0) / 0.15) * 0.1;
  return 1.0 - dip;
}

/** B3-5000 #1049 — bullet subsonic visual: no tracer. Subsonic rounds
 *  don't heat the tracer compound enough to ignite it (the slow bullet
 *  doesn't generate enough friction). Returns true if the tracer should be
 *  hidden. Aliases BULLET_TRAIL_VISUALS.subsonic.opacity === 0 + the
 *  ProjectileSystem.ts:211 `tracerHidden` opt. */
export function bulletSubsonicHidesTracer(ammoSlug: string): boolean {
  return ammoSlug === "subsonic";
}

/** B3-5000 #1050 — bullet subsonic audio: no supersonic crack. Subsonic
 *  rounds don't break the sound barrier, so they don't produce a crack.
 *  Returns true if the crack should be suppressed. Aliases
 *  Ballistics.ts:producesSonicCrack (inverted — producesSonicCrack returns
 *  true for supersonic; this returns true for "should suppress crack"). */
export function bulletSubsonicHidesCrack(velocityMs: number, speedOfSound = 343): boolean {
  return velocityMs < speedOfSound;
}
