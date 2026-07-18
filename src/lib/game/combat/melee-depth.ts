/**
 * SEC5-COMBAT — Prompt 47: Melee combat depth.
 *
 * The existing MeleeSystem.ts supports two attacks: `trySlash()` (50 dmg,
 * 2.5m range, 800ms cooldown) + `tryTakedown()` (instakill from behind, 1.8m,
 * 800ms cooldown). Both are single-hit; there's no combo system + no parry.
 *
 * This module defines the combo + parry layer that the orchestrator wires into
 * MeleeSystem.ts (one-liner per attack). Each melee weapon (knife, axe, katana,
 * machete, crowbar, sledgehammer — see store.MELEE_WEAPONS) gets a 3-hit combo
 * table. Each combo hit has:
 *
 *   - `direction` — "left" | "right" | "overhead" | "thrust" (drives animation + arc).
 *   - `damageMult` — multiplier on the weapon's base damage (1.0, 1.1, 1.3 for
 *     escalating combos). The 3rd hit is the finisher.
 *   - `rangeMult` — multiplier on the weapon's base range (some combos reach
 *     further — e.g. the katana's 3rd hit is a thrust).
 *   - `windupMs` — pre-swing delay (the existing 800ms cooldown becomes a
 *     per-hit windup).
 *   - `recoveryMs` — post-swing recovery (player can't act).
 *   - `comboWindowMs` — grace period after this hit during which the next hit
 *     in the combo can be triggered. If the player doesn't press melee within
 *     this window, the combo resets to hit 0.
 *
 * Parry: every melee weapon has a `MELEE_PARRY_WINDOW_MS` — the window during
 * a swing's windup where the player can be parried by an enemy melee attack.
 * A successful parry stuns the attacker for 600ms + knocks their weapon aside
 * (they can't attack during the stun). The parry window is short (120-180ms)
 * — it's a deliberate defensive read, not a spam mechanic.
 *
 * The orchestrator wires this by:
 *
 *   1. On melee key press, call `getCombo(slug, currentHitIndex)` to read the
 *      combo hit. MeleeSystem.trySlash applies the hit's damageMult + rangeMult.
 *   2. After the hit, set `lastMeleeTime = now` + schedule a combo-reset check
 *      at `now + comboWindowMs`. If the next melee press arrives before that,
 *      advance the combo index; otherwise reset to 0.
 *   3. For parry: when an enemy melee attack is detected within the player's
 *      swing windup, check `getParryWindow(slug)` for the active window. If
 *      the enemy's swing started within the window, trigger the parry.
 *
 * Tone reference: see src/lib/game/DESIGN.md (tactical-mil-sim-leaning-arcade).
 * Melee combos are short (3 hits max) + the parry window is tight. This isn't
 * a fighting game — melee is the "I'm out of ammo / I'm flanking" tool.
 */

import { MELEE_WEAPON_MAP, type MeleeWeaponConfig } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Combo definitions
// ─────────────────────────────────────────────────────────────────────────────

export type MeleeDirection = "left" | "right" | "overhead" | "thrust";

export interface MeleeComboHit {
  /** Hit index in the combo (0, 1, or 2). */
  index: 0 | 1 | 2;
  /** Swing direction — drives the animation + the arc of the hit cone. */
  direction: MeleeDirection;
  /** Damage multiplier on the weapon's base MeleeStats.damage. */
  damageMult: number;
  /** Range multiplier on the weapon's base MeleeStats.range. */
  rangeMult: number;
  /** Pre-swing windup (ms). The damage applies at the end of windup. */
  windupMs: number;
  /** Post-swing recovery (ms). Player can't act during recovery. */
  recoveryMs: number;
  /** Combo window after this hit (ms). If the next melee press arrives within
   *  this window, advance the combo; otherwise reset to hit 0. */
  comboWindowMs: number;
  /** Cone half-angle for this hit (radians). Overhead is tighter (more
   *  precise); left/right are wider (cleaving arcs). */
  coneHalfAngle: number;
}

