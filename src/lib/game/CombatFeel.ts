/**
 * Phase 11: Gameplay Loop & Combat Feel.
 *
 * Tunes gunplay, movement, AI behavior, and pacing for a more
 * responsive + satisfying game feel. All values are tunable constants.
 */

export interface CombatFeelConfig {
  /** Weapon sway amplitude when aiming (lower = steadier). */
  aimSwayMultiplier: number;
  /** Weapon sway amplitude when not aiming. */
  hipSwayMultiplier: number;
  /** Recoil recovery rate (higher = faster recovery). */
  recoilRecoveryRate: number;
  /** Crosshair expansion per shot (pixels). */
  crosshairExpandPerShot: number;
  /** Crosshair recovery rate. */
  crosshairRecoveryRate: number;
  /** Hit marker duration (ms). */
  hitMarkerDuration: number;
  /** Damage flash duration (ms). */
  damageFlashDuration: number;
  /** Kill feed display duration (ms). */
  killFeedDuration: number;
  /** Headshot multiplier. */
  headshotMultiplier: number;
  /** Suppression decay rate per second. */
  suppressionDecayRate: number;
  /** Suppression gain per near-miss (within 5m). */
  suppressionGainNear: number;
  /** Suppression gain per near-miss (within 15m). */
  suppressionGainFar: number;
}

export interface MovementFeelConfig {
  /** Base walk speed (m/s). */
  walkSpeed: number;
  /** Sprint speed (m/s). */
  sprintSpeed: number;
  /** Crouch speed (m/s). */
  crouchSpeed: number;
  /** ADS speed (m/s). */
  adsSpeed: number;
  /** Acceleration on ground. */
  groundAccel: number;
  /** Acceleration in air. */
  airAccel: number;
  /** Jump velocity. */
  jumpVelocity: number;
  /** Gravity. */
  gravity: number;
  /** Step interval when walking (seconds). */
  walkStepInterval: number;
  /** Step interval when sprinting. */
  sprintStepInterval: number;
  /** Step interval when crouching. */
  crouchStepInterval: number;
  /** Camera bob amplitude. */
  bobAmplitude: number;
  /** Camera bob frequency. */
  bobFrequency: number;
}

export interface PacingConfig {
  /** Initial wave enemy count. */
  waveBaseEnemies: number;
  /** Enemies added per wave. */
  waveEnemiesPerWave: number;
  /** Delay between waves (ms). */
  waveTransitionDelay: number;
  /** Max waves for SURVIVAL mode. */
  survivalMaxWaves: number;
  /** Enemy health scaling per wave. */
  enemyHealthPerWave: number;
  /** Enemy speed scaling per wave. */
  enemySpeedPerWave: number;
  /** Enemy accuracy scaling per wave (0..1, added to base). */
  enemyAccuracyPerWave: number;
}

export const COMBAT_FEEL: CombatFeelConfig = {
  aimSwayMultiplier: 0.4,
  hipSwayMultiplier: 1.0,
  recoilRecoveryRate: 8,
  crosshairExpandPerShot: 8,
  crosshairRecoveryRate: 5,
  hitMarkerDuration: 180,
  damageFlashDuration: 350,
  killFeedDuration: 4500,
  headshotMultiplier: 2.2,
  suppressionDecayRate: 0.2,
  suppressionGainNear: 0.18,
  suppressionGainFar: 0.08,
};

export const MOVEMENT_FEEL: MovementFeelConfig = {
  walkSpeed: 5.2,
  sprintSpeed: 8.2,
  crouchSpeed: 2.4,
  adsSpeed: 3.0,
  groundAccel: 60,
  airAccel: 12,
  jumpVelocity: 7.2,
  gravity: 22,
  walkStepInterval: 0.45,
  sprintStepInterval: 0.3,
  crouchStepInterval: 0.6,
  bobAmplitude: 0.04,
  bobFrequency: 1.4,
};

export const PACING: PacingConfig = {
  waveBaseEnemies: 3,
  waveEnemiesPerWave: 2,
  waveTransitionDelay: 2500,
  survivalMaxWaves: 6,
  enemyHealthPerWave: 10,
  enemySpeedPerWave: 0.3,
  enemyAccuracyPerWave: 0.02,
};

/**
 * Phase 11: QOL improvements — quality-of-life features.
 */
export interface QOLFeature {
  /** Auto-reload when ammo hits 0. */
  autoReload: boolean;
  /** Show hit marker on headshots (distinct color). */
  headshotHitMarker: boolean;
  /** Show damage direction indicator. */
  damageDirectionIndicator: boolean;
  /** Auto-pickup medical items when walking over them. */
  autoPickupMedical: boolean;
  /** Show enemy health bars when damaged. */
  enemyHealthBars: boolean;
  /** Highlight enemies in scope view. */
  scopeHighlight: boolean;
  /** Show kill confirm sound. */
  killConfirmSound: boolean;
  /** Auto-switch to secondary when primary is empty. */
  autoSwitchOnEmpty: boolean;
  /** Show ammo count on weapon viewmodel. */
  ammoCounterOnWeapon: boolean;
  /** Quick-swap weapon (last used) on Q key. */
  quickSwap: boolean;
}

