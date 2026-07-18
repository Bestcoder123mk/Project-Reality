import * as THREE from "three";
import type { GameSystem, GameContext } from "./types";
import { animateGait } from "./utils";
import { tryVaultOrMantle, tryLadder } from "./VaultSystem";
import { tryJump, canSprint } from "./StaminaSystem";
import type { GunPartsWithArms } from "./weapon-viewmodel";
// Prompt A#48 — multi-beat inspect timeline (replaces the simple sine-wave
// inspect motion with a 3-phase hand-animated feel).
import { evalInspectAnimation } from "./weapon-viewmodel";
import type { WeaponType, AttachmentSlug } from "../store";
import { SmoothNoise, easeOutCubic, easeInOutCubic, easeInQuad } from "../anim";
import type { SurfaceMaterial } from "../audio/foley";
import { ballisticsSurfaceToFoley } from "../audio/foley";
import { tryWallLean, wallLeanBuffs } from "../combat/movement-tech";
// Section F (#92) — single source-of-truth gravity + arcade multiplier for the
// player. PhysicsBackend.ts (where these are defined) uses -9.81 m/s²; the
// player applies a 2.2× multiplier so jumps still feel snappy without diverging
// from the backend's value. Fixes #92 — three gravity values (-22 / -9.81 /
// -9.8) caused inconsistent player/ragdoll/backend behavior.
import { GRAVITY as BACKEND_GRAVITY, PHYSICS_GRAVITY_ARCADE_MULT } from "../physics/PhysicsBackend";
const PLAYER_GRAVITY = BACKEND_GRAVITY * PHYSICS_GRAVITY_ARCADE_MULT; // ≈ -21.6 m/s²

// ─── ADS sight-height table (Task 36) ───
// Per-weapon + per-sight height of the sight line above the gun's centerline
// (in meters). Used by the viewmodel ADS section to position the gun so the
// sight/optic/scope sits exactly at the screen-center crosshair (y=0 in
// camera space) when fully aimed.
//
// Iron-sight heights are measured from each weapon's buildXxx() in
// WeaponBuilder.ts (front + rear sight Y on the receiver). Optic heights
// account for the rail Y + optic mount height.
const IRON_SIGHT_HEIGHT: Record<WeaponType, number> = {
  ak74:  0.058,  // front sight post on gas block + rear sight on dust cover
  m4:    0.055,  // flip-up iron sights on top rail
  mp7:   0.050,  // integrated iron sights on top rail
  p90:   0.060,  // integrated front post + rear aperture
  usp:   0.030,  // slide-height front + rear sights
  deagle:0.035,  // slide-height front + rear sights (taller slide)
  awp:   0.100,  // built-in telescopic scope optical axis (scope at y=0.10)
  scout: 0.095,  // built-in medium scope optical axis (scope at y=0.095)
  nova:  0.050,  // front bead + ghost ring rear sight
  m249:  0.078,  // top-cover rail + rear aperture

  // ── Task-5 — new weapons (mirror closest sibling per category) ──
  // RIFLE / battle rifle / marksman
  hk416:  0.055,  // flat-top rail like the M4
  famas:  0.060,  // bullpup carry-handle sight
  aug:    0.070,  // built-in 1.5x optic on carry handle
  scarh:  0.058,  // flat-top Picatinny like the M4, slightly taller front sight
  galil:  0.060,  // AK-style front trunnion + rear tangent sight
  mk17:   0.060,  // SCAR-H variant — same rail height as SCAR-L
  mk14:   0.065,  // extended top rail + medium iron sight
  // SMG
  mp5:    0.045,  // compact drum rear + hooded front
  ump45:  0.050,  // polymer rear aperture + hooded front
  vector: 0.050,  // top-rail flip-up sights
  pp90m1: 0.050,  // integrated compact iron sights
  // PISTOL
  glock18:0.030,  // slide-height polymer sights (USP-style)
  m1911:  0.035,  // taller 1911 front blade + rear notch
  revolver:0.040, // tall revolver front blade + rear groove
  // SNIPER
  kar98k: 0.090,  // Mauser tangent rear + hooded front
  l115a3: 0.105,  // Schmidt & Bender scope — same axis as AWP, slightly higher
  // SHOTGUN
  m1014:  0.050,  // ghost ring rear + fiber-optic front (M4-style)
  spas12: 0.055,  // folding ghost ring + blade front
  // LMG
  rpk:    0.075,  // AK-style tangent rear + front sight post (RPK is taller)
  mk48:   0.080,  // top-cover rail like the M249
};

/** Top-rail Y (meters above the gun centerline) for each weapon — where
 *  attached optics mount. Used to compute the optic's optical-axis height. */
const RAIL_HEIGHT: Record<WeaponType, number> = {
  ak74:  0.072,  // top rail above the dust cover
  m4:    0.052,  // flat-top Picatinny rail
  mp7:   0.045,  // compact top rail
  p90:   0.055,  // bullpup top rail
  usp:   0.040,  // slide-top accessory rail
  deagle:0.045,  // slide-top rail
  awp:   0.080,  // scope rail (unused — AWP has built-in scope)
  scout: 0.075,  // scope rail (unused — Scout has built-in scope)
  nova:  0.055,  // receiver top
  m249:  0.073,  // top-cover rail

  // ── Task-5 — new weapons (mirror closest sibling per category) ──
  hk416:  0.052,  // flat-top rail like the M4
  famas:  0.065,  // carry-handle rail
  aug:    0.070,  // built-in optic rail (unused — AUG has built-in scope)
  scarh:  0.055,  // flat-top Picatinny
  galil:  0.065,  // dust-cover rail (AK-style)
  mk17:   0.055,  // flat-top Picatinny
  mk14:   0.060,  // extended top rail
  mp5:    0.043,  // compact claw-mount rail
  ump45:  0.048,  // polymer top rail
  vector: 0.050,  // top Picatinny
  pp90m1: 0.045,  // compact top rail
  glock18:0.038,  // slide accessory rail
  m1911:  0.045,  // frame accessory rail (aftermarket)
  revolver:0.050, // top-strap rail
  kar98k: 0.070,  // receiver rail (unused — Kar98 has tangent sight)
  l115a3: 0.085,  // scope rail (unused — L115 has built-in scope)
  m1014:  0.055,  // receiver top
  spas12: 0.058,  // receiver top
  rpk:    0.070,  // dust-cover rail (AK-style)
  mk48:   0.075,  // top-cover rail
};

/** Returns the ADS sight height (meters above the gun centerline) for the
 *  given weapon + sight attachment. Attached optics (scope8x, acog, holo,
 *  red_dot) override the iron sights; snipers always use their built-in scope. */
function getAdsSightHeight(weapon: WeaponType, sight: AttachmentSlug): number {
  // Snipers always use their built-in scope (attached optics aren't mounted).
  if (weapon === "awp") return 0.100;
  if (weapon === "scout") return 0.095;
  // Attached optics sit on the weapon's top rail at a known mount height.
  const railY = RAIL_HEIGHT[weapon] ?? 0.060;
  if (sight === "scope8x") return railY + 0.050;  // scope mount + scope center
  if (sight === "acog")    return railY + 0.020;  // ACOG base + body center
  if (sight === "holo")    return railY + 0.020;  // holo base + window center
  if (sight === "red_dot") return railY + 0.020;  // red-dot base + window center
  // Iron sights.
  return IRON_SIGHT_HEIGHT[weapon] ?? 0.055;
}

/**
 * PhysicsSystem — owns player movement, collision resolution, gravity,
 * camera placement (1st/3rd person), viewmodel animation (position/recoil),
 * and the avatar gait. Reads input from context.keys and weapon/medical
 * state. Mutates context.player and context.weapon.
 *
 * P4.3: vault/mantle is checked first; if active, normal movement is skipped
 * for the duration of the vault/mantle animation.
 */
export class PhysicsSystem implements GameSystem {
  /** Camera juice: strafe roll (smoothed). */
  private _camRoll = 0;
  /** Camera juice: screen shake intensity (decays to 0). */
  private _shakeIntensity = 0;
  /** Camera juice: screen shake offset (recomputed each frame from intensity). */
  private _shakeOffset = new THREE.Vector3();
  /** Mouse-look sway: last frame's yaw/pitch for delta computation. */
  private _lastYaw = 0;
  private _lastPitch = 0;
  /** Mouse-look sway: spring-damped offsets. */
  private _swayX = 0;
  private _swayY = 0;
  /** Viewmodel juice: previous onGround state for landing-dip detection. */
  private _prevOnGround = true;
  /** Viewmodel juice: landing dip magnitude (decays to 0 after a sharp land). */
  private _landDip = 0;
  /** Viewmodel juice: idle breathing phase (slow ~0.5Hz sin oscillation). */
  private _breathingPhase = 0;
  /** Viewmodel juice: smoothed sprint blend (0..1) for arm pose transitions. */
  private _sprintBlend = 0;

  // ── Task-8: camera juice (landing impact, footstep dip, slide, idle breath). ──
  // ── Task-34: fluid camera — landing + footstep converted from sharp dip+decay
  //    to underdamped springs (overshoot + settle). Head bob amplitude damped
  //    for graceful fade-in/out. ADS sway added. Crouch + sprint + slide
  //    transitions all damped. ──
  /** Camera juice: previous onGround state for camera landing detection. */
  private _camPrevOnGround = true;
  /** Camera juice: stashed vertical velocity just before landing (for impact). */
  private _lastFallVel = 0;
  /** Camera juice: landing dip position (spring-integrated; underdamped → slight overshoot). */
  private _camLandDip = 0;
  /** Camera juice: landing dip velocity (for spring integration). */
  private _camLandDipVel = 0;
  /** Camera juice: forced-crouch stagger timer (very-hard landings, counts down). */
  private _camLandStagger = 0;
  /** Camera juice: per-footstep vertical dip (spring-integrated; quick dip + smooth recover). */
  private _footstepDip = 0;
  /** Camera juice: per-footstep dip velocity (for spring integration). */
  private _footstepDipVel = 0;
  /** Camera juice: per-footstep roll (alternating left/right per foot). */
  private _footstepRoll = 0;
  /** Camera juice: footstep alternator (+1 / -1) for left/right roll. */
  private _footstepSign = 1;
  /** Camera juice: idle breathing phase (0.3Hz, fades in when standing still). */
  private _camBreathPhase = 0;
  /** Task-34: smoothed head-bob amplitude (fades in/out when starting/stopping). */
  private _bobAmpS = 0;
  /** Task-34: smoothed ADS sway phase (continuous; amplitude scales with aimBlend). */
  private _adsSwayPhase = 0;
  /** Task-34: smoothed crouch blend (0..1) — drives a subtle spring-dipped camera lower. */
  private _crouchBlend = 0;
  /** Task-34: crouch dip position (spring-integrated; absorbs the snap when crouching). */
  private _crouchDip = 0;
  /** Task-34: crouch dip velocity (for spring integration). */
  private _crouchDipVel = 0;
  /** Task-34: previous crouch state — detects transitions to apply dip impulse. */
  private _prevCrouching = false;
  /** Camera juice: smoothed slide camera lower (0 = standing, -0.15 = sliding). */
  private _slideCamLower = 0;

