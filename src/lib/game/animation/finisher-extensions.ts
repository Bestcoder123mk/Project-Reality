/**
 * Section B — Animation & Finishers
 * ─────────────────────────────────────────────────────────────────────────────
 * FinisherExtensions — 4 new finishers added to the existing 6 (slam, throw,
 * shark, suplex, squish, disintegrate) in src/lib/game/systems/FinisherSystem.ts.
 *
 * New finishers:
 *   7. execute   — execution-style neck-snap (grounded; CQC takedown)
 *   8. disarm    — CQC disarm + counter-shot (grounded; player FP rig)
 *   9. throatSlit — knife-lunge throat slit (grounded; ragdoll corpse)
 *  10. backstab  — backstab from behind (grounded; stealth takedown)
 *
 * B-prompt mapping:
 *   B-00042 / B-00076 / B-00093 — execution-style neck-snap finisher.
 *   B-00043 / B-00092 / B-00099 — CQC disarm finisher.
 *   B-00018 / B-00019 / B-00040 / B-00078 — back-lean corner slice / knife lunge.
 *   B-00026 / B-00051 / B-00072 / B-00075 — lean around doorframe (backstab
 *     from behind corner — same driver).
 *   B-00099 — knife-lunge finisher (boss NPC).
 *
 * Each finisher exposes:
 *   - Config (slug, name, desc, tone, rarity, duration) — matches the
 *     existing FinisherConfig shape from FinisherSystem.ts.
 *   - AnimFn(seq, t, ctx) — the per-frame procedural transform driver.
 *     Mirrors the signature of the existing animSlam/animThrow/etc.
 *     private methods on FinisherSystem.
 *
 * The host (FinisherSystem) can integrate these by:
 *   1. Extending its FinisherSlug union to include the 4 new slugs.
 *   2. Merging EXTENDED_FINISHERS into its FINISHERS record.
 *   3. Adding a case in its switch(seq.slug) dispatch to call the matching
 *      anim function from this module.
 *
 * SSR-safe: pure THREE + TS; no window/document.
 *
 * Public API:
 *   - EXTENDED_FINISHER_SLUGS — the 4 new slugs.
 *   - EXTENDED_FINISHERS — config catalog (Record<slug, FinisherConfig>).
 *   - animExecute / animDisarm / animThroatSlit / animBackstab — drivers.
 *   - EXTENDED_FINISHER_ANIM_FNS — slug → anim-fn map (for host dispatch).
 *   - pickRandomExtendedFinisher(tone?) — random slug from the catalog.
 */

import * as THREE from "three";
import type { Rarity } from "../store";

// ───────────────────────────────────────────────────────────────────────────
// Types (mirror FinisherSystem.ts)
// ───────────────────────────────────────────────────────────────────────────

export type ExtendedFinisherSlug = "execute" | "disarm" | "throatSlit" | "backstab";

export interface ExtendedFinisherConfig {
  slug: ExtendedFinisherSlug;
  name: string;
  desc: string;
  tone: "grounded" | "absurd";
  rarity: Rarity;
  duration: number;
}

/** Sequence-state shape (matches FinisherSystem.SequenceState, but
 *  trimmed to the fields the anim fns need). The host's real
 *  SequenceState is structurally compatible. */
export interface ExtendedFinisherSeq {
  slug: ExtendedFinisherSlug;
  enemy: {
    group: THREE.Object3D;
    health: number;
    alive: boolean;
    className?: string;
  };
  start: number;
  duration: number;
  scratch: Record<string, THREE.Vector3 | number>;
  killed: boolean;
}

/** Anim-fn signature. `ctx` is a minimal subset of GameContext the anim
 *  functions actually touch — the host can pass its full ctx. */
export interface ExtendedFinisherCtx {
  player: {
    pos: THREE.Vector3;
    viewMode: "first" | "third";
  };
  camera: THREE.Camera;
  scene: THREE.Scene;
  audio?: { enemyDeath?: () => void };
  triggerShake?: (mag: number) => void;
}

export type ExtendedFinisherAnimFn = (
  seq: ExtendedFinisherSeq,
  t: number,
  ctx: ExtendedFinisherCtx,
) => void;