export const DEFAULT_QOL: QOLFeature = {
  autoReload: true,
  headshotHitMarker: true,
  damageDirectionIndicator: true,
  autoPickupMedical: false,
  enemyHealthBars: true,
  scopeHighlight: true,
  killConfirmSound: true,
  autoSwitchOnEmpty: true,
  ammoCounterOnWeapon: false,
  quickSwap: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Section B — Prompts 224–227: crosshair bloom, crosshair editor, hitmarker
// customization, hitmarker kill/hit/headshot differentiation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 224 — crosshair bloom config. The hipfire crosshair expands while
 * moving/firing + contracts when still. The bloom gap multiplier is applied
 * to the crosshair's base gap.
 */
export interface CrosshairBloomConfig {
  /** Bloom amount per unit of movement speed (gap-pixels per m/s). */
  moveBloomPerMs: number;
  /** Bloom amount per shot (gap-pixels). */
  shotBloomPerShot: number;
  /** Recovery rate (gap-pixels per second). */
  recoveryPerSec: number;
  /** Max bloom multiplier (relative to base gap). */
  maxBloomMult: number;
}

export const DEFAULT_CROSSHAIR_BLOOM: CrosshairBloomConfig = {
  moveBloomPerMs: 0.5,
  shotBloomPerShot: 8,
  recoveryPerSec: 30,
  maxBloomMult: 3.0,
};

/**
 * Prompt 224 — compute the current bloom gap multiplier given the player's
 * movement speed + recent shots. Returns a multiplier on the base gap.
 */
export function computeCrosshairBloom(
  moveSpeedMs: number,
  shotsInLastSec: number,
  cfg: CrosshairBloomConfig = DEFAULT_CROSSHAIR_BLOOM,
): number {
  const moveBloom = moveSpeedMs * cfg.moveBloomPerMs;
  const shotBloom = shotsInLastSec * cfg.shotBloomPerShot;
  const baseMult = 1.0 + moveBloom / 10 + shotBloom / 10;
  return Math.min(cfg.maxBloomMult, baseMult);
}

/**
 * Prompt 225 — crosshair editor config. The player can customize the
 * crosshair color, thickness, gap, dot, and outline in settings.
 */
export interface CrosshairEditorConfig {
  color: number;
  thickness: number;
  gap: number;
  dot: boolean;
  outline: boolean;
  outlineColor: number;
  /** Hitmarker color (overrides default when set). */
  hitmarkerColor?: number;
  /** Hitmarker size. */
  hitmarkerSize?: number;
}

export const DEFAULT_CROSSHAIR_EDITOR: CrosshairEditorConfig = {
  color: 0x00ff00,
  thickness: 2,
  gap: 6,
  dot: false,
  outline: true,
  outlineColor: 0x000000,
  hitmarkerColor: 0xffffff,
  hitmarkerSize: 12,
};

/**
 * Prompt 226 — hitmarker customization. Color, size, sound, headshot variant.
 */
export interface HitmarkerCustomization {
  /** Hit color. */
  hitColor: number;
  /** Headshot color (distinct variant). */
  headshotColor: number;
  /** Kill color (distinct variant). */
  killColor: number;
  /** Size (pixels). */
  size: number;
  /** Headshot size multiplier (headshots are bigger). */
  headshotSizeMult: number;
  /** Kill size multiplier. */
  killSizeMult: number;
  /** Play a sound on hit. */
  sound: boolean;
  /** Distinct headshot sound. */
  headshotSound: boolean;
  /** Distinct kill sound. */
  killSound: boolean;
}

export const DEFAULT_HITMARKER_CUSTOMIZATION: HitmarkerCustomization = {
  hitColor: 0xffffff,
  headshotColor: 0xff5555,
  killColor: 0xff3333,
  size: 12,
  headshotSizeMult: 1.3,
  killSizeMult: 1.5,
  sound: true,
  headshotSound: true,
  killSound: true,
};

/**
 * Prompt 227 — get the hitmarker visual + audio for the given hit type.
 * Returns the color, size, and whether to play a sound.
 */
export function hitmarkerForType(
  hitType: "hit" | "headshot" | "kill",
  cfg: HitmarkerCustomization = DEFAULT_HITMARKER_CUSTOMIZATION,
): { color: number; size: number; playSound: boolean } {
  switch (hitType) {
    case "headshot":
      return {
        color: cfg.headshotColor,
        size: Math.round(cfg.size * cfg.headshotSizeMult),
        playSound: cfg.sound && cfg.headshotSound,
      };
    case "kill":
      return {
        color: cfg.killColor,
        size: Math.round(cfg.size * cfg.killSizeMult),
        playSound: cfg.sound && cfg.killSound,
      };
    case "hit":
    default:
      return {
        color: cfg.hitColor,
        size: cfg.size,
        playSound: cfg.sound,
      };
  }
}