  // ── SEC8 prompt 66 — Material-aware footsteps ──
  /** Reusable raycaster for the downward footstep-surface probe. Allocated
   *  once + reused (no per-footstep allocation).
   *  PERF FIX: raycaster.camera is set in init() so Three.js doesn't warn
   *  about sprites during intersectObjects (the scene contains particle
   *  sprites). We also cache a filtered list of "surface" meshes (those
   *  carrying userData.materialSlug) so the raycast doesn't traverse the
   *  entire scene graph (weapon=220 meshes, avatar, enemies, particles)
   *  on every footstep. */
  private _footRay = new THREE.Raycaster(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, -1, 0),
    0,
    3.0,
  );
  /** Reusable down-vector (avoid allocating per footstep). */
  private _footDown = new THREE.Vector3(0, -1, 0);
  /** Cached list of meshes that carry a materialSlug (ground + floor props).
   *  Populated lazily on first footstep + invalidated when the map changes
   *  (detected via a scene-children-count hash). Raycasting this flat list
   *  is ~50× cheaper than intersectObjects(scene.children, true). */
  private _surfaceMeshes: THREE.Object3D[] = [];
  private _surfaceMeshSceneSig = 0;

  // ── ANIM-POLISH — SmoothNoise instances replace Math.random() white noise
  //    in the screen-shake offset. Three independent per-axis noise sources
  //    (different frequencies so they don't lockstep) produce a smooth,
  //    temporally-coherent shake that no longer flickers violently at 60fps.
  //    The amplitude is still scaled by `_shakeIntensity` (which itself
  //    decays exponentially) so the shake still fades out gracefully. ──
  private _shakeNoiseX = new SmoothNoise(28, 1);
  private _shakeNoiseY = new SmoothNoise(31, 1);
  private _shakeNoiseZ = new SmoothNoise(25, 1);

  constructor(private ctx: GameContext) {}

  /** Trigger a screen shake. External systems call this on explosions/damage. */
  triggerShake(intensity: number) {
    this._shakeIntensity = Math.min(1.0, Math.max(this._shakeIntensity, intensity));
  }

  update(dt: number) {
    if (this.ctx.match.matchOver) return;
    // P4.3 / Task-8: vault/mantle takes priority over normal movement, but
    // camera + viewmodel still update during vault so the camera tracks
    // player.pos and vault camera flourishes are applied.
    const vaulting = tryVaultOrMantle(this.ctx, this.ctx.vault, dt);
    this.updatePlayer(dt, vaulting);
  }

  /**
   * SEC8 prompt 66 — Play a surface-aware footstep.
   *
   * Raycasts downward from the player's chest position (1.0m above feet) up
   * to 3m, finds the closest scene mesh under the player, reads its
   * `userData.materialSlug` (set by RendererSystem.addBox / addDestructible
   * via the SURFACE_MATERIAL_MAP), and maps it to a foley SurfaceMaterial
   * via `ballisticsSurfaceToFoley()`. Then plays the footstep via
   * `audio.playFootstep(surface)` — which itself prefers a real sample
   * (`/sfx/footstep_<surface>.wav`) and falls back to procedural synth.
   *
   * Falls back to "concrete" when no surface is found (e.g. standing on the
   * bare ground plane outside any collider — the ground is implicitly
   * concrete in the default map).
   *
   * Cheap: only fires on the footstep cadence (every 0.18–0.6s depending on
   * gait) + on landings, so the per-call raycast cost is negligible.
   */
  private playFootstepForSurface(): void {
    const ctx = this.ctx;
    const audio = ctx.audio as unknown as {
      playFootstep?: (surface: SurfaceMaterial, intensity?: number) => void;
      footstep?: () => void;
    };
    if (!audio) return;
    const surface = this.detectFootSurface();
    if (typeof audio.playFootstep === "function") {
      audio.playFootstep(surface, 1);
    } else {
      audio.footstep?.();
    }
  }

  /**
   * Raycast downward from the player's chest to find the surface material
   * under their feet. Returns the foley SurfaceMaterial ("concrete" default).
   *
   * PERF FIX: raycasts against a cached flat list of surface-tagged meshes
   * (those with userData.materialSlug) instead of the entire scene graph.
   * This avoids traversing the weapon (~220 meshes), avatar, enemies, and
   * particle sprites on every footstep. The cache is rebuilt when the
   * scene's top-level child count changes (map load / wave spawn clears).
   */
  private detectFootSurface(): SurfaceMaterial {
    const ctx = this.ctx;
    const player = ctx.player;
    // Ensure the raycaster has a camera reference — Three.js requires this
    // to raycast against Sprites (particle sprites exist in the scene). Even
    // though we skip sprites in the hit loop, the intersectObjects call
    // traverses them and logs a warning if raycaster.camera is null.
    if (!this._footRay.camera) this._footRay.camera = ctx.camera;

    // Rebuild the surface-mesh cache if the scene changed (cheap sig: top-level child count).
    const sig = ctx.scene.children.length;
    if (sig !== this._surfaceMeshSceneSig || this._surfaceMeshes.length === 0) {
      this._surfaceMeshSceneSig = sig;
      this._surfaceMeshes.length = 0;
      ctx.scene.traverse((o) => {
        const ud = (o as THREE.Mesh).userData as { materialSlug?: string; surfaceType?: string };
        if (ud && (ud.materialSlug || ud.surfaceType) && o.type === "Mesh") {
          this._surfaceMeshes.push(o);
        }
      });
    }

    // Origin: 1.0m above the player's feet (chest height — well above the
    // floor so the ray has room to travel). Player.pos.y is the eye height;
    // subtract ~0.5 to get chest height.
    const origin = this._footRay.ray.origin;
    origin.set(player.pos.x, player.pos.y - 0.5, player.pos.z);
    this._footRay.set(origin, this._footDown);
    this._footRay.far = 3.0;
    // Raycast ONLY the cached surface meshes (flat list, non-recursive —
    // they're already leaf meshes so recursive=false is correct + faster).
    const intersects = this._footRay.intersectObjects(this._surfaceMeshes, false);
    for (const hit of intersects) {
      const ud = (hit.object as THREE.Mesh).userData as {
        materialSlug?: string;
        surfaceType?: string;
      };
      if (ud && (ud.materialSlug || ud.surfaceType)) {
        const slug = ud.materialSlug ?? "concrete";
        return ballisticsSurfaceToFoley(slug);
      }
    }
    return "concrete";
  }

  /** True if `obj` is part of the camera/avatar/weapon rig (skip for surface
   *  raycasts — we want world geometry, not the player's own mesh). */
  private isCameraSubtree(obj: THREE.Object3D): boolean {
    let p: THREE.Object3D | null = obj;
    while (p) {
      if (p === this.ctx.camera) return true;
      if (p === this.ctx.avatar?.group) return true;
      if (p === this.ctx.weaponGroup) return true;
      p = p.parent;
    }
    return false;
  }

  private updatePlayer(dt: number, skipMovement: boolean = false) {
    const { ctx } = this;
    const { keys, player, weapon, medical, audio, avatar, stamina } = ctx;

    // ── Movement state (computed every frame so camera + viewmodel have it
    // even when movement is skipped during vault). ──
    const crouch = keys["ControlLeft"] || keys["KeyC"];
    player.crouching =
      (!!crouch && player.onGround) || !!player.sliding || this._camLandStagger > 0;
    // P4.2: sprint requires stamina (pure function on the stamina state).
    // Task-14: sprint is disabled while on a ladder or diving.
    const wantSprint =
      keys["ShiftLeft"] && !player.crouching && keys["KeyW"] && !weapon.isAiming && !player.onLadder && !player.diving;
    const sprint = wantSprint && canSprint(stamina);

    if (!skipMovement) {
      // V3 — FIXED: use LOCAL vectors for forward/right instead of ctx.scratch.
      // The scratch vectors are shared across systems, and tryLadder()
      // (called below) overwrites scratch.v2 with player.pos — corrupting the
      // `right` vector and causing D/A to move the player toward their spawn
      // position instead of strafing. Local vectors are not GC-heavy (they're
      // stack-allocated per-call in V8) and eliminate this class of bug.
      const forward = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
      const right = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));

      // Task-14: ladder climbing takes top priority. tryLadder handles its own
      // velocity (no gravity while attached). Returns true while on the ladder.
      const ladderActive = tryLadder(ctx, dt);

      // Task-14: dolphin dive — second priority (after ladder). Handles its
      // own velocity + state transitions (air → prone → recover).
      const diveActive = !ladderActive && this.updateDive(dt, forward);

      // Hoisted so the footstep-cadence block below can read it.
      let slideActive = false;

      if (!ladderActive && !diveActive) {
        // Task-8: slide — check end conditions + apply slide velocity if active.
        slideActive = this.updateSlide(dt, forward);

        if (!slideActive) {
          let baseSpeed = sprint ? 8.2 : player.crouching ? 2.4 : weapon.isAiming ? 3.0 : 5.2;
          if (medical.casualtyState === "FRACTURED" && medical.fractureLimb === "leg") baseSpeed *= 0.5;
          if (medical.casualtyState === "UNCONSCIOUS") baseSpeed = 0;

          const wish = new THREE.Vector3(0, 0, 0);
          if (keys["KeyW"]) wish.add(forward);
          if (keys["KeyS"]) wish.sub(forward);
          if (keys["KeyD"]) wish.add(right);
          if (keys["KeyA"]) wish.sub(right);
          if (wish.lengthSq() > 0) wish.normalize();

          const accel = player.onGround ? 100 : 18; // V3 — snappier ground accel (was 60/12)
          const targetVel = wish.multiplyScalar(baseSpeed);
          player.vel.x = THREE.MathUtils.damp(player.vel.x, targetVel.x, accel * 0.1, dt);
          player.vel.z = THREE.MathUtils.damp(player.vel.z, targetVel.z, accel * 0.1, dt);
          if (player.onGround && wish.lengthSq() === 0) {
            // V3 — faster deceleration so the player stops crisply (was 12 → 20).
            player.vel.x = THREE.MathUtils.damp(player.vel.x, 0, 20, dt);
            player.vel.z = THREE.MathUtils.damp(player.vel.z, 0, 20, dt);
          }
        }

        player.vel.y += PLAYER_GRAVITY * dt; // Section F (#92) — single gravity source-of-truth.
        // P4.2: jump requires stamina. Task-8: jump cancels slide (preserves momentum).
        if (
          keys["Space"] &&
          player.onGround &&
          (!player.crouching || player.sliding) &&
          tryJump(stamina)
        ) {
          player.vel.y = 7.2;
          player.onGround = false;
          if (player.sliding) {
            player.sliding = false;
            player.slideTime = 0;
          }
        }
      }
      // Else: dive handles vel internally (including its own gravity during
      // the air phase); ladder handles vel internally (no gravity). The shared
      // position-integration block below applies in all cases.

      // Task-8: stash fall velocity for landing impact (before onGround resets it).
      // Skipped during dive/ladder (they manage their own landing transitions).
      if (!player.onGround && !diveActive && !ladderActive) this._lastFallVel = player.vel.y;

      const radius = 0.4;
      // Task-14: eye height + collision box adapt for dive (prone) + ladder.
      // Dive prone eye height = 0.4m. Ladder eye height = 1.5m.
      const eyeHeight = player.diving ? 0.4 : player.onLadder ? 1.5 : player.crouching ? 1.15 : 1.7;
      const height = player.diving ? 0.6 : player.onLadder ? 1.6 : player.crouching ? 1.3 : 1.8;

      // Section F (#90/#747) — Capsule-vs-collider resolution.
      // The old `resolveHorizontal` did axis-by-axis (X then Z) which kills
      // tangential velocity on the first hit (a player sliding along a wall
      // stops dead). The new `resolveHorizontalSwept` does a single combined
      // resolution: find the contact normal on the most-penetrating collider,
      // push the player out along that normal, and only cancel the normal
      // component of velocity — tangential (slide) is preserved. Fixes #96.
      player.pos.x += player.vel.x * dt;
      player.pos.z += player.vel.z * dt;
      this.resolveHorizontalSwept(radius, eyeHeight, height);
      player.pos.y += player.vel.y * dt;

      // Section F (#93) — Ground check via downward raycast against chunk
      // meshes (not the implicit y=0 plane). Lets the player stand on top of
      // crates, vehicles, or any surface mesh with userData.materialSlug. The
      // raycast uses the cached _surfaceMeshes list (rebuilt lazily — see
      // detectFootSurface). If no surface is hit, fall back to the implicit
      // floor at y=eyeHeight (the bare-ground plane).
      const groundY = this._probeGroundHeight(player.pos.x, player.pos.z, eyeHeight + 0.5);
      const floorY = groundY !== null ? groundY + eyeHeight : eyeHeight;
      if (player.pos.y <= floorY) {
        player.pos.y = floorY;
        player.vel.y = 0;
        player.onGround = true;
      } else player.onGround = false;

      // Prompt 6 — Jump pad detection: if the player is on the ground and
      // standing on a mesh tagged userData.isJumpPad, apply an upward impulse.
      if (player.onGround) {
        for (const c of this.ctx.colliders) {
          const box = (c as any).box as THREE.Box3;
          if (!box) continue;
          // Check if player is horizontally within the collider's XZ bounds
          // and at ground level above it.
          if (player.pos.x < box.min.x - 0.3 || player.pos.x > box.max.x + 0.3) continue;
          if (player.pos.z < box.min.z - 0.3 || player.pos.z > box.max.z + 0.3) continue;
          const mesh = (c as any).mesh as THREE.Object3D | undefined;
          if (!mesh || !(mesh as any).userData?.isJumpPad) continue;
          const force = (mesh as any).userData.jumpPadForce ?? 12;
          const now = performance.now();
          const lastPad = (mesh as any).userData._lastPadTime ?? 0;
          if (now - lastPad < 500) break; // cooldown
          (mesh as any).userData._lastPadTime = now;
          player.vel.y = force;
          player.onGround = false;
          this.playFootstepForSurface(); // reuse as a launch cue
          break;
        }
      }

      const b = 43;
      player.pos.x = Math.max(-b, Math.min(b, player.pos.x));
      player.pos.z = Math.max(-b, Math.min(b, player.pos.z));

      // Section F (#94) — Out-of-bounds kill plane. If the player falls below
      // y=-20 (e.g. clipped through the map or fell off an edge), trigger
      // respawn. The kill plane fires the engine's onPlayerOOB callback if
      // registered; otherwise it teleports the player back to spawn with a
      // small upward velocity so they don't immediately re-trigger.
      if (player.pos.y < -20) {
        const onOOB = (this.ctx as any).onPlayerOOB as (() => void) | undefined;
        if (typeof onOOB === "function") {
          onOOB();
        } else {
          // Fallback: teleport to spawn.
          player.pos.set(0, 5, 0);
          player.vel.set(0, 0, 0);
        }
        this.triggerShake(0.5);
      }

      const moveSpeed = Math.hypot(player.vel.x, player.vel.z);
      if (player.onGround && moveSpeed > 0.5) {
        const stepFreq = slideActive ? 2.0 : sprint ? 1.4 : player.crouching ? 0.8 : 1.4;
        player.bobTime += dt * moveSpeed * stepFreq;
        player.stepTimer += dt;
        const stepInterval = slideActive ? 0.18 : sprint ? 0.3 : player.crouching ? 0.6 : 0.45;
        if (player.stepTimer >= stepInterval) {
          player.stepTimer = 0;
          this.playFootstepForSurface();
          // Task-34: footstep camera dip — spring impulse (quick dip + smooth
          // recover + slight overshoot) instead of a sharp drop. The spring
          // is integrated below in the landing-impact block.
          const dipAmt = slideActive ? 0.025 : sprint ? 0.02 : player.crouching ? 0.005 : 0.01;
          // Impulse: kick the dip velocity downward (negative = camera dips down).
          this._footstepDipVel = -dipAmt * 18;
          this._footstepRoll = 0.005 * this._footstepSign;
          this._footstepSign *= -1;
        }
      } else {
        player.bobTime = THREE.MathUtils.damp(player.bobTime, 0, 8, dt);
      }

      if (avatar) {
        avatar.group.position.copy(player.pos);
        avatar.group.position.y = 0;
        avatar.group.rotation.y = player.yaw + Math.PI;
        if (moveSpeed > 0.5) {
          ctx.avatarGaitPhase += dt * moveSpeed * (sprint ? 2.4 : 1.6);
          animateGait(avatar.parts, ctx.avatarGaitPhase, moveSpeed, sprint);
        } else {
          animateGait(avatar.parts, 0, 0, false);
        }
      }
    } else {
      // Vaulting — avatar still tracks player.pos (vault animates pos directly).
      if (avatar) {
        avatar.group.position.copy(player.pos);
        avatar.group.position.y = 0;
        avatar.group.rotation.y = player.yaw + Math.PI;
        animateGait(avatar.parts, 0, 0, false);
      }
    }

    // ── Task-8/34: landing impact (camera dip + shake + stagger on hard landings). ──
    // Task-34: the dip is now an underdamped spring (overshoot + settle) instead
    // of a sharp drop + linear decay. F = -k*x - c*v with k=120, c=7 →
    // ω₀ = sqrt(120) ≈ 11.0, ζ = 7/(2*11) ≈ 0.32 (underdamped → 1-2 small
    // overshoots before settling, like real knees absorbing impact).
    const vaultActive = ctx.vault.timer > 0;
    if (!vaultActive) {
      const camJustLanded = player.onGround && !this._camPrevOnGround;
      if (camJustLanded) {
        const fv = this._lastFallVel;
        if (fv < -15) {
          // Very hard landing: force crouch (stumble) + heavy shake + dip impulse.
          this._camLandStagger = 0.3;
          // Impulse: kick the dip velocity downward (negative = camera dips down).
          this._camLandDipVel = -3.5;
          this.triggerShake(0.5);
          this.playFootstepForSurface();
        } else if (fv < -8) {
          // Hard landing: shake + dip impulse.
          this._camLandDipVel = -2.5;
          this.triggerShake(THREE.MathUtils.clamp(Math.abs(fv) / 20, 0.1, 0.5));
          this.playFootstepForSurface();
        } else if (fv < -3) {
          // Soft landing: tiny dip impulse.
          this._camLandDipVel = -0.8;
        }
      }
    }
    this._camPrevOnGround = player.onGround;
    // Integrate the landing-dip spring (underdamped → slight overshoot + settle).
    {
      const k = 120, c = 7;
      this._camLandDipVel += (-k * this._camLandDip - c * this._camLandDipVel) * dt;
      this._camLandDip += this._camLandDipVel * dt;
    }
    this._camLandStagger = Math.max(0, this._camLandStagger - dt);
    // Integrate the footstep-dip spring (faster — quick dip + smooth recover).
    // k=300, c=14 → ω₀ ≈ 17.3, ζ ≈ 0.40 (underdamped, settles in ~0.15s).
    {
      const k = 300, c = 14;
      this._footstepDipVel += (-k * this._footstepDip - c * this._footstepDipVel) * dt;
      this._footstepDip += this._footstepDipVel * dt;
    }
    this._footstepRoll = THREE.MathUtils.damp(this._footstepRoll, 0, 10, dt);

    // Task-34: crouch blend + crouch dip spring. The player's eye height snaps
    // in the movement section (clamp to eyeHeight), so we add a spring-dipped
    // camera offset that absorbs the snap: when crouch toggles, the camera dips
    // slightly BELOW the target eye height then springs back up (the head
    // follows the body down, with a tiny bounce).
    if (player.crouching !== this._prevCrouching) {
      // Impulse: crouch engaged → dip down (negative); released → lift up (positive).
      this._crouchDipVel += player.crouching ? -1.2 : 1.2;
      this._prevCrouching = player.crouching;
    }
    this._crouchBlend = THREE.MathUtils.damp(this._crouchBlend, player.crouching ? 1 : 0, 12, dt);
    {
      // Spring toward 0 (target = no dip). k=160, c=10 → ω₀ ≈ 12.6, ζ ≈ 0.40.
      const k = 160, c = 10;
      this._crouchDipVel += (-k * this._crouchDip - c * this._crouchDipVel) * dt;
      this._crouchDip += this._crouchDipVel * dt;
    }

    // ── Camera placement — with juice: head bob, strafe roll, screen shake,
    //    lean, slide, vault, landing, footstep dip. ──
    const speed = Math.hypot(player.vel.x, player.vel.z);
    const sprintActive = sprint && speed > 3 && !weapon.isAiming;
    const adsFactor = weapon.aimBlend * 0.8;
    const bobScale =
      (1 - adsFactor) *
      (player.crouching ? 0.6 : 1) *
      (sprintActive ? 1.3 : 1) *
      (player.sliding ? 0.3 : 1);
    const speedFactor = Math.min(speed / 5, 1);
    // Task-34: damped head-bob amplitude (fades in/out gracefully when
    // starting/stopping instead of snapping). λ=6 → ~0.17s transition.
    this._bobAmpS = THREE.MathUtils.damp(this._bobAmpS, speed > 0.5 ? 1 : 0, 6, dt);
    // Dual-frequency bob: vertical at 2× step freq (each step pushes body up),
    // lateral at 1× step freq (weight shifts side-to-side per step).
    let bobY = Math.sin(player.bobTime * 2) * 0.04 * speedFactor * bobScale * this._bobAmpS;
    const bobX = Math.cos(player.bobTime) * 0.025 * speedFactor * bobScale * this._bobAmpS;

    // Task-34: idle breathing — 0.3Hz, 3mm vertical + 1mrad rotational sway.
    // Fades in when standing still (idleFactor) — damped so the transition
    // from walking to breathing is smooth, not a snap.
    this._camBreathPhase += dt * Math.PI * 0.6;
    const idleFactor = 1 - Math.min(speed / 0.5, 1);
    bobY += Math.sin(this._camBreathPhase) * 0.003 * idleFactor;
    // Tiny rotational sway synced to breathing (chest expansion pitches the view).
    const breathRotZ = Math.sin(this._camBreathPhase * 0.7) * 0.001 * idleFactor;

    // Task-34: ADS sway — the gun isn't perfectly steady. Low-frequency sin
    // (breathing-rate) + tiny random noise (hand tremor). Scales with aimBlend.
    this._adsSwayPhase += dt * 1.2; // ~0.19Hz sway
    const adsSwayAmt = weapon.aimBlend * 0.0015;
    const adsSwayX = Math.sin(this._adsSwayPhase) * adsSwayAmt + (Math.random() - 0.5) * adsSwayAmt * 0.5;
    const adsSwayY = Math.cos(this._adsSwayPhase * 0.85) * adsSwayAmt * 0.8 + (Math.random() - 0.5) * adsSwayAmt * 0.5;

    // Task-8: vault/mantle camera flourishes.
    let vaultPitchTilt = 0;
    let vaultFovBoost = 0;
    let vaultMantleDip = 0;
    if (vaultActive && ctx.vault.type) {
      const vt = 1 - ctx.vault.timer / ctx.vault.duration;
      vaultFovBoost = 3;
      if (ctx.vault.type === "vault") {
        vaultPitchTilt = Math.sin(vt * Math.PI) * 0.1; // tilt forward, peak mid-vault
      } else if (ctx.vault.type === "mantle") {
        vaultMantleDip = -Math.sin(vt * Math.PI) * 0.15; // dip then rise (pull-up)
      }
    }

    // Task-8: slide camera — smooth lower dip.
    const slideTarget = player.sliding ? -0.15 : 0;
    this._slideCamLower = THREE.MathUtils.damp(this._slideCamLower, slideTarget, 10, dt);

    weapon.recoilOffset = THREE.MathUtils.damp(weapon.recoilOffset, 0, 8, dt);
    const slidePitch = player.sliding ? 0.1 : 0;
    const sprintLean = sprintActive ? 0.03 : 0;
    // Task-14: ladder — camera tilts slightly forward (+0.1 rad) while climbing.
    const ladderPitch = player.onLadder ? 0.1 : 0;
    // Task-14: dive — extra forward pitch while airborne (looks like a dive).
    const divePitch = player.diving && player.divePhase === "air" ? 0.12 : 0;
    const effPitch = player.pitch + weapon.recoilOffset + slidePitch + sprintLean + vaultPitchTilt + ladderPitch + divePitch;

    // Task-8: hold-based lean (BracketLeft/BracketRight). ADS = slower + smaller.
    let leanTarget = 0;
    if (keys["BracketLeft"]) leanTarget = -1;
    if (keys["BracketRight"]) leanTarget = 1;
    if (weapon.isAiming) leanTarget *= 0.5; // subtle ADS lean for corner peeking
    const leanDampRate = weapon.isAiming ? 6 : 10;
    player.lean = THREE.MathUtils.damp(player.lean ?? 0, leanTarget, leanDampRate, dt);

    // Strafe roll — camera tilts slightly when moving sideways + lean roll.
    // V3 — FIXED inverted strafe roll: the strafe component is vel·right, and
    // right.z = -sin(yaw), so the correct dot product is vel.x*cos(yaw) - vel.z*sin(yaw).
    // The previous code had +vel.z*sin(yaw) which inverted the roll direction
    // (camera tilted left when strafing right — disorienting).
    const strafeVel = player.vel.x * Math.cos(player.yaw) - player.vel.z * Math.sin(player.yaw);
    const targetRoll =
      THREE.MathUtils.clamp(strafeVel * 0.008, -0.04, 0.04) + (player.lean ?? 0) * 0.15;
    if (!this._camRoll) this._camRoll = 0;
    this._camRoll = THREE.MathUtils.damp(this._camRoll, targetRoll, 8, dt);

    // Lean lateral offset — capped at 0.5m (0.25m in ADS to avoid wall clip).
    // Prompt A#111 — wall-lean: when the player is leaning AND a wall is
    // detected on the lean side, reduce the lateral offset (camera presses
    // against the wall instead of poking through it) + apply a sway-reduction
    // buff (the wall braces the weapon). tryWallLean uses the scoped env
    // raycast cache (Prompt A#110), so this is cheap.
    let leanOffset = (player.lean ?? 0) * (weapon.isAiming ? 0.25 : 0.5);
    if (Math.abs(player.lean ?? 0) > 0.1) {
      const leaning = tryWallLean(
        ctx,
        player.pos,
        player.yaw,
        player.lean > 0 ? 1 : -1,
        ctx.raycaster,
      );
      const buffs = wallLeanBuffs(leaning);
      leanOffset *= buffs.offsetMult;
      // Sway buff — exposed via ctx for WeaponSystem to read. We stash it on
      // player.leanWallBuff so the weapon sway code can multiply its sway
      // amplitude without coupling PhysicsSystem to the weapon sway math.
      (player as unknown as { leanWallBuff?: number }).leanWallBuff = buffs.swayMult;
    } else {
      (player as unknown as { leanWallBuff?: number }).leanWallBuff = 1.0;
    }

    // Screen shake — decay-based. External systems call triggerShake(intensity).
    if (!this._shakeIntensity) this._shakeIntensity = 0;
    if (!this._shakeOffset) this._shakeOffset = new THREE.Vector3();
    this._shakeIntensity = THREE.MathUtils.damp(this._shakeIntensity, 0, 12, dt);
    const shakeAmt = this._shakeIntensity;
    // ANIM-POLISH — SmoothNoise (2-octave value noise) replaces Math.random()
    // white noise. The previous code flickered violently at 60fps because
    // each axis was an independent uniform sample; the new noise is
    // temporally coherent (smooth interpolation between lattice points),
    // so the shake reads as a coherent camera wobble rather than TV static.
    this._shakeOffset.set(
      this._shakeNoiseX.sample(dt) * shakeAmt,
      this._shakeNoiseY.sample(dt) * shakeAmt,
      this._shakeNoiseZ.sample(dt) * shakeAmt * 0.5,
    );

    const { camera } = ctx;
    if (player.viewMode === "third") {
      const dist = player.thirdPersonDist;
      const back = ctx.scratch.v4
        .set(Math.sin(player.yaw), 0, Math.cos(player.yaw))
        .multiplyScalar(dist);
      const rightOff = ctx.scratch.v5
        .set(Math.cos(player.yaw), 0, -Math.sin(player.yaw))
        .multiplyScalar(0.6);
      camera.position.copy(player.pos).add(back).add(rightOff);
      camera.position.y += 0.5;
      camera.position.add(this._shakeOffset);
      camera.position.y += bobY * 0.3;
      camera.position.y -= this._camLandDip * 0.5;
      camera.position.y -= this._footstepDip * 0.5;
      camera.position.y += vaultMantleDip * 0.5;
      camera.position.y += this._slideCamLower * 0.5;
      camera.position.y -= this._crouchDip * 0.3;
      camera.rotation.order = "YXZ";
      camera.rotation.y = player.yaw;
      camera.rotation.x = effPitch;
      camera.rotation.z = this._camRoll * 0.5 + this._footstepRoll * 0.5 + breathRotZ;
    } else {
      // First person: lean + bob + shake + land dip + footstep dip + vault dip + slide lower.
      const rightDir = ctx.scratch.v4.set(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
      camera.position.copy(player.pos);
      camera.position.add(rightDir.multiplyScalar(leanOffset));
      camera.position.y += bobY;
      camera.position.y -= this._camLandDip;
      camera.position.y -= this._footstepDip;
      camera.position.y += vaultMantleDip;
      camera.position.y += this._slideCamLower;
      // Task-34: crouch dip (absorbs the snap when toggling crouch).
      camera.position.y -= this._crouchDip;
      // Task-34: ADS sway (gun isn't perfectly steady — subtle low-freq + tremor).
      camera.position.x += adsSwayX;
      camera.position.y += adsSwayY;
      camera.position.add(this._shakeOffset);
      camera.rotation.order = "YXZ";
      camera.rotation.y = player.yaw + bobX * 0.1;
      camera.rotation.x = effPitch;
      camera.rotation.z = this._camRoll + this._footstepRoll + breathRotZ;
    }

    // ADS blend + FOV (with slide + vault + dive FOV boost for speed sensation).
    const targetAim = weapon.isAiming ? 1 : 0;
    const adsSpeed = ctx.settings.extended?.adsSpeed ?? 14;
    weapon.aimBlend = THREE.MathUtils.damp(weapon.aimBlend, targetAim, adsSpeed, dt);
    // Task-14: dive adds +8 FOV for speed sensation (COD-style dive FOV widen).
    const baseFovEff = weapon.baseFov + (player.sliding ? 5 : 0) + (player.diving ? 8 : 0) + vaultFovBoost;
    const adsFov = baseFovEff / weapon.stats.effectiveZoom;
    // ANIM-POLISH — FOV now tracks the damped aimBlend via easeOutCubic so the
    // FOV transition is LOCKED to the gun's ADS motion. The previous code
    // used `adsSpeed - 2` for FOV vs `adsSpeed` for aimBlend — they were 2
    // rate units out of sync, so the FOV lagged the gun's zoom-in by ~50ms
    // and felt disjoint. Now both share the same rate (adsSpeed) + the FOV
    // is sampled from the damped aimBlend (via easeOutCubic) so the gun +
    // FOV move in perfect sync. easeOutCubic gives the FOV a fast-out /
    // slow-in profile matching the gun's ADS approach (the gun snaps up to
    // the eye, then settles the last few % smoothly).
    const fovAtBlend = THREE.MathUtils.lerp(baseFovEff, adsFov, easeOutCubic(weapon.aimBlend));
    camera.fov = THREE.MathUtils.damp(camera.fov, fovAtBlend, adsSpeed, dt);
    camera.updateProjectionMatrix();
    ctx.pushHud({
      aiming: weapon.aimBlend > 0.5,
      scoped: weapon.stats.scoped && weapon.aimBlend > 0.6,
      viewMode: player.viewMode,
    });

    // Weapon viewmodel — with mouse-look sway, sprint pose, jump/land dip, inspect.
    const gun = weapon ? ctx.gunParts.gun : null;
    if (gun) {
      weapon.weaponRecoilKick.z = THREE.MathUtils.damp(weapon.weaponRecoilKick.z, 0, 14, dt);
      weapon.weaponRecoilKick.x = THREE.MathUtils.damp(weapon.weaponRecoilKick.x, 0, 14, dt);

      // Mouse-look sway: weapon lags behind camera rotation via spring-damper.
      // Accumulate the mouse delta as an impulse, then damp back to 0.
      // Kept very subtle (multiplier 1.5) so the gun doesn't swing wildly.
      if (!this._lastYaw) this._lastYaw = player.yaw;
      if (!this._lastPitch) this._lastPitch = player.pitch;
      const deltaYaw = player.yaw - this._lastYaw;
      const deltaPitch = player.pitch - this._lastPitch;
      this._lastYaw = player.yaw;
      this._lastPitch = player.pitch;
      // Accumulate delta as impulse (clamped so huge mouse flicks don't spike).
      this._swayX = THREE.MathUtils.clamp(this._swayX - deltaYaw * 1.5, -0.08, 0.08);
      this._swayY = THREE.MathUtils.clamp(this._swayY - deltaPitch * 1.5, -0.08, 0.08);
      // Damp back to 0 (spring recovery) — single damp, no fighting.
      this._swayX = THREE.MathUtils.damp(this._swayX, 0, 8, dt);
      this._swayY = THREE.MathUtils.damp(this._swayY, 0, 8, dt);

      // ADS: move gun to center, closer to camera, and aligned for iron sights.
      // Hip-fire: offset right + down for a relaxed grip.
      // Sprint: lower the gun to a relaxed carry pose.
      // Inspect: rotate the gun to show it off.
      //
      // Y target: raised so the weapon's sight (iron sight / optic / scope)
      // lands at y=0 in camera space — visually aligned with the screen-center
      // crosshair. Each weapon + sight combo has a different sight height
      // (the scope sits higher than iron sights), so the ADS Y is per-weapon.
      // The bullet trajectory is always camera-forward (crosshair); this just
      // makes the viewmodel sights coherently sit ON the crosshair when ADS,
      // so the player can aim with the sight picture instead of the crosshair.
      const aimT = weapon.aimBlend;
      const isSprinting = sprint && speed > 3 && !weapon.isAiming;
      const isInspecting = weapon.inspectAnim > 0;

      // Per-weapon + per-sight ADS sight height (height of the sight above
      // the gun's centerline). The gun Y target = -sightHeight so the sight
      // sits at y=0 (crosshair line) in camera space.
      const sightHeight = getAdsSightHeight(weapon.loadout.weapon, weapon.loadout.sight);
      const isScoped = weapon.stats.scoped;
      // Scoped weapons: bring the gun closer (z) so the scope ocular lens
      // fills more of the view behind the HTML scope overlay. Non-scoped:
      // standard ADS distance.
      const adsZ = isScoped ? -0.22 : -0.30;

      let targetX = THREE.MathUtils.lerp(0.22, 0.0, aimT);
      let targetY = THREE.MathUtils.lerp(-0.22, -sightHeight, aimT);
      let targetZ = THREE.MathUtils.lerp(-0.45, adsZ, aimT);
      // Scoped weapons: keep the gun dead-level at full ADS so the scope
      // axis is parallel to the camera forward (no tilt — the scope reticle
      // stays centered). Non-scoped: slight forward tilt for natural feel.
      let targetRotX = isScoped && aimT > 0.5
        ? -0.01
        : (aimT > 0.5 ? -0.02 : -weapon.weaponRecoilKick.z * 4);
      let targetRotY = 0;
      let targetRotZ = THREE.MathUtils.lerp(0, isScoped ? 0.0 : 0.03, aimT);

      // Sprint pose: lower + tilt the gun.
      if (isSprinting) {
        // V5.3 — sprint interrupts an in-progress reload (don't queue awkwardly).
        if (weapon.reloading) {
          weapon.reloading = false;
          weapon.reloadPhase = 0;
          ctx.pushHud({ reloading: false, reloadProgress: 0 });
        }
        targetY = -0.35;
        targetZ = -0.38;
        targetRotX = 0.4;
        targetRotZ = 0.15;
      }

      // Inspect animation: rotate the gun to show attachments/skins.
      // Prompt A#48 — use the multi-beat evalInspectAnimation timeline (was:
      // a simple sine-wave bump that gave a flat inspect motion). The
      // multi-beat timeline gives a 3-phase inspect (tilt to check mag →
      // rack chamber → settle back) with anticipation + overshoot-settle
      // for a hand-animated feel.
      if (isInspecting) {
        const inspectT = 1 - weapon.inspectAnim / 2.0; // 0→1 over 2s
        const inspectPose = evalInspectAnimation(inspectT);
        targetRotY = inspectPose.rotY;
        targetRotX = inspectPose.rotX;
        targetRotZ = inspectPose.rotZ;
        targetX += inspectPose.posX;
        targetY += inspectPose.posY;
        targetZ += inspectPose.posZ;
      }

      // Prompt A#49 — tick the FPAnimStateMachine. The state machine's
      // output (BASE_POSES blended toward the current state) is used as
      // the canonical idle/ads/sprint target below (replacing the
      // previously-hardcoded 0.22, -0.22, -0.45). The state machine
      // also drives the FOV transition (idle 90 → ads 65 → sprint 100).
      if (weapon.fpStateMachine) {
        // Sync the state machine's base state with the weapon's current mode.
        if (isSprinting) weapon.fpStateMachine.setState("sprint");
        else if (weapon.isAiming) weapon.fpStateMachine.setState("ads");
        else weapon.fpStateMachine.setState("idle");
        // Tick the state machine (advances the base-pose damping + any
        // active one-shot overlay).
        weapon.fpStateMachine.tick(dt);
        // Read the blended base pose + use its position as the target.
        // This is the prompt A#45 wiring: BASE_POSES[currentState] now
        // visibly drives the viewmodel — changing a BASE_POSE value in
        // fp-state-machine.ts changes the viewmodel's idle/ads/sprint pose.
        const fpTransform = weapon.fpStateMachine.getViewModelTransform();
        // Override the target X/Y/Z with the state machine's output when
        // not sprinting/inspecting (those states have their own overrides
        // above). When ADS, use the state machine's ads pose directly.
        if (!isSprinting && !isInspecting) {
          // Blend the hardcoded target (which has per-weapon sight height)
          // with the state machine's base pose. The state machine provides
          // the canonical pose; the sight-height adjustment layers on top.
          if (weapon.isAiming) {
            targetX = fpTransform.pos[0];
            targetY = fpTransform.pos[1] - sightHeight * 0.5; // keep sight alignment
            targetZ = fpTransform.pos[2];
          } else {
            // Idle — use the state machine's idle pose directly.
            targetX = fpTransform.pos[0];
            targetY = fpTransform.pos[1];
            targetZ = fpTransform.pos[2];
          }
        }
      }

      // Jump/land dip: scale by fall velocity (clamped).
      if (!player.onGround) {
        targetY -= 0.05; // gun drops slightly when airborne
        targetRotX += 0.1;
      }

      // ─── Procedural viewmodel juice: breathing + walk bob + landing dip ───
      // Landing dip — sharp downward dip on land, recovers in ~0.15s.
      const justLanded = player.onGround && !this._prevOnGround;
      this._prevOnGround = player.onGround;
      if (justLanded) this._landDip = 0.08;
      this._landDip = THREE.MathUtils.damp(this._landDip, 0, 18, dt);
      // Idle breathing — ~0.5Hz subtle vertical + rotational sway.
      this._breathingPhase += dt;
      const breatheY = Math.sin(this._breathingPhase * Math.PI) * 0.005;
      const breatheRot = Math.sin(this._breathingPhase * Math.PI) * 0.003;
      // Walk bob — synced to player.bobTime, slightly more pronounced than camera.
      const walkFactor = Math.min(speed / 5, 1);
      const walkBobY = Math.sin(player.bobTime * 2) * 0.015 * walkFactor;
      const walkBobX = Math.cos(player.bobTime) * 0.010 * walkFactor;
      // Sprint blend — smoothed for graceful in/out arm transitions.
      this._sprintBlend = THREE.MathUtils.damp(this._sprintBlend, isSprinting ? 1 : 0, 10, dt);

      // ANIM-POLISH — wrap the switch-dip time term in easeInOutCubic so the
      // bell curve has weight at the start/end (the gun eases INTO the dip
      // and eases OUT of it, rather than starting/stopping at peak velocity).
      // switchAnim counts DOWN from 0.35, so (1 - switchAnim/0.35) goes 0→1.
      const switchDip = weapon.switchAnim > 0
        ? Math.sin(easeInOutCubic(1 - weapon.switchAnim / 0.35) * Math.PI) * 0.12
        : 0;
      gun.position.x = THREE.MathUtils.damp(gun.position.x, targetX + weapon.weaponRecoilKick.x + this._swayX + walkBobX, 16, dt);
      gun.position.y = THREE.MathUtils.damp(gun.position.y, targetY - switchDip + this._swayY + breatheY + walkBobY - this._landDip, 16, dt);
      gun.position.z = THREE.MathUtils.damp(gun.position.z, targetZ + weapon.weaponRecoilKick.z, 16, dt);
      gun.rotation.x = THREE.MathUtils.damp(gun.rotation.x, targetRotX + breatheRot + this._landDip * 0.6, 14, dt);
      gun.rotation.y = THREE.MathUtils.damp(gun.rotation.y, targetRotY, 14, dt);
      gun.rotation.z = THREE.MathUtils.damp(gun.rotation.z, targetRotZ, 14, dt);

      // ─── First-person arm procedural animation ───
      // Arms are children of the gun group, so they inherit sway/recoil/sprint/
      // inspect/ADS automatically. The offsets below are hand-specific motions
      // layered on top of the gun's transform.
      const armParts = ctx.gunParts as GunPartsWithArms;
      const lh = armParts.leftArm;
      const rh = armParts.rightArm;
      const lhHand = armParts.leftHand;
      const rhHand = armParts.rightHand;
      if (lh && rh) {
        // Reset arms to default pose each frame, then apply procedural offsets.
        const lp = lh.userData.defaultPos as THREE.Vector3 | undefined;
        const lr = lh.userData.defaultRot as THREE.Euler | undefined;
        const rp = rh.userData.defaultPos as THREE.Vector3 | undefined;
        const rr = rh.userData.defaultRot as THREE.Euler | undefined;
        if (lp && lr) { lh.position.copy(lp); lh.rotation.copy(lr); }
        if (rp && rr) { rh.position.copy(rp); rh.rotation.copy(rr); }

        // Reset hands to default pose (position + rotation) each frame.
        // The hand default rotation includes the pistol-support tilt (for
        // USP/Deagle left hand) — captured in hand.userData.defaultRot at
        // arm-build time. Without this reset, the reload wrist offsets would
        // accumulate frame-over-frame and the hand would spin.
        const lhDefRot = lhHand?.userData.defaultRot as THREE.Euler | undefined;
        const rhDefRot = rhHand?.userData.defaultRot as THREE.Euler | undefined;
        if (lhHand) {
          lhHand.position.set(0, 0.005, 0);
          if (lhDefRot) lhHand.rotation.copy(lhDefRot); else lhHand.rotation.set(0, 0, 0);
        }
        if (rhHand) {
          rhHand.position.set(0, 0.005, 0);
          if (rhDefRot) rhHand.rotation.copy(rhDefRot); else rhHand.rotation.set(0, 0, 0);
        }

        // ─── Reload animation: multi-phase hand + finger choreography ───
        // Tactical reload (mag not empty): 5 phases over [0, 0.85], then a
        //   quick charging-handle TAP on [0.85, 1.0] (knife-hand strike).
        // Empty reload (mag empty): same 5 phases, then a full charging-
        //   handle PULL on [0.85, 1.0] (grab → pull back → release).
        //
        // Grip poses — each specifies a per-finger curl (radians, applied to
        // all 3 joints of that finger) + thumb MCP/IP curl. Total finger
        // curl = 3 × perJoint:
        //   RELAXED   ~29° total (default weapon-holding grip; spec ~30°)
        //   PRESS     index straight, others ~69° (mag release button press;
        //              spec: index extended straight, others curled)
        //   MAG_GRIP  ~69° total (tight grip around the magazine; spec ~70°)
        //   FIST      ~89° total (closed fist around the fresh mag; spec ~90°)
        //   KNIFE     all fingers near-straight (palm-edge strike pose)
        type GripPose = { f: [number, number, number, number]; tm: number; ti: number };
        const POSE_RELAXED:  GripPose = { f: [0.17, 0.17, 0.17, 0.17], tm: 0.20, ti: 0.10 };
        const POSE_PRESS:    GripPose = { f: [0.00, 0.40, 0.40, 0.40], tm: 0.18, ti: 0.08 };
        const POSE_MAG_GRIP: GripPose = { f: [0.40, 0.40, 0.40, 0.40], tm: 0.35, ti: 0.20 };
        const POSE_FIST:     GripPose = { f: [0.52, 0.52, 0.52, 0.52], tm: 0.46, ti: 0.36 };
        const POSE_KNIFE:    GripPose = { f: [0.05, 0.05, 0.05, 0.05], tm: 0.20, ti: 0.10 };

        // Apply a grip pose to a hand's finger + thumb joints (overwrites the
        // per-joint rotation.x each frame — no accumulation).
        const applyPose = (hand: THREE.Group | undefined, pose: GripPose) => {
          if (!hand) return;
          const fjs = hand.userData.fingerJoints as THREE.Group[][] | undefined;
          if (fjs) {
            for (let i = 0; i < fjs.length; i++) {
              const joints = fjs[i];
              const curl = pose.f[i] ?? 0;
              for (const j of joints) j.rotation.x = curl;
            }
          }
          const tjs = hand.userData.thumbJoints as THREE.Group[] | undefined;
          if (tjs && tjs.length >= 2) {
            tjs[0].rotation.x = pose.tm;
            tjs[1].rotation.x = pose.ti;
          }
        };

        // Lerp two grip poses (per-finger + thumb).
        const lerpPose = (a: GripPose, b: GripPose, t: number): GripPose => ({
          f: [
            THREE.MathUtils.lerp(a.f[0], b.f[0], t),
            THREE.MathUtils.lerp(a.f[1], b.f[1], t),
            THREE.MathUtils.lerp(a.f[2], b.f[2], t),
            THREE.MathUtils.lerp(a.f[3], b.f[3], t),
          ],
          tm: THREE.MathUtils.lerp(a.tm, b.tm, t),
          ti: THREE.MathUtils.lerp(a.ti, b.ti, t),
        });

        // Default grip pose (both hands relaxed on the gun).
        let leftPose: GripPose = POSE_RELAXED;
        let rightPose: GripPose = POSE_RELAXED;
        // Hand position + rotation offsets (gun-local, applied to the arm
        // groups). These move the hands to the mag release, belt, mag well,
        // and charging handle during the reload.
        let lhOffX = 0, lhOffY = 0, lhOffZ = 0;
        let rhOffX = 0, rhOffY = 0, rhOffZ = 0;
        let lhRotX = 0, rhRotX = 0, rhRotZ = 0;

        if (weapon.reloading) {
          const phase = weapon.reloadPhase;
          // Empty reload = full charging-handle pull at the end (vs a quick tap
          // for tactical). Detected by ammo === 0 (ammo doesn't change until
          // finishReload()).
          const emptyReload = weapon.ammo === 0;

          // Phase 0 - 0.15: right hand releases pistol grip + reaches FORWARD
          //   to the mag release, index finger extends (PRESS pose).
          //   Right hand: moves forward (-Z) toward the mag release, slight
          //   wrist tilt up (palm faces the mag release above the hand).
          //   Left hand: stays at foregrip (RELAXED).
          if (phase < 0.15) {
            const t = phase / 0.15;
            rightPose = lerpPose(POSE_RELAXED, POSE_PRESS, t);
            rhRotX = -t * 0.18;       // wrist tilts up toward the mag release
            rhOffY = -t * 0.014;      // slight drop (hand comes off the grip)
            rhOffZ = -t * 0.040;      // reach FORWARD toward the mag release
          }
          // Phase 0.15 - 0.30: left hand grips the mag + pulls it DOWN out
          //   of the well.
          //   Right hand: smoothly returns to the pistol grip (RELAXED) —
          //   position + rotation lerp back to default so there's no visual
          //   snap from the mag-release reach.
          //   Left hand: MAG_GRIP, moves from foregrip to the mag well, then
          //   pulls DOWN with the mag.
          else if (phase < 0.30) {
            const t = (phase - 0.15) / 0.15;
            leftPose = lerpPose(POSE_RELAXED, POSE_MAG_GRIP, Math.min(t * 2, 1));
            if (t < 0.5) {
              // First half: reach from foregrip to the mag well.
              const tt = t * 2;
              lhOffZ = tt * 0.22;
              lhOffY = tt * 0.01;
              lhRotX = -tt * 0.20;
            } else {
              // Second half: pull the mag DOWN out of the well.
              const tt = (t - 0.5) * 2;
              lhOffZ = 0.22;
              lhOffY = 0.01 - tt * 0.10;
              lhRotX = -0.20 - tt * 0.30;
            }
            rightPose = lerpPose(POSE_PRESS, POSE_RELAXED, t);
            // Smooth right-hand return to the pistol grip (lerp the mag-
            // release reach back to 0 over this phase — avoids a snap).
            const rt = 1 - t;
            rhRotX = -rt * 0.18;
            rhOffY = -rt * 0.014;
            rhOffZ = -rt * 0.040;
          }
          // Phase 0.30 - 0.50: right hand reaches to the belt (off-screen)
          //   and grabs a fresh mag (FIST pose).
          //   Left hand: returns to foregrip (empty mag is dropped).
          else if (phase < 0.50) {
            const t = (phase - 0.30) / 0.20;
            // Right hand moves DOWN-RIGHT-BACK (off-screen toward the belt).
            const reachT = Math.min(t * 1.3, 1);
            rhOffX = reachT * 0.12;
            rhOffY = -reachT * 0.18;
            rhOffZ = reachT * 0.10;
            rhRotX = -reachT * 0.6;
            rhRotZ = reachT * 0.4;
            // Fist closes around the fresh mag partway through the reach.
            rightPose = lerpPose(POSE_RELAXED, POSE_FIST, Math.min(t * 1.5, 1));
            // Left hand returns to foregrip.
            const retT = Math.min(t * 2, 1);
            leftPose = lerpPose(POSE_MAG_GRIP, POSE_RELAXED, retT);
            lhOffZ = (1 - retT) * 0.22;
            lhOffY = (1 - retT) * -0.09 + retT * 0.01 * (1 - retT);
            lhRotX = (1 - retT) * -0.50;
          }
          // Phase 0.50 - 0.70: right hand brings the fresh mag UP + inserts
          //   it into the well (MAG_GRIP pose, wrist rotates to guide it).
          //   Left hand: at foregrip (RELAXED).
          else if (phase < 0.70) {
            const t = (phase - 0.50) / 0.20;
            // Right hand returns from off-screen up to the mag well.
            const retT = Math.min(t * 1.6, 1); // 0 → 1 over first ~62%
            rhOffX = (1 - retT) * 0.12;
            rhOffY = (1 - retT) * -0.18 + retT * -0.03;
            rhOffZ = (1 - retT) * 0.10 + retT * -0.10;
            rhRotX = (1 - retT) * -0.6 + retT * -0.20;
            rhRotZ = (1 - retT) * 0.4 + retT * 0.08; // slight roll to guide mag
            // Fist → mag-grip as the hand guides the mag into the well.
            rightPose = lerpPose(POSE_FIST, POSE_MAG_GRIP, Math.min(t * 1.5, 1));
          }
          // Phase 0.70 - 0.85: right hand returns to the pistol grip.
          //   Right hand: lerp MAG_GRIP → RELAXED.
          //   Left hand: at foregrip (RELAXED).
          else if (phase < 0.85) {
            const t = (phase - 0.70) / 0.15;
            rightPose = lerpPose(POSE_MAG_GRIP, POSE_RELAXED, t);
            // Right hand moves from the mag well back to the pistol grip.
            rhOffY = (1 - t) * -0.03;
            rhOffZ = (1 - t) * -0.10 + t * 0.02;
            rhRotX = (1 - t) * -0.20;
          }
          // Phase 0.85 - 1.0: charging handle.
          //   Tactical (mag not empty): left hand taps the charging handle
          //     with a palm-edge strike (KNIFE pose), quick up + down.
          //   Empty (mag empty): left hand grabs the charging handle
          //     (MAG_GRIP), pulls it all the way back, then releases.
          else {
            const t = (phase - 0.85) / 0.15;
            if (emptyReload) {
              // Empty: reach → grab → pull back → release.
              if (t < 0.4) {
                const tt = t / 0.4;
                leftPose = lerpPose(POSE_RELAXED, POSE_MAG_GRIP, tt);
                lhOffY = tt * 0.10;
                lhOffZ = tt * 0.22;
                lhRotX = -tt * 0.40;
              } else if (t < 0.75) {
                const tt = (t - 0.4) / 0.35;
                leftPose = POSE_MAG_GRIP;
                lhOffY = 0.10;
                lhOffZ = 0.22 + tt * 0.08; // pull back with the handle
                lhRotX = -0.40 - tt * 0.20;
              } else {
                const tt = (t - 0.75) / 0.25;
                leftPose = lerpPose(POSE_MAG_GRIP, POSE_RELAXED, tt);
                lhOffY = (1 - tt) * 0.10;
                lhOffZ = (1 - tt) * 0.30;
                lhRotX = (1 - tt) * -0.60;
              }
            } else {
              // Tactical: quick knife-hand tap (up → tap → down).
              const upT = Math.sin(Math.min(t * Math.PI, Math.PI));
              leftPose = lerpPose(POSE_RELAXED, POSE_KNIFE, upT);
              lhOffY = upT * 0.10;
              lhOffZ = upT * 0.22;
              lhRotX = -upT * 0.40;
            }
          }
        }

        // Apply the grip poses to the finger + thumb joints.
        applyPose(lhHand, leftPose);
        applyPose(rhHand, rightPose);

        // Apply the hand position + rotation offsets to the arm groups.
        lh.position.x += lhOffX;
        lh.position.y += lhOffY;
        lh.position.z += lhOffZ;
        lh.rotation.x += lhRotX;
        rh.position.x += rhOffX;
        rh.position.y += rhOffY;
        rh.position.z += rhOffZ;
        rh.rotation.x += rhRotX;
        rh.rotation.z += rhRotZ;

        // Sprint — left hand slides off foregrip, arms relax (smoothed blend).
        const sT = this._sprintBlend;
        lh.position.x += sT * 0.04;
        lh.rotation.z += sT * 0.3;
        lh.rotation.x += sT * 0.2;
        rh.rotation.z -= sT * 0.15;

        // ADS — hands slide forward slightly to center (suppressed during sprint).
        const aT = aimT * (1 - sT);
        lh.position.z -= aT * 0.02;
        rh.position.z -= aT * 0.02;

        // Fire — right hand wrist flex follows the recoil kick (additive on
        // top of any reload wrist offset — reload doesn't fire, so kick is
        // typically 0 during reload, but the additive form is robust).
        if (rhHand) {
          const kick = weapon.weaponRecoilKick.z;
          rhHand.rotation.x += -kick * 6;
          rhHand.position.y += -kick * 0.3;
        }
      }

      // V3.1 — when fully scoped (ADS with a scoped weapon), hide the weapon
      // model so the glass scope mesh doesn't block the camera. The HTML
      // ScopeOverlay (reticle + black ring with transparent center) provides
      // the scope visual. The 3D scene is visible through the overlay's
      // transparent center. Without this, the transmission-glass scope mesh
      // renders as opaque black in the EffectComposer pipeline.
      const isFullyScoped = weapon.stats.scoped && weapon.aimBlend > 0.6;
      ctx.weaponGroup.visible = player.viewMode === "first" && !isFullyScoped;
      if (weapon.switchAnim > 0) weapon.switchAnim = Math.max(0, weapon.switchAnim - dt);
      if (weapon.inspectAnim > 0) weapon.inspectAnim = Math.max(0, weapon.inspectAnim - dt);
    }

    // Reload animation — gun motion (dip + tilt + breathing bob + mag-insert
    // "click") + magazine drop/insert visual.
    if (weapon.reloading) {
      weapon.reloadPhase = Math.min(1, (performance.now() - weapon.reloadStart) / weapon.stats.effectiveReloadTime);
      const phase = weapon.reloadPhase;
      if (gun) {
        // Dip — gun tilts down slightly during the reload (peaks mid-reload).
        const dipT = Math.sin(phase * Math.PI); // 0 → 1 → 0
        gun.rotation.x += dipT * 0.12;
        gun.position.y -= dipT * 0.015;
        // Tilt right — gun rolls ~12° right so the player can see the mag well.
        gun.rotation.z += dipT * 0.20;
        // Breathing bob — subtle 2Hz oscillation during the reload.
        const bobT = (performance.now() - weapon.reloadStart) * 0.012;
        gun.position.y += Math.sin(bobT) * 0.003;
        gun.rotation.x += Math.sin(bobT * 0.7) * 0.005;
        // ANIM-POLISH — Mag insertion "click": replace the sharp triangular
        // pulse with a damped sine. Same peak amplitude, but with 2-3 visible
        // bounces on the trailing edge so the gun feels weighty (it oscillates
        // briefly after the mag seats, like a real spring-loaded mag well)
        // rather than snapping back to rest instantly. Window = 4% of phase
        // (~80ms at a 2s reload — matches the spec).
        // sin(t * π * 3) gives 1.5 full cycles → 3 zero crossings → 2-3 bumps.
        // exp(-t * 8) decays to ~3% by t=0.5 (the second bump is much smaller).
        // Peak amplitude ≈ 0.36 (at t≈0.092); the 0.035 / 0.012 scale factors
        // are tuned so the visible kick matches the original triangular pulse.
        const clickWindow = 0.04;
        const clickPhase = phase - 0.50;
        const clickT = clickPhase >= 0 && clickPhase < clickWindow
          ? Math.sin((clickPhase / clickWindow) * Math.PI * 3) * Math.exp(-(clickPhase / clickWindow) * 8)
          : 0;
        gun.rotation.x += clickT * 0.035; // ~2° kick down (peak ≈ 0.013 rad)
        gun.position.y -= clickT * 0.012; // small recoil drop (peak ≈ 0.004 m)
      }
      // Magazine drop + insertion.
      //   Phase 0    - 0.15: mag in well (default position).
      //   Phase 0.15 - 0.50: mag drops DOWN out of the well (quick fall, then
      //                      stays down while the right hand grabs a fresh mag).
      //   Phase 0.50 - 1.0 : mag snaps back to default with a small bounce
      //                      (the fresh mag is inserted; the "click" gun kick
      //                      above sells the impact).
      if (ctx.gunParts.mag) {
        const mag = ctx.gunParts.mag;
        const defaultPos = mag.userData.defaultPos as THREE.Vector3 | undefined;
        const baseY = defaultPos?.y ?? -0.16;
        let dropAmt = 0;
        if (phase >= 0.15 && phase < 0.50) {
          const dropT = (phase - 0.15) / 0.35;
          // ANIM-POLISH — easeIn quadratic for the mag drop (replaces linear).
          // Gravity accelerates things downward, so the mag should START slow
          // (just released from the well) and ACCELERATE as it falls. The
          // linear fall looked weightless; the eased fall reads as gravity.
          // First 40% of the window: falling (eased). Then stays down (off-
          // screen while the right hand reaches for the fresh mag).
          if (dropT < 0.4) {
            dropAmt = -0.20 * easeInQuad(dropT / 0.4);
          } else {
            dropAmt = -0.20;
          }
        } else if (phase >= 0.50) {
          // ANIM-POLISH — mag insertion bounce: replace the single sine pulse
          // with a damped sine (same as the click kick). The mag oscillates
          // around its seated position with 2-3 visible bounces, like a real
          // spring-loaded mag well absorbing the impact. Window = 5% of phase
          // (~100ms at a 2s reload). Peak amplitude ≈ 0.36 (at t≈0.092); the
          // 0.04 scale factor is tuned so the visible peak matches the
          // original 0.015 amplitude (0.04 * 0.36 ≈ 0.014 ≈ 0.015).
          const bounceWindow = 0.05;
          const bouncePhase = phase - 0.50;
          const bounceT = bouncePhase >= 0 && bouncePhase < bounceWindow
            ? Math.sin((bouncePhase / bounceWindow) * Math.PI * 3) * Math.exp(-(bouncePhase / bounceWindow) * 8)
            : 0;
          dropAmt = -0.04 * bounceT;
        }
        mag.position.y = baseY + dropAmt;
      }
      if (weapon.reloadPhase >= 1) this.finishReload();
    }
  }

  /**
   * Task-8: slide — burst of speed (1.5× sprint) decaying to 0.4× sprint over
   * 0.6s. Ends on time-up, wall-hit (speed < 3), or W release. Jump cancels
   * slide (handled in the jump block above to preserve forward momentum).
   * Returns true while the slide is active (skips normal accel).
   */
  private updateSlide(dt: number, forward: THREE.Vector3): boolean {
    const { player, keys } = this.ctx;
    if (!player.sliding) return false;
    // End conditions (using previous frame's velocity — post-collision).
    const prevSpeed = Math.hypot(player.vel.x, player.vel.z);
    player.slideTime = (player.slideTime ?? 0) + dt;
    if ((player.slideTime ?? 0) >= 0.6 || prevSpeed < 3.0 || !keys["KeyW"]) {
      player.sliding = false;
      player.slideTime = 0;
      return false;
    }
    // Apply slide velocity: 1.5× sprint burst, linear decay to 0.4× sprint over 0.6s.
    const sprintSpeed = 8.2;
    const t = Math.min(1, (player.slideTime ?? 0) / 0.6);
    const slideSpeed = THREE.MathUtils.lerp(sprintSpeed * 1.5, sprintSpeed * 0.4, t);
    player.vel.x = forward.x * slideSpeed;
    player.vel.z = forward.z * slideSpeed;
    return true;
  }

  /**
   * Task-14: dolphin dive — COD-style forward dive triggered by pressing
   * crouch (Ctrl/C) while sprinting forward + airborne. Two phases:
   *
   *   "air"   — forward launch (vel = forward * 12 m/s + slight downward arc),
   *             gravity applies, player can't steer. Ends on landing (onGround)
   *             or 0.6s timeout. On landing: trigger 0.1 shake, transition to
   *             "prone".
   *   "prone" — 0.3s stationary prone recover (vel = 0, eye height 0.4m). After
   *             0.3s, the player snaps back to standing eye height (1.7m) and
   *             normal movement resumes.
   *
   * The launch impulse is applied on the FIRST updateDive frame after the dive
   * was triggered in InputSystem (diveTime === 0 + divePhase === "air"). This
   * guarantees a fresh forward vector from the current yaw (avoids stale state
   * if the player turned between keypress and the next physics tick).
   *
   * Returns true while the dive is active (skips normal accel + external
   * gravity; the air phase applies its own gravity internally).
   */
  private updateDive(dt: number, forward: THREE.Vector3): boolean {
    const { player } = this.ctx;
    if (!player.diving) return false;

    // First-frame launch (divePhase was just set to "air" with diveTime = 0
    // by InputSystem — apply the launch impulse now that we have a fresh
    // forward vector from the current yaw).
    if (player.divePhase === "air" && (player.diveTime ?? 0) === 0) {
      player.vel.x = forward.x * 12; // 12 m/s forward launch
      player.vel.z = forward.z * 12;
      player.vel.y = -2; // slight downward arc to start
    }

    player.diveTime = (player.diveTime ?? 0) + dt;

    if (player.divePhase === "air") {
      // Apply gravity during the airborne phase (PhysicsSystem skips its
      // external gravity application while diveActive is true).
      player.vel.y += PLAYER_GRAVITY * dt; // Section F (#92).

      // End conditions: landed (with small grace to avoid immediate trigger
      // — the dive was triggered while airborne, so we need at least one
      // integration step before checking onGround) OR 0.6s timeout.
      if (player.onGround && (player.diveTime ?? 0) > 0.05) {
        player.divePhase = "prone";
        player.diveTime = 0;
        player.vel.set(0, 0, 0);
        // Spec: screen shake (0.1) on dive landing.
        this.ctx.triggerShake(0.1);
      } else if ((player.diveTime ?? 0) >= 0.6) {
        // Timeout — force prone even if still airborne (rare; usually lands
        // within 0.6s on flat ground). No shake (didn't actually land).
        player.divePhase = "prone";
        player.diveTime = 0;
        player.vel.set(0, 0, 0);
      }
    } else if (player.divePhase === "prone") {
      // Brief stationary prone recover. No gravity, no movement.
      player.vel.set(0, 0, 0);
      if ((player.diveTime ?? 0) >= 0.3) {
        // Section F (#95) — Raycast up before snapping from prone (0.4m eye)
        // to standing (1.7m eye). The old code did `pos.y += 1.3` unconditionally,
        // which teleported the player through low ceilings (e.g. under a car
        // or in a vent). Now we probe upward; if there's <1.3m of clearance
        // above the player's head, cancel the stand-up: keep the player prone
        // (eye height 0.4m) and don't end the dive. They'll have to crawl out.
        const standClearance = this._probeCeilingClearance(player.pos.x, player.pos.y, player.pos.z, 1.4);
        if (standClearance === false) {
          // Blocked — stay prone. Reset diveTime so the recover re-arms.
          player.diveTime = 0;
          // Don't end the dive; the player must move out from under the
          // obstacle before they can stand. The MovementFeelSystem / input
          // layer can read `player.diving === true && player.divePhase ===
          // "prone"` after the 0.3s timer to show a "blocked" HUD hint.
        } else {
          player.diving = false;
          player.divePhase = undefined;
          player.diveTime = 0;
          // Snap back to standing eye height (avoid the eye-height clamp
          // teleporting the player from 0.4m to 1.7m on the next frame).
          // 1.3m = 1.7 (standing) - 0.4 (prone).
          player.pos.y += 1.3;
          player.onGround = true;
        }
      }
    }

    return true;
  }

  private finishReload() {
    const { ctx } = this;
    const w = ctx.weapon;
    const need = w.stats.effectiveMagSize - w.ammo;
    const take = Math.min(need, w.reserveAmmo);
    w.ammo += take;
    w.reserveAmmo -= take;
    w.reloading = false;
    ctx.pushHud({ ammo: w.ammo, reserveAmmo: w.reserveAmmo, reloading: false, reloadProgress: 1 });
    // Prompt A#46 — reset the magazine to its authored socket position on
    // reload end. The previous code left the mag at the end-of-reload pose
    // (which could drift ~11cm low if a frame was dropped near the end of
    // the reload animation). Reading `mag.userData.defaultPos` + `defaultRot`
    // (captured at viewmodel build time) ensures the mag snaps back to its
    // exact socket position every reload. The defaultPos snapshot is now
    // the canonical socket definition (not a workaround).
    const mag = ctx.gunParts.mag;
    if (mag) {
      const defaultPos = mag.userData.defaultPos as THREE.Vector3 | undefined;
      const defaultRot = mag.userData.defaultRot as THREE.Euler | undefined;
      if (defaultPos) mag.position.copy(defaultPos);
      if (defaultRot) mag.rotation.copy(defaultRot);
    }
  }

  /** Resolve horizontal collision on one axis (swept-AABB-ish).
   *  Kept for legacy callers; new movement path uses `resolveHorizontalSwept`
   *  (Section F #90/#96) which preserves tangential velocity along walls. */
  resolveHorizontal(axis: "x" | "z", radius: number, height: number) {
    const { ctx } = this;
    const p = ctx.player.pos;
    const vel = ctx.player.vel;
    // Section F (#91) — feet-relative box. The player's pos.y is the EYE
    // height; the box bottom should be at the player's feet (pos.y - eyeHeight).
    // The legacy signature doesn't have eyeHeight, so approximate: assume eye
    // height = 1.7m (standing) — this is the common case. The new
    // `resolveHorizontalSwept` always passes the real eyeHeight.
    const eyeHeight = 1.7;
    const feet = p.y - eyeHeight;
    const head = feet + height;
    const playerBox = ctx.scratch.box1.set(
      new THREE.Vector3(p.x - radius, feet, p.z - radius),
      new THREE.Vector3(p.x + radius, head, p.z + radius),
    );
    for (const c of ctx.colliders) {
      if (!playerBox.intersectsBox(c.box)) continue;
      if (axis === "x") {
        if (vel.x > 0) p.x = c.box.min.x - radius - 0.001;
        else if (vel.x < 0) p.x = c.box.max.x + radius + 0.001;
        vel.x = 0;
      } else {
        if (vel.z > 0) p.z = c.box.min.z - radius - 0.001;
        else if (vel.z < 0) p.z = c.box.max.z + radius + 0.001;
        vel.z = 0;
      }
      playerBox.set(
        new THREE.Vector3(p.x - radius, feet, p.z - radius),
        new THREE.Vector3(p.x + radius, head, p.z + radius),
      );
    }
  }

  /**
   * Section F (#90/#96/#747) — Swept horizontal resolution that preserves
   * tangential velocity. Builds a feet-relative AABB for the player, finds the
   * most-penetrating collider, projects the player out along the contact
   * normal, and only cancels the normal component of velocity (tangential
   * slide is preserved). Fixes the "slide-along-wall stops dead on the corner"
   * bug from the old axis-by-axis resolver (#96).
   *
   * The capsule-vs-mesh narrowphase (#747) is approximated here as
   * capsule-vs-AABB: the player is a vertical capsule (radius 0.4, height
   * varies with crouch/dive/ladder). We treat it as an AABB for the
   * horizontal broadphase (cheap + correct enough for axis-aligned walls);
   * the corner-smoothing below (push-out along the contact normal, not the
   * axis) gives the capsule-feel sliding behavior. A real capsule-vs-trimesh
   * narrowphase is in PhysicsEnhancements.ts (capsuleVsMesh).
   */
  resolveHorizontalSwept(radius: number, eyeHeight: number, height: number) {
    const { ctx } = this;
    const p = ctx.player.pos;
    const vel = ctx.player.vel;
    // Section F (#91) — feet-relative box. Player.pos.y is eye height; the box
    // bottom is at feet (pos.y - eyeHeight), top is at head (feet + height).
    // Old code: bottom = (eye - height) → 1.7 - 1.8 = -0.1m (sunk into floor).
    // New: bottom = (eye - eyeHeight) = 0m (at feet), top = 0 + height = 1.8m.
    const feet = p.y - eyeHeight;
    const head = feet + height;
    const playerBox = ctx.scratch.box1.set(
      new THREE.Vector3(p.x - radius, feet, p.z - radius),
      new THREE.Vector3(p.x + radius, head, p.z + radius),
    );
    // A3-5000-retry / 518: player broadphase — distance-cull colliders that
    // can't possibly intersect the player this frame. Was iterating ALL
    // ctx.colliders per pass (3 passes × 100+ colliders = 300+ tests/frame).
    // Now we filter to colliders within ~5m of the player (the largest
    // reasonable collider extent + the player's max velocity per frame at
    // 60fps ≈ 0.2m). Typical result: 5-15 collider tests/frame (vs 300+).
    // The filter is cheap (single distance check) + the existing
    // `playerBox.intersectsBox(c.box)` test still runs as the narrowphase.
    const BROADPHASE_RADIUS_SQ = 25; // 5m squared
    const nearbyColliders: typeof ctx.colliders = [];
    for (const c of ctx.colliders) {
      // Cheap sphere-vs-sphere broadphase: compare player position to the
      // collider's center (within BROADPHASE_RADIUS + the collider's max extent).
      const cx = (c.box.min.x + c.box.max.x) * 0.5;
      const cz = (c.box.min.z + c.box.max.z) * 0.5;
      const dx = cx - p.x;
      const dz = cz - p.z;
      // Include the collider's half-extent in the radius check so large
      // colliders (e.g. 50m walls) aren't culled when the player is near their edge.
      const halfExtent = Math.max(
        (c.box.max.x - c.box.min.x) * 0.5,
        (c.box.max.z - c.box.min.z) * 0.5,
      );
      const r = BROADPHASE_RADIUS_SQ + halfExtent * halfExtent;
      if (dx * dx + dz * dz <= r) nearbyColliders.push(c);
    }
    // Find the most-penetrating collider; resolve against it. Repeat up to 3
    // times to handle multi-wall corners (player wedged between two walls).
    for (let pass = 0; pass < 3; pass++) {
      let bestC: { box: THREE.Box3; pen: number; nx: number; nz: number } | null = null;
      for (const c of nearbyColliders) {
        if (!playerBox.intersectsBox(c.box)) continue;
        // Compute overlap on each axis; the contact normal is along the axis
        // of LEAST horizontal penetration (so we push out the cheapest way).
        const overlapX = vel.x > 0
          ? (p.x + radius) - c.box.min.x
          : c.box.max.x - (p.x - radius);
        const overlapZ = vel.z > 0
          ? (p.z + radius) - c.box.min.z
          : c.box.max.z - (p.z - radius);
        const overlapY = Math.min(head - c.box.min.y, c.box.max.y - feet);
        // Require some vertical overlap (otherwise the player is above/below
        // the collider and there's no real collision).
        if (overlapY <= 0) continue;
        if (overlapX <= 0 || overlapZ <= 0) continue;
        // Pick the smaller horizontal axis as the contact normal.
        let nx = 0, nz = 0, pen = 0;
        if (overlapX < overlapZ) {
          nx = vel.x > 0 ? -1 : 1;
          pen = overlapX;
        } else {
          nz = vel.z > 0 ? -1 : 1;
          pen = overlapZ;
        }
        if (!bestC || pen > bestC.pen) {
          bestC = { box: c.box, pen, nx, nz };
        }
      }
      if (!bestC) break;
      // Push the player out along the contact normal.
      p.x += bestC.nx * (bestC.pen + 0.001);
      p.z += bestC.nz * (bestC.pen + 0.001);
      // Cancel ONLY the normal component of velocity — tangential is preserved
      // so the player slides along the wall instead of stopping dead. #96.
      const vn = vel.x * bestC.nx + vel.z * bestC.nz;
      if (vn < 0) {
        // Moving into the wall — remove the normal component.
        vel.x -= bestC.nx * vn;
        vel.z -= bestC.nz * vn;
      }
      // Refresh the box for the next pass.
      playerBox.set(
        new THREE.Vector3(p.x - radius, feet, p.z - radius),
        new THREE.Vector3(p.x + radius, head, p.z + radius),
      );
    }
  }

  /**
   * Section F (#93) — Probe the highest ground surface under (x, z). Returns
   * the world Y of the surface (or null if no surface is found within range).
   * Used by the ground check so the player can stand on top of crates,
   * vehicles, or any chunk mesh (instead of only the implicit y=0 plane).
   *
   * Raycasts downward from (x, originY+0.5, z) to (x, originY-2, z) — 2.5m of
   * range below the player's eye. Uses the cached `_surfaceMeshes` list
   * (rebuilt lazily when the scene changes — see detectFootSurface).
   */
  private _probeGroundHeight(x: number, z: number, originY: number): number | null {
    const ctx = this.ctx;
    if (!this._footRay.camera) this._footRay.camera = ctx.camera;
    // Rebuild the surface-mesh cache if the scene changed (cheap sig).
    const sig = ctx.scene.children.length;
    if (sig !== this._surfaceMeshSceneSig || this._surfaceMeshes.length === 0) {
      this._surfaceMeshSceneSig = sig;
      this._surfaceMeshes.length = 0;
      ctx.scene.traverse((o) => {
        const ud = (o as THREE.Mesh).userData as { materialSlug?: string; surfaceType?: string };
        if (ud && (ud.materialSlug || ud.surfaceType) && o.type === "Mesh") {
          this._surfaceMeshes.push(o);
        }
      });
    }
    const origin = this._footRay.ray.origin;
    origin.set(x, originY + 0.5, z);
    this._footRay.set(origin, this._footDown);
    this._footRay.far = 3.0;
    const intersects = this._footRay.intersectObjects(this._surfaceMeshes, false);
    if (intersects.length === 0) return null;
    return intersects[0].point.y;
  }

  /**
   * Section F (#95) — Probe upward clearance from (x, y, z). Returns true if
   * there is at least `clearance` meters of empty space above (x, y, z);
   * false if a ceiling mesh blocks the probe within that range. Used by the
   * dive-prone recover so the player can't stand up through a low ceiling.
   *
   * Raycasts upward from (x, y, z) to (x, y + clearance, z). Uses the same
   * cached `_surfaceMeshes` list as the ground probe.
   */
  private _probeCeilingClearance(x: number, y: number, z: number, clearance: number): boolean {
    const ctx = this.ctx;
    if (!this._footRay.camera) this._footRay.camera = ctx.camera;
    // Rebuild cache if scene changed (cheap sig).
    const sig = ctx.scene.children.length;
    if (sig !== this._surfaceMeshSceneSig || this._surfaceMeshes.length === 0) {
      this._surfaceMeshSceneSig = sig;
      this._surfaceMeshes.length = 0;
      ctx.scene.traverse((o) => {
        const ud = (o as THREE.Mesh).userData as { materialSlug?: string; surfaceType?: string };
        if (ud && (ud.materialSlug || ud.surfaceType) && o.type === "Mesh") {
          this._surfaceMeshes.push(o);
        }
      });
    }
    const origin = this._footRay.ray.origin;
    origin.set(x, y, z);
    this._footRay.set(origin, _upVec);
    this._footRay.far = clearance;
    const intersects = this._footRay.intersectObjects(this._surfaceMeshes, false);
    return intersects.length === 0;
  }
}

// Reusable upward direction (avoid allocating per probe).
const _upVec = new THREE.Vector3(0, 1, 0);
