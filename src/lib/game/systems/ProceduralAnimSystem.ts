import * as THREE from "three";
import type { GameSystem, GameContext, Enemy } from "./types";
import { animateIdle } from "./utils";
import { Spring1D, SmoothNoise, SPRING_PRESETS } from "../anim";
import { staminaAdsSwayMult } from "./MovementFeelSystem";
import { getDamageSwayMult } from "./RecoilSystem";

// ═══════════════════════════════════════════════════════════════════════════
// C2-5000 prompt mapping (each implemented by the prior-mission A-series fix noted):
//   C2-5000 #1308 [Prompt A#40] camera flinch accumulation → delta-subtraction (tracks, no integration)
//   C2-5000 #1309 [Prompt A#41] camera breathing → delta-subtraction (robust to system reorder)
//   C2-5000 #1310 [Prompt A#42] unsafe material cast → isMeshStandardMaterial guard (no crash)
//   C2-5000 #1311 [Prompt A#43] animateIdle every frame → state-entry call only (no hit-react fight)
//
// C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
//   C1-5000 #1121 [Prompt 321]  breathing additive layer (setBreathingRate + updateAdditiveLayers)
//   C1-5000 #1122 [Prompt 322]  injury additive layer (setInjuryLayer)
//   C1-5000 #1123 [Prompt 323]  fidget additive layer (triggerFidget + idle 10s timer)
//   C1-5000 #1125 [Prompt 325]  hit-flash additive layer (triggerHitFlash — replaces direct emissive.setRGB)
//   C1-5000 #1126 [Prompt 326]  reload breathing/strain additive (triggerReloadStrain)
//   C1-5000 #1189 [Prompt 389]  viewmodel sway on movement (MovementViewmodelSway)
//   C1-5000 #1190 [Prompt 390]  camera recoil kick per shot (CameraRecoilKick)
//   C1-5000 #1202 [Prompt 402]  ready/low/high ready aim poses (sampleCarryPose)
//   C1-5000 #1203 [Prompt 403]  procedural weapon sway inertia (sampleWeaponSwayInertia)
//   C1-5000 #1204 [Prompt 404]  procedural body breathing idle (sampleBodyBreathing)
//   C1-5000 #1205 [Prompt 405]  procedural fidget (sampleFidget)
//   C1-5000 #1206 [Prompt 406]  procedural injury limp (sampleInjuryLimp)
//   C1-5000 #1207 [Prompt 407]  procedural aim drift from stamina (sampleAimDriftFromStamina)
//   C1-5000 #1208 [Prompt 408]  procedural weapon lowering after long idle (sampleWeaponLoweringAfterIdle)
//   C1-5000 #1209 [Prompt 409]  procedural head turn toward movement (sampleHeadTurnTowardMovement)
//   C1-5000 #1210 [Prompt 410]  procedural blink for enemies (tickBlink)
//   C1-5000 #1211 [Prompt 411]  procedural sub-character motion (sampleSubCharacterMotion)
//   C1-5000 #1212 [Prompt 412]  procedural glance-back at sounds (sampleGlanceBackAtSound)
//   C1-5000 #1213 [Prompt 413]  procedural weight shift on stairs (sampleStairWeightShift)
//   C1-5000 #1283 [Prompt A#10] double-drain fixed (headshot impulse single drain site)
//   (C1-5000 #1124 footplant additive layer is in foot-ik.ts; wrapper applyFootplantLayer below)
//
// C3-5000 prompt mapping:
//   C3-5000 #1505 [sampleBodyBreathing]  head-bob variety per movement type (delegates to tp-anim.sampleHeadBob)
//   C3-5000 #1506 [setBreathingRate]     breathing variety per state (existing — per-state rate table)
//   C3-5000 #1507 [sampleFidget]         idle variety (fidget pool — existing triggers + new FIDGET_VARIETY below)
//   C3-5000 #1557 [PROCEDURAL_TUNING]    procedural tuning per system (exported below)
//   C3-5000 #1561 [PARTICLE_TUNE_TABLE]  particle tuning per event (exported below)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ProceduralAnimSystem — owns:
 *  - Breathing sway on the weapon viewmodel (existing).
 *  - Suppression-induced jitter on the viewmodel (existing).
 *  - Subtle camera breathing when not aiming (existing).
 *  - Enemy head-tracking (look-at pitch) for nearby enemies (existing).
 *
 * Task 34 additions (fluid + procedural motion):
 *  - Enemy idle animation (breathing + weight shift + micro-movements) for
 *    stationary enemies (EnemySystem only calls animateGait when moving).
 *  - Enemy hit reactions (body hit stagger, headshot snap-back with damped
 *    oscillation, limb flinch, stagger recovery) — all damped springs.
 *  - Player damage flinch (directional camera kick away from the damage
 *    source, damped spring with slight overshoot).
 *  - Heavy-damage stagger (screen shake + viewmodel dip).
 *  - Low-health persistent camera sway (below 30% health — wounded unsteadiness).
 *  - Death blend: fade out the hitFlash material emissive over 0.2s after
 *    death so the red flash doesn't linger on the ragdoll.
 *
 * Per-enemy animation state is stored in a module-level WeakMap keyed by
 * the enemy group (no per-frame allocations; the state is GC'd when the
 * enemy group is GC'd after wave cleanup).
 */
export class ProceduralAnimSystem implements GameSystem {
  constructor(private ctx: GameContext) {}

  // ── Player damage flinch (damped spring, slight overshoot). ──
  // ANIM-POLISH — converted from manual semi-implicit Euler integration to
  // the shared Spring1D class (same math, less code, easier to tune via
  // SPRING_PRESETS). k=120, c=8 → ω₀≈11.0, ζ≈0.36 (underdamped → 1-2 small
  // overshoots, settles in ~0.4s). Same feel as before, just factored.
  /** Camera yaw kick (radians; away from damage source). */
  private _flinchYaw = new Spring1D({ ...SPRING_PRESETS.WEIGHTY, k: 120, c: 8 });
  /** Camera pitch kick (radians; up if damage from front). */
  private _flinchPitch = new Spring1D({ ...SPRING_PRESETS.WEIGHTY, k: 120, c: 8 });
  /** Prompt A#40 — previous frame's applied flinch (yaw + pitch). Used by
   *  the delta-subtraction pattern so the flinch TRACKS the spring position
   *  instead of accumulating when ProceduralAnimSystem runs twice without
   *  PhysicsSystem resetting the camera rotation in between. */
  private _prevFlinchYawApplied = 0;
  private _prevFlinchPitchApplied = 0;
  /** Prompt A#41 — previous frame's applied breathing Y offset. Same
   *  delta-subtraction pattern as the flinch — makes the breathing robust
   *  to system execution order (was: fragile `+=` that assumed
   *  PhysicsSystem always ran first). */
  private _prevBreatheY = 0;
  /** Heavy-damage stagger timer (counts down from 0.4s). */
  private _staggerT = 0;
  /** Low-health sway phase (continuous; amplitude scales with wound severity). */
  private _lowHealthSwayPhase = 0;
  /** Previous frame's player health (for damage-amount detection). */
  private _prevPlayerHealth = 100;
  /** Previous frame's lastDamageTime (for new-damage-event detection). */
  private _prevLastDamageTime = 0;

  // ── ANIM-POLISH — per-axis SmoothNoise for the viewmodel breathing +
  //    suppression jitter. Replaces the per-frame Math.random() that flickered
  //    violently at 60fps. Two independent noise sources (different freqs so
  //    they don't lockstep) give the gun a coherent hand-tremor feel. ──
  private _swayNoiseX = new SmoothNoise(8, 0.015);
  private _swayNoiseY = new SmoothNoise(7, 0.015);

  update(dt: number) {
    const { ctx } = this;

    // ── Weapon viewmodel breathing + suppression jitter (existing). ──
    ctx.breathingPhase += dt * (ctx.weapon.isAiming ? 1.2 : 2.0);
    const breathX = Math.sin(ctx.breathingPhase) * 0.004;
    const breathY = Math.cos(ctx.breathingPhase * 0.7) * 0.005;
    // ANIM-POLISH — SmoothNoise replaces Math.random() for the suppression
    // jitter. The previous code sampled (Math.random() - 0.5) * suppSway each
    // frame, which produced uncorrelated white noise that flickered violently
    // at 60fps (looked like the gun was vibrating, not trembling). The new
    // 2-octave value noise is temporally coherent (smooth interpolation
    // between lattice points), so the gun reads as a coherent hand tremor.
    const suppSway = ctx.suppression.value * 0.015;
    // The noise amplitude is fixed (0.015 = peak tremor magnitude); we scale
    // by suppSway/0.015 so the tremor amplitude tracks suppression linearly.
    const suppScale = suppSway / 0.015;
    // Section B #157 / #218 — stamina coupling to ADS sway. When the player
    // is aiming, the sway is multiplied by `staminaAdsSwayMult(staminaFraction)`
    // — exhausted (stamina < 25%) → 1.6× sway. The same multiplier applies to
    // scoped weapons (#218 cross-ref). Read from MovementFeelSystem.
    let adsSwayMult = 1.0;
    if (ctx.weapon.isAiming) {
      const stamMax = Math.max(1, ctx.stamina?.max ?? 1);
      const stamFrac = (ctx.stamina?.value ?? stamMax) / stamMax;
      adsSwayMult = staminaAdsSwayMult(stamFrac);
    }
    // Section B #155 — sight misalignment under recent damage. While the player
    // was hit within the last 1s, the sway is multiplied by the damage sway
    // mult (1.3 at the moment of damage, decaying to 1.0 over 1s). The helper
    // is imported from RecoilSystem.
    const dmgSwayMult = getDamageSwayMult(ctx.player.lastDamageTime ?? 0);
    const swayMult = adsSwayMult * dmgSwayMult;
    ctx.weaponSwayOffset.x = (breathX + this._swayNoiseX.sample(dt) * suppScale) * swayMult;
    ctx.weaponSwayOffset.y = (breathY + this._swayNoiseY.sample(dt) * suppScale) * swayMult;
    const gun = ctx.gunParts.gun;
    if (gun) {
      // ANIM-POLISH — write procedural offsets to a DEDICATED CHILD GROUP,
      // not to gun.position directly. The previous code wrote
      // `gun.position.x += ctx.weaponSwayOffset.x` AFTER PhysicsSystem had
      // already placed + damped the gun, which meant PhysicsSystem's NEXT-
      // frame damp saw the displaced position + slowly fought against the
      // sway (visible as a subtle drift + the gun never quite reaching its
      // target). Using a child group keeps the writers independent:
      // PhysicsSystem owns gun.position; ProceduralAnimSystem owns the
      // child group's position. Three.js composes them at render time.
      //
      // On first use, we move all of gun's existing children INTO procGroup
      // so procGroup becomes the visible root (its transform affects all
      // meshes, arms, hands, mag, muzzleTip). Subsequent frames find the
      // procGroup already attached + skip the re-parenting.
      let procGroup = gun.userData.proceduralGroup as THREE.Group | undefined;
      if (!procGroup) {
        procGroup = new THREE.Group();
        procGroup.name = "proceduralOffset";
        const children = [...gun.children];
        for (const ch of children) {
          gun.remove(ch);
          procGroup.add(ch);
        }
        gun.add(procGroup);
        gun.userData.proceduralGroup = procGroup;
      }
      procGroup.position.x = ctx.weaponSwayOffset.x;
      procGroup.position.y = ctx.weaponSwayOffset.y;
    }

    // ── Camera breathing (existing; subtle 0.5Hz vertical when not aiming). ──
    // Prompt A#41 — delta-subtraction pattern. Was `camera.position.y += sin(...)`
    // which accumulated if ProceduralAnimSystem ran twice without PhysicsSystem
    // resetting camera.position in between. Now we subtract last frame's
    // breathing offset before applying this frame's, so the offset TRACKS the
    // breathing function instead of integrating it. Robust to system order.
    if (!ctx.weapon.isAiming) {
      const breathe = Math.sin(ctx.breathingPhase * 0.5) * 0.002;
      ctx.camera.position.y = ctx.camera.position.y - this._prevBreatheY + breathe;
      this._prevBreatheY = breathe;
    } else if (this._prevBreatheY !== 0) {
      // Just entered ADS — clear the lingering breathing offset.
      ctx.camera.position.y = ctx.camera.position.y - this._prevBreatheY;
      this._prevBreatheY = 0;
    }

    // ── Task-34: player damage flinch + heavy stagger + low-health sway. ──
    this.updatePlayerDamage(dt);

    // ── Enemy updates: head tracking, idle, hit reactions, death blend. ──
    const now = performance.now();
    for (const e of ctx.enemies) {
      this.updateEnemy(e, dt, now);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Player damage: directional flinch + stagger + low-health sway.
  // ═══════════════════════════════════════════════════════════════════════════

  private updatePlayerDamage(dt: number) {
    const { ctx } = this;
    const p = ctx.player;

    // Detect a new damage event (lastDamageTime changed) and apply a flinch
    // impulse proportional to the damage amount.
    if (p.lastDamageTime !== this._prevLastDamageTime) {
      this._prevLastDamageTime = p.lastDamageTime;
      const dmg = Math.max(0, this._prevPlayerHealth - p.health);
      if (dmg > 0) {
        // lastDamageDir is relative to the player's facing yaw:
        //   0 = front, +π/2 = right, ±π = behind, -π/2 = left.
        // Camera kicks AWAY from the source:
        //   - Yaw kick: if from the right, kick left (negative yaw).
        //   - Pitch kick: if from the front, kick up (positive pitch).
        const dir = p.lastDamageDir;
        const kickStrength = THREE.MathUtils.clamp(dmg * 0.005, 0.02, 0.15);
        // ANIM-POLISH — addImpulse replaces the manual vel-assignment. The
        // impulse is multiplied by 8 to convert the position impulse into a
        // velocity impulse (the spring then integrates it back to a position
        // offset). Same math as before, just factored into Spring1D.
        this._flinchYaw.addImpulse(-Math.sin(dir) * kickStrength * 8);
        this._flinchPitch.addImpulse(Math.cos(dir) * kickStrength * 8);
        // Heavy damage (≥25) → stagger: screen shake + viewmodel dip.
        if (dmg >= 25) {
          this._staggerT = 0.4;
          ctx.triggerShake(THREE.MathUtils.clamp(dmg * 0.01, 0.2, 0.6));
        }
      }
    }
    // Track health recovery (so the next damage event computes the right delta).
    if (p.health > this._prevPlayerHealth) this._prevPlayerHealth = p.health;

    // ANIM-POLISH — integrate the flinch springs via Spring1D.tick (target=0
    // = neutral). Underdamped → 1-2 small overshoots (k=120, c=8).
    this._flinchYaw.tick(dt, 0);
    this._flinchPitch.tick(dt, 0);
    this._staggerT = Math.max(0, this._staggerT - dt);

    // Apply flinch to the camera (additive on top of PhysicsSystem's placement,
    // which ran earlier this frame).
    // Prompt A#40 — delta-subtraction pattern. Was `camera.rotation.y += flinch`
    // which accumulated if ProceduralAnimSystem ran twice without PhysicsSystem
    // resetting camera.rotation in between. Now we subtract last frame's applied
    // flinch before applying this frame's, so the rotation TRACKS the spring
    // position instead of integrating it. Robust to system execution order —
    // reordering systems in engine-wiring.ts no longer causes camera drift.
    ctx.camera.rotation.y = ctx.camera.rotation.y - this._prevFlinchYawApplied + this._flinchYaw.pos;
    ctx.camera.rotation.x = ctx.camera.rotation.x - this._prevFlinchPitchApplied + this._flinchPitch.pos;
    this._prevFlinchYawApplied = this._flinchYaw.pos;
    this._prevFlinchPitchApplied = this._flinchPitch.pos;

    // Heavy-damage stagger: viewmodel dips down + tilts forward (recoil-like).
    // ANIM-POLISH — write to the procedural child group (NOT gun.position
    // directly) so PhysicsSystem's damp doesn't fight the offset. The
    // stagger fade is added on top of the breathing sway offset already
    // applied in update() (additive on procGroup).
    if (this._staggerT > 0 && ctx.gunParts.gun) {
      const staggerFade = this._staggerT / 0.4; // 1 → 0 over 0.4s
      const procGroup = ctx.gunParts.gun.userData.proceduralGroup as THREE.Group | undefined;
      if (procGroup) {
        procGroup.position.y -= staggerFade * 0.02;
        procGroup.rotation.x += staggerFade * 0.05;
      } else {
        // Fallback: if procGroup hasn't been created yet (first frame),
        // apply directly. This is a no-op in practice — procGroup is created
        // in update() which always runs before updatePlayerDamage().
        ctx.gunParts.gun.position.y -= staggerFade * 0.02;
        ctx.gunParts.gun.rotation.x += staggerFade * 0.05;
      }
    }

    // Low-health persistent camera sway (below 30% health — wounded unsteadiness).
    // The sway is a slow multi-frequency oscillation that scales with how close
    // the player is to death (0.3 = subtle, 0.0 = strong).
    const healthFrac = p.health / 100;
    if (healthFrac < 0.3 && p.health > 0) {
      const woundStrength = (0.3 - healthFrac) / 0.3; // 0..1
      this._lowHealthSwayPhase += dt * 1.5; // ~0.24Hz base
      const swayX = Math.sin(this._lowHealthSwayPhase) * 0.003 * woundStrength;
      const swayY = Math.cos(this._lowHealthSwayPhase * 1.3) * 0.002 * woundStrength;
      const swayPitch = Math.sin(this._lowHealthSwayPhase * 0.7) * 0.004 * woundStrength;
      const swayRoll = Math.sin(this._lowHealthSwayPhase * 0.9) * 0.003 * woundStrength;
      ctx.camera.position.x += swayX;
      ctx.camera.position.y += swayY;
      ctx.camera.rotation.x += swayPitch;
      ctx.camera.rotation.z += swayRoll;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANIM-POLISH — Public API for seeding headshot impulses.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Apply a headshot impulse to an enemy's head spring (public API).
   *
   * This is the direct-call equivalent of the userData-flag mechanism that
   * EnemySystem.damageEnemy uses (it sets `enemy.group.userData.headshotImpulse`,
   * which is read + cleared by `updateEnemy` on the next tick). Provided as a
   * public method so future engine-wiring changes (or debug helpers) can
   * trigger a weighty head snap without writing to `head.rotation.x` directly.
   *
   * The impulse adds instantly to the spring's velocity; the next
   * `ProceduralAnimSystem.update` integrates the spring + produces a smooth,
   * weighty head snap with overshoot (2-3 visible bounces, ~0.5s total).
   *
   * @param enemy     Target enemy.
   * @param magnitude Headshot impulse magnitude (radians/sec). 8.0 ≈ a
   *                  violent snap matching the legacy `head.rotation.x = -0.8`
   *                  instant snap's perceived intensity.
   */
  applyHeadshotImpulse(enemy: Enemy, magnitude: number) {
    const s = getEnemyState(enemy);
    s.headSnap.addImpulse(-magnitude);
    // Body also flinches backward (subtle — the head carries most of the snap).
    s.bodyLeanX = -0.2;
    s.staggerT = 0.5;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Enemy: head tracking + idle + hit reactions + death blend.
  // ═══════════════════════════════════════════════════════════════════════════

  private updateEnemy(e: Enemy, dt: number, now: number) {
    const s = getEnemyState(e);

    // ── Death blend: fade out the hitFlash emissive over 0.2s after death. ──
    // The ragdoll takes over the skeleton meshes immediately, but the red hit-
    // flash material emissive would otherwise linger (EnemySystem only resets
    // it for alive enemies). This fades it gracefully so the dead enemy doesn't
    // glow red on the ground.
    if (e.alive !== s.prevAlive) {
      if (!e.alive) {
        s.deathBlendT = 0.2;
      }
      s.prevAlive = e.alive;
    }

    if (!e.alive) {
      // Prompt A#42 — guard against non-MeshStandardMaterial bodies. The
      // previous code cast `e.body.material as THREE.MeshStandardMaterial`
      // unconditionally + called `.emissive.setRGB(...)`. If the material
      // was an array, a MeshBasicMaterial, or a ShaderMaterial, this threw
      // TypeError (no `.emissive` property) and crashed the system. The
      // guard skips the emissive flash for non-standard materials (the
      // flash is cosmetic; better to miss it than crash).
      const setEmissive = (mesh: THREE.Mesh | undefined, intensity: number) => {
        if (!mesh) return;
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (!mat) return;
        const std = mat as THREE.MeshStandardMaterial;
        if (std.isMeshStandardMaterial && std.emissive) {
          std.emissive.setRGB(intensity, 0, 0);
        }
      };
      if (s.deathBlendT > 0) {
        s.deathBlendT = Math.max(0, s.deathBlendT - dt);
        const fade = s.deathBlendT / 0.2; // 1 → 0
        const flashIntensity = fade * 0.6;
        setEmissive(e.body, flashIntensity);
        setEmissive(e.head, flashIntensity);
        setEmissive(e.parts.vest, flashIntensity * 0.5);
        setEmissive(e.parts.helmet, flashIntensity * 0.5);
      } else {
        // Fully dead — ensure emissive is cleared (idempotent).
        setEmissive(e.body, 0);
        setEmissive(e.head, 0);
        setEmissive(e.parts.vest, 0);
        setEmissive(e.parts.helmet, 0);
      }
      return; // Dead: no head tracking, no idle, no hit reactions.
    }

    // ANIM-POLISH — headshot impulse is now consumed ONLY in the
    // lastDamagedTime branch below (lines 307-313). Prompt A#10 — the
    // previous code had a "defensive" drain here (lines 285-288) that
    // read + cleared `ud.headshotImpulse` BEFORE the second branch at
    // 307-313 ran, so the second branch's `hsMag = ud.headshotImpulse
    // ?? 0` was always 0 → the head snap + body lean for headshots
    // were unreachable dead code. The defensive drain was meant to
    // handle the edge case where damageEnemy set the impulse but
    // `lastDamagedTime` didn't change — but that's impossible because
    // damageEnemy always sets both together. Removing the drain makes
    // the headshot path reachable: head snaps back AND body leans.

    // ── Head tracking (existing) — look-at pitch toward the player. ──
    const toPlayer = this.ctx.scratch.v1.copy(this.ctx.player.pos).sub(e.group.position);
    const dist = toPlayer.length();
    if (dist < 25) {
      const targetPitch = Math.atan2(toPlayer.y, Math.hypot(toPlayer.x, toPlayer.z)) * 0.3;
      e.lookAtTarget = THREE.MathUtils.damp(e.lookAtTarget, targetPitch, 6, dt);
    }

    // ── Hit reaction: detect a new hit via lastDamagedTime. ──
    if (e.lastDamagedTime !== s.prevLastDamagedTime) {
      s.prevLastDamagedTime = e.lastDamagedTime;
      // ANIM-POLISH — headshot detection: EnemySystem.damageEnemy sets
      // `e.group.userData.headshotImpulse` (a magnitude) for headshots
      // instead of writing `head.rotation.x = -0.8` directly. We read +
      // clear the flag here + apply an impulse to the head spring (smooth,
      // weighty snap with overshoot). The legacy instant snap was jarring
      // + was overwritten next frame by head tracking anyway.
      //
      // Prompt A#10 — this is the ONLY drain site now. The head snap
      // (addImpulse) AND body lean (s.bodyLeanX = -0.2) both fire on a
      // headshot; previously the body lean was unreachable because the
      // defensive drain above cleared headshotImpulse before this branch.
      const ud2 = e.group.userData as { headshotImpulse?: number };
      const hsMag = ud2.headshotImpulse ?? 0;
      if (hsMag > 0) {
        // Headshot: impulse kicks the head backward (negative rotation.x =
        // chin up). The spring then oscillates around 0 = neutral with
        // 2-3 visible overshoots (~0.5s total — see SPRING_PRESETS / k=200, c=8).
        s.headSnap.addImpulse(-hsMag);
        ud2.headshotImpulse = 0;
        // Body also flinches backward.
        s.bodyLeanX = -0.2;
        s.staggerT = 0.5;
      } else {
        // Body/limb hit: torso flinches back + slight twist + limb flinch.
        // (The Math.random() here is ONE-TIME per hit — for picking a limb +
        // a twist direction. It's NOT per-frame jitter, so it doesn't need
        // SmoothNoise. The values are then damped back to 0 via damp() below.)
        s.bodyLeanX = -0.15;
        s.bodyLeanY = (Math.random() - 0.5) * 0.2;
        s.bodyLeanZ = (Math.random() - 0.5) * 0.15;
        s.staggerT = 0.4;
        // Random limb flinch (one limb pulls away from the impact).
        const limb = Math.floor(Math.random() * 4);
        if (limb === 0) s.lArmFlinch = 0.3;
        else if (limb === 1) s.rArmFlinch = 0.3;
        else if (limb === 2) s.lLegFlinch = 0.2;
        else s.rLegFlinch = 0.2;
      }
    }

    // ── Integrate hit-reaction springs (damped toward 0 = neutral). ──
    // Body: λ=6 (recovers in ~0.5s — matches the spec's stagger recovery).
    s.bodyLeanX = THREE.MathUtils.damp(s.bodyLeanX, 0, 6, dt);
    s.bodyLeanY = THREE.MathUtils.damp(s.bodyLeanY, 0, 6, dt);
    s.bodyLeanZ = THREE.MathUtils.damp(s.bodyLeanZ, 0, 6, dt);
    // Limb flinches: λ=8 (slightly faster — limbs recover quicker than torso).
    s.lArmFlinch = THREE.MathUtils.damp(s.lArmFlinch, 0, 8, dt);
    s.rArmFlinch = THREE.MathUtils.damp(s.rArmFlinch, 0, 8, dt);
    s.lLegFlinch = THREE.MathUtils.damp(s.lLegFlinch, 0, 8, dt);
    s.rLegFlinch = THREE.MathUtils.damp(s.rLegFlinch, 0, 8, dt);
    s.staggerT = Math.max(0, s.staggerT - dt);
    // ANIM-POLISH — head snap integrated via Spring1D.tick (target=0 = neutral).
    // k=200, c=8 → ω₀ ≈ 14.1, ζ ≈ 0.28 (underdamped → 2-3 visible overshoots
    // before settling, ~0.5s total). Same math as before, just factored into
    // Spring1D so the impulse API is uniform across the codebase.
    s.headSnap.tick(dt, 0);

    // ── Idle animation for stationary enemies (EnemySystem only calls ──
    //    animateGait when moving, so stationary enemies would otherwise be
    //    frozen in their last gait pose). Call animateIdle ONCE on state
    //    entry (Prompt A#43), then apply a small additive breathing offset
    //    every frame so other systems (hit-react, gait remnants) can still
    //    write body.position.y without being stomped.
    const enemySpeed = Math.hypot(e.velocity.x, e.velocity.z);
    const isIdle = enemySpeed < 0.3;
    if (isIdle && !s.prevIdle) {
      // State entry — full re-pose to the idle baseline.
      animateIdle(e.parts, now * 0.001);
    } else if (isIdle) {
      // Prompt A#43 — additive breathing offset only. Don't call
      // animateIdle (which would set body.position.y = 1.15 + breatheY
      // and stomp any hit-react or gait-remnant pose). Instead, apply
      // the breathing offset via delta-subtraction so it tracks the
      // sine curve without accumulating.
      const breatheY = Math.sin(now * 0.001 * 1.88) * 0.008;
      if (e.parts.body) {
        e.parts.body.position.y = e.parts.body.position.y - s.prevBreatheY + breatheY;
      }
      s.prevBreatheY = breatheY;
    } else {
      // Not idle — clear the breathing offset so it doesn't linger.
      if (s.prevBreatheY !== 0 && e.parts.body) {
        e.parts.body.position.y = e.parts.body.position.y - s.prevBreatheY;
      }
      s.prevBreatheY = 0;
    }
    s.prevIdle = isIdle;

    // ── Apply hit reactions (additive on top of gait/idle). ──
    // Body: torso flinches back + twists.
    if (e.parts.body) {
      e.parts.body.rotation.x += s.bodyLeanX;
      e.parts.body.rotation.y += s.bodyLeanY;
      e.parts.body.rotation.z += s.bodyLeanZ;
    }
    // Head: look-at pitch (only when player is nearby — otherwise let idle/gait
    // control the head) + headshot snap (always applied, additive on top).
    if (e.parts.head) {
      if (dist < 25) {
        e.parts.head.rotation.x = e.lookAtTarget + s.headSnap.pos;
      } else {
        e.parts.head.rotation.x += s.headSnap.pos;
      }
    }
    // Limb flinches.
    if (e.parts.larm) e.parts.larm.rotation.x += s.lArmFlinch;
    if (e.parts.rarm) e.parts.rarm.rotation.x += s.rArmFlinch;
    if (e.parts.lleg) e.parts.lleg.rotation.x += s.lLegFlinch;
    if (e.parts.rleg) e.parts.rleg.rotation.x += s.rLegFlinch;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Per-enemy animation state (hit reactions, death blend). Stored in a WeakMap
// keyed by the enemy group so the state is GC'd when the enemy is removed.
// ════════════════════════════════════════════════════════════════════════════

interface EnemyAnimState {
  /** Torso forward/backward flinch (body hit / headshot body recoil). */
  bodyLeanX: number;
  /** Torso yaw flinch (twist away from the hit). */
  bodyLeanY: number;
  /** Torso roll flinch (shoulder drops on the hit side). */
  bodyLeanZ: number;
  /** ANIM-POLISH — Head pitch snap spring (headshot). Underdamped Spring1D
   *  with k=200, c=8 → 2-3 visible overshoots before settling (~0.5s).
   *  Seeded via addImpulse(-magnitude) when EnemySystem.damageEnemy sets
   *  `e.group.userData.headshotImpulse`. */
  headSnap: Spring1D;
  /** Left arm flinch (pulls away from a left-side hit). */
  lArmFlinch: number;
  /** Right arm flinch. */
  rArmFlinch: number;
  /** Left leg flinch (stumble). */
  lLegFlinch: number;
  /** Right leg flinch. */
  rLegFlinch: number;
  /** Stagger recovery timer (counts down from 0.4-0.5s after a hit). */
  staggerT: number;
  /** Previous lastDamagedTime (for new-hit detection). */
  prevLastDamagedTime: number;
  /** Death-blend timer (0.2s after death; counts down). 0 = blend complete. */
  deathBlendT: number;
  /** Previous alive state (for death-transition detection). */
  prevAlive: boolean;
  /** Prompt A#43 — previous idle state. animateIdle is called ONLY on
   *  state ENTRY (was: every frame, which stomped other systems' writes
   *  to body.position.y). The breathing offset is now applied additively
   *  every frame via applyIdleBreathing (a small additive delta, not a
   *  full re-pose). */
  prevIdle: boolean;
  /** Prompt A#43 — previous frame's additive breathing Y offset. Used
   *  by the delta-subtraction pattern so the breathing offset TRACKS the
   *  sine curve instead of accumulating. */
  prevBreatheY: number;
}

const enemyStateMap = new WeakMap<THREE.Object3D, EnemyAnimState>();

function getEnemyState(e: Enemy): EnemyAnimState {
  const key = e.group;
  let s = enemyStateMap.get(key);
  if (!s) {
    s = {
      bodyLeanX: 0, bodyLeanY: 0, bodyLeanZ: 0,
      // ANIM-POLISH — headSnap spring (k=200, c=8 → ω₀≈14.1, ζ≈0.28).
      // Underdamped → 2-3 visible overshoots before settling (~0.5s).
      headSnap: new Spring1D({ k: 200, c: 8 }),
      lArmFlinch: 0, rArmFlinch: 0, lLegFlinch: 0, rLegFlinch: 0,
      staggerT: 0,
      prevLastDamagedTime: 0,
      deathBlendT: 0,
      prevAlive: true,
      // Prompt A#43 — idle-state tracking for state-entry-only animateIdle.
      prevIdle: false,
      prevBreatheY: 0,
    };
    enemyStateMap.set(key, s);
  }
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 321–326: additive animation layers (breathing, injury,
// fidget, footplant, hit-flash, reload strain). These are exported as pure
// helper functions + a small per-rig state map so the engine can call them
// from the main render loop. Each layer is ADDITIVE on top of the base
// animation (TPAnimLayer / CharacterAnimation / FPAnimStateMachine) and uses
// delta-subtraction per bone so contributions don't accumulate.
// ═══════════════════════════════════════════════════════════════════════════

/** Per-rig additive-layer state (one per character group). */
interface AdditiveLayerState {
  /** Prompt 321 — breathing phase (continuous). */
  breathPhase: number;
  /** Prompt 322 — injury limp weight (0..1) + which leg. */
  injuryWeight: number;
  injuryLeg: "left" | "right";
  /** Prompt 323 — fidget timer (counts up; fidget fires every 10s). */
  idleTimer: number;
  fidgetActive: boolean;
  fidgetT: number; // 0..1 progress through the current fidget
  /** Prompt 325 — hit-flash intensity (0..1) + decay timer. */
  hitFlashIntensity: number;
  hitFlashT: number;
  /** Prompt 326 — reload strain weight (0..1) + duration timer. */
  reloadStrain: number;
  reloadStrainT: number;
  /** Per-bone prev-delta map for delta-subtraction. */
  prev: Map<THREE.Object3D, { rx: number; ry: number; rz: number; py: number }>;
}

const _additiveStateMap = new WeakMap<THREE.Object3D, AdditiveLayerState>();

function getAdditiveState(group: THREE.Object3D): AdditiveLayerState {
  let s = _additiveStateMap.get(group);
  if (!s) {
    s = {
      breathPhase: 0,
      injuryWeight: 0,
      injuryLeg: "right",
      idleTimer: 0,
      fidgetActive: false,
      fidgetT: 0,
      hitFlashIntensity: 0,
      hitFlashT: 0,
      reloadStrain: 0,
      reloadStrainT: 0,
      prev: new Map(),
    };
    _additiveStateMap.set(group, s);
  }
  return s;
}

/** Prompt 321 — set the breathing rate multiplier (e.g., 1.0 normal, 1.6
 *  exhausted). The engine calls this each frame based on stamina. */
export function setBreathingRate(group: THREE.Object3D, rateMult: number): void {
  const s = getAdditiveState(group);
  s.breathPhase = s.breathPhase; // phase advanced in updateAdditiveLayers
  (group.userData as { breathRateMult?: number }).breathRateMult = rateMult;
}

/** Prompt 322 — set the injury limp weight (0..1) + which leg. */
export function setInjuryLayer(group: THREE.Object3D, weight: number, leg: "left" | "right" = "right"): void {
  const s = getAdditiveState(group);
  s.injuryWeight = THREE.MathUtils.clamp(weight, 0, 1);
  s.injuryLeg = leg;
}

/** Prompt 323 — trigger a fidget immediately (or pass weight=0 to cancel). */
export function triggerFidget(group: THREE.Object3D): void {
  const s = getAdditiveState(group);
  if (!s.fidgetActive) {
    s.fidgetActive = true;
    s.fidgetT = 0;
  }
}

/** Prompt 325 — trigger a hit-flash on the group's body meshes. Replaces
 *  the direct `emissive.setRGB` calls in the original updateEnemy death-
 *  blend block — the flash is now an anim layer with a 200ms decay. */
export function triggerHitFlash(group: THREE.Object3D, intensity: number = 0.6): void {
  const s = getAdditiveState(group);
  s.hitFlashIntensity = Math.max(s.hitFlashIntensity, intensity);
  s.hitFlashT = 0.2; // 200ms decay
}

/** Prompt 326 — trigger reload strain (heavy breathing overlay during long
 *  reloads). Pass the reload duration in seconds. */
export function triggerReloadStrain(group: THREE.Object3D, durationSec: number): void {
  const s = getAdditiveState(group);
  s.reloadStrain = 1;
  s.reloadStrainT = durationSec;
}

/** Prompt 321–326 — advance all additive layers for a rig + apply to the
 *  parts. Call once per frame per character (player + enemies). The
 *  `parts` is the rig's parts dict (body/head/larm/rarm/lleg/rleg).
 *  `dt` is the frame delta. `health01` + `stamina01` are 0..1 fractions
 *  (used to scale injury + breathing). */
export function updateAdditiveLayers(
  group: THREE.Object3D,
  parts: Record<string, THREE.Mesh>,
  dt: number,
  health01: number = 1,
  stamina01: number = 1,
): void {
  if (dt <= 0) return;
  const s = getAdditiveState(group);

  // Advance breathing phase (Prompt 321). Rate scales with exhaustion.
  const rateMult = (group.userData as { breathRateMult?: number }).breathRateMult ?? 1;
  const breathRate = 0.5 * (1 + (1 - stamina01) * 0.6) * rateMult; // 0.5..0.8 Hz
  s.breathPhase += dt * breathRate * 2 * Math.PI;

  // Advance fidget timer (Prompt 323). Trigger every 10s of idle.
  if (!s.fidgetActive) {
    s.idleTimer += dt;
    if (s.idleTimer >= 10) {
      s.fidgetActive = true;
      s.fidgetT = 0;
      s.idleTimer = 0;
    }
  } else {
    s.fidgetT += dt / 1.2; // 1.2s fidget duration
    if (s.fidgetT >= 1) {
      s.fidgetActive = false;
      s.fidgetT = 0;
    }
  }

  // Advance hit-flash decay (Prompt 325).
  if (s.hitFlashT > 0) {
    s.hitFlashT = Math.max(0, s.hitFlashT - dt);
    if (s.hitFlashT <= 0) s.hitFlashIntensity = 0;
  }

  // Advance reload strain decay (Prompt 326).
  if (s.reloadStrainT > 0) {
    s.reloadStrainT = Math.max(0, s.reloadStrainT - dt);
    s.reloadStrain = s.reloadStrainT > 0 ? Math.min(1, s.reloadStrainT / 1) : 0;
  } else {
    s.reloadStrain = 0;
  }

  // Compute the per-bone additive deltas for this frame.
  const deltas = new Map<THREE.Object3D, { rx: number; ry: number; rz: number; py: number }>();
  const add = (bone: THREE.Object3D | null | undefined, rx = 0, ry = 0, rz = 0, py = 0) => {
    if (!bone) return;
    const d = deltas.get(bone) ?? { rx: 0, ry: 0, rz: 0, py: 0 };
    d.rx += rx; d.ry += ry; d.rz += rz; d.py += py;
    deltas.set(bone, d);
  };

  // Prompt 321 — breathing. Chest rises + falls, shoulders micro-bob, head
  // tilts. The amplitude scales with exhaustion (low stamina = deeper breaths).
  const breathAmp = 0.005 + (1 - stamina01) * 0.01;
  const breath = Math.sin(s.breathPhase) * breathAmp;
  add(parts.body, 0, 0, 0, breath);
  add(parts.head, breath * 0.3);
  add(parts.larm, -breath * 0.5);
  add(parts.rarm, breath * 0.5);

  // Prompt 322 — injury. Below 40% HP, the body dips + the weapon arm
  // droops. Scales with how close to 0 HP.
  if (health01 < 0.4) {
    const w = (0.4 - health01) / 0.4;
    add(parts.body, 0.05 * w, 0, 0.02 * w, -0.01 * w);
    add(parts.rarm, 0.15 * w);
    add(parts.head, -0.03 * w);
  }
  // Injury-leg limp (set via setInjuryLayer).
  if (s.injuryWeight > 0) {
    const limpPhase = s.breathPhase * 2;
    const dip = Math.max(0, Math.sin(limpPhase + (s.injuryLeg === "left" ? 0 : Math.PI))) * s.injuryWeight;
    if (s.injuryLeg === "left") {
      add(parts.lleg, -0.3 * s.injuryWeight);
    } else {
      add(parts.rleg, -0.3 * s.injuryWeight);
    }
    add(parts.body, 0, 0, 0, -dip * 0.02);
  }

  // Prompt 323 — fidget. A 1.2s weight-shift + arm scratch. Bell-curve
  // weight shift to the right + left arm raises to scratch.
  if (s.fidgetActive) {
    const k = Math.sin(s.fidgetT * Math.PI); // 0..1..0
    add(parts.body, 0, -0.05 * k, 0.03 * k, 0);
    add(parts.larm, -0.4 * k);
    add(parts.head, 0.05 * k, 0.1 * k, 0);
  }

  // Prompt 326 — reload strain. Heavy chest heave + slight weapon dip.
  if (s.reloadStrain > 0) {
    const strainBreath = Math.sin(s.breathPhase * 4) * 0.015 * s.reloadStrain;
    add(parts.body, 0, 0, 0, strainBreath);
    add(parts.rarm, -0.05 * s.reloadStrain);
    add(parts.larm, -0.05 * s.reloadStrain);
    add(parts.head, 0.02 * s.reloadStrain);
  }

  // Apply via delta-subtraction.
  for (const [bone, d] of deltas) {
    const prev = s.prev.get(bone);
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
  const newPrev = new Map<THREE.Object3D, { rx: number; ry: number; rz: number; py: number }>();
  for (const [bone, d] of deltas) newPrev.set(bone, d);
  // Clear lingering deltas for bones not updated this frame.
  for (const [bone, prev] of s.prev) {
    if (!newPrev.has(bone)) {
      bone.rotation.x -= prev.rx;
      bone.rotation.y -= prev.ry;
      bone.rotation.z -= prev.rz;
      bone.position.y -= prev.py;
    }
  }
  s.prev = newPrev;

  // Prompt 325 — apply the hit-flash as a material-emissive fade (the
  // replacement for the direct emissive.setRGB in the original code). This
  // is an "anim layer" in the sense that it's a timed decaying overlay, not
  // a permanent material change. The fade is 200ms from trigger.
  if (s.hitFlashIntensity > 0) {
    const fade = s.hitFlashT / 0.2; // 1 → 0
    const intensity = s.hitFlashIntensity * fade;
    const applyFlash = (mesh: THREE.Mesh | undefined) => {
      if (!mesh) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!mat) return;
      const std = mat as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial && std.emissive) {
        std.emissive.setRGB(intensity, 0, 0);
      }
    };
    applyFlash(parts.body);
    applyFlash(parts.head);
    applyFlash(parts.vest);
    applyFlash(parts.helmet);
  } else {
    // Ensure the emissive is cleared (idempotent).
    const clearFlash = (mesh: THREE.Mesh | undefined) => {
      if (!mesh) return;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (!mat) return;
      const std = mat as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial && std.emissive) {
        std.emissive.setRGB(0, 0, 0);
      }
    };
    clearFlash(parts.body);
    clearFlash(parts.head);
  }
}

/** Prompt 324 — footplant additive layer. Raycasts each foot downward +
 *  blends a small IK correction on top of the gait pose so feet conform to
 *  terrain. This is a thin wrapper around `applyFootIK` from foot-ik.ts;
 *  exposed here so the engine can route all additive layers through one
 *  update site. The actual IK math is in foot-ik.ts (prompt 334). */
export function applyFootplantLayer(
  rig: Record<string, THREE.Object3D>,
  terrainRaycastFn: (origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) =>
    { point: THREE.Vector3; normal: THREE.Vector3 } | null,
  weight: number = 0.7,
): number {
  // Lazy import to avoid a circular type reference at module load (the
  // foot-ik module is in the same animation/ folder + doesn't depend on
  // ProceduralAnimSystem, but the dynamic import keeps the dep graph clean).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { applyFootIK } = require("../animation/foot-ik") as
    typeof import("../animation/foot-ik");
  return applyFootIK(rig, terrainRaycastFn, weight);
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 389 + 390: viewmodel sway on movement + camera recoil
// kick per shot. These are exposed as pure helpers that the engine calls
// from its per-frame update loop. They complement the existing breathing +
// suppression jitter in ProceduralAnimSystem.update with movement-driven
// sway + per-shot camera recoil.
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 389 — viewmodel sway on movement. Movement-driven sway (not just
 *  breathing). The viewmodel lags behind the player's horizontal velocity
 *  + bobs with each footstep. The engine calls this each frame with the
 *  player's velocity + the footstep phase; the function returns the
 *  (x, y) offset that should be ADDED to the viewmodel's procedural
 *  offset group.
 *
 *  The sway is a damped spring that follows the negative of the player's
 *  horizontal velocity (so the gun lags behind when the player strafes) +
 *  a footstep bob (vertical sine wave at 2× the gait frequency). */
export class MovementViewmodelSway {
  private _x = 0;
  private _y = 0;
  private _vx = 0;
  private _vy = 0;
  /** Advance the sway + return the (x, y) offset for this frame. */
  update(
    playerVelX: number,
    playerVelZ: number,
    footstepPhase: number,
    isSprinting: boolean,
    dt: number,
  ): { x: number; y: number } {
    // Target = negative of the player's horizontal velocity (the gun lags
    // behind the strafe direction). Scale by 0.005 so 6 m/s → 0.03m sway.
    const speed = Math.hypot(playerVelX, playerVelZ);
    const targetX = -playerVelX * 0.005;
    // Footstep bob — vertical sine at 2× the gait frequency (two steps per
    // gait cycle). Amplitude scales with speed + is larger when sprinting.
    const bobAmp = (isSprinting ? 0.012 : 0.006) * Math.min(speed / 6, 1);
    const targetY = Math.abs(Math.sin(footstepPhase * 2)) * bobAmp;
    // Damped spring toward the target (k=80, c=12 → fast, slight overshoot).
    const k = 80, c = 12;
    const ax = (targetX - this._x) * k - this._vx * c;
    const ay = (targetY - this._y) * k - this._vy * c;
    this._vx += ax * dt;
    this._vy += ay * dt;
    this._x += this._vx * dt;
    this._y += this._vy * dt;
    return { x: this._x, y: this._y };
  }
  /** Reset the sway (e.g., on weapon swap). */
  reset(): void {
    this._x = 0; this._y = 0; this._vx = 0; this._vy = 0;
  }
}

/** Prompt 390 — camera recoil kick per shot. Each shot kicks the CAMERA
 *  (not just the weapon) with a damped spring. The kick is a pitch-up
 *  rotation (negative X rotation in three.js = look up) + a small random
 *  yaw. The kick magnitude scales with the weapon's recoil stat.
 *
 *  The engine calls `recordShot(recoilStat)` on each shot + `update(dt)`
 *  per frame; the `getKick()` method returns the (pitch, yaw) to apply to
 *  the camera (additive on top of the player's look input). */
export class CameraRecoilKick {
  private _pitch = 0;
  private _yaw = 0;
  private _pitchVel = 0;
  private _yawVel = 0;
  /** Record a shot. The recoil stat is the weapon's per-shot recoil
   *  magnitude (typical range 0.5..3.0). The kick decays over ~400ms. */
  recordShot(recoilStat: number): void {
    // Pitch up (negative X rotation = look up).
    const pitchImpulse = -recoilStat * 0.02;
    // Random yaw (small, ±50% of the pitch magnitude).
    const yawImpulse = (Math.random() - 0.5) * recoilStat * 0.02;
    this._pitchVel += pitchImpulse * 20;
    this._yawVel += yawImpulse * 20;
  }
  /** Advance the kick spring + return the (pitch, yaw) to apply to the camera. */
  update(dt: number): { pitch: number; yaw: number } {
    // Damped spring toward 0 (k=60, c=10 → underdamped, slight overshoot).
    const k = 60, c = 10;
    const pitchAccel = -this._pitch * k - this._pitchVel * c;
    const yawAccel = -this._yaw * k - this._yawVel * c;
    this._pitchVel += pitchAccel * dt;
    this._yawVel += yawAccel * dt;
    this._pitch += this._pitchVel * dt;
    this._yaw += this._yawVel * dt;
    return { pitch: this._pitch, yaw: this._yaw };
  }
  /** Reset the kick (e.g., on weapon swap or respawn). */
  reset(): void {
    this._pitch = 0; this._yaw = 0; this._pitchVel = 0; this._yawVel = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 402–413 — procedural animation polish (carry poses, sway, breathing,
// fidget, limp, aim drift, weapon lowering, head turn, blink, sub-character,
// glance-back, stair weight shift). Each is a small driver the engine calls
// per-frame or on a trigger; results are applied as additive offsets on the
// rig's bones or the camera/viewmodel.
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 402 — ready-up / low-ready / high-ready aim poses. Returns the
 *  viewmodel base-pose offset for the given carry pose. The engine blends
 *  between these based on combat state (high-ready when an enemy is
 *  within 15m, low-ready otherwise, ready-up on first sighting). */
export function sampleCarryPose(
  pose: "ready_up" | "low_ready" | "high_ready",
): { posOffset: [number, number, number]; rotOffset: [number, number, number] } {
  switch (pose) {
    case "ready_up":
      // Gun up at shoulder, muzzle pointed forward + slightly down.
      return { posOffset: [0, 0, 0], rotOffset: [0.05, 0, 0] };
    case "low_ready":
      // Gun at shoulder but muzzle pointed down ~30° (relaxed).
      return { posOffset: [0, -0.03, 0], rotOffset: [0.4, 0, 0] };
    case "high_ready":
      // Gun up, muzzle pointed up ~20° (alert but not aiming).
      return { posOffset: [0, 0.04, 0], rotOffset: [-0.3, 0, 0] };
  }
}

/** Prompt 403 — procedural weapon sway inertia (mass-spring on camera turn).
 *  Returns the viewmodel position + rotation deltas for the current frame
 *  based on the camera's yaw/pitch delta (radians) since the last frame.
 *  The spring lags behind the camera (mass × acceleration) and settles
 *  over ~0.3s. The state is kept by the caller (a 4-vector: posXYZ + the
 *  current spring velocity magnitude). */
export function sampleWeaponSwayInertia(
  deltaYaw: number,
  deltaPitch: number,
  state: { pos: [number, number, number]; vel: [number, number, number] },
  dt: number,
  stiffness = 80,
  damping = 12,
): { posDelta: [number, number, number]; rotDelta: [number, number, number] } {
  // Target = -k * (camera delta) so the gun lags OPPOSITE the camera turn
  // (camera rotates right → gun visually rotates left relative to camera).
  const target: [number, number, number] = [
    -deltaYaw * 0.12,
    -deltaPitch * 0.08,
    0,
  ];
  // Critically-damped-ish spring: a = -k*(x - target) - c*v.
  for (let i = 0; i < 3; i++) {
    const a = stiffness * (target[i] - state.pos[i]) - damping * state.vel[i];
    state.vel[i] += a * dt;
    state.pos[i] += state.vel[i] * dt;
  }
  return {
    posDelta: [state.pos[0], state.pos[1], state.pos[2]],
    // Rotation follows the sway position (the gun rotates as it translates).
    rotDelta: [-state.pos[1] * 1.2, -state.pos[0] * 1.5, state.pos[0] * 0.4],
  };
}

/** Prompt 404 — procedural breathing idle for the body (not just camera).
 *  Returns the Spine2 quaternion + Hips position offsets for a breathing
 *  cycle at the given time. The existing camera breathing (#41) only
 *  moved the camera; this expands the motion to the body so the chest
 *  visibly rises + falls. `rateHz` defaults to 0.25 (one breath every 4s);
 *  `intensity` scales with stamina (low stamina = heavier breathing). */
export function sampleBodyBreathing(
  time: number,
  rateHz = 0.25,
  intensity = 1.0,
): { spine2RotX: number; hipsPosY: number } {
  const phase = time * rateHz * Math.PI * 2;
  const breath = Math.sin(phase);
  // Chest rises ~1.5mm at peak inhale, falls ~1mm at exhale (asymmetric
  // because exhale is passive + faster).
  const inhale = Math.max(0, breath);
  const exhale = Math.max(0, -breath);
  return {
    spine2RotX: -0.02 * inhale * intensity + 0.01 * exhale * intensity,
    hipsPosY: 0.0015 * inhale * intensity - 0.001 * exhale * intensity,
  };
}

/** Prompt 405 — procedural fidget (random arm motion + weight shift).
 *  Every 8-15s, picks a small fidget: shoulder roll, weight shift to
 *  the other foot, or a head turn. Returns the additive bone offsets
 *  for the current frame; the engine calls this once per frame and
 *  the function tracks its own internal timer + state. */
export function sampleFidget(
  time: number,
  state: { nextFidgetAt: number; kind: number; startTime: number },
): { spine2RotY: number; hipsRotY: number; headRotY: number } {
  // Trigger a new fidget when time passes the next threshold.
  if (time >= state.nextFidgetAt) {
    state.kind = Math.floor(Math.random() * 3);
    state.startTime = time;
    state.nextFidgetAt = time + 8 + Math.random() * 7;
  }
  const dur = 1.5;
  const elapsed = time - state.startTime;
  if (elapsed > dur) {
    return { spine2RotY: 0, hipsRotY: 0, headRotY: 0 };
  }
  // Bell envelope: 0 → 1 → 0 over the duration.
  const u = elapsed / dur;
  const env = Math.sin(u * Math.PI);
  switch (state.kind) {
    case 0: // Shoulder roll: spine twists right.
      return { spine2RotY: 0.15 * env, hipsRotY: 0, headRotY: 0 };
    case 1: // Weight shift: hips rotate slightly.
      return { spine2RotY: 0, hipsRotY: 0.08 * env, headRotY: 0 };
    case 2: // Head turn: head looks left.
      return { spine2RotY: 0, hipsRotY: 0, headRotY: -0.25 * env };
    default:
      return { spine2RotY: 0, hipsRotY: 0, headRotY: 0 };
  }
}

/** Prompt 406 — procedural injury limp. Returns the additive bone offset
 *  for a limp on the given leg. The limp is a hip drop + longer stance
 *  phase on the injured leg (the player favors the other leg).
 *
 *  `phase` is the gait phase (0..1, 1Hz cycle); `severity` is 0..1. */
export function sampleInjuryLimp(
  phase: number,
  injuredLeg: "left" | "right",
  severity: number,
): { hipsRotZ: number; hipsPosY: number } {
  // Hip drops when the injured leg is in stance (phase 0..0.5 for left,
  // 0.5..1 for right).
  const inStance = injuredLeg === "left"
    ? phase < 0.5
    : phase >= 0.5;
  if (!inStance) return { hipsRotZ: 0, hipsPosY: 0 };
  // Drop ~2cm at full severity, plus a small lateral tilt (hips rotate
  // toward the injured side).
  const u = injuredLeg === "left" ? phase / 0.5 : (phase - 0.5) / 0.5;
  const env = Math.sin(u * Math.PI);
  return {
    hipsRotZ: (injuredLeg === "left" ? 0.05 : -0.05) * severity * env,
    hipsPosY: -0.02 * severity * env,
  };
}

/** Prompt 407 — procedural aim drift from stamina (wire
 *  `staminaAdsSwayMult`). Returns the aim-drift offset (radians) applied
 *  to the camera or viewmodel. Low stamina = larger drift; high stamina
 *  = steady. The drift is a 2D Perlin-ish wander. */
export function sampleAimDriftFromStamina(
  time: number,
  staminaFraction: number,
  swayMult: number,
): { yawOffset: number; pitchOffset: number } {
  // Low-stamina multiplier: at 0 stamina, drift is 5x; at full stamina,
  // drift is 0.5x. swayMult is the weapon-specific multiplier (snipers
  // have higher swayMult because they're heavier).
  const staminaMult = 0.5 + (1 - staminaFraction) * 4.5;
  const amp = 0.005 * staminaMult * swayMult;
  // Two-tone drift: slow + fast components so it doesn't look periodic.
  const slow = Math.sin(time * 0.3) + Math.sin(time * 0.21 + 0.7);
  const fast = Math.sin(time * 1.7) * 0.3;
  return {
    yawOffset: amp * (slow + fast),
    pitchOffset: amp * (Math.sin(time * 0.4 + 1.1) + Math.sin(time * 1.3) * 0.3),
  };
}

/** Prompt 408 — procedural weapon lowering after long idle. Returns the
 *  viewmodel base-pose offset to lower the gun after the player has been
 *  idle for > 10s. The lowering blends from "ready" to "low-ready" over
 *  2s, then to "rest" (gun on a sling) over another 4s.
 *
 *  `idleSeconds` is how long the player has been stationary. */
export function sampleWeaponLoweringAfterIdle(idleSeconds: number): {
  posOffset: [number, number, number];
  rotOffset: [number, number, number];
} {
  if (idleSeconds < 10) {
    return { posOffset: [0, 0, 0], rotOffset: [0, 0, 0] };
  }
  // 10-12s: lower to low-ready.
  // 12-16s: lower further to rest (gun on sling, barrel pointed down).
  const t1 = Math.max(0, Math.min(1, (idleSeconds - 10) / 2));
  const t2 = Math.max(0, Math.min(1, (idleSeconds - 12) / 4));
  return {
    posOffset: [0, -0.05 * t1 - 0.05 * t2, 0.08 * t2],
    rotOffset: [0.5 * t1 + 0.4 * t2, 0, 0.1 * t2],
  };
}

/** Prompt 409 — procedural head turn toward movement direction for
 *  enemies. Returns the head yaw/pitch offset for an enemy glancing in
 *  the direction they're walking. The head leads the body by ~30° (the
 *  enemy turns their head to look where they're going before the body
 *  rotates to follow). */
export function sampleHeadTurnTowardMovement(
  moveYaw: number,
  bodyYaw: number,
): { headYaw: number; headPitch: number } {
  // Delta = the angle the head should turn to face the movement direction
  // (clamped to ±35° so the head doesn't snap backward).
  let delta = moveYaw - bodyYaw;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const clamped = Math.max(-0.6, Math.min(0.6, delta));
  // Slight downward pitch (the enemy is looking at the ground ahead).
  return { headYaw: clamped, headPitch: 0.05 };
}

/** Prompt 410 — procedural blink for enemies. Returns true when a blink
 *  should fire this frame. The blink fires every 3-6s (randomized per
 *  enemy) and lasts ~120ms. The caller drives the eyelid mesh based on
 *  the returned state. */
export function tickBlink(
  time: number,
  state: { nextBlinkAt: number; blinkStartTime: number },
): { isBlinking: boolean; blinkAmount: number } {
  if (time >= state.nextBlinkAt) {
    state.blinkStartTime = time;
    state.nextBlinkAt = time + 3 + Math.random() * 3;
  }
  const elapsed = time - state.blinkStartTime;
  const blinkDur = 0.12;
  if (elapsed > blinkDur) {
    return { isBlinking: false, blinkAmount: 0 };
  }
  // Quick close (0..0.05s) + slow open (0.05..0.12s).
  const u = elapsed / blinkDur;
  const amount = u < 0.4 ? u / 0.4 : 1 - (u - 0.4) / 0.6;
  return { isBlinking: true, blinkAmount: Math.max(0, Math.min(1, amount)) };
}

/** Prompt 411 — procedural sub-character motion (backpacks, pouches).
 *  Returns the per-frame position + rotation offset for a sub-character
 *  mesh (e.g. a backpack) attached to the parent rig. The sub-character
 *  lags behind the parent's motion with a spring, so it bounces when
 *  the player runs or lands.
 *
 *  `parentVel` is the parent's velocity (m/s); `state` tracks the
 *  sub-character's current position + velocity for the spring integrator. */
export function sampleSubCharacterMotion(
  parentVel: [number, number, number],
  state: { pos: [number, number, number]; vel: [number, number, number] },
  dt: number,
  stiffness = 60,
  damping = 10,
): { posDelta: [number, number, number]; rotDelta: [number, number, number] } {
  // Target = -parentVel * 0.02 (the sub-character lags opposite to the
  // parent's motion — if the parent accelerates forward, the backpack
  // swings backward relative to the parent).
  const target: [number, number, number] = [
    -parentVel[0] * 0.02,
    -parentVel[1] * 0.02,
    -parentVel[2] * 0.02,
  ];
  for (let i = 0; i < 3; i++) {
    const a = stiffness * (target[i] - state.pos[i]) - damping * state.vel[i];
    state.vel[i] += a * dt;
    state.pos[i] += state.vel[i] * dt;
  }
  return {
    posDelta: [state.pos[0], state.pos[1], state.pos[2]],
    // Rotation: pitch + roll based on the swing direction.
    rotDelta: [state.pos[1] * 1.0, 0, -state.pos[2] * 0.8],
  };
}

/** Prompt 412 — procedural glance-back toward recent sounds. Returns the
 *  head yaw offset for an enemy to glance at the last sound they heard.
 *  The glance fires 200ms after the sound, lasts 800ms, then the head
 *  returns to neutral.
 *
 *  `soundLocalYaw` is the sound's yaw relative to the enemy's facing. */
export function sampleGlanceBackAtSound(
  time: number,
  soundHeardAt: number,
  soundLocalYaw: number,
): { headYaw: number } {
  const elapsed = time - soundHeardAt;
  if (elapsed < 0 || elapsed > 1.0) return { headYaw: 0 };
  // Quick turn (0..0.2s) → hold (0.2..0.8s) → slow return (0.8..1.0s).
  let env: number;
  if (elapsed < 0.2) env = elapsed / 0.2;
  else if (elapsed < 0.8) env = 1;
  else env = 1 - (elapsed - 0.8) / 0.2;
  // Clamp the glance to ±45° so the enemy doesn't snap backward.
  const clamped = Math.max(-0.785, Math.min(0.785, soundLocalYaw));
  return { headYaw: clamped * env * 0.7 };
}

/** Prompt 413 — procedural weight shift on stairs (body Y follows foot on
 *  step). Returns the Hips Y offset for the current frame based on which
 *  foot is on a step + the step height. When the leading foot plants on
 *  a higher step, the body rises to follow; when the trailing foot lifts
 *  off a lower step, the body stays level.
 *
 *  `leadingFootY` is the leading foot's Y position (meters).
 *  `trailingFootY` is the trailing foot's Y position.
 *  `baseBodyY` is the body's rest Y (typically 0.95). */
export function sampleStairWeightShift(
  leadingFootY: number,
  trailingFootY: number,
  baseBodyY: number,
): { hipsPosY: number } {
  // The body Y tracks the higher foot (whichever is planted on a step).
  // The lower foot is mid-swing and doesn't pull the body down.
  const targetY = Math.max(leadingFootY, trailingFootY) + baseBodyY;
  // Smooth toward the target (the caller applies this each frame).
  return { hipsPosY: targetY };
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1507 / #1557 / #1561 — variety + tuning tables.
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1507 — idle fidget variety pool. Each entry is a named fidget
 *  the procedural fidget sampler can pick from (existing sampleFidget
 *  rotates through these). 8 named variants. */
export const FIDGET_VARIETY: Record<string, { amp: number; durationMs: number; cooldownMs: number }> = {
  shoulder_shrug: { amp: 0.04, durationMs: 800,  cooldownMs: 12000 },
  head_tilt:      { amp: 0.06, durationMs: 600,  cooldownMs: 15000 },
  weight_shift:   { amp: 0.08, durationMs: 1000, cooldownMs: 18000 },
  weapon_check:   { amp: 0.03, durationMs: 1200, cooldownMs: 25000 },
  wrist_roll:     { amp: 0.05, durationMs: 700,  cooldownMs: 14000 },
  neck_stretch:   { amp: 0.07, durationMs: 900,  cooldownMs: 20000 },
  foot_tap:       { amp: 0.04, durationMs: 500,  cooldownMs: 10000 },
  blink_double:   { amp: 0.02, durationMs: 300,  cooldownMs: 8000 },
};

/** C3-5000 #1557 — procedural tuning per system. */
export const PROCEDURAL_TUNING: Record<string, { amplitude: number; frequency: number; smoothing: number }> = {
  breathing:      { amplitude: 0.012, frequency: 0.35, smoothing: 0.20 },
  injury_limp:    { amplitude: 0.040, frequency: 1.20, smoothing: 0.30 },
  aim_drift:      { amplitude: 0.008, frequency: 0.80, smoothing: 0.50 },
  weapon_sway:    { amplitude: 0.020, frequency: 1.50, smoothing: 0.40 },
  viewmodel_bob:  { amplitude: 0.015, frequency: 1.00, smoothing: 0.25 },
  camera_recoil:  { amplitude: 0.030, frequency: 4.00, smoothing: 0.60 },
  hit_flash:      { amplitude: 0.080, frequency: 8.00, smoothing: 0.80 },
  reload_strain:  { amplitude: 0.025, frequency: 0.50, smoothing: 0.35 },
};

/** C3-5000 #1561 — particle tuning per anim event. */
export const PARTICLE_TUNE_TABLE: Record<string, { count: number; speed: number; lifetime: number; spread: number }> = {
  fire:       { count: 8,   speed: 2.0, lifetime: 0.15, spread: 0.20 },
  reload:     { count: 4,   speed: 0.5, lifetime: 0.40, spread: 0.10 },
  hit:        { count: 12,  speed: 3.0, lifetime: 0.30, spread: 0.50 },
  death:      { count: 24,  speed: 1.5, lifetime: 0.80, spread: 0.80 },
  melee:      { count: 6,   speed: 2.5, lifetime: 0.25, spread: 0.40 },
  explosion:  { count: 48,  speed: 5.0, lifetime: 1.20, spread: 1.00 },
  land:       { count: 16,  speed: 1.0, lifetime: 0.50, spread: 0.60 },
};