export interface MeleeCombo {
  /** Weapon slug (matches MELEE_WEAPON_MAP keys). */
  slug: string;
  /** Up to 3 hits. The 3rd hit is the finisher (highest damageMult). */
  hits: MeleeComboHit[];
  /** Parry window during the windup of any hit (ms). */
  parryWindowMs: number;
  /** Cooldown after a missed swing (no combo follow-up) — ms. */
  missCooldownMs: number;
}

/**
 * Per-melee-weapon combo tables. 3-hit combos for each of the 6 melee weapons
 * in MELEE_WEAPON_MAP. Damage escalates across the combo; the 3rd hit is the
 * finisher.
 *
 * Tuning philosophy (mil-sim-leaning-arcade):
 *   - Knife: fast + light. 3 quick slashes. Low per-hit but high combo speed.
 *   - Axe: slow + heavy. 2 chops + 1 thrust. High damage, slow recovery.
 *   - Katana: long reach + precise. 3 cuts with escalating reach.
 *   - Machete: wide arcs. 3 slashes with wide cones (cleaves).
 *   - Crowbar: hook + smash. Unconventional combo — hook pulls, smash finishes.
 *   - Sledgehammer: devastating but slow. Overhead smash + ground pound.
 */
export const MELEE_COMBOS: Record<string, MeleeCombo> = {
  knife: {
    slug: "knife",
    hits: [
      { index: 0, direction: "right",   damageMult: 1.0, rangeMult: 1.0, windupMs: 120, recoveryMs: 200, comboWindowMs: 450, coneHalfAngle: Math.PI / 4 },
      { index: 1, direction: "left",    damageMult: 1.1, rangeMult: 1.0, windupMs: 110, recoveryMs: 200, comboWindowMs: 450, coneHalfAngle: Math.PI / 4 },
      { index: 2, direction: "thrust",  damageMult: 1.4, rangeMult: 1.2, windupMs: 150, recoveryMs: 350, comboWindowMs: 0,    coneHalfAngle: Math.PI / 6 },
    ],
    parryWindowMs: 130,
    missCooldownMs: 600,
  },
  axe: {
    slug: "axe",
    hits: [
      { index: 0, direction: "overhead",damageMult: 1.0, rangeMult: 1.0, windupMs: 220, recoveryMs: 350, comboWindowMs: 550, coneHalfAngle: Math.PI / 5 },
      { index: 1, direction: "right",   damageMult: 1.1, rangeMult: 1.0, windupMs: 200, recoveryMs: 350, comboWindowMs: 550, coneHalfAngle: Math.PI / 4 },
      { index: 2, direction: "overhead",damageMult: 1.5, rangeMult: 1.1, windupMs: 280, recoveryMs: 500, comboWindowMs: 0,    coneHalfAngle: Math.PI / 6 },
    ],
    parryWindowMs: 160,
    missCooldownMs: 800,
  },
  katana: {
    slug: "katana",
    hits: [
      { index: 0, direction: "right",   damageMult: 1.0, rangeMult: 1.0, windupMs: 180, recoveryMs: 280, comboWindowMs: 500, coneHalfAngle: Math.PI / 5 },
      { index: 1, direction: "left",    damageMult: 1.1, rangeMult: 1.05,windupMs: 170, recoveryMs: 280, comboWindowMs: 500, coneHalfAngle: Math.PI / 5 },
      { index: 2, direction: "thrust",  damageMult: 1.6, rangeMult: 1.3, windupMs: 220, recoveryMs: 450, comboWindowMs: 0,    coneHalfAngle: Math.PI / 8 },
    ],
    parryWindowMs: 140,
    missCooldownMs: 700,
  },
  machete: {
    slug: "machete",
    hits: [
      { index: 0, direction: "right",   damageMult: 1.0, rangeMult: 1.0, windupMs: 160, recoveryMs: 300, comboWindowMs: 500, coneHalfAngle: Math.PI / 3 },
      { index: 1, direction: "left",    damageMult: 1.1, rangeMult: 1.0, windupMs: 150, recoveryMs: 300, comboWindowMs: 500, coneHalfAngle: Math.PI / 3 },
      { index: 2, direction: "overhead",damageMult: 1.4, rangeMult: 1.0, windupMs: 200, recoveryMs: 400, comboWindowMs: 0,    coneHalfAngle: Math.PI / 5 },
    ],
    parryWindowMs: 150,
    missCooldownMs: 700,
  },
  crowbar: {
    slug: "crowbar",
    hits: [
      { index: 0, direction: "thrust",  damageMult: 0.9, rangeMult: 1.1, windupMs: 200, recoveryMs: 300, comboWindowMs: 500, coneHalfAngle: Math.PI / 6 }, // hook
      { index: 1, direction: "right",   damageMult: 1.1, rangeMult: 1.0, windupMs: 180, recoveryMs: 320, comboWindowMs: 500, coneHalfAngle: Math.PI / 4 }, // swing
      { index: 2, direction: "overhead",damageMult: 1.5, rangeMult: 1.0, windupMs: 260, recoveryMs: 480, comboWindowMs: 0,    coneHalfAngle: Math.PI / 6 }, // smash
    ],
    parryWindowMs: 150,
    missCooldownMs: 750,
  },
  sledgehammer: {
    slug: "sledgehammer",
    hits: [
      { index: 0, direction: "overhead",damageMult: 1.0, rangeMult: 1.0, windupMs: 280, recoveryMs: 450, comboWindowMs: 600, coneHalfAngle: Math.PI / 6 },
      { index: 1, direction: "right",   damageMult: 1.1, rangeMult: 1.0, windupMs: 260, recoveryMs: 450, comboWindowMs: 600, coneHalfAngle: Math.PI / 5 },
      { index: 2, direction: "overhead",damageMult: 1.8, rangeMult: 1.1, windupMs: 380, recoveryMs: 700, comboWindowMs: 0,    coneHalfAngle: Math.PI / 6 }, // ground pound
    ],
    parryWindowMs: 180,
    missCooldownMs: 900,
  },
};

