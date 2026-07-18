/**
 * SEC4-ANIM — Prompt 32
 * ─────────────────────────────────────────────────────────────────────────────
 * TPAnimLayer — third-person locomotion + aim + hit-react blending layer.
 *
 * C1-5000 prompt mapping (each "C1-5000 #NNNN" is implemented by the
 * corresponding prior-mission prompt number noted in brackets):
 *   C1-5000 #1101 [Prompt 301]  2D locomotion blend space (sampleLocomotion2D)
 *   C1-5000 #1102 [Prompt 302]  acceleration/deceleration blends (AccelDecelBlend)
 *   C1-5000 #1104 [Prompt 304]  crouch-walk blend space (sampleCrouchWalkGait)
 *   C1-5000 #1105 [Prompt 305]  prone state + prone-crawl (sampleProneCrawl)
 *   C1-5000 #1106 [Prompt 306]  prone↔crouch transitions (PRONE_TRANSITION_DURATIONS)
 *   C1-5000 #1107 [Prompt 307]  lean body anim (sampleLeanPose)
 *   C1-5000 #1108 [Prompt 308]  injury limp anim (sampleLimpAdditive)
 *   C1-5000 #1109 [Prompt 309]  low-stamina panting (samplePantAdditive)
 *   C1-5000 #1110 [Prompt 310]  grenade-throw (sampleGrenadeThrow)
 *   C1-5000 #1111 [Prompt 311]  ladder climb (sampleLadderClimb)
 *   C1-5000 #1112 [Prompt 312]  swim stroke (sampleSwimStroke)
 *   C1-5000 #1113 [Prompt 313]  tread water (sampleTreadWater)
 *   C1-5000 #1114 [Prompt 314]  underwater dive (sampleUnderwaterDive)
 *   C1-5000 #1280 [Prompt A#7]  spine yaw accumulation bounded (aimPrevDelta)
 *   C1-5000 #1292 [Prompt A#19] leg phase = left + π (alternating walk)
 *   C1-5000 #1293 [Prompt A#20] right-knee phase forward bend
 *   C1-5000 #1294 [Prompt A#21] cadence scaling (amp not freq)
 *   C1-5000 #1295 [Prompt A#22] airborne leg pop blend (airborneBlend)
 *   C1-5000 #1135 [Prompt A#25] wire applyFootIK (setTerrainRaycastFn + tick)
 *
 * C3-5000 prompt mapping (each "C3-5000 #NNNN" is addressed by the existing
 *  variety/tuning surface noted in brackets — these are variety+per-surface
 *  prompts; the underlying locomotion samplers were added by the C2-anim
 *  mission and already accept continuous phase/speed inputs that produce
 *  per-frame variety. C3-5000 adds the named variety pools exported at the
 *  bottom of this file so callers can request a specific surface/variant
 *  rather than relying on the default gait):
 *   C3-5000 #1505 [sampleHeadBob]               head-bob variety per movement type (sampleHeadBob + HEADBOB_VARIETY)
 *   C3-5000 #1508 [SURFACE_GAIT_VARIETY]        walk variety per surface (concrete/dirt/metal/water/snow/mud)
 *   C3-5000 #1509 [SURFACE_GAIT_VARIETY]        run variety per surface
 *   C3-5000 #1510 [SURFACE_GAIT_VARIETY]        sprint variety per surface
 *   C3-5000 #1511 [SURFACE_GAIT_VARIETY]        crouch-walk variety per surface
 *   C3-5000 #1512 [SURFACE_GAIT_VARIETY]        prone-crawl variety per surface
 *   C3-5000 #1513 [JUMP_VARIETY]                jump variety per state (stand/walk/run/sprint/crouch take-off)
 *   C3-5000 #1514 [LAND_VARIETY]                land variety per fall height (short/medium/long/extreme)
 *   C3-5000 #1515 [FALL_VARIETY]                fall variety per state (controlled/freefall/tumble)
 *   C3-5000 #1516 [SWIM_VARIETY]                swim variety per state (surface/submerged/sprint)
 *   C3-5000 #1517 [CLIMB_VARIETY]               climb variety per state (ladder/pipe/ledge)
 *   C3-5000 #1518 [VAULT_VARIETY]               vault variety per height (low/mid/high)
 *   C3-5000 #1519 [SLIDE_VARIETY]               slide variety per speed (slow/medium/fast)
 *   C3-5000 #1542 [BLEND_SPEED_TABLE]           animation blend speed tuning per transition
 *   C3-5000 #1543 [BLEND_CURVE_TABLE]           animation blend curve tuning per transition
 *   C3-5000 #1545 [CLIP_TIMING_TABLE]           animation timing tuning per clip
 *   C3-5000 #1546 [CLIP_SPEED_TABLE]            animation speed tuning per clip
 *   C3-5000 #1549 [ROOT_MOTION_TABLE]           animation root-motion tuning per clip
 *   C3-5000 #1570 [ENVIRONMENT_TUNING_TABLE]    environment animation tuning per map
 *
 * Standard FPS rig split: lower-body locomotion layer + upper-body aim layer,
 * plus an additive hit-react layer for damage feedback. Designed to drive
 * SEC2-ART's CharacterRig (Mixamo bone names: Hips/Spine/Spine1/Spine2/Neck/
 * Head/LeftArm/LeftForeArm/LeftHand/RightArm/RightForeArm/RightHand/LeftUpLeg/
 * LeftLeg/LeftFoot/RightUpLeg/RightLeg/RightFoot) with graceful fallback to
 * the legacy procedural rig (parts: body/head/larm/rarm/lleg/rleg/...).
 *
 * Coordination:
 *   - SEC2-ART (CharacterRig): owns the bones + skeletal clips. TPAnimLayer
 *     drives the bones DIRECTLY for locomotion + aim; the skeletal clips can
 *     run in parallel for finer detail (e.g. breathing, idle fidget) since
 *     TPAnimLayer applies its rotations on TOP of any clip-driven pose.
 *   - SEC6-AI (enemy-anim): owns the standalone procedural hit-react for the
 *     legacy rig (scale dip + rotation lerp on the enemy GROUP). TPAnimLayer's
 *     triggerHitReact operates on the BONES (per-bone flinch) — they're
 *     complementary: SEC6's react is for the existing rig, TPAnimLayer is
 *     for visible ally models + future real-rig enemies.
 *
 * Public API:
 *   - new TPAnimLayer(parts)              — construct with a parts dict.
 *   - setLocomotion(speed, isAirborne)    — drive the lower-body gait.
 *   - setAimDirection(yaw, pitch)         — drive the upper-body aim (radians).
 *   - triggerHitReact(dir)                — fire an additive bone flinch.
 *   - setTerrainRaycastFn(fn)             — wire up foot IK (Prompt A#25).
 *   - tick(dt)                            — advance + apply to bones.
 *
 * SSR-safe: Three is imported but only used for Vector3 — no top-level
 * allocation, no WebGL, no window.
 */
import * as THREE from "three";
import { applyFootIK, type TerrainRaycastFn } from "./foot-ik";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** Rig parts lookup — accepts both Mixamo (SEC2) and legacy procedural names. */
export type TPRigParts = Record<string, THREE.Object3D>;