// ───────────────────────────────────────────────────────────────────────────
// Catalog
// ───────────────────────────────────────────────────────────────────────────

export const EXTENDED_FINISHER_SLUGS: ExtendedFinisherSlug[] = [
  "execute", "disarm", "throatSlit", "backstab",
];

export const EXTENDED_FINISHERS: Record<ExtendedFinisherSlug, ExtendedFinisherConfig> = {
  execute: {
    slug: "execute",
    name: "Execute",
    desc: "Behind-the-back neck snap. Quick, brutal, silent.",
    tone: "grounded",
    rarity: "RARE",
    duration: 1.4,
  },
  disarm: {
    slug: "disarm",
    name: "Disarm",
    desc: "Strip their weapon + put a round in their chest.",
    tone: "grounded",
    rarity: "EPIC",
    duration: 1.6,
  },
  throatSlit: {
    slug: "throatSlit",
    name: "Throat Slit",
    desc: "Knife lunge. They go down silently.",
    tone: "grounded",
    rarity: "EPIC",
    duration: 1.3,
  },
  backstab: {
    slug: "backstab",
    name: "Backstab",
    desc: "From shadow to spine. Classic stealth takedown.",
    tone: "grounded",
    rarity: "RARE",
    duration: 1.2,
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Easing helpers (local copies so this module is self-contained)
// ───────────────────────────────────────────────────────────────────────────

function _easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function _easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function _clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ───────────────────────────────────────────────────────────────────────────
// Anim drivers
// ───────────────────────────────────────────────────────────────────────────

/** EXECUTE — quick neck-snap from behind.
 *   - Phase 1 (0..0.3):  player arms reach around enemy's neck.
 *   - Phase 2 (0.3..0.5): sharp rotation (the "snap").
 *   - Phase 3 (0.5..1.0): enemy crumples to the ground. */
export const animExecute: ExtendedFinisherAnimFn = (seq, t, ctx) => {
  const enemyGroup = seq.enemy.group;
  const playerPos = ctx.player.pos;
  const enemyPos = enemyGroup.position;

  if (t < 0.3) {
    // Setup — enemy held upright in front of player.
    const u = _easeOutCubic(t / 0.3);
    enemyPos.x = playerPos.x;
    enemyPos.z = playerPos.z + 0.6;
    enemyPos.y = 0;
    enemyGroup.rotation.set(0, Math.PI, 0); // facing away from player
    // Subtle head-tilt build-up.
    enemyGroup.rotation.x = -0.1 * u;
  } else if (t < 0.5) {
    // SNAP — quick head twist.
    const u = _easeInOutCubic((t - 0.3) / 0.2);
    enemyGroup.rotation.set(
      -0.1 - u * 0.9,        // head pitches down
      Math.PI + u * Math.PI * 0.5, // body twists 90°
      u * 0.3,               // slight roll
    );
    // Camera shake on the snap frame.
    if (t > 0.4 && t < 0.42 && ctx.triggerShake) ctx.triggerShake(0.6);
  } else {
    // Crumple — enemy falls forward to the ground.
    const u = _easeOutCubic((t - 0.5) / 0.5);
    enemyPos.y = -u * 0.5; // sink toward ground
    enemyGroup.rotation.set(
      -1.0 - u * 0.5,       // continue pitch forward (face-down)
      Math.PI * 1.5,
      0.3 - u * 0.3,
    );
    // Subtle scale-down for "lifeless" feel.
    const s = 1 - u * 0.05;
    enemyGroup.scale.setScalar(s);
  }
};

/** DISARM — strip the enemy's weapon, then counter-shot them with it.
 *   - Phase 1 (0..0.4):  player grabs enemy's weapon arm + twists.
 *   - Phase 2 (0.4..0.5): weapon rips free (small spin).
 *   - Phase 3 (0.5..0.8): player raises the stripped weapon + fires.
 *   - Phase 4 (0.8..1.0): enemy staggers + falls. */
export const animDisarm: ExtendedFinisherAnimFn = (seq, t, ctx) => {
  const enemyGroup = seq.enemy.group;
  const playerPos = ctx.player.pos;
  const enemyPos = enemyGroup.position;

  if (t < 0.4) {
    // Struggle — enemy faces player, weapon arm pulled to the side.
    const u = _easeOutCubic(t / 0.4);
    enemyPos.x = playerPos.x;
    enemyPos.z = playerPos.z + 0.8;
    enemyPos.y = 0;
    enemyGroup.rotation.set(0, 0, 0); // facing player
    enemyGroup.rotation.y = u * 0.4; // slight twist
    // Lean back as the disarm force builds.
    enemyGroup.rotation.x = -u * 0.2;
  } else if (t < 0.5) {
    // SNAP-DISARM — weapon flies free.
    const u = _easeInOutCubic((t - 0.4) / 0.1);
    enemyGroup.rotation.set(
      -0.2 - u * 0.3,
      0.4 + u * 0.3,
      u * 0.15,
    );
    if (t > 0.45 && t < 0.47 && ctx.triggerShake) ctx.triggerShake(0.4);
  } else if (t < 0.8) {
    // Counter-shot — enemy recoils from being shot with their own gun.
    const u = _easeOutCubic((t - 0.5) / 0.3);
    enemyGroup.rotation.set(
      -0.5 - u * 0.6, // sharp pitch back (chest hit)
      0.7 - u * 0.4,
      0.15 - u * 0.3,
    );
    enemyPos.y = -u * 0.1;
    // Muzzle-flash-style camera kick on the shot frame.
    if (t > 0.55 && t < 0.57 && ctx.triggerShake) ctx.triggerShake(0.5);
  } else {
    // Fall — enemy crumples backward.
    const u = _easeOutCubic((t - 0.8) / 0.2);
    enemyPos.y = -u * 0.6;
    enemyGroup.rotation.set(
      -1.1 - u * 0.4,
      0.3,
      -0.15,
    );
  }
};

/** THROAT-SLIT — knife lunge + throat slit.
 *   - Phase 1 (0..0.2):  player's knife-hand darts forward.
 *   - Phase 2 (0.2..0.4): blade across the throat (enemy recoils).
 *   - Phase 3 (0.4..1.0): enemy staggers, drops to knees, collapses. */
export const animThroatSlit: ExtendedFinisherAnimFn = (seq, t, ctx) => {
  const enemyGroup = seq.enemy.group;
  const playerPos = ctx.player.pos;
  const enemyPos = enemyGroup.position;

  if (t < 0.2) {
    // Lunge approach — enemy snapped to within knife range.
    enemyPos.x = playerPos.x;
    enemyPos.z = playerPos.z + 0.5;
    enemyPos.y = 0;
    enemyGroup.rotation.set(0, Math.PI, 0); // facing away
  } else if (t < 0.4) {
    // SLIT — sharp head-jerk back + slight roll.
    const u = _easeOutCubic((t - 0.2) / 0.2);
    enemyGroup.rotation.set(
      -u * 0.4,           // head pitches back
      Math.PI,
      u * 0.2,            // slight roll from blade drag
    );
    if (t > 0.25 && t < 0.27 && ctx.triggerShake) ctx.triggerShake(0.3);
  } else {
    // Stagger + collapse to knees, then face-down.
    const u = _easeOutCubic((t - 0.4) / 0.6);
    if (u < 0.4) {
      // Knees buckle.
      const k = u / 0.4;
      enemyPos.y = -k * 0.4;
      enemyGroup.rotation.set(-0.4 - k * 0.5, Math.PI, 0.2 - k * 0.2);
    } else {
      // Fall forward.
      const k = (u - 0.4) / 0.6;
      enemyPos.y = -0.4 - k * 0.4;
      enemyGroup.rotation.set(-0.9 - k * 0.7, Math.PI, 0);
    }
  }
};

/** BACKSTAB — stealth takedown from directly behind.
 *   - Phase 1 (0..0.15): player hand clamps over enemy's mouth.
 *   - Phase 2 (0.15..0.35): blade drives up under the ribs.
 *   - Phase 3 (0.35..0.7): player lowers the enemy quietly.
 *   - Phase 4 (0.7..1.0): enemy laid on the ground, motionless. */
export const animBackstab: ExtendedFinisherAnimFn = (seq, t, _ctx) => {
  const enemyGroup = seq.enemy.group;
  const enemyPos = enemyGroup.position;

  if (t < 0.15) {
    // Clamp — enemy frozen upright.
    enemyPos.y = 0;
    enemyGroup.rotation.set(0, Math.PI, 0);
    // Slight muffle-twitch.
    enemyGroup.rotation.x = -0.05 * Math.sin(t * 60);
  } else if (t < 0.35) {
    // STAB — small upward lurch.
    const u = _easeOutCubic((t - 0.15) / 0.2);
    enemyPos.y = u * 0.05; // tiny lift
    enemyGroup.rotation.set(
      -0.05 - u * 0.15, // slight arch back
      Math.PI,
      u * 0.05,
    );
  } else if (t < 0.7) {
    // Lower — player eases the enemy down.
    const u = _easeInOutCubic((t - 0.35) / 0.35);
    enemyPos.y = 0.05 - u * 0.5;
    enemyGroup.rotation.set(
      -0.2 - u * 0.6,
      Math.PI,
      0.05,
    );
  } else {
    // Settle — enemy laid out face-down.
    const u = _easeOutCubic((t - 0.7) / 0.3);
    enemyPos.y = -0.5 - u * 0.1;
    enemyGroup.rotation.set(-0.8 - u * 0.7, Math.PI, 0.05);
    // Final lifelessness — slight scale-down.
    const s = 1 - u * 0.03;
    enemyGroup.scale.setScalar(s);
  }
};

// ───────────────────────────────────────────────────────────────────────────
// Slug → anim-fn dispatch map (for FinisherSystem integration)
// ───────────────────────────────────────────────────────────────────────────

export const EXTENDED_FINISHER_ANIM_FNS: Record<ExtendedFinisherSlug, ExtendedFinisherAnimFn> = {
  execute: animExecute,
  disarm: animDisarm,
  throatSlit: animThroatSlit,
  backstab: animBackstab,
};

/** Per-finisher setup hook (called at trigger time, like FinisherSystem's
 *  per-finisher setup in trigger()). For now, the 4 new finishers only
 *  need scratch initialization. */
export function setupExtendedFinisher(
  seq: ExtendedFinisherSeq,
  ctx: ExtendedFinisherCtx,
): void {
  const enemyPos = seq.enemy.group.position;
  const playerPos = ctx.player.pos;
  // Direction from player to enemy (horizontal).
  const toEnemy = new THREE.Vector3().subVectors(enemyPos, playerPos);
  toEnemy.y = 0;
  toEnemy.normalize();
  // All 4 new finishers place the enemy in front of the player.
  const enemyTarget = playerPos.clone().addScaledVector(toEnemy, 1.2);
  enemyTarget.y = enemyPos.y;
  seq.enemy.group.position.copy(enemyTarget);
  // Face the player (for execute/throatSlit/backstab from behind).
  const faceYaw = Math.atan2(-toEnemy.x, -toEnemy.z);
  seq.scratch.faceYaw = faceYaw;
  seq.scratch.startY = enemyTarget.y;
  // Disarm + execute place the enemy FACING the player (face-to-face).
  if (seq.slug === "disarm") {
    seq.enemy.group.rotation.y = faceYaw + Math.PI;
  } else {
    // execute / throatSlit / backstab: enemy faces AWAY from the player.
    seq.enemy.group.rotation.y = faceYaw;
  }
}

/** Pick a random extended finisher slug (optionally filtered by tone). */
export function pickRandomExtendedFinisher(
  tone?: "grounded" | "absurd",
): ExtendedFinisherSlug {
  const pool = EXTENDED_FINISHER_SLUGS.filter(
    (s) => !tone || EXTENDED_FINISHERS[s].tone === tone,
  );
  return pool[Math.floor(Math.random() * pool.length)] ?? "execute";
}

/** Check whether the enemy is in a valid position for the given extended
 *  finisher. Stealth finishers (backstab, throatSlit, execute) require
 *  the player to be behind the enemy; disarm requires the player to be
 *  in front. */
export function canTriggerExtendedFinisher(
  slug: ExtendedFinisherSlug,
  enemyForwardYaw: number,
  playerToEnemyYaw: number,
): boolean {
  // "Behind the enemy" = the player is on the opposite side of the enemy's
  // facing direction. enemyForwardYaw is where the enemy is looking;
  // playerToEnemyYaw is the direction from player to enemy.
  // The player is behind the enemy if playerToEnemyYaw is roughly opposite
  // to enemyForwardYaw.
  let delta = playerToEnemyYaw - (enemyForwardYaw + Math.PI);
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const isBehind = Math.abs(delta) < Math.PI / 3; // within 60° of "behind"

  switch (slug) {
    case "backstab":
    case "throatSlit":
    case "execute":
      return isBehind;
    case "disarm":
      return !isBehind; // disarm requires face-to-face
    default:
      return true;
  }
}

/** Build a THREE.AnimationClip for the given extended finisher. This is
 *  a procedural clip that drives the enemy group's position + rotation
 *  (matches what the anim fns do at runtime). Useful for the killcam
 *  replay system, which captures AnimationClip data rather than runtime
 *  function calls. */
export function buildExtendedFinisherClip(
  slug: ExtendedFinisherSlug,
  enemyGroup: THREE.Object3D,
  playerPos: THREE.Vector3,
): THREE.AnimationClip {
  const cfg = EXTENDED_FINISHERS[slug];
  const dur = cfg.duration;
  const steps = 16;
  const times: number[] = [];
  const posValues: number[] = [];
  const quatValues: number[] = [];

  // Fake seq + ctx for the anim fn to operate on (we capture its outputs
  // into the keyframe arrays).
  const fakeEnemy = { group: enemyGroup, health: 100, alive: true };
  const fakeSeq: ExtendedFinisherSeq = {
    slug,
    enemy: fakeEnemy,
    start: 0,
    duration: dur,
    scratch: {},
    killed: false,
  };
  const fakeCtx: ExtendedFinisherCtx = {
    player: { pos: playerPos, viewMode: "third" },
    camera: new THREE.Object3D() as THREE.Camera,
    scene: new THREE.Scene(),
  };

  // Save the enemy's initial transform (so we can restore after sampling).
  const savedPos = enemyGroup.position.clone();
  const savedQuat = enemyGroup.quaternion.clone();
  const savedScale = enemyGroup.scale.clone();

  const fn = EXTENDED_FINISHER_ANIM_FNS[slug];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dur;
    // Reset before each sample (anim fns write absolute transforms).
    enemyGroup.position.copy(savedPos);
    enemyGroup.quaternion.copy(savedQuat);
    enemyGroup.scale.copy(savedScale);
    fn(fakeSeq, t, fakeCtx);
    times.push(t);
    posValues.push(enemyGroup.position.x, enemyGroup.position.y, enemyGroup.position.z);
    quatValues.push(enemyGroup.quaternion.x, enemyGroup.quaternion.y, enemyGroup.quaternion.z, enemyGroup.quaternion.w);
  }
  // Restore.
  enemyGroup.position.copy(savedPos);
  enemyGroup.quaternion.copy(savedQuat);
  enemyGroup.scale.copy(savedScale);

  return new THREE.AnimationClip(
    `ext_finisher_${slug}`,
    dur,
    [
      new THREE.VectorKeyframeTrack(".position", times, posValues),
      new THREE.QuaternionKeyframeTrack(".quaternion", times, quatValues),
    ],
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Integration helper: register the 4 extended finishers with the existing
// FinisherSystem's FINISHERS catalog. (Host calls this once at boot.)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Merge EXTENDED_FINISHERS into a host's existing FinisherConfig record.
 * Returns a new record that includes both the original 6 + the 4 new ones.
 *
 * Usage in FinisherSystem.ts:
 *   import { EXTENDED_FINISHERS, mergeExtendedFinishers } from "../animation/finisher-extensions";
 *   const ALL = mergeExtendedFinishers(FINISHERS);
 */
export function mergeExtendedFinishers<T extends Record<string, unknown>>(
  existing: T,
): T & typeof EXTENDED_FINISHERS {
  return { ...existing, ...EXTENDED_FINISHERS };
}