/**
 * Default parry window for melee weapons not in the MELEE_COMBOS table.
 * Conservative — the parry window is the defensive read against an enemy
 * melee swing.
 */
export const MELEE_PARRY_WINDOW_MS = 150;

// ─────────────────────────────────────────────────────────────────────────────
// Accessors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get the combo hit at the given index for a melee weapon. Falls back to the
 * first hit (index 0) if the index is out of range (e.g. the combo was reset).
 *
 * @param slug     Melee weapon slug (knife, axe, katana, machete, crowbar, sledgehammer).
 * @param hitIndex Combo hit index (0, 1, or 2). Out-of-range wraps to 0.
 * @returns        The MeleeComboHit. If the slug isn't in MELEE_COMBOS, returns
 *                 a generic single-hit (damageMult 1.0, no combo follow-up).
 */
export function getCombo(slug: string, hitIndex: number): MeleeComboHit {
  const combo = MELEE_COMBOS[slug];
  if (!combo) {
    // Generic fallback — single hit, no combo.
    return {
      index: 0,
      direction: "right",
      damageMult: 1.0,
      rangeMult: 1.0,
      windupMs: 150,
      recoveryMs: 300,
      comboWindowMs: 0,
      coneHalfAngle: Math.PI / 4,
    };
  }
  const idx = Math.max(0, Math.min(combo.hits.length - 1, hitIndex)) as 0 | 1 | 2;
  return combo.hits[idx];
}

/**
 * Get the parry window for a melee weapon. This is the window during the
 * swing's windup where the player can be parried by an enemy melee attack.
 * Falls back to MELEE_PARRY_WINDOW_MS (150ms) if the slug isn't in the table.
 */
export function getParryWindow(slug: string): number {
  return MELEE_COMBOS[slug]?.parryWindowMs ?? MELEE_PARRY_WINDOW_MS;
}

/**
 * Get the full combo definition for a melee weapon (all 3 hits + parry window).
 * Returns undefined if the slug isn't in MELEE_COMBOS.
 */
export function getMeleeCombo(slug: string): MeleeCombo | undefined {
  return MELEE_COMBOS[slug];
}

/**
 * Compute the effective damage for a combo hit. Base damage comes from the
 * weapon's MeleeStats.damage; the combo hit's damageMult is applied.
 */
