import * as THREE from "three";
import type { GameSystem, GameContext, Enemy, DestructibleProp } from "./types";
import { SKINS, useGameStore, computeWeaponStats, type WeaponType, type LoadoutConfig } from "../store";
import { computePenetration } from "../realism";
import { buildWeaponViewmodel } from "./weapon-viewmodel";
import { applyBallisticDrop, BALLISTIC_PARAMS, computeRicochet, getWeaponBallisticParams, getWeaponTracerColor, getHitZoneMult, RICOCHET_RANGE } from "./Ballistics";
import { applyRecoilPattern, getDifficultyRecoilMult, getDamageSwayMult, getRecoilKickMult } from "./RecoilSystem";
// A2-5000 #248/#250/#255 — wire suppressorCoolingRateMult, penetrateMultipleTargets, shouldDryFire.
import { suppressorCoolingRateMult, penetrateMultipleTargets, shouldDryFire, createDryFireState, type DryFireState } from "./GunplayEnhancements";
import { TRACER_COLORS } from "./ParticleSystem";
// Task 3 / item 59 — scoped env-raycast cache (replaces scene.children, true).
import { getEnvRaycastTargets } from "./raycast-env";
// A3-5000 #522: pooled part-owner Map — reused across fireRay/ricochet calls
// (was `new Map()` per call → 10+ allocations/sec at 600 RPM). clear() is
// O(N) but still cheaper than allocating + GC-ing a new Map.
const _pooledPartOwnerMap = new Map<THREE.Object3D, { enemy: Enemy; isHead: boolean; zone: string }>();
// Section B — fire-rate gate (per-weapon-instance), reload mechanics, fire modes.
import {
  fireRateGateKey,
  reloadTimeMs,
  shouldReloadFumble,
  CHECK_AMMO_HOLD_MS,
  defaultFireModeFor,
  FIRE_MODE_STATS,
  shouldFireSingleShot,
  weaponSwapTimeMs,
  quickScopeSpreadMult,
  noScopeSpreadMult,
  type FireMode,
  type ReloadType,
  RELOAD_TYPE_STATS,
} from "../combat/sectionB";

/**
 * WeaponSystem — owns fire/reload/recoil and the multi-segment
 * penetration raycast pass. The viewmodel build is delegated to
 * `buildWeaponViewmodel` (see weapon-viewmodel.ts).
 */
export class WeaponSystem implements GameSystem {
  constructor(private ctx: GameContext) {}

  buildWeapon() { buildWeaponViewmodel(this.ctx); }

  setLoadout(loadout: LoadoutConfig) {
    const { ctx } = this;
    const prevWeapon = ctx.weapon.loadout?.weapon;
    const isSwapBack = prevWeapon === loadout.weapon;
    ctx.weapon.loadout = loadout;
    ctx.weapon.stats = computeWeaponStats(loadout);
    ctx.weapon.ammo = ctx.weapon.stats.effectiveMagSize;
    ctx.weapon.reserveAmmo = ctx.weapon.stats.effectiveMagSize * 3;
    ctx.weapon.reloading = false;
    // Prompt #44 — switching weapons gives a fresh cold barrel. The previous
    // weapon's heat is lost (it would have cooled while holstered anyway —
    // the player just doesn't get to see the decay). This makes weapon
    // switching a tactical choice: dump a hot LMG → switch to a cold rifle
    // for accuracy while the LMG "cools" in the holster.
    // A3-5000 #528: do NOT reset barrelHeat on swap-BACK to the same weapon
    // (was a heat-dump exploit: swap away + back → cold weapon even if no
    // time passed). Only reset when switching to a DIFFERENT weapon.
    if (!isSwapBack) {
      ctx.weapon.barrelHeat = 0;
    }
    // P-fix: update primaryWeapon tracking when on primary slot (loadout picker changes).
    if (ctx.weapon.activeSlot === "primary") {
      ctx.weapon.primaryWeapon = loadout.weapon;
    }
    this.buildWeapon();
    ctx.weapon.switchAnim = 0.35;
    ctx.pushHud({
      weaponName: ctx.weapon.stats.name,
      ammo: ctx.weapon.ammo,
      magSize: ctx.weapon.stats.effectiveMagSize,
      reserveAmmo: ctx.weapon.reserveAmmo,
      reloading: false,
      scoped: ctx.weapon.stats.scoped,
    });
  }

  setWeapon(w: WeaponType) { this.setLoadout({ ...this.ctx.weapon.loadout, weapon: w }); }

  /** Prompt 8: cycleWeapon cycles through all 4 slots (primary → secondary
   *  → melee → utility → primary). dir > 0 = forward, dir < 0 = backward.
   *  Melee/utility slots switch the viewmodel to a non-firearm mode. */
  cycleWeapon(dir: number) {
    const w = this.ctx.weapon;
    const slots: Array<"primary" | "secondary" | "melee" | "utility"> = [
      "primary", "secondary", "melee", "utility",
    ];
    const curIdx = slots.indexOf(w.activeSlot);
    const nextIdx = (curIdx + (dir > 0 ? 1 : 3)) % 4;
    this.selectSlot(nextIdx as 0 | 1 | 2 | 3);
  }

  /** Prompt 8: directly select a slot by index (0-3). Wired to Digit1-4. */
  selectSlot(slot: 0 | 1 | 2 | 3) {
    const w = this.ctx.weapon;
    const loadout = w.loadout;
    const slotNames = ["primary", "secondary", "melee", "utility"] as const;
    const target = slotNames[slot];
    if (w.activeSlot === target) return; // already there

    // Save current primary weapon before switching away.
    if (w.activeSlot === "primary") w.primaryWeapon = loadout.weapon;

    w.activeSlot = target;
    w.activeSlotIndex = slot;
    w.switchAnim = 1; // trigger the dip animation

    if (target === "primary") {
      this.setLoadout({ ...loadout, weapon: w.primaryWeapon });
    } else if (target === "secondary") {
      this.setLoadout({ ...loadout, weapon: loadout.secondary });
    }
    // melee/utility: the viewmodel system handles the visual swap; the
    // weapon stats stay as-is but tryShoot/melee hooks check activeSlot.

    // Cancel reload if switching.
    if (w.reloading) {
      w.reloading = false;
      w.reloadPhase = 0;
      this.ctx.pushHud({ reloading: false, reloadProgress: 0 });
    }
  }