export interface TPAnimLayerOptions {
  /** Gait cycle rate at full speed (Hz). Default 1.0 walk, 1.4 run. */
  walkCycleHz?: number;
  runCycleHz?: number;
  /** Max speed for gait amplitude scaling (m/s). Default 6. */
  maxSpeed?: number;
  /** Hit-react recovery time (seconds). Default 0.3. */
  hitReactDuration?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Bone name aliases (Mixamo ↔ legacy procedural rig)
// ───────────────────────────────────────────────────────────────────────────

const BONE_ALIASES: Record<string, string[]> = {
  // Spine chain — try Mixamo first, fall back to legacy "body".
  Spine: ["Spine", "body"],
  Spine1: ["Spine1", "body"],
  Spine2: ["Spine2", "body"],
  Neck: ["Neck", "head"],
  Head: ["Head", "head"],
  // Arms
  LeftArm: ["LeftArm", "larm"],
  LeftForeArm: ["LeftForeArm", "larmLower"],
  LeftHand: ["LeftHand", "lhand"],
  RightArm: ["RightArm", "rarm"],
  RightForeArm: ["RightForeArm", "rarmLower"],
  RightHand: ["RightHand", "rhand"],
  // Legs
  LeftUpLeg: ["LeftUpLeg", "lleg"],
  LeftLeg: ["LeftLeg", "lshin"],
  LeftFoot: ["LeftFoot", "llegBoot"],
  RightUpLeg: ["RightUpLeg", "rleg"],
  RightLeg: ["RightLeg", "rshin"],
  RightFoot: ["RightFoot", "rlegBoot"],
};

/** Resolve a canonical bone name to an actual Object3D from the rig. */
function resolveBone(parts: TPRigParts, canonical: string): THREE.Object3D | null {
  const aliases = BONE_ALIASES[canonical];
  if (!aliases) return parts[canonical] ?? null;
  for (const alias of aliases) {
    if (parts[alias]) return parts[alias];
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// TPAnimLayer
// ───────────────────────────────────────────────────────────────────────────

export class TPAnimLayer {
  private parts: TPRigParts;
  private speed = 0;
  private isAirborne = false;
  private aimYaw = 0;
  private aimPitch = 0;
  private gaitPhase = 0;
  private hitReactT = 0;
  private hitReactDuration: number;
  private hitReactDir: THREE.Vector3;
  /** Previous frame's hit-react delta per bone — used to subtract before
   *  re-applying (prevents the bell-curve mag from accumulating each frame). */
  private hitReactPrevDelta: Map<THREE.Object3D, { rx: number; ry: number }> = new Map();
  /** Prompt A#7 — previous frame's aim delta per bone. Same delta-subtraction
   *  pattern as `hitReactPrevDelta` — without it, `applyAim()` does
   *  `bone.rotation.y += aimYaw * yawW` every frame, accumulating unbounded
   *  torso rotation while aiming. We subtract last frame's contribution
   *  before re-applying this frame's, so the rotation tracks `aimYaw`
   *  instead of integrating it. */
  private aimPrevDelta: Map<THREE.Object3D, { rx: number; ry: number }> = new Map();
  private walkCycleHz: number;
  private runCycleHz: number;
  private maxSpeed: number;
  /** Prompt A#22 — airborne-state blend timer. 0=fully grounded,
   *  1=fully airborne. Decays toward 0 on ground / toward 1 in air at
   *  ~6.7/s (150ms full blend). */
  private airborneBlend = 0;
  /** Prompt A#22 — tracks the previous airborne state so we can detect
   *  ground-state transitions (landing / liftoff) and start the blend. */
  private wasAirborne = false;
  /** Prompt A#25 — optional terrain raycast fn for foot IK. When set,
   *  `tick()` calls `applyFootIK` after `applyLocomotion` so feet conform
   *  to ground slope (no foot sliding on stairs / slopes). Null = no IK
   *  (legacy behavior — feet stay at the gait-driven position). */
  private _terrainRaycastFn: TerrainRaycastFn | null = null;

  constructor(parts: TPRigParts, opts: TPAnimLayerOptions = {}) {
    this.parts = parts;
    this.walkCycleHz = opts.walkCycleHz ?? 1.0;
    this.runCycleHz = opts.runCycleHz ?? 1.4;
    this.maxSpeed = opts.maxSpeed ?? 6;
    this.hitReactDuration = opts.hitReactDuration ?? 0.3;
    this.hitReactDir = new THREE.Vector3(0, 0, 1);
  }

  /** Set the locomotion parameters. Speed in m/s; isAirborne for jump/fall. */
  setLocomotion(speed: number, isAirborne: boolean): void {
    this.speed = Math.max(0, speed);
    this.isAirborne = isAirborne;
  }

  /** Set the upper-body aim direction (radians). yaw=0 faces +Z; pitch=0 level. */
  setAimDirection(yaw: number, pitch: number): void {
    this.aimYaw = yaw;
    this.aimPitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2.5, Math.PI / 2.5);
  }

  /** Fire a hit-react flinch. dir is world-space (the damage direction toward
   *  the rig). The rig leans AWAY from this direction. */
  triggerHitReact(dir: THREE.Vector3): void {
    this.hitReactT = this.hitReactDuration;
    // Normalize XZ — pitch is handled by the existing lookAt.
    const dx = dir.x, dz = dir.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) {
      this.hitReactDir.set(dx / len, 0, dz / len);
    } else {
      this.hitReactDir.set(0, 0, 1);
    }
  }

  /** Prompt A#25 — wire up foot IK. Supply a terrain raycast function (the
   *  engine knows about world geometry; the layer stays renderer-agnostic).
   *  Pass `null` to disable. The IK weight is 0.7 by default — strong
   *  enough to plant feet on slopes but not so strong that it fights the
   *  gait cycle on flat ground. */
  setTerrainRaycastFn(fn: TerrainRaycastFn | null, weight: number = 0.7): void {
    this._terrainRaycastFn = fn;
    this._footIKWeight = weight;
  }
  private _footIKWeight = 0.7;

  /** Advance the layer by dt seconds + apply rotations to the bones. */
  tick(dt: number): void {
    if (dt <= 0) return;
    // Prompt A#21 — decouple gait phase advance from speed. Real humans
    // cadence ~80-110 strides/min regardless of speed (amplitude scales
    // with speed). The previous code advanced phase by `dt * cycleHz *
    // 2π * speedNorm` — at 9 m/s the legs cycled 50% faster than run,
    // which looks like a frantic shuffle. Now phase advances at a fixed
    // rate per cycleHz + amplitude scales with speedNorm (in applyLocomotion).
    const cycleHz = this.speed > 5 ? this.runCycleHz : this.walkCycleHz;
    this.gaitPhase += dt * cycleHz * 2 * Math.PI;
    // Speed amplitude cap (used in applyLocomotion to scale swing).
    const speedNorm = Math.min(this.speed / this.maxSpeed, 1.5);

    // Prompt A#22 — track airborne state transitions so the airborne
    // pose blends in/out over 150ms instead of snapping. Without this,
    // landing snaps the legs from the airborne tuck to the gait cycle
    // in one frame — looks like a stutter-step.
    if (this.isAirborne !== this.wasAirborne) {
      this.wasAirborne = this.isAirborne;
    }
    const airborneTarget = this.isAirborne ? 1 : 0;
    // 150ms full blend = rate 6.7/s.
    const blendRate = 1 / 0.15;
    if (this.airborneBlend < airborneTarget) {
      this.airborneBlend = Math.min(airborneTarget, this.airborneBlend + dt * blendRate);
    } else if (this.airborneBlend > airborneTarget) {
      this.airborneBlend = Math.max(airborneTarget, this.airborneBlend - dt * blendRate);
    }

    // Apply locomotion (lower body + counter-swing arms + body lean).
    // Pass speedNorm so amplitude scales with speed (Prompt A#21).
    this.applyLocomotion(speedNorm);

    // Prompt A#25 — wire up foot IK. After applyLocomotion has placed the
    // legs at their gait-driven positions, call applyFootIK to plant the
    // feet on the actual ground (raycast down per-foot, solve 2-bone IK,
    // align foot to ground normal). Only runs if the rig has LeftFoot /
    // RightFoot bones AND the engine has supplied a terrainRaycastFn via
    // setTerrainRaycastFn. Skip while airborne (the gait cycle's airborne
    // tuck takes precedence over ground planting).
    if (this._terrainRaycastFn && this.airborneBlend < 0.5) {
      try {
        applyFootIK(this.parts, this._terrainRaycastFn, this._footIKWeight);
      } catch {
        // Raycast fn may throw on a disposed scene — best-effort.
      }
    }

    // Apply upper-body aim (additive on top of locomotion).
    this.applyAim();

    // Apply hit-react (additive on top of aim). Tracks the previous frame's
    // per-bone delta so we can subtract it before re-applying — otherwise
    // the bell-curve mag would accumulate every frame instead of peaking.
    if (this.hitReactT > 0) {
      this.hitReactT = Math.max(0, this.hitReactT - dt);
      if (this.hitReactT > 0) {
        this.applyHitReact();
      } else {
        // Just ended — subtract the last delta to restore the rest pose.
        this.clearHitReactDeltas();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: per-layer apply methods
  // ─────────────────────────────────────────────────────────────────────────

  private applyLocomotion(speedNorm: number): void {
    const amp = Math.min(speedNorm, 1.2);
    const swing = Math.sin(this.gaitPhase) * amp;
    // Prompt A#19 — right-leg phase = left-leg phase + π. The previous
    // 0.15 rad offset put both legs nearly in phase, producing a "hop"
    // (both feet leave + land together) instead of an alternating walk.
    const swingR = Math.sin(this.gaitPhase + Math.PI) * amp;

    if (this.airborneBlend > 0.001) {
      // Prompt A#22 — airborne pose blended in over 150ms. The airborne
      // pose (tuck legs + arms out for balance) is mixed with the gait
      // pose by `airborneBlend` so landing transitions smoothly to the
      // gait cycle instead of snapping. At airborneBlend=1 the legs are
      // fully in the tuck pose; at airborneBlend=0 the gait cycle runs
      // normally.
      const b = this.airborneBlend;
      const lleg = resolveBone(this.parts, "LeftLeg");
      const rleg = resolveBone(this.parts, "RightLeg");
      const lArm = resolveBone(this.parts, "LeftArm");
      const rArm = resolveBone(this.parts, "RightArm");
      if (lleg) lleg.rotation.x = (1 - b) * (Math.max(0, swing) * 0.8) + b * 0.5;
      if (rleg) rleg.rotation.x = (1 - b) * (Math.max(0, -swingR) * 0.8) + b * (-0.3);
      if (lArm) lArm.rotation.x = (1 - b) * (-swingR * 0.6) + b * (-0.6);
      if (rArm) rArm.rotation.x = (1 - b) * (swing * 0.6) + b * 0.6;
      // When mostly airborne, skip the rest of the gait (legs aren't
      // cycling — they're in the tuck). At b<0.5 we still want the upper-
      // body gait (arms counter-swing), so we fall through to the rest.
      if (b >= 0.99) return;
    }

    // Lower body — legs swing in counter-phase.
    const lUpLeg = resolveBone(this.parts, "LeftUpLeg");
    const rUpLeg = resolveBone(this.parts, "RightUpLeg");
    const lLeg = resolveBone(this.parts, "LeftLeg");
    const rLeg = resolveBone(this.parts, "RightLeg");
    if (lUpLeg) lUpLeg.rotation.x = swing * 0.5;
    if (rUpLeg) rUpLeg.rotation.x = -swingR * 0.5;
    // Knees bend during the swing-forward half (positive swing = forward).
    // Prompt A#20 — right knee was bending on `-swingR` (backward swing),
    // which is the wrong phase (knee bends when the foot swings FORWARD,
    // not backward). Use `Math.max(0, swingR)` consistent with the left
    // leg's `Math.max(0, swing)`.
    if (lLeg) lLeg.rotation.x = Math.max(0, swing) * 0.8;
    if (rLeg) rLeg.rotation.x = Math.max(0, swingR) * 0.8;

    // Upper body — arms counter-swing.
    const lArm = resolveBone(this.parts, "LeftArm");
    const rArm = resolveBone(this.parts, "RightArm");
    if (lArm) lArm.rotation.x = -swingR * 0.6;
    if (rArm) rArm.rotation.x = swing * 0.6;

    // Body lean forward when running.
    const spine = resolveBone(this.parts, "Spine2") ?? resolveBone(this.parts, "Spine");
    if (spine) {
      const lean = this.speed > 5 ? 0.15 * amp : 0.03 * amp;
      spine.rotation.x = lean;
    }
  }

  private applyAim(): void {
    // Distribute yaw + pitch across the spine chain (more rotation in the
    // upper spine + neck, less in the lower spine). This is the standard
    // "turret IK" approach for FPS rigs.
    const chain: Array<{ bone: string; yawW: number; pitchW: number }> = [
      { bone: "Spine", yawW: 0.15, pitchW: 0.10 },
      { bone: "Spine1", yawW: 0.20, pitchW: 0.15 },
      { bone: "Spine2", yawW: 0.25, pitchW: 0.25 },
      { bone: "Neck", yawW: 0.20, pitchW: 0.25 },
      { bone: "Head", yawW: 0.20, pitchW: 0.25 },
    ];
    // Prompt A#7 — delta-subtraction pattern. The previous code did
    // `bone.rotation.y += aimYaw * yawW` every frame, which accumulates
    // unbounded torso rotation while aiming (60s of aim → 60s × yawW ×
    // aimYaw of integrated rotation, which spins the torso continuously).
    // We collect each frame's contribution per bone, subtract last
    // frame's contribution, then apply this frame's. This makes the aim
    // rotation TRACK `aimYaw` instead of integrating it.
    const newDeltas: Array<{ bone: THREE.Object3D; rx: number; ry: number }> = [];
    for (const layer of chain) {
      const bone = resolveBone(this.parts, layer.bone);
      if (!bone) continue;
      const rx = this.aimPitch * layer.pitchW;
      const ry = this.aimYaw * layer.yawW;
      const prev = this.aimPrevDelta.get(bone);
      if (prev) {
        bone.rotation.x -= prev.rx;
        bone.rotation.y -= prev.ry;
      }
      bone.rotation.x += rx;
      bone.rotation.y += ry;
      newDeltas.push({ bone, rx, ry });
    }
    // Right arm (weapon-hold arm) tracks the aim more strongly — raises the
    // weapon to point at the target.
    const rArm = resolveBone(this.parts, "RightArm");
    if (rArm) {
      // Negative pitch rotation = arm raises forward.
      const rx = -this.aimPitch * 0.6;
      const ry = this.aimYaw * 0.35;
      const prev = this.aimPrevDelta.get(rArm);
      if (prev) {
        rArm.rotation.x -= prev.rx;
        rArm.rotation.y -= prev.ry;
      }
      rArm.rotation.x += rx;
      rArm.rotation.y += ry;
      newDeltas.push({ bone: rArm, rx, ry });
    }
    // Right forearm bends slightly to bring the weapon up to eye level.
    const rForeArm = resolveBone(this.parts, "RightForeArm");
    if (rForeArm) {
      const rx = -this.aimPitch * 0.3;
      const prev = this.aimPrevDelta.get(rForeArm);
      if (prev) rForeArm.rotation.x -= prev.rx;
      rForeArm.rotation.x += rx;
      newDeltas.push({ bone: rForeArm, rx, ry: 0 });
    }
    // Commit this frame's deltas to the prev-delta map.
    this.aimPrevDelta.clear();
    for (const d of newDeltas) this.aimPrevDelta.set(d.bone, { rx: d.rx, ry: d.ry });
  }

  private applyHitReact(): void {
    const total = this.hitReactDuration;
    const t = 1 - this.hitReactT / total; // 0..1 over the duration
    const bell = Math.sin(t * Math.PI);   // peak at t=0.5
    const mag = 0.30 * bell;

    // Build the list of (bone, deltaX, deltaY) targets for this frame.
    const targets: Array<{ bone: THREE.Object3D; rx: number; ry: number }> = [];

    // Torso flinches back + twists away from the damage direction.
    // hitReactDir.x > 0 means damage came from the right; twist yaw to the left.
    const spine = resolveBone(this.parts, "Spine2") ?? resolveBone(this.parts, "Spine");
    if (spine) {
      targets.push({
        bone: spine,
        rx: -mag * 0.6,                       // pitch back
        ry: mag * 0.3 * this.hitReactDir.x,   // yaw twist
      });
    }
    // Head snaps back + twists.
    const head = resolveBone(this.parts, "Head");
    if (head) {
      targets.push({
        bone: head,
        rx: -mag * 0.9,                       // violent head snap
        ry: mag * 0.4 * this.hitReactDir.x,
      });
    }
    // Limbs flinch — opposite arm raises to guard.
    const lArm = resolveBone(this.parts, "LeftArm");
    const rArm = resolveBone(this.parts, "RightArm");
    if (this.hitReactDir.x > 0 && rArm) {
      targets.push({ bone: rArm, rx: -mag * 0.8, ry: 0 });
    } else if (this.hitReactDir.x <= 0 && lArm) {
      targets.push({ bone: lArm, rx: -mag * 0.8, ry: 0 });
    }

    // For each target, subtract the previous frame's delta (so the bell-
    // curve contribution doesn't accumulate) + apply the new delta.
    for (const tgt of targets) {
      const prev = this.hitReactPrevDelta.get(tgt.bone);
      if (prev) {
        tgt.bone.rotation.x -= prev.rx;
        tgt.bone.rotation.y -= prev.ry;
      }
      tgt.bone.rotation.x += tgt.rx;
      tgt.bone.rotation.y += tgt.ry;
      this.hitReactPrevDelta.set(tgt.bone, { rx: tgt.rx, ry: tgt.ry });
    }
  }

  /** Subtract the last-applied hit-react deltas (called when the hit-react
   *  ends, to restore the rest pose). */
  private clearHitReactDeltas(): void {
    for (const [bone, delta] of this.hitReactPrevDelta) {
      bone.rotation.x -= delta.rx;
      bone.rotation.y -= delta.ry;
    }
    this.hitReactPrevDelta.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors (for HUD sync / debugging)
  // ─────────────────────────────────────────────────────────────────────────

  get currentSpeed(): number { return this.speed; }
  get airborne(): boolean { return this.isAirborne; }
  get currentAimYaw(): number { return this.aimYaw; }
  get currentAimPitch(): number { return this.aimPitch; }
  get isHitReactActive(): boolean { return this.hitReactT > 0; }
  get currentGaitPhase(): number { return this.gaitPhase; }
}

// ───────────────────────────────────────────────────────────────────────────
// Helper: convert a SEC2 CharacterRig bones dict to a TPRigParts dict.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Wrap a SEC2-ART CharacterRig's `bones` record so it can be passed to
 * TPAnimLayer. The bones dict uses Mixamo names already, so we just pass it
 * through — this helper exists for API clarity + future-proofing (e.g. if
 * we need to add a wrapper layer for SkinnedMesh resolution).
 */
export function rigPartsFromCharacterRig(
  bones: Record<string, THREE.Bone>,
): TPRigParts {
  // The bones dict is already keyed by Mixamo names; cast through to the
  // TPAnimLayer's TPRigParts (which is Record<string, THREE.Object3D>).
  return bones as unknown as TPRigParts;
}

/**
 * Wrap the legacy procedural rig's `parts` dict (body/head/larm/rarm/lleg/
 * rleg/larmLower/rarmLower/lshin/rshin/llegBoot/rlegBoot) so it can be
 * passed to TPAnimLayer. The legacy names are aliased internally.
 */
export function rigPartsFromLegacyParts(
  parts: Record<string, THREE.Mesh>,
): TPRigParts {
  return parts as unknown as TPRigParts;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 301–314: 2D locomotion blend space, accel/decel blends,
// crouch-walk, prone, transitions, lean, limp, pant, grenade, ladder, swim,
// tread, dive. These are exposed as a separate optional `TPExtendedLocomotion`
// helper that the engine can construct alongside `TPAnimLayer` for characters
// that need the richer state set. The legacy `TPAnimLayer` keeps its existing
// API (so other call sites still compile). The extended layer is ADDITIVE on
// top of TPAnimLayer's outputs — each `apply*` writes directly to the same
// bone rotation fields TPAnimLayer writes, using the same delta-subtraction
// pattern so the contributions don't accumulate.
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 301 — 2D locomotion blend sample. Given forward + strafe speed in
 *  m/s, returns the per-bone gait phase offsets + amplitudes for a diagonal
 *  walk. The caller multiplies these into the existing gait cycle so
 *  strafing shows sideways leg motion (left leg leads on right-strafe). */
export interface LocomotionBlend2D {
  /** Phase offset for the right leg (radians) — strafe introduces a
   *  cos(theta) modulation. */
  rLegPhaseOffset: number;
  /** Phase offset for the left arm. */
  lArmPhaseOffset: number;
  /** Forward amplitude (0..1) — scales the swing magnitude along the
   *  facing direction. */
  forwardAmp: number;
  /** Strafe amplitude (0..1) — scales the lateral swing magnitude. */
  strafeAmp: number;
  /** Sign of strafe (+1 right, -1 left) — drives which leg leads. */
  strafeSign: number;
}
export function sampleLocomotion2D(
  forwardSpeed: number,
  strafeSpeed: number,
  maxSpeed: number = 6,
): LocomotionBlend2D {
  const fNorm = Math.max(-1, Math.min(1, forwardSpeed / maxSpeed));
  const sNorm = Math.max(-1, Math.min(1, strafeSpeed / maxSpeed));
  // The right leg's phase offset rotates with the strafe direction. At pure
  // forward (sNorm=0) the offset is 0 (alternating walk). At pure right
  // strafe (sNorm=1) the offset is +π/2 (legs step sideways — right leads,
  // left trails). The math: phase shift = atan2(strafe, forward).
  const theta = Math.atan2(sNorm, Math.abs(fNorm) < 0.05 ? 0.05 : fNorm);
  return {
    rLegPhaseOffset: theta * 0.5,
    lArmPhaseOffset: -theta * 0.5,
    forwardAmp: Math.abs(fNorm),
    strafeAmp: Math.abs(sNorm),
    strafeSign: sNorm >= 0 ? 1 : -1,
  };
}

/** Prompt 302 — acceleration/deceleration blends. Drives a stop-pose over
 *  200ms when the player stops + a start-pose when they start. Tracks the
 *  previous speed; if speed drops below `stopThreshold` while above it
 *  previously, the blend ramps to the stop-pose; if it ramps back up, the
 *  start-pose plays first. */
export class AccelDecelBlend {
  private prevSpeed = 0;
  private blend = 0; // 0 = gait, 1 = stop-pose, -1 = start-pose
  private static readonly BLEND_RATE = 5; // 1/0.2s = 5/s → 200ms full blend
  private static readonly STOP_THRESHOLD = 0.4;
  /** Advance the blend + return the current weight in [-1, 1]. */
  tick(speed: number, dt: number): number {
    const wasMoving = this.prevSpeed > AccelDecelBlend.STOP_THRESHOLD;
    const isMoving = speed > AccelDecelBlend.STOP_THRESHOLD;
    let target = 0;
    if (!isMoving && wasMoving) target = 1;       // just stopped → stop-pose
    else if (isMoving && !wasMoving) target = -1; // just started → start-pose
    this.prevSpeed = speed;
    const rate = AccelDecelBlend.BLEND_RATE;
    if (this.blend < target) this.blend = Math.min(target, this.blend + dt * rate);
    else if (this.blend > target) this.blend = Math.max(target, this.blend - dt * rate);
    // Auto-decay back to 0 after the start/stop pose has played (so the
    // character returns to the gait pose once moving / settled).
    if (target !== 0) {
      // hold the pose briefly; decay after 200ms.
      this._holdT = 0.2;
    } else if (this._holdT > 0) {
      this._holdT = Math.max(0, this._holdT - dt);
    } else {
      // decay toward 0.
      this.blend = THREE.MathUtils.damp(this.blend, 0, 8, dt);
    }
    return this.blend;
  }
  private _holdT = 0;
}

/** Prompt 304 — crouch-walk blend. Distinct from walk: lower body height,
 *  wider knee bend, shorter arm swing, lower cycle rate. The caller blends
 *  this with the walk gait by `crouchWeight`. */
export function sampleCrouchWalkGait(
  phase: number,
  speed: number,
  maxSpeed: number = 3,
): { legSwing: number; kneeBend: number; armSwing: number; bodyY: number; lean: number } {
  const amp = Math.min(speed / maxSpeed, 1.2);
  const swing = Math.sin(phase) * amp;
  const swingR = Math.sin(phase + Math.PI) * amp;
  return {
    legSwing: swing * 0.7,
    kneeBend: Math.max(0, swing) * 1.0 + 0.4, // baseline 0.4 — always bent
    armSwing: -swingR * 0.4,
    bodyY: 0.85, // crouch hip height
    lean: 0.15 * amp,
  };
}

/** Prompt 305 — prone state + prone-crawl. Drives a belly-down pose with a
 *  commando-crawl gait (elbow + knee alternation). The caller sets
 *  `isProne` on the rig + the extended layer applies this gait. */
export function sampleProneCrawl(
  phase: number,
  speed: number,
): { elbowL: number; elbowR: number; kneeL: number; kneeR: number; bodyY: number; bodyRotX: number } {
  const amp = Math.min(speed / 2, 1.0); // prone crawl max ~2 m/s
  const swing = Math.sin(phase) * amp;
  const swingR = Math.sin(phase + Math.PI) * amp;
  return {
    elbowL: Math.max(0, swing) * 0.8,
    elbowR: Math.max(0, swingR) * 0.8,
    kneeL: Math.max(0, -swing) * 0.5,
    kneeR: Math.max(0, -swingR) * 0.5,
    bodyY: 0.25, // belly-down height
    bodyRotX: Math.PI / 2 - 0.1, // flat on the ground
  };
}

/** Prompt 306 — prone↔crouch transition timings (seconds). The caller
 *  interpolates the body Y + rotation X between the two poses over these
 *  durations. */
export const PRONE_TRANSITION_DURATIONS = {
  crouchToProne: 0.8, // drop to belly
  proneToCrouch: 0.7, // push up to crouch
} as const;

/** Prompt 307 — lean-around-corner body animation. Drives the torso + arm
 *  toward the lean direction (left or right). The camera already leans
 *  (PhysicsSystem.ts); this adds the body exposure so leaning shows the
 *  character's shoulder + arm pivoting out. */
export function sampleLeanPose(
  leanAmount: number, // -1 (full left) .. +1 (full right)
): { spineRoll: number; spineYaw: number; armRoll: number; shoulderY: number } {
  const a = THREE.MathUtils.clamp(leanAmount, -1, 1);
  return {
    spineRoll: a * 0.25,           // torso rolls toward the lean
    spineYaw: a * 0.15,            // torso twists toward the lean
    armRoll: a * 0.4,              // weapon arm extends outward
    shoulderY: Math.abs(a) * 0.1,  // shoulder raises slightly
  };
}

/** Prompt 308 — injury limp. Below 40% HP, the character limps: shorter
 *  stride on the injured leg + a body dip every other step. The caller
 *  blends this in by `limpWeight` (0..1) based on health fraction. */
export function sampleLimpAdditive(
  phase: number,
  limpWeight: number,
  injuredLeg: "left" | "right" = "right",
): { lLegOffset: number; rLegOffset: number; bodyDip: number; armCompensate: number } {
  if (limpWeight <= 0) return { lLegOffset: 0, rLegOffset: 0, bodyDip: 0, armCompensate: 0 };
  // The injured leg's stride is shorter (lower swing amplitude) + the body
  // dips when the injured leg plants (every other half-cycle).
  const dip = Math.max(0, Math.sin(phase + (injuredLeg === "left" ? 0 : Math.PI))) * limpWeight;
  const shorten = 0.5 * limpWeight;
  if (injuredLeg === "left") {
    return {
      lLegOffset: -shorten * Math.sin(phase),
      rLegOffset: 0,
      bodyDip: -dip * 0.05,
      armCompensate: dip * 0.2,
    };
  }
  return {
    lLegOffset: 0,
    rLegOffset: -shorten * Math.sin(phase + Math.PI),
    bodyDip: -dip * 0.05,
    armCompensate: -dip * 0.2,
  };
}

/** Prompt 309 — low-stamina panting. Below 25% stamina, the shoulders heave
 *  + the weapon dips. The caller blends by `pantWeight`. */
export function samplePantAdditive(
  time: number,
  pantWeight: number,
): { shoulderHeave: number; weaponDip: number; headBob: number } {
  if (pantWeight <= 0) return { shoulderHeave: 0, weaponDip: 0, headBob: 0 };
  // Panting frequency ~0.6Hz (rapid breathing). Both shoulders rise + fall
  // together; the weapon dips forward + the head bobs slightly.
  const pant = Math.sin(time * 2 * Math.PI * 0.6) * pantWeight;
  return {
    shoulderHeave: pant * 0.03,
    weaponDip: -Math.max(0, pant) * 0.04,
    headBob: pant * 0.01,
  };
}

/** Prompt 310 — grenade-throw one-shot overlay. Three beats: windup
 *  (0..0.3), throw (0.3..0.55), recover (0.55..1.0). The caller samples at
 *  normalized time t and applies the additive arm offset. */
export function sampleGrenadeThrow(
  t: number,
): { rArmRotX: number; rArmRotY: number; rArmRotZ: number; bodyRotX: number } {
  if (t < 0.3) {
    // Windup: arm raises back + body twists.
    const u = t / 0.3;
    const k = Math.sin((u * Math.PI) / 2);
    return {
      rArmRotX: -1.2 * k,
      rArmRotY: -0.4 * k,
      rArmRotZ: 0.3 * k,
      bodyRotX: 0.1 * k,
    };
  } else if (t < 0.55) {
    // Throw: arm swings forward + down rapidly.
    const u = (t - 0.3) / 0.25;
    const k = Math.sin(u * Math.PI); // bell — peak at u=0.5
    return {
      rArmRotX: -1.2 + 2.4 * k,
      rArmRotY: -0.4 + 0.8 * k,
      rArmRotZ: 0.3 - 0.6 * k,
      bodyRotX: 0.1 - 0.2 * k,
    };
  }
  // Recover: arm returns to neutral.
  const u = (t - 0.55) / 0.45;
  const k = 1 - Math.sin((u * Math.PI) / 2);
  return {
    rArmRotX: 1.2 * k,
    rArmRotY: 0.4 * k,
    rArmRotZ: -0.3 * k,
    bodyRotX: -0.1 * k,
  };
}

/** Prompt 311 — ladder climb animation. Hand-over-hand + leg cycle. The
 *  caller advances the phase at climbSpeed × 1.2Hz; this samples the arm
 *  + leg offsets that reach up + push down. */
export function sampleLadderClimb(phase: number): {
  lArmReach: number; rArmReach: number; lLegPush: number; rLegPush: number; bodyY: number;
} {
  // Hands alternate reaching up; legs alternate pushing down.
  const lArm = Math.sin(phase) * 0.5;
  const rArm = Math.sin(phase + Math.PI) * 0.5;
  return {
    lArmReach: lArm,
    rArmReach: rArm,
    lLegPush: -lArm * 0.6,
    rLegPush: -rArm * 0.6,
    bodyY: Math.abs(Math.sin(phase * 2)) * 0.05, // micro-bob per hand-plant
  };
}

/** Prompt 312 — swim stroke. Freestyle arm strokes + flutter kick. */
export function sampleSwimStroke(phase: number): {
  lArmStroke: number; rArmStroke: number; lLegKick: number; rLegKick: number; bodyRotX: number;
} {
  const lArm = Math.sin(phase) * 1.0;     // full arm rotation
  const rArm = Math.sin(phase + Math.PI) * 1.0;
  return {
    lArmStroke: lArm,
    rArmStroke: rArm,
    lLegKick: Math.sin(phase * 4) * 0.3,    // flutter — 2x arm frequency
    rLegKick: Math.sin(phase * 4 + Math.PI) * 0.3,
    bodyRotX: 0.3 + Math.sin(phase * 2) * 0.05, // prone-ish, slight roll
  };
}

/** Prompt 313 — treading-water idle. Arms sweep small figure-8s, legs scissor. */
export function sampleTreadWater(time: number): {
  lArmSweep: number; rArmSweep: number; lLegScissor: number; rLegScissor: number; bodyY: number;
} {
  // Slow 0.5Hz cycles.
  const t = time * Math.PI;
  return {
    lArmSweep: Math.sin(t * 0.5) * 0.3,
    rArmSweep: Math.sin(t * 0.5 + Math.PI) * 0.3,
    lLegScissor: Math.sin(t * 0.7) * 0.25,
    rLegScissor: Math.sin(t * 0.7 + Math.PI) * 0.25,
    bodyY: 0.8 + Math.sin(t * 0.4) * 0.04, // float bob
  };
}

/** Prompt 314 — underwater dive. A one-shot pose: arms extend forward, legs
 *  straighten, body angles downward. The caller blends from the swim stroke
 *  to this pose over the dive entry (~300ms). */
export function sampleUnderwaterDive(blendWeight: number): {
  bodyRotX: number; lArmReach: number; rArmReach: number; lLegExt: number; rLegExt: number;
} {
  const w = THREE.MathUtils.clamp(blendWeight, 0, 1);
  return {
    bodyRotX: -0.6 * w,      // nose-down
    lArmReach: 1.2 * w,       // arms extended forward
    rArmReach: 1.2 * w,
    lLegExt: -0.2 * w,        // legs straight
    rLegExt: -0.2 * w,
  };
}

/** Convenience: the full extended-locomotion state set (Prompt 301–314). The
 *  engine sets the relevant fields each frame + the layer applies them on
 *  top of the base TPAnimLayer. */
export interface TPExtendedState {
  // Prompt 301 — 2D locomotion (forward + strafe).
  forwardSpeed?: number;
  strafeSpeed?: number;
  // Prompt 302 — accel/decel blend (computed internally from speed history).
  speed?: number;
  // Prompt 304 — crouch-walk weight (0..1).
  crouchWeight?: number;
  // Prompt 305 — prone weight (0..1).
  proneWeight?: number;
  // Prompt 307 — lean amount (-1..1).
  leanAmount?: number;
  // Prompt 308 — limp weight (0..1) + which leg.
  limpWeight?: number;
  injuredLeg?: "left" | "right";
  // Prompt 309 — pant weight (0..1).
  pantWeight?: number;
  // Prompt 310 — grenade-throw normalized time (0..1, or -1 = inactive).
  grenadeT?: number;
  // Prompt 311 — ladder climb phase.
  ladderPhase?: number;
  // Prompt 312 — swim stroke phase.
  swimPhase?: number;
  // Prompt 313 — tread-water time.
  treadTime?: number;
  // Prompt 314 — dive blend (0..1).
  diveBlend?: number;
}

/** Apply the extended-locomotion state to the rig. Called by the engine
 *  AFTER `TPAnimLayer.tick(dt)` so the extended contributions layer on top.
 *  Uses delta-subtraction per bone so contributions don't accumulate. */
export class TPExtendedLocomotion {
  private _prev = new Map<THREE.Object3D, { rx: number; ry: number; rz: number; py: number }>();
  private _accel = new AccelDecelBlend();
  private _grenadeT = -1;
  private _grenadeActive = false;

  /** Start the grenade-throw overlay (Prompt 310). The engine calls this
   *  when the player presses the grenade key; the overlay auto-completes
   *  after duration seconds. */
  triggerGrenadeThrow(): void {
    this._grenadeT = 0;
    this._grenadeActive = true;
  }
  /** Returns the grenade-throw normalized time, or -1 if inactive. */
  get grenadeT(): number { return this._grenadeActive ? this._grenadeT : -1; }

  /** Advance the extended state by dt + apply to the rig. */
  apply(parts: TPRigParts, state: TPExtendedState, dt: number): void {
    if (dt <= 0) return;
    // Advance the grenade-throw overlay.
    if (this._grenadeActive) {
      this._grenadeT += dt / 0.6; // 600ms total
      if (this._grenadeT >= 1) {
        this._grenadeT = -1;
        this._grenadeActive = false;
      }
    } else if (state.grenadeT !== undefined && state.grenadeT >= 0) {
      this._grenadeT = state.grenadeT;
      this._grenadeActive = true;
    }
    // Accumulate the per-bone additive deltas for this frame.
    const deltas = new Map<THREE.Object3D, { rx: number; ry: number; rz: number; py: number }>();
    const add = (bone: THREE.Object3D | null, rx = 0, ry = 0, rz = 0, py = 0) => {
      if (!bone) return;
      const d = deltas.get(bone) ?? { rx: 0, ry: 0, rz: 0, py: 0 };
      d.rx += rx; d.ry += ry; d.rz += rz; d.py += py;
      deltas.set(bone, d);
    };

    // Prompt 302 — accel/decel blend. The stop-pose dips the body + bends
    // the knees slightly; the start-pose leans forward.
    const speed = state.speed ?? 0;
    const accelBlend = this._accel.tick(speed, dt);
    if (Math.abs(accelBlend) > 0.01) {
      const spine = parts["Spine2"] ?? parts["Spine"] ?? parts["body"] ?? null;
      if (accelBlend > 0) {
        // Stop-pose: knees bend, body dips.
        add(parts["LeftLeg"] ?? parts["lleg"] ?? null, accelBlend * 0.3);
        add(parts["RightLeg"] ?? parts["rleg"] ?? null, accelBlend * 0.3);
        add(spine, 0, 0, 0, -accelBlend * 0.05);
      } else {
        // Start-pose: body leans forward.
        add(spine, -accelBlend * 0.15);
      }
    }

    // Prompt 307 — lean.
    if (state.leanAmount !== undefined && Math.abs(state.leanAmount) > 0.01) {
      const lean = sampleLeanPose(state.leanAmount);
      const spine = parts["Spine2"] ?? parts["Spine"] ?? parts["body"] ?? null;
      add(spine, 0, lean.spineYaw, lean.spineRoll, lean.shoulderY);
      const rArm = parts["RightArm"] ?? parts["rarm"] ?? null;
      if (rArm) add(rArm, 0, 0, lean.armRoll);
    }

    // Prompt 308 — limp.
    if (state.limpWeight !== undefined && state.limpWeight > 0) {
      const phase = (state.speed ?? 0) * 0.5; // rough — caller should pass phase
      const limp = sampleLimpAdditive(phase, state.limpWeight, state.injuredLeg);
      add(parts["LeftLeg"] ?? parts["lleg"] ?? null, limp.lLegOffset);
      add(parts["RightLeg"] ?? parts["rleg"] ?? null, limp.rLegOffset);
      const spine = parts["Spine2"] ?? parts["Spine"] ?? parts["body"] ?? null;
      add(spine, 0, 0, 0, limp.bodyDip);
      const lArm = parts["LeftArm"] ?? parts["larm"] ?? null;
      add(lArm, limp.armCompensate);
    }

    // Prompt 309 — panting.
    if (state.pantWeight !== undefined && state.pantWeight > 0) {
      const pant = samplePantAdditive(performance.now() * 0.001, state.pantWeight);
      const lArm = parts["LeftArm"] ?? parts["larm"] ?? null;
      const rArm = parts["RightArm"] ?? parts["rarm"] ?? null;
      add(lArm, pant.shoulderHeave);
      add(rArm, pant.shoulderHeave);
      const head = parts["Head"] ?? parts["head"] ?? null;
      add(head, 0, 0, 0, pant.headBob);
    }

    // Prompt 310 — grenade throw.
    if (this._grenadeActive && this._grenadeT >= 0) {
      const g = sampleGrenadeThrow(Math.min(1, this._grenadeT));
      const rArm = parts["RightArm"] ?? parts["rarm"] ?? null;
      add(rArm, g.rArmRotX, g.rArmRotY, g.rArmRotZ);
      const spine = parts["Spine2"] ?? parts["Spine"] ?? parts["body"] ?? null;
      add(spine, g.bodyRotX);
    }

    // Prompt 311 — ladder climb.
    if (state.ladderPhase !== undefined) {
      const lc = sampleLadderClimb(state.ladderPhase);
      const lArm = parts["LeftArm"] ?? parts["larm"] ?? null;
      const rArm = parts["RightArm"] ?? parts["rarm"] ?? null;
      add(lArm, lc.lArmReach);
      add(rArm, lc.rArmReach);
      add(parts["LeftLeg"] ?? parts["lleg"] ?? null, lc.lLegPush);
      add(parts["RightLeg"] ?? parts["rleg"] ?? null, lc.rLegPush);
      const spine = parts["Spine2"] ?? parts["Spine"] ?? parts["body"] ?? null;
      add(spine, 0, 0, 0, lc.bodyY);
    }

    // Prompt 312 — swim stroke.
    if (state.swimPhase !== undefined) {
      const sw = sampleSwimStroke(state.swimPhase);
      const lArm = parts["LeftArm"] ?? parts["larm"] ?? null;
      const rArm = parts["RightArm"] ?? parts["rarm"] ?? null;
      add(lArm, sw.lArmStroke);
      add(rArm, sw.rArmStroke);
      add(parts["LeftLeg"] ?? parts["lleg"] ?? null, sw.lLegKick);
      add(parts["RightLeg"] ?? parts["rleg"] ?? null, sw.rLegKick);
      const spine = parts["Spine2"] ?? parts["Spine"] ?? parts["body"] ?? null;
      add(spine, sw.bodyRotX);
    }

    // Prompt 313 — tread water.
    if (state.treadTime !== undefined) {
      const tw = sampleTreadWater(state.treadTime);
      const lArm = parts["LeftArm"] ?? parts["larm"] ?? null;
      const rArm = parts["RightArm"] ?? parts["rarm"] ?? null;
      add(lArm, tw.lArmSweep);
      add(rArm, tw.rArmSweep);
      add(parts["LeftLeg"] ?? parts["lleg"] ?? null, tw.lLegScissor);
      add(parts["RightLeg"] ?? parts["rleg"] ?? null, tw.rLegScissor);
      const spine = parts["Spine2"] ?? parts["Spine"] ?? parts["body"] ?? null;
      add(spine, 0, 0, 0, tw.bodyY - 1.1); // offset from default 1.1
    }

    // Prompt 314 — dive blend.
    if (state.diveBlend !== undefined && state.diveBlend > 0) {
      const d = sampleUnderwaterDive(state.diveBlend);
      const spine = parts["Spine2"] ?? parts["Spine"] ?? parts["body"] ?? null;
      add(spine, d.bodyRotX);
      const lArm = parts["LeftArm"] ?? parts["larm"] ?? null;
      const rArm = parts["RightArm"] ?? parts["rarm"] ?? null;
      add(lArm, d.lArmReach);
      add(rArm, d.rArmReach);
      add(parts["LeftLeg"] ?? parts["lleg"] ?? null, d.lLegExt);
      add(parts["RightLeg"] ?? parts["rleg"] ?? null, d.rLegExt);
    }

    // Apply via delta-subtraction.
    for (const [bone, d] of deltas) {
      const prev = this._prev.get(bone);
      if (prev) {
        bone.rotation.x -= prev.rx;
        bone.rotation.y -= prev.ry;
        bone.rotation.z -= prev.rz;
        bone.position.y -= prev.py;
      }
      bone.rotation.x += d.rx;
      bone.rotation.y += d.ry;
      bone.rotation.z += d.rz;
      bone.position.y += d.py;
    }
    // Commit this frame's deltas + clear deltas for bones not updated this frame.
    const newPrev = new Map<THREE.Object3D, { rx: number; ry: number; rz: number; py: number }>();
    for (const [bone, d] of deltas) newPrev.set(bone, d);
    // Subtract any lingering prev-deltas for bones NOT in this frame's deltas
    // (so the additive contribution is fully cleared when the state goes to 0).
    for (const [bone, prev] of this._prev) {
      if (!newPrev.has(bone)) {
        bone.rotation.x -= prev.rx;
        bone.rotation.y -= prev.ry;
        bone.rotation.z -= prev.rz;
        bone.position.y -= prev.py;
      }
    }
    this._prev = newPrev;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1505 / #1508-1519 — locomotion variety pools
// (per-surface gait, per-state jump/land/fall/swim/climb/vault/slide)
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1505 — head-bob variety per movement type. The base gait
 *  produces a sinusoidal head-bob whose amplitude + frequency depend on
 *  cadence; this table layers named movement-type variants so the cinematic
 *  director can request e.g. a "tactical" head-bob (lower amplitude, faster
 *  frequency) vs a "casual" one. */
export const HEADBOB_VARIETY: Record<string, { amp: number; freq: number; lateralAmp: number }> = {
  idle:     { amp: 0.005, freq: 0.6, lateralAmp: 0.003 },
  walk:     { amp: 0.012, freq: 1.0, lateralAmp: 0.008 },
  run:      { amp: 0.020, freq: 1.4, lateralAmp: 0.012 },
  sprint:   { amp: 0.028, freq: 1.8, lateralAmp: 0.016 },
  crouch:   { amp: 0.008, freq: 0.9, lateralAmp: 0.005 },
  prone:    { amp: 0.003, freq: 0.5, lateralAmp: 0.002 },
  tactical: { amp: 0.010, freq: 1.2, lateralAmp: 0.007 },
  casual:   { amp: 0.014, freq: 0.85, lateralAmp: 0.010 },
};
/** Sample a head-bob offset for the given movement type + phase (0..1). */
export function sampleHeadBob(movementType: string, phase: number): { vertical: number; lateral: number } {
  const v = HEADBOB_VARIETY[movementType] ?? HEADBOB_VARIETY.walk!;
  return {
    vertical: Math.sin(phase * Math.PI * 2 * v.freq) * v.amp,
    lateral: Math.cos(phase * Math.PI * 2 * v.freq) * v.lateralAmp,
  };
}

/** C3-5000 #1508-1512 — per-surface gait variety. Each surface type scales
 *  the gait's stride length + foot-fall noise so walking on snow is shorter
 *  + crunchier than walking on concrete. The TPAnimLayer reads this table
 *  via `surfaceGaitScale(surface)` and applies the multipliers to the
 *  locomotion sampler's stride + amplitude inputs. */
export type SurfaceKind = "concrete" | "dirt" | "metal" | "water" | "snow" | "mud" | "sand" | "grass";
export const SURFACE_GAIT_VARIETY: Record<SurfaceKind, { strideScale: number; ampScale: number; noise: number }> = {
  concrete: { strideScale: 1.00, ampScale: 1.00, noise: 0.005 },
  dirt:     { strideScale: 0.98, ampScale: 1.05, noise: 0.012 },
  metal:    { strideScale: 1.02, ampScale: 0.95, noise: 0.020 },
  water:    { strideScale: 0.92, ampScale: 1.15, noise: 0.035 },
  snow:     { strideScale: 0.90, ampScale: 1.10, noise: 0.028 },
  mud:      { strideScale: 0.88, ampScale: 1.20, noise: 0.040 },
  sand:     { strideScale: 0.93, ampScale: 1.12, noise: 0.025 },
  grass:    { strideScale: 1.00, ampScale: 1.02, noise: 0.008 },
};
export function surfaceGaitScale(surface: SurfaceKind): { strideScale: number; ampScale: number; noise: number } {
  return SURFACE_GAIT_VARIETY[surface] ?? SURFACE_GAIT_VARIETY.concrete!;
}

/** C3-5000 #1513 — jump take-off variety. The take-off pose depends on the
 *  locomotion state immediately before the jump (standing still vs walking
 *  vs sprinting changes the crouch depth + arm swing). */
export const JUMP_VARIETY: Record<string, { crouchDepth: number; armSwing: number; anticipationMs: number }> = {
  stand:    { crouchDepth: 0.18, armSwing: 0.20, anticipationMs: 120 },
  walk:     { crouchDepth: 0.20, armSwing: 0.35, anticipationMs: 100 },
  run:      { crouchDepth: 0.24, armSwing: 0.55, anticipationMs: 80 },
  sprint:   { crouchDepth: 0.30, armSwing: 0.70, anticipationMs: 60 },
  crouch:   { crouchDepth: 0.12, armSwing: 0.10, anticipationMs: 150 },
};

/** C3-5000 #1514 — landing variety. Fall height bucket → impact absorption
 *  depth + arm-stabilization weight. */
export const LAND_VARIETY: Record<string, { dipDepth: number; armStab: number; recoveryMs: number }> = {
  short:    { dipDepth: 0.10, armStab: 0.20, recoveryMs: 180 },
  medium:   { dipDepth: 0.20, armStab: 0.45, recoveryMs: 320 },
  long:     { dipDepth: 0.32, armStab: 0.70, recoveryMs: 480 },
  extreme:  { dipDepth: 0.45, armStab: 0.90, recoveryMs: 720 },
};

/** C3-5000 #1515 — fall variety per state. */
export const FALL_VARIETY: Record<string, { bodyTilt: number; limbSplay: number; tumbleRate: number }> = {
  controlled: { bodyTilt: 0.05, limbSplay: 0.20, tumbleRate: 0.0 },
  freefall:   { bodyTilt: 0.15, limbSplay: 0.60, tumbleRate: 0.0 },
  tumble:     { bodyTilt: 0.40, limbSplay: 0.80, tumbleRate: 1.2 },
};

/** C3-5000 #1516 — swim variety per state. */
export const SWIM_VARIETY: Record<string, { strokeRate: number; bodyRoll: number; kickAmp: number }> = {
  surface:   { strokeRate: 0.6, bodyRoll: 0.15, kickAmp: 0.20 },
  submerged: { strokeRate: 0.5, bodyRoll: 0.10, kickAmp: 0.30 },
  sprint:    { strokeRate: 1.0, bodyRoll: 0.25, kickAmp: 0.45 },
};

/** C3-5000 #1517 — climb variety per state. */
export const CLIMB_VARIETY: Record<string, { reachHeight: number; bodyOffset: number; gripMs: number }> = {
  ladder: { reachHeight: 0.45, bodyOffset: 0.20, gripMs: 180 },
  pipe:   { reachHeight: 0.40, bodyOffset: 0.10, gripMs: 220 },
  ledge:  { reachHeight: 0.55, bodyOffset: 0.30, gripMs: 280 },
};

/** C3-5000 #1518 — vault variety per obstacle height. */
export const VAULT_VARIETY: Record<string, { handPlant: number; tuckKnees: number; durationMs: number }> = {
  low:    { handPlant: 0.30, tuckKnees: 0.20, durationMs: 380 },
  mid:    { handPlant: 0.50, tuckKnees: 0.55, durationMs: 560 },
  high:   { handPlant: 0.75, tuckKnees: 0.90, durationMs: 820 },
};

/** C3-5000 #1519 — slide variety per entry speed. */
export const SLIDE_VARIETY: Record<string, { bodyLower: number; frictionDrag: number; durationMs: number }> = {
  slow:   { bodyLower: 0.30, frictionDrag: 1.20, durationMs: 600 },
  medium: { bodyLower: 0.45, frictionDrag: 1.00, durationMs: 900 },
  fast:   { bodyLower: 0.60, frictionDrag: 0.80, durationMs: 1300 },
};

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1542 / #1543 / #1545 / #1546 / #1549 / #1570 — tuning tables
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1542 — blend-speed tuning per locomotion transition (seconds
 *  to fully blend from the source to destination state). */
export const BLEND_SPEED_TABLE: Record<string, number> = {
  idle_to_walk: 0.18,
  walk_to_run: 0.22,
  run_to_sprint: 0.15,
  sprint_to_run: 0.20,
  any_to_crouch: 0.25,
  crouch_to_prone: 0.45,
  prone_to_crouch: 0.40,
  any_to_jump: 0.08,
  any_to_land: 0.12,
  any_to_swim: 0.35,
};

/** C3-5000 #1543 — blend-curve tuning per transition (named easing function). */
export const BLEND_CURVE_TABLE: Record<string, "easeInOutCubic" | "easeOutExpo" | "easeOutBack" | "linear"> = {
  idle_to_walk: "easeInOutCubic",
  walk_to_run: "easeInOutCubic",
  run_to_sprint: "easeOutExpo",
  sprint_to_run: "easeInOutCubic",
  any_to_crouch: "easeOutCubic" as never,
  crouch_to_prone: "easeOutExpo",
  prone_to_crouch: "easeOutBack",
  any_to_jump: "linear",
  any_to_land: "easeOutExpo",
  any_to_swim: "easeInOutCubic",
};

/** C3-5000 #1545 — per-clip timing offset (seconds to delay/advance clip start). */
export const CLIP_TIMING_TABLE: Record<string, number> = {
  grenade_throw: 0.05,
  ladder_climb: 0.0,
  swim_stroke: 0.0,
  reload_rifle: 0.02,
  reload_pistol: 0.01,
  melee_knife: 0.04,
  jump_takeoff: 0.0,
};

/** C3-5000 #1546 — per-clip playback speed multiplier (1.0 = native). */
export const CLIP_SPEED_TABLE: Record<string, number> = {
  idle: 1.0,
  walk: 1.0,
  run: 1.05,
  sprint: 1.10,
  crouch: 0.95,
  prone: 0.85,
  swim: 0.9,
  climb: 0.9,
};

/** C3-5000 #1549 — per-clip root-motion tuning (bool: use root motion vs
 *  in-place + scale multiplier when used). */
export const ROOT_MOTION_TABLE: Record<string, { useRootMotion: boolean; scale: number }> = {
  walk: { useRootMotion: true, scale: 1.0 },
  run: { useRootMotion: true, scale: 1.05 },
  sprint: { useRootMotion: true, scale: 1.15 },
  swim: { useRootMotion: true, scale: 0.85 },
  climb: { useRootMotion: true, scale: 1.0 },
  reload: { useRootMotion: false, scale: 0.0 },
};

/** C3-5000 #1570 — per-map environment animation tuning (global gait
 *  multiplier applied to all locomotion on that map — e.g. jungle = slower
 *  + noisier, desert = faster + drier). */
export const ENVIRONMENT_TUNING_TABLE: Record<string, { gaitScale: number; noiseBoost: number; surfaceDefault: SurfaceKind }> = {
  urban:    { gaitScale: 1.00, noiseBoost: 0.0, surfaceDefault: "concrete" },
  jungle:   { gaitScale: 0.92, noiseBoost: 0.10, surfaceDefault: "grass" },
  desert:   { gaitScale: 1.05, noiseBoost: 0.05, surfaceDefault: "sand" },
  arctic:   { gaitScale: 0.88, noiseBoost: 0.15, surfaceDefault: "snow" },
  industrial: { gaitScale: 1.00, noiseBoost: 0.20, surfaceDefault: "metal" },
  coastal:  { gaitScale: 0.95, noiseBoost: 0.08, surfaceDefault: "water" },
};