export function getComboDamage(slug: string, hitIndex: number): number {
  const weapon = MELEE_WEAPON_MAP[slug] as MeleeWeaponConfig | undefined;
  const baseDamage = weapon?.stats.damage ?? 50;
  const hit = getCombo(slug, hitIndex);
  return Math.round(baseDamage * hit.damageMult);
}

/**
 * Compute the effective range for a combo hit. Base range comes from the
 * weapon's MeleeStats.range; the combo hit's rangeMult is applied.
 */
export function getComboRange(slug: string, hitIndex: number): number {
  const weapon = MELEE_WEAPON_MAP[slug] as MeleeWeaponConfig | undefined;
  const baseRange = weapon?.stats.range ?? 1.6;
  const hit = getCombo(slug, hitIndex);
  return baseRange * hit.rangeMult;
}

/**
 * Compute the effective backstab damage for a combo hit. Base damage comes
 * from the weapon's MeleeStats.damage × backstabMult; the combo hit's
 * damageMult is applied on top.
 */
export function getComboBackstabDamage(slug: string, hitIndex: number): number {
  const weapon = MELEE_WEAPON_MAP[slug] as MeleeWeaponConfig | undefined;
  const baseDamage = weapon?.stats.damage ?? 50;
  const backstabMult = weapon?.stats.backstabMult ?? 2.0;
  const hit = getCombo(slug, hitIndex);
  return Math.round(baseDamage * backstabMult * hit.damageMult);
}