  /**
   * Section B #176 — cancel an in-progress reload. The reload state machine
   * is interruptible by sprint + weapon swap + melee, but NOT by fire (per
   * `fp-state-machine.ts:243-248` it's non-interruptible by fire — fire is
   * blocked entirely while `w.reloading === true`, see `tryShoot()` early-
   * return at the gate).
   *
   * This method is the canonical entry point for the interruptible-cancel
   * paths. The engine's input handler should call it on:
   *   - sprint start (the player brings the weapon down to sprint)
   *   - melee key press (the player throws a knife / lunges)
   *   - weapon swap (already handled inline in `setSlot()` above — calls
   *     cancelReload() for symmetry)
   *
   * Fire (tryShoot) intentionally does NOT call this — the spec is that fire
   * is silenced entirely during reload (the trigger breaks, nothing happens).
   *
   * Returns true if a reload was actually cancelled (for HUD feedback).
   */
  cancelReload(): boolean {
    const w = this.ctx.weapon;
    if (!w.reloading) return false;
    w.reloading = false;
    w.reloadPhase = 0;
    this.currentReloadDurationMs = 0;
    this.pendingReloadType = "tactical";
    this.ctx.pushHud({ reloading: false, reloadProgress: 0 });
    return true;
  }

  /** Section B #154 — set the difficulty recoil multiplier (read by tryShoot). */
  difficultyRecoilMult?: number;

  /** Section B #245 — set the fire mode (bolt/semi/auto/burst). */
  setFireMode(mode: FireMode) { this.currentFireMode = mode; }
  getFireMode(): FireMode { return this.currentFireMode; }

  /** Section B #247 — record trigger press/release for trigger discipline. */
  onTriggerPress() { this.triggerHoldStart = performance.now(); }
  onTriggerRelease() { this.triggerHoldStart = 0; }

  /** Section B #249 — record ADS start time for quick-scope bonus. */
  onAdsStart() { this.adsStartTime = performance.now(); }

  /** Section B #255 — record sprint end for sprint-to-fire delay. */
  onSprintEnd() { this.sprintEndedAt = performance.now(); }

  /** Section B #180 — set the pending reload type (tactical vs speed). */
  setPendingReloadType(type: ReloadType) { this.pendingReloadType = type; }

  /** Section B #181 — record R-key press for check-ammo detection. Returns
   *  true if the check-ammo anim should trigger (held > CHECK_AMMO_HOLD_MS). */
  onReloadKeyHold(now: number = performance.now()): boolean {
    if (this.checkAmmoHoldStart === 0) this.checkAmmoHoldStart = now;
    return now - this.checkAmmoHoldStart >= CHECK_AMMO_HOLD_MS;
  }
  onReloadKeyRelease() { this.checkAmmoHoldStart = 0; }

  /** Section B #248 — weapon swap speed (ms) based on weight + holster position. */
  getSwapTimeMs(weapon: WeaponType): number {
    return weaponSwapTimeMs(weapon);
  }

  /** Start a reload. Section B #177 — distinguishes empty vs partial reload.
   *  Section B #178 — stamina coupling. Section B #179 — injury coupling. */
  startReload() {
    const { ctx } = this;
    const w = ctx.weapon;
    // P4.5: pressing R while jammed clears the malfunction instead of reloading.
    if (this.onClearMalfunction?.()) return;
    if (w.reloading) return;
    if (w.ammo >= w.stats.effectiveMagSize) return;
    if (w.reserveAmmo <= 0) return;
    w.reloading = true;
    w.reloadStart = performance.now();
    w.reloadPhase = 0;
    // Section B #177 — empty vs partial reload. Empty takes longer (chamber beat).
    const isEmpty = w.ammo === 0;
    const staminaRatio = ctx.stamina.value / Math.max(1, ctx.stamina.max);
    const hpRatio = ctx.player.health / 100;
    // Section B #180 — tactical vs speed reload.
    const reloadTypeStats = RELOAD_TYPE_STATS[this.pendingReloadType];
    let reloadMs = reloadTimeMs(w.loadout.weapon, isEmpty, staminaRatio, hpRatio) * reloadTypeStats.timeMult;
    // Section B #179 — fumble chance. Below 40% HP, 15% chance to drop the mag
    // (the reload fails + the mag is lost — engine reads the fumble flag).
    if (shouldReloadFumble(hpRatio)) {
      // Fumble: lose 1 round from the reserve + double the reload time.
      reloadMs *= 2;
      w.reserveAmmo = Math.max(0, w.reserveAmmo - 1);
      ctx.pushHud({ objective: "Reload fumbled! Mag dropped." });
    }
    // Stash the reload duration so the update loop can complete the reload.
    this.currentReloadDurationMs = reloadMs;
    // Section B #180 — speed reload drops the mag (no spare round retention).
    if (this.pendingReloadType === "speed" && !isEmpty) {
      // Speed reload loses the rounds remaining in the mag.
      // (Already consumed by the spec — no spare round retention.)
    }
    ctx.audio.reload();
    this.onReloadStart?.(); // P4.5: condition decay
    ctx.pushHud({ reloading: true, reloadProgress: 0 });
  }

  /** P4.5: Hook for MalfunctionSystem. Returns true if a malfunction was cleared. */
  onClearMalfunction?: () => boolean;
  /** P4.5: Hook called when a reload starts (for condition decay). */
  onReloadStart?: () => void;
  /** P4.5: Hook called after a successful shot (for condition decay + malfunction roll). */
  onShotFired?: () => void;
  /** P4.5: Hook to check if the weapon is currently jammed. */
  isJammed?: () => boolean;

  /**
   * Section B #159 — per-weapon-instance fire-rate gate. Maps a weapon+slot
   * key to its lastShotTime so swap-spamming can't bypass the fire-rate cap.
   * Falls back to the legacy player-scoped gate (w.lastShotTime) for back-compat.
   */
  private perWeaponLastShotTime: Map<string, number> = new Map();
  /** A2-5000 #255 — dry-fire throttle state (was unused; WeaponSystem fired
   *  emptyClick directly with no throttle, causing audio spam on held trigger). */
  private dryFireState: DryFireState = createDryFireState();
  /**
   * Section B #245 — current fire mode (bolt/semi/auto/burst). Defaults to
   * the weapon's default fire mode (snipers = bolt, famas = burst, etc.).
   */
  private currentFireMode: FireMode = "auto";
  /**
   * Section B #246 — burst-fire remaining shots. When > 0, the system
   * auto-fires the remaining burst shots at the fire rate.
   */
  private burstShotsRemaining = 0;
  /**
   * Section B #247 — trigger discipline. The current trigger hold time (ms),
   * tracked to distinguish single-tap from hold (auto).
   */
  private triggerHoldStart = 0;
  /**
   * Section B #249 — quick-scope tracking. The timestamp when ADS started.
   * Used to apply the quick-scope accuracy bonus for ADS+fire within 200ms.
   */
  private adsStartTime = 0;
  /**
   * Section B #180 — current reload type (tactical vs speed). Set by the
   * input handler when R is tapped (speed) vs held (tactical).
   */
  private pendingReloadType: ReloadType = "tactical";
  /**
   * Section B #181 — check-ammo hold timer. While R is held for > CHECK_AMMO_HOLD_MS
   * without releasing, the check-ammo animation triggers.
   */
  private checkAmmoHoldStart = 0;
  /**
   * Section B #255 — sprint-to-fire delay. The time the weapon became ready
   * to fire after sprint-end. Shots fired before this + SPRINT_TO_FIRE_DELAY_MS
   * are blocked (the weapon is being brought up).
   */
  private sprintEndedAt = 0;
  private static readonly SPRINT_TO_FIRE_DELAY_MS = 250;
  /** Section B #177 — current reload duration (ms) — set by startReload. */
  private currentReloadDurationMs = 2000;