// ─────────────────────────────────────────────────────────────────────────────
// Combo state machine (pure — the engine owns the mutable state)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the next combo hit index given the current index + the time since
 * the last hit. Returns 0 if the combo window has expired (reset); otherwise
 * returns the next index (capped at the combo's max).
 *
 * Pure function — the engine owns the `currentHitIndex` state + calls this
 * on each melee key press to compute the next index.
 */
export function advanceComboIndex(
  slug: string,
  currentHitIndex: number,
  msSinceLastHit: number,
): number {
  const combo = MELEE_COMBOS[slug];
  if (!combo) return 0;
  const currentHit = combo.hits[Math.min(currentHitIndex, combo.hits.length - 1)];
  // If the combo window has expired (or the current hit doesn't allow a
  // follow-up), reset to 0.
  if (msSinceLastHit > currentHit.comboWindowMs) return 0;
  // Advance to the next hit, capping at the last hit (which has comboWindowMs=0
  // so it always resets after).
  const next = currentHitIndex + 1;
  if (next >= combo.hits.length) return 0;
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring notes (for the orchestrator — one-liners, none touch shared files)
// ─────────────────────────────────────────────────────────────────────────────
//
// The existing MeleeSystem.trySlash + tryTakedown are kept as the entry points.
// The orchestrator adds combo + parry state on the MeleeSystem instance:
//
//   // In MeleeSystem (add 3 private fields + 2 methods):
//   private comboHitIndex = 0;
//   private lastComboHitTime = 0;
//   private swingWindupStart = 0;
//
//   trySlash(): boolean {
//     // ... existing cooldown check ...
//     const slug = this.ctx.weapon.loadout.melee;
//     const now = performance.now();
//     // Advance the combo index (resets if the window expired).
//     if (now - this.lastComboHitTime > 600) this.comboHitIndex = 0;
//     else this.comboHitIndex = advanceComboIndex(slug, this.comboHitIndex, now - this.lastComboHitTime);
//     const hit = getCombo(slug, this.comboHitIndex);
//     this.lastComboHitTime = now;
//     this.swingWindupStart = now;
//     // Apply the hit's damageMult + rangeMult.
//     const dmg = getComboDamage(slug, this.comboHitIndex);
//     const range = getComboRange(slug, this.comboHitIndex);
//     const target = this.findEnemyInCone(range, hit.coneHalfAngle);
//     if (target) {
//       this.onDamageEnemy?.(target, dmg, false, target.group.position);
//       this.onSpawnBlood?.(target.group.position);
//       if (!target.alive) this.ctx.match.meleeKills++;
//       return true;
//     }
//     return false;
//   }
//
// For parry: the existing EnemySystem doesn't have enemy melee attacks yet
// (enemies are ranged). When enemy melee is added (future SEC), the parry
// window check is:
//
//   const playerSlug = ctx.weapon.loadout.melee;
//   const parryWindow = getParryWindow(playerSlug);
//   const msSinceWindupStart = now - meleeSystem.swingWindupStart;
//   if (msSinceWindupStart < parryWindow) {
//     // Parry success — stun the attacker + knock their weapon aside.
//     enemyMeleeAttacker.stunnedUntil = now + 600;
//   }

// ─────────────────────────────────────────────────────────────────────────────
// B1-5000 — Prompts 702 (melee arc trace), 705 (destructible props), 706
// (knockback), 710 (combo finisher bonus), 711 (stamina cost), 712 (vs vehicle).
//
// These helpers extend the existing MeleeSystem with the missing prompts from
// Section B (601–767). The system already covers: 701 (lunge arc), 703
// (backstab multiplier), 704 (wallbang melee), 707 (parry window), 708
// (melee weapon variety — 6 weapons in MELEE_COMBOS), 709 (finisher via
// onFinisher hook), 713–717 (bug fixes — dedicated swing sound, 60° takedown
// cone, 3D cone, deferred kill count, per-frame combo reset).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 702 — melee arc trace. Instead of a single instant cone check, the
 * swing traces over the windup + swing duration. This helper returns the
 * per-tick arc check parameters so the engine can call findEnemyInCone at
 * 5 sub-steps during the swing.
 *
 * The arc starts at swingStartMs + windupMs (the start of the swing after
 * the windup), and lasts for swingDurationMs. The engine samples 5 sub-steps
 * during the swing so a target moving into the cone mid-swing is hit.
 *
 * Returns the timestamps (ms) at which the engine should sample the cone.
 */
export function meleeArcSampleTimes(
  swingStartMs: number,
  windupMs: number,
  swingDurationMs: number,
  samples: number = 5,
): number[] {
  const start = swingStartMs + windupMs;
  const step = swingDurationMs / Math.max(1, samples - 1);
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    times.push(start + step * i);
  }
  return times;
}

/** Default swing duration (ms) — used by the arc trace if the combo hit
 *  doesn't specify one explicitly. */
export const DEFAULT_MELEE_SWING_DURATION_MS = 150;

/**
 * Prompt 705 — melee vs destructible props. Returns the damage to apply to a
 * destructible prop hit by a melee swing + whether the prop should shatter.
 * Glass + small props shatter; crates + barrels take damage but don't
 * shatter unless destroyed.
 *
 * The damage scales with the melee weapon's base damage + a prop-type
 * multiplier. Glass takes 2× damage (shatters easily); wood crates take 1×;
 * metal barrels take 0.5× (melee can't dent metal easily).
 */
export function meleePropDamage(
  baseDamage: number,
  propMaterialSlug: string,
): { damage: number; shatters: boolean } {
  const multByProp: Record<string, { mult: number; shatters: boolean }> = {
    glass:    { mult: 2.0, shatters: true },
    wood:     { mult: 1.0, shatters: false },
    drywall:  { mult: 1.5, shatters: true },
    sheet_metal: { mult: 0.5, shatters: false },
    steel_plate: { mult: 0.2, shatters: false },
    plastic:  { mult: 1.2, shatters: true },
    concrete: { mult: 0.1, shatters: false },
    brick:    { mult: 0.15, shatters: false },
  };
  const entry = multByProp[propMaterialSlug] ?? { mult: 1.0, shatters: false };
  return { damage: Math.round(baseDamage * entry.mult), shatters: entry.shatters };
}

/**
 * Prompt 706 — melee knockback. The melee weapon's `knockback` field (from
 * MELEE_WEAPON_MAP) defines the impulse applied to the target on hit. This
 * helper returns the knockback impulse vector (direction × magnitude) for
 * the engine to apply to the target's velocity.
 *
 * Heavier weapons (sledgehammer) knock back harder; the knife has minimal
 * knockback. The default knockback (when the weapon doesn't define one) is
 * 4 m/s — enough to push a target back ~0.5m.
 */
export const DEFAULT_MELEE_KNOCKBACK_MAGNITUDE = 4.0;

export function meleeKnockbackImpulse(
  forwardDir: { x: number; y: number; z: number },
  knockbackMagnitude: number = DEFAULT_MELEE_KNOCKBACK_MAGNITUDE,
): { x: number; y: number; z: number } {
  return {
    x: forwardDir.x * knockbackMagnitude,
    y: forwardDir.y * knockbackMagnitude * 0.3, // slight upward bias
    z: forwardDir.z * knockbackMagnitude,
  };
}

/**
 * Prompt 710 — combo finisher bonus. The 3rd hit of a combo applies a special
 * effect: knockdown (sledgehammer), stagger (axe/katana), or bleed (knife/
 * machete). This helper returns the finisher effect for a given combo hit
 * index + weapon slug.
 *
 * Returns null for non-finisher hits (index 0 or 1). Returns the effect for
 * the 3rd hit (index 2).
 */
export type ComboFinisherEffect = "knockdown" | "stagger" | "bleed" | null;

export function comboFinisherEffect(slug: string, hitIndex: number): ComboFinisherEffect {
  if (hitIndex !== 2) return null;
  switch (slug) {
    case "sledgehammer": return "knockdown";
    case "axe":
    case "katana":
    case "crowbar": return "stagger";
    case "knife":
    case "machete": return "bleed";
    default: return null;
  }
}

/** Prompt 710 — combo finisher effect duration (ms). Knockdown = 1500ms,
 *  stagger = 600ms, bleed = 4000ms (DoT). */
export function comboFinisherDurationMs(effect: ComboFinisherEffect): number {
  switch (effect) {
    case "knockdown": return 1500;
    case "stagger": return 600;
    case "bleed": return 4000;
    default: return 0;
  }
}

/** Prompt 710 — combo finisher bleed DPS (damage per second). */
export const COMBO_BLEED_DPS = 8;

/**
 * Prompt 711 — melee stamina cost. Each melee swing costs stamina; heavier
 * weapons cost more. The engine applies this cost on swing start; if stamina
 * is below the cost, the swing is a weak "exhausted" version (50% damage).
 *
 * Returns the stamina cost for a swing of the given weapon. Default 12
 * (matches the existing MeleeSystem's stamina drain baseline).
 */
export const MELEE_STAMINA_COST: Record<string, number> = {
  knife: 8,
  machete: 12,
  axe: 18,
  katana: 14,
  crowbar: 16,
  sledgehammer: 25,
};

export function meleeStaminaCost(slug: string): number {
  return MELEE_STAMINA_COST[slug] ?? 12;
}

/** Prompt 711 — exhausted-melee damage multiplier. Below the stamina cost,
 *  the swing deals 50% damage. */
export const EXHAUSTED_MELEE_DAMAGE_MULT = 0.5;

/**
 * Prompt 712 — melee vs vehicle. Vehicles are immune to melee damage from
 * most weapons (the knife bounces off the armor). The sledgehammer + crowbar
 * can damage light vehicles (ATVs, unarmored cars) for 5–10 damage per hit.
 * Heavily armored vehicles (APCs, tanks) are immune.
 *
 * Returns the damage to apply to the vehicle + whether the melee "bounces"
 * (no damage + a spark VFX + a metallic clang audio).
 */
export function meleeVsVehicle(
  slug: string,
  vehicleArmorClass: "light" | "medium" | "heavy",
): { damage: number; bounces: boolean } {
  if (vehicleArmorClass === "heavy") {
    return { damage: 0, bounces: true };
  }
  if (vehicleArmorClass === "medium") {
    // Only sledgehammer + crowbar can damage medium armor.
    if (slug === "sledgehammer") return { damage: 3, bounces: false };
    if (slug === "crowbar") return { damage: 2, bounces: false };
    return { damage: 0, bounces: true };
  }
  // Light armor — all weapons damage, but knives/machetes do less.
  const dmgBySlug: Record<string, number> = {
    knife: 5, machete: 8, axe: 12, katana: 10, crowbar: 15, sledgehammer: 20,
  };
  return { damage: dmgBySlug[slug] ?? 5, bounces: false };
}