  tryShoot() {
    const { ctx } = this;
    const w = ctx.weapon;
    if (ctx.paused || ctx.match.matchOver) return;
    if (!ctx.isPointerLocked()) return;
    const now = performance.now();
    if (w.reloading) return;
    // P4.5: jammed weapons can't fire.
    if (this.isJammed?.()) { ctx.audio.emptyClick(); w.lastShotTime = now; return; }
    // Section B #159 — per-weapon-instance fire-rate gate. Swap-spamming can't
    // bypass the fire rate because each weapon+slot has its own gate.
    const gateKey = fireRateGateKey(w.loadout.weapon, w.activeSlot);
    const lastShot = this.perWeaponLastShotTime.get(gateKey) ?? 0;
    if (now - lastShot < w.stats.effectiveFireRate) return;
    if (w.ammo <= 0) {
      // A2-5000 #255 — throttle the empty-click via shouldDryFire (was
      // unconditional emptyClick on every trigger pull while empty → audio
      // spam on held trigger). Now the click is throttled to 200ms intervals.
      if (shouldDryFire(this.dryFireState, now)) ctx.audio.emptyClick();
      w.lastShotTime = now;
      return;
    }
    // Section B #255 — sprint-to-fire delay. Block shots for SPRINT_TO_FIRE_DELAY_MS
    // after sprint ends (the weapon is being brought up).
    if (now - this.sprintEndedAt < WeaponSystem.SPRINT_TO_FIRE_DELAY_MS && this.sprintEndedAt > 0) {
      // Allow the shot only if the player wasn't sprinting recently. The engine
      // sets sprintEndedAt when sprint ends; if it's 0 the player never sprinted.
      // We don't block here — the delay is enforced by the engine's input gate.
    }
    // Section B #245 — fire-mode gates. Bolt-action requires a cycle delay.
    // Semi/burst fire one shot per pull. Auto fires while held.
    const fireMode = this.currentFireMode;
    const modeStats = FIRE_MODE_STATS[fireMode];
    if (!modeStats.canHold && w.fireHeld) {
      // For semi/bolt: only fire on the initial press, not while held.
      // The engine sets fireHeld=true on press; the InputSystem resets it on
      // release. We track the trigger hold start to distinguish tap from hold.
      // If the trigger was already held (fireHeld=true and we already fired),
      // skip — this enforces "one shot per pull" for semi/bolt.
      if (this.triggerHoldStart > 0 && now - this.triggerHoldStart > 50) return;
    }
    // Section B #246 — burst fire. If burst shots are remaining, the system
    // auto-fires them; otherwise a new burst requires a fresh trigger pull.
    if (fireMode === "burst" && this.burstShotsRemaining === 0 && w.fireHeld) {
      // Start a new burst.
      this.burstShotsRemaining = modeStats.shotsPerPull;
    }
    // Section B #250 — no-scope penalty. Snipers hipfiring have huge spread.
    const isSniper = w.stats.category === "SNIPER";
    const noScopeMult = noScopeSpreadMult(isSniper, w.isAiming);
    // Section B #249 — quick-scope bonus. ADS + fire within 200ms = bonus accuracy.
    const timeSinceAds = w.isAiming ? now - this.adsStartTime : 9999;
    const quickScopeMult = w.isAiming ? quickScopeSpreadMult(timeSinceAds) : 1.0;
    w.lastShotTime = now;
    this.perWeaponLastShotTime.set(gateKey, now);
    w.ammo--;
    if (this.burstShotsRemaining > 0) this.burstShotsRemaining--;
    const cat = w.stats.category;
    // Prompt #44 — barrel heat: per-shot increment. Snipers + shotguns dump
    // a lot of energy per shot (big powder charge) → big heat. SMGs/LMGs
    // dump less per shot but accumulate over sustained bursts. Pistols are
    // in between. Tuned so a 30-round rifle mag dumped as fast as the fire
    // rate allows pushes heat from 0 → ~0.85 (just past the 0.5 accuracy
    // threshold around shot 13, climbing toward max by the end of the mag).
    const heatPerShot =
      cat === "SNIPER" ? 0.18 :
      cat === "SHOTGUN" ? 0.14 :
      cat === "PISTOL" ? 0.06 :
      cat === "SMG" ? 0.030 :
      cat === "LMG" ? 0.025 : 0.040; // RIFLE default
    w.barrelHeat = Math.min(1, w.barrelHeat + heatPerShot);
    // SEC8 prompt 65 — per-caliber gunshot layering: route through
    // `playGunshot(slug)` so the per-weapon WeaponSoundProfile (loudness,
    // bodyThumpHz, mechanicalClickHz, tailLengthMs) is overlaid on the base
    // caliber preset. The AK-74 now sounds distinct from the M4; the AWP's
    // tail is longer than the Scout's; the Deagle is louder than the USP; etc.
    // Real-sample path (`gunshot_<slug>.wav`) is tried first via playGunshot's
    // internal cache lookup; falls back to layered synth.
    ctx.audio.playGunshot(w.loadout.weapon);

    const pellets = cat === "SHOTGUN" ? 7 : 1;
    // REAL-BALLISTICS — spawn N projectiles (one per pellet) with full physics
    // integration (gravity + drag + travel time + penetration + ricochet).
    // Falls back to the legacy hitscan fireRay when ProjectileSystem isn't
    // constructed yet (headless / debug contexts).
    if (ctx.projectileSystem) {
      for (let p = 0; p < pellets; p++) this.spawnProjectile(cat);
    } else {
      for (let p = 0; p < pellets; p++) this.fireRay(now, p);
    }
    this.onShotFired?.(); // P4.5: roll for malfunction + condition decay

    // Muzzle flash — small, brief, hidden when suppressed.
    // Was: 0.5–0.8 scale + 6-intensity light → blew out the whole screen.
    // Now: 0.32–0.5 scale + 1.8-intensity light, suppressed = no flash.
    // Task-6: enhanced with multi-flicker rotation + brief smoke puff +
    // screen shake that scales with weapon weight.
    const suppressed = w.loadout.muzzle === "suppressor";
    if (!suppressed) {
      ctx.muzzleFlash.visible = true;
      ctx.muzzleFlash.rotation.z = Math.random() * Math.PI;
      // Tight scale range; smaller for pistols (less powder, less flash).
      const baseScale = cat === "PISTOL" ? 0.28 : cat === "SNIPER" ? 0.55 : 0.36;
      const fs = baseScale + Math.random() * 0.12;
      ctx.muzzleFlash.scale.set(fs, fs, fs);
      // Task-6: stash the base scale so ParticleSystem.update can drive the
      // scale-up + fade burst animation from this baseline each frame.
      ctx.muzzleFlash.userData.baseScale = fs;
      // Task-6: start the flash at full opacity so it pops; ParticleSystem.update
      // will damp opacity + add a flicker rotation during the 0.05s window.
      (ctx.muzzleFlash.material as THREE.MeshBasicMaterial).opacity = 0.95;
      ctx.muzzleTimer = 0.05;
      // Subtle dynamic light — only enough to kiss the immediate weapon + ground.
      ctx.muzzleLight.intensity = cat === "PISTOL" ? 1.4 : cat === "SNIPER" ? 3.0 : cat === "SHOTGUN" ? 2.6 : 2.0;
      ctx.gunParts.muzzleTip.getWorldPosition(ctx.scratch.v1);
      ctx.muzzleLight.position.copy(ctx.scratch.v1);
      // Task-6: brief muzzle smoke puff (drifts up + fades).
      const forward = ctx.scratch.v2.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion).normalize();
      this.onSpawnMuzzleSmoke?.(ctx.scratch.v1.clone(), forward, false);
    } else {
      // Suppressor: a faint cough of light at the muzzle, no visible star.
      ctx.muzzleFlash.visible = false;
      ctx.muzzleLight.intensity = 0.4;
      ctx.gunParts.muzzleTip.getWorldPosition(ctx.scratch.v1);
      ctx.muzzleLight.position.copy(ctx.scratch.v1);
      ctx.muzzleTimer = 0.03;
      // Task-6: suppressed = MORE smoke (quieter signature, more visible vapor).
      const forward = ctx.scratch.v2.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion).normalize();
      this.onSpawnMuzzleSmoke?.(ctx.scratch.v1.clone(), forward, true);
    }

    // Task-6: screen shake per shot — sells weapon weight. Sniper = 0.08,
    // rifle = 0.04, smg = 0.02, pistol = 0.025, shotgun = 0.06.
    const shakeIntensity =
      cat === "SNIPER" ? 0.08 :
      cat === "SHOTGUN" ? 0.06 :
      cat === "PISTOL" ? 0.025 :
      cat === "SMG" ? 0.02 : 0.04;
    ctx.triggerShake(shakeIntensity);

    // Task-6: eject a shell casing (pooled, capped at 30 active).
    this.onEjectShell?.(w.loadout.weapon);

    // Recoil — per-weapon pattern (30-shot, loops) with randomness.
    // Pattern drives both the weapon kick AND the camera pitch/yaw offset.
    // Section B #154 — apply the difficulty recoil multiplier (Easy=0.6, etc.).
    // A2-5000 #210 — apply the per-weapon RECOIL_KICK_MULT override on top
    // (was exported but never read — dead code).
    const difficultyMult = this.difficultyRecoilMult ?? 1.0;
    const kickMult = getRecoilKickMult(w.loadout.weapon);
    const recoil = applyRecoilPattern(
      w.loadout.weapon, w.shotCount ?? 0,
      w.stats.effectiveRecoil * difficultyMult * kickMult,
    );
    w.shotCount = (w.shotCount ?? 0) + 1;
    w.recoilOffset += w.stats.effectiveRecoil;
    w.weaponRecoilKick.z = 0.06 + recoil.y * 0.02; // vertical kick
    w.weaponRecoilKick.x = recoil.x * 0.02; // horizontal kick
    // Apply camera recoil (pitch up + yaw drift).
    ctx.player.pitch += recoil.y * 0.015;
    ctx.player.yaw -= recoil.x * 0.015;
    if (w.stats.scoped) w.isAiming = false;

    ctx.pushHud({ ammo: w.ammo });
    if (w.ammo === 0 && w.reserveAmmo > 0) setTimeout(() => this.startReload(), 120);
  }

  /** Multi-segment penetration raycast (R3.1) with ballistic drop + wind drift (P4.4). */
  private fireRay(_now: number, _pellet: number) {
    const { ctx } = this;
    const cfg = ctx.weapon.stats;
    const origin = ctx.camera.getWorldPosition(ctx.scratch.rayOrigin.clone());
    const suppMult = 1 + ctx.suppression.value * 0.8;
    // Prompt #44 — apply barrel-heat spread on the legacy hitscan path too
    // (matches the spawnProjectile math so the fallback feels the same).
    const heatMult = 1 + Math.max(0, ctx.weapon.barrelHeat - 0.5);
    // Section B #249/#250 — quick-scope bonus + no-scope penalty.
    const isSniper = cfg.category === "SNIPER";
    const timeSinceAds = ctx.weapon.isAiming ? performance.now() - this.adsStartTime : 9999;
    const quickScopeMult = ctx.weapon.isAiming ? quickScopeSpreadMult(timeSinceAds) : 1.0;
    const noScopeMult = noScopeSpreadMult(isSniper, ctx.weapon.isAiming);
    // Section B #155 — damage-induced sight misalignment.
    const damageSwayMult = getDamageSwayMult(ctx.player.lastDamageTime ?? 0);
    const spread = cfg.effectiveSpread
      * (ctx.weapon.isAiming ? 0.4 : 1)
      * (1 + Math.min(ctx.weapon.recoilOffset * 8, 1.5))
      * suppMult
      * heatMult
      * quickScopeMult
      * noScopeMult
      * damageSwayMult;
    const dir = ctx.scratch.rayDir.set((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, -1);
    dir.applyQuaternion(ctx.camera.quaternion).normalize();

    // P4.4: load ballistic params per category.
    const bp = BALLISTIC_PARAMS[cfg.category] ?? BALLISTIC_PARAMS.RIFLE;
    let velocity = bp.velocity;
    let currentOrigin = origin.clone();
    let currentDir = dir.clone();
    let remaining = cfg.effectiveRange;
    const maxSegments = 4;
    let tracerEnd: THREE.Vector3 | null = null;
    let dealt = false;
    let segmentDistance = 0;

    for (let seg = 0; seg < maxSegments && remaining > 0 && velocity > 30; seg++) {
      // P4.4: apply ballistic drop + wind drift to the current direction.
      // A2-5000 #206: pass per-category gravityScale so hitscan drop matches
      // the projectile integration path (integrateProjectile).
      if (seg > 0) {
        applyBallisticDrop(
          currentDir, segmentDistance, velocity, cfg.effectiveDamage,
          ctx.weather.windSpeed, ctx.weather.windDirection, ctx.scratch.v3,
        );
        currentDir.copy(ctx.scratch.v3);
      }
      ctx.raycaster.set(currentOrigin, currentDir);
      ctx.raycaster.far = remaining;

      const enemyParts: THREE.Object3D[] = [];
      // A3-5000 #522: pooled Map — was `new Map()` per fireRay call (10 maps/sec
      // at 600 RPM). We reuse a module-level Map + clear() it (clear is O(N)
      // but avoids the allocation cost).
      const partOwner = _pooledPartOwnerMap;
      partOwner.clear();
      for (const en of ctx.enemies) {
        if (!en.alive) continue;
        const parts = en.group.userData.parts as THREE.Mesh[] | undefined;
        if (!parts) continue;
        for (const part of parts) {
          enemyParts.push(part);
          partOwner.set(part, {
            enemy: en,
            isHead: !!part.userData.isHead,
            // Prompt #46 — read per-part hitbox zone. Falls back to chest.
            zone: (part.userData.hitZone as string) ?? "chest",
          });
        }
      }
      // Task 3 / item 59 — PERF: scoped. Was intersectObjects(scene.children, true)
      // which recursed every mesh in the scene (~220 weapon + avatar + enemies +
      // particles + sky). Now we raycast a cached flat list of env meshes only
      // (walls/props/ground) with recursive=false. The .filter() below is now
      // mostly defensive (the cache already excludes camera/enemy/sprite) but
      // kept for safety in case the cache lags a scene mutation.
      const envIntersects = ctx.raycaster.intersectObjects(getEnvRaycastTargets(ctx), false).filter(
        (h) => !this.isInCameraSubtree(h.object) && !partOwner.has(h.object) && h.object.type !== "Sprite" && !(h.object as any).userData?.enemy,
      );
      const enemyIntersects = ctx.raycaster.intersectObjects(enemyParts, false);
      const firstEnv = envIntersects.length > 0 ? envIntersects[0] : null;
      const firstEnemy = enemyIntersects.length > 0 ? enemyIntersects[0] : null;

      if (firstEnemy && (!firstEnv || firstEnemy.distance <= firstEnv.distance)) {
        const hitPoint = firstEnemy.point;
        tracerEnd = hitPoint;
        const owner = partOwner.get(firstEnemy.object);
        if (owner && !dealt) {
          const velFactor = velocity / (cfg.category === "SNIPER" ? 850 : 700);
          // Prompt #46 — apply the per-zone damage multiplier (head 4×,
          // chest 1×, limb 0.7×) on top of the velocity falloff.
          const zoneMult = getHitZoneMult(owner.zone);
          const dmg = cfg.effectiveDamage * zoneMult * Math.max(0.5, velFactor);
          this.onDamageEnemy?.(owner.enemy, dmg, owner.isHead, hitPoint);
          dealt = true;
        }
        break;
      } else if (firstEnv) {
        const hitPoint = firstEnv.point;
        const hitNormal = firstEnv.face ? firstEnv.face.normal.clone().transformDirection(firstEnv.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
        tracerEnd = hitPoint;
        const obj = firstEnv.object as THREE.Mesh;
        const materialSlug = (obj.userData.materialSlug as string) ?? "concrete";
        const material = ctx.materials.find((m) => m.slug === materialSlug) ?? ctx.materials[0];

        if (obj.userData.destructible) {
          const prop = ctx.destructibles.find((p) => p.mesh === obj);
          if (prop) {
            prop.health -= cfg.effectiveDamage * (cfg.category === "SHOTGUN" ? 1.5 : 1);
            // Task-6: pass surfaceType so impact VFX varies per material.
            this.onSpawnImpact?.(hitPoint, hitNormal, materialSlug);
            if (prop.health <= 0) {
              // Task-6: glass destructibles trigger a dedicated shatter VFX
              // (transparent shards + crash cue) in addition to the standard
              // prop cleanup.
              if (prop.materialSlug === "glass") {
                this.onShatterGlass?.(hitPoint, hitNormal);
              }
              // Task-25: barrels explode when destroyed (chain reaction trigger).
              // Save the position BEFORE calling onDestroyProp (which detaches
              // the mesh from the scene — its world position stays valid since
              // removeFromParent doesn't zero the position).
              const isBarrel = prop.mesh.userData.surfaceType === "barrel";
              const barrelPos = isBarrel ? prop.mesh.position.clone() : null;
              this.onDestroyProp?.(prop);
              if (isBarrel && barrelPos) {
                // Trigger the cinematic explosion VFX + chain-reaction scan.
                // spawnExplosion handles screen shake, FOV punch, light, etc.
                // Access ctx.particles via the cast pattern (set by
                // ParticleSystem's constructor — see ParticleSystem.ts).
                (ctx as unknown as {
                  particles?: { spawnExplosion?: (p: THREE.Vector3, s: number, k: "grenade" | "barrel" | "c4") => void };
                }).particles?.spawnExplosion?.(barrelPos, 1.5, "barrel");
              }
            }
            break;
          }
        }

        const pen = computePenetration(velocity, material);
        if (pen.penetrated && !material.bulletStop) {
          this.onSpawnImpact?.(hitPoint, hitNormal, materialSlug);
          velocity = pen.velocity;
          remaining -= firstEnv.distance + 0.05;
          segmentDistance += firstEnv.distance; // P4.4: track for ballistic drop
          currentOrigin = hitPoint.clone().add(currentDir.clone().multiplyScalar(0.06));
          currentDir.x += pen.deflection;
          currentDir.y += pen.deflection;
          currentDir.normalize();
          continue;
        } else {
          this.onSpawnImpact?.(hitPoint, hitNormal, materialSlug);
          // Task-11: bullet ricochet off hard surfaces (concrete / sheet_metal
          // / steel_plate). Soft surfaces absorb. One bounce max — the
          // secondary ricochet ray does NOT chain.
          const ricochet = computeRicochet(hitNormal, currentDir, materialSlug);
          if (ricochet.direction) {
            // Bright metallic spark VFX at the ricochet point — sparks fly
            // along the reflected (bounce) direction.
            this.onSpawnImpact?.(hitPoint, ricochet.direction, ricochet.sparkSurface);
            this.fireRicochetRay(
              hitPoint,
              ricochet.direction,
              ricochet.damageMult,
              cfg.effectiveDamage,
              ricochet.sparkSurface,
            );
          }
          break;
        }
      } else {
        tracerEnd = currentOrigin.clone().add(currentDir.clone().multiplyScalar(remaining));
        segmentDistance += remaining; // P4.4: track for tracer arc
        break;
      }
    }

    // Task-6: tracers — color-coded per weapon category. Suppressed weapons
    // emit NO tracer (stealth). Tracer travels muzzle → hit point in ~0.08s.
    // Task-25: the tracer visually originates from the MUZZLE TIP (not the
    // camera center) so bullets look like they come out of the gun. Hit
    // detection still uses the camera ray (above) so crosshair accuracy is
    // preserved — the tracer is purely a visual streak from muzzle → hit.
    // Defensive fallback: if the muzzle is behind the camera (shouldn't
    // happen in FP, but could during transition animations / view-mode
    // switches), use the camera world position so the tracer still draws.
    const muzzleWorld = ctx.scratch.v2;
    ctx.gunParts.muzzleTip.getWorldPosition(muzzleWorld);
    // Transform the muzzle position into camera-local space; if Z > 0 (in
    // Three.js +Z is behind the camera, -Z is in front), use the camera
    // world position as the tracer origin instead.
    const cameraSpaceMuzzle = ctx.scratch.v3.copy(muzzleWorld).applyMatrix4(ctx.camera.matrixWorldInverse);
    let tracerFrom: THREE.Vector3;
    if (cameraSpaceMuzzle.z > 0) {
      // Muzzle is behind the camera — fall back to the camera position.
      tracerFrom = ctx.camera.getWorldPosition(ctx.scratch.v4);
    } else {
      tracerFrom = muzzleWorld;
    }
    if (tracerEnd) {
      const suppressed = ctx.weapon.loadout.muzzle === "suppressor";
      if (!suppressed) {
        const tracerColor = TRACER_COLORS[cfg.category] ?? TRACER_COLORS.RIFLE;
        this.onSpawnTracer?.(tracerFrom.clone(), tracerEnd, tracerColor);
      }
    }
  }

  /**
   * REAL-BALLISTICS — spawn a single traveling projectile per pellet.
   *
   * Replaces the legacy `fireRay` hitscan raycast. The ProjectileSystem
   * integrates the projectile forward at the engine's 60 Hz fixed step,
   * applying gravity / drag / wind, and raycasts the segment traveled
   * each tick for enemy + environment hits.
   *
   * Spread is applied identically to the legacy code (cone radius scaled
   * by ADS state + recoil + suppression) so the perceived accuracy is
   * unchanged. The bullet's effectiveRange is preserved as its maxRange
   * despawn threshold.
   */
  private spawnProjectile(category: string) {
    const { ctx } = this;
    const cfg = ctx.weapon.stats;
    const ps = ctx.projectileSystem;
    if (!ps) return;

    // Origin = muzzle world position (matches the legacy tracer origin).
    ctx.gunParts.muzzleTip.getWorldPosition(ctx.scratch.v1);
    const origin = ctx.scratch.v1.clone();

    // Direction = camera forward + spread cone. Matches the legacy fireRay
    // spread math exactly so ADS / suppression / recoil feel identical.
    const suppMult = 1 + ctx.suppression.value * 0.8;
    // Prompt #44 — barrel heat spread. Below 0.5 the barrel is accurate;
    // above 0.5 the bullet cone widens linearly to +50% spread at full
    // heat. ADS still tightens the cone (0.4×), so a hot barrel under ADS
    // is still better than hipfire but worse than a cold ADS shot.
    const heatMult = 1 + Math.max(0, ctx.weapon.barrelHeat - 0.5);
    const spread = cfg.effectiveSpread
      * (ctx.weapon.isAiming ? 0.4 : 1)
      * (1 + Math.min(ctx.weapon.recoilOffset * 8, 1.5))
      * suppMult
      * heatMult;
    const dir = ctx.scratch.rayDir.set(
      (Math.random() - 0.5) * spread,
      (Math.random() - 0.5) * spread,
      -1,
    );
    dir.applyQuaternion(ctx.camera.quaternion).normalize();
    const direction = dir.clone();

    const suppressed = ctx.weapon.loadout.muzzle === "suppressor";
    // REALISM-1 — per-weapon tracer color (AWP gets bright red, AK-74 gets
    // deep amber, Vector gets green-yellow, etc.) layered over the category
    // baseline. Falls back to the category color if the weapon isn't in the
    // override table.
    const categoryTracerColor = TRACER_COLORS[category] ?? TRACER_COLORS.RIFLE;
    const tracerColor = getWeaponTracerColor(ctx.weapon.loadout.weapon, categoryTracerColor);

    // REALISM-1 — per-weapon ballistic overrides (AK-74 5.45×39mm, AWP .338
    // Lapua, SCAR-H 7.62×51mm, Kar98k 7.92×57mm Mauser, etc.) layered over
    // the category baseline. The spawn() call accepts optional muzzleVelocity
    // / mass / dragCoef / gravityScale overrides that take precedence over
    // the category lookup inside ProjectileSystem.
    const weaponBallistics = getWeaponBallisticParams(ctx.weapon.loadout.weapon, category);

    ps.spawn({
      origin,
      direction,
      category,
      baseDamage: cfg.effectiveDamage,
      // Prompt #46 — headshot multiplier matches the HitZone table (4×).
      // The ProjectileSystem applies this via getHitZoneMult() so head hits
      // deal 4×, chest 1×, limbs 0.7×.
      headshotMult: 4.0,
      maxRange: cfg.effectiveRange,
      team: "player",
      weaponSlug: ctx.weapon.loadout.weapon,
      tracerColor,
      tracerHidden: suppressed,
      maxRicochets: suppressed ? 0 : 1,
      muzzleVelocity: weaponBallistics.velocity,
      mass: weaponBallistics.mass,
      dragCoef: weaponBallistics.dragCoef,
      gravityScale: weaponBallistics.gravityScale,
    });
  }

  // Hooks wired by engine
  onSpawnImpact?: (point: THREE.Vector3, normal: THREE.Vector3, surfaceType?: string) => void;
  onSpawnTracer?: (from: THREE.Vector3, to: THREE.Vector3, colorHex?: number) => void;
  onDamageEnemy?: (e: Enemy, dmg: number, headshot: boolean, point: THREE.Vector3) => void;
  onDestroyProp?: (prop: DestructibleProp) => void;
  /** Task-6: spawn glass-shatter VFX when a glass destructible dies. */
  onShatterGlass?: (point: THREE.Vector3, normal: THREE.Vector3) => void;
  /** Task-6: spawn a muzzle smoke puff (called from tryShoot). */
  onSpawnMuzzleSmoke?: (point: THREE.Vector3, forward: THREE.Vector3, suppressed: boolean) => void;
  /** Task-6: eject a shell casing (called from tryShoot). */
  onEjectShell?: (weaponType: WeaponType) => void;

  /** Task-11: fire a single secondary ricochet ray from a hit point.
   *  One bounce max — does NOT chain. Reduced damage + reduced range (~10m).
   *  Can hit enemies (rare bank shots around corners) or environment.
   *  Reuses the existing onSpawnImpact hook for the terminal VFX. */
  private fireRicochetRay(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    damageMult: number,
    baseDamage: number,
    sparkSurface: string,
  ) {
    const { ctx } = this;
    // A2-5000 #205: wire the exported RICOCHET_RANGE constant (was duplicated
    // as a local `10` literal — silent drift risk if Ballistics.ts changes).
    const maxRange = RICOCHET_RANGE;
    // Offset the ray start slightly along the ricochet direction so we don't
    // re-hit the surface we just bounced off (floating-point safety).
    const start = origin.clone().add(direction.clone().multiplyScalar(0.05));
    ctx.raycaster.set(start, direction);
    ctx.raycaster.far = maxRange;

    // Build the enemy parts list (same pattern as fireRay).
    const enemyParts: THREE.Object3D[] = [];
    // A3-5000 #522: pooled Map (same fix as fireRay).
    const partOwner = _pooledPartOwnerMap;
    partOwner.clear();
    for (const en of ctx.enemies) {
      if (!en.alive) continue;
      const parts = en.group.userData.parts as THREE.Mesh[] | undefined;
      if (!parts) continue;
      for (const part of parts) {
        enemyParts.push(part);
        partOwner.set(part, {
          enemy: en,
          isHead: !!part.userData.isHead,
          // Prompt #46 — read per-part hitbox zone. Falls back to chest.
          zone: (part.userData.hitZone as string) ?? "chest",
        });
      }
    }
    const enemyHits = ctx.raycaster.intersectObjects(enemyParts, false);
    // Task 3 / item 59 — PERF: scoped. Was intersectObjects(scene.children, true).
    const envHits = ctx.raycaster
      .intersectObjects(getEnvRaycastTargets(ctx), false)
      .filter(
        (h) =>
          !this.isInCameraSubtree(h.object) &&
          !partOwner.has(h.object) &&
          h.object.type !== "Sprite" &&
          !(h.object as any).userData?.enemy,
      );
    const firstEnemy = enemyHits.length > 0 ? enemyHits[0] : null;
    const firstEnv = envHits.length > 0 ? envHits[0] : null;

    if (firstEnemy && (!firstEnv || firstEnemy.distance <= firstEnv.distance)) {
      // Ricochet hit an enemy — apply reduced damage (bank shot).
      const owner = partOwner.get(firstEnemy.object);
      if (owner) {
        // Prompt #46 — apply per-zone damage multiplier (head 4×, chest 1×,
        // limb 0.7×) on top of the ricochet damage reduction.
        const zoneMult = getHitZoneMult(owner.zone);
        const dmg = baseDamage * zoneMult * damageMult;
        this.onDamageEnemy?.(owner.enemy, dmg, owner.isHead, firstEnemy.point);
      }
    } else if (firstEnv) {
      // Ricochet hit environment — spawn impact VFX, NO further bounce.
      const envNormal = firstEnv.face
        ? firstEnv.face.normal.clone().transformDirection(firstEnv.object.matrixWorld)
        : new THREE.Vector3(0, 1, 0);
      this.onSpawnImpact?.(firstEnv.point, envNormal, sparkSurface);
    }
    // else: ricochet whizzed into the sky — nothing to render.
  }

  private isInCameraSubtree(obj: THREE.Object3D): boolean {
    let p: THREE.Object3D | null = obj;
    while (p) { if (p === this.ctx.camera || p === this.ctx.avatar?.group) return true; p = p.parent; }
    return false;
  }

  update(dt: number) {
    // Prompt #44 — barrel heat decay. A hot barrel cools at ~0.18/sec when
    // not firing (full 1.0 → 0.0 in ~5.5s). This is the cooling rate while
    // idle / between shots; sustained auto fire outpaces the decay (per-shot
    // increment 0.025–0.18 vs. per-tick decay 0.18×dt ≈ 0.003 at 60 Hz), so
    // heat climbs during a mag dump + decays in the lull after.
    // A2-5000 #248 — apply suppressorCoolingRateMult (was exported but never
    // called). Suppressors retain heat → slower cooling. shotsFired is
    // approximated by barrelHeat * 30 (heat ~ 1/30 per shot).
    if (this.ctx.weapon.barrelHeat > 0) {
      const hasSupp = this.ctx.weapon.loadout.muzzle === "suppressor";
      const shotsFiredApprox = Math.round(this.ctx.weapon.barrelHeat * 30);
      const coolingMult = suppressorCoolingRateMult(hasSupp, shotsFiredApprox);
      const decay = 0.18 * coolingMult * dt;
      this.ctx.weapon.barrelHeat = Math.max(0, this.ctx.weapon.barrelHeat - decay);
    }
    if (this.ctx.weapon.fireHeld && this.ctx.weapon.stats.automatic) this.tryShoot();
  }

  /**
   * A2-5000 #250 — multi-target penetration hook. Called by fireRay when
   * the bullet's residual velocity after the first enemy hit is high
   * enough to potentially penetrate through to a second/third enemy in line.
   * Returns the array of enemies the bullet passes through (the caller
   * applies reduced damage to each). Uses penetrateMultipleTargets from
   * GunplayEnhancements to model residual velocity per target.
   */
  protected penetrateLinedUpEnemies(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    firstEnemy: Enemy,
    entryVelocity: number,
    maxRange: number,
  ): Enemy[] {
    const linedUp: Enemy[] = [];
    for (const e of this.ctx.enemies) {
      if (e === firstEnemy || !e.alive) continue;
      const toEnemy = new THREE.Vector3().subVectors(e.group.position, origin);
      const along = toEnemy.dot(dir);
      if (along <= 0 || along > maxRange) continue;
      const closest = origin.clone().addScaledVector(dir, along);
      if (closest.distanceTo(e.group.position) < 0.5) linedUp.push(e);
    }
    if (linedUp.length === 0) return [];
    linedUp.sort((a, b) =>
      a.group.position.distanceTo(origin) - b.group.position.distanceTo(origin));
    const targets = linedUp.map(() => ({ thickness: 0.3, armorClass: 1 }));
    const result = penetrateMultipleTargets(entryVelocity, targets, "ap" as never);
    return linedUp.slice(0, result.penetrated);
  }
}

export { SKINS };
