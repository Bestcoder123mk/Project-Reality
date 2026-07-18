import type { GameSystem, GameContext } from "./types";
import { useGameStore, type WeaponType } from "../store";
import { canSprint } from "./StaminaSystem";
import { track } from "@/lib/analytics";

/**
 * InputSystem — owns keyboard + mouse state, pointer lock, wheel.
 * Translates raw input into context.keys + weapon/fire/aim flags.
 * Action routing (reload, medical, radio, view toggle, weapon cycle) lives here.
 *
 * Note: this system does not own the actual game logic for those actions;
 * it delegates to other systems via the context (set on engine wiring).
 */
export class InputSystem implements GameSystem {
  private boundResize: () => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundLockChange: () => void;
  private boundContext: (e: Event) => void;

  /** Prompt A#2 — pointer-lock engage telemetry. `attempts` counts
   *  requestPointerLock() calls made since the last successful engage;
   *  `engageStartT` is the timestamp of the first attempt in this cycle.
   *  On a successful lock (onLockChange with locked=true), emit a
   *  `pointer_lock_engage` event with attempts + latencyMs. */
  private _lockAttempts = 0;
  private _lockEngageStartT = 0;

  // Callbacks wired by engine after construction.
  onReload?: () => void;
  onToggleView?: () => void;
  onCycleWeapon?: (dir: number) => void;
  onUseMedical?: (slug: string) => void;
  onRadioMacro?: (type: string) => void;
  onToggleWeatherCycle?: () => void;
  onTryShoot?: () => void;
  /** P4.6: melee slash (default key F). */
  onMeleeSlash?: () => void;
  /** Grenade throw (default key G) — wind-up + release. */
  onGrenadeThrow?: () => void;
  /** V5.4 — Deploy recon-drone killstreak reward (moved to F5 per Prompt 8). */
  onDeployRecon?: () => void;
  /** V5.4 — Deploy airstrike killstreak reward (moved to F6 per Prompt 8). */
  onDeployAirstrike?: () => void;
  /** Prompt 8: direct slot selection (Digit1-4 → primary/secondary/melee/utility). */
  onSelectSlot?: (slot: 0 | 1 | 2 | 3) => void;

  constructor(private ctx: GameContext) {
    this.boundResize = () => this.onResize();
    this.boundKeyDown = (e) => this.onKeyDown(e);
    this.boundKeyUp = (e) => this.onKeyUp(e);
    this.boundMouseMove = (e) => this.onMouseMove(e);
    this.boundMouseDown = (e) => this.onMouseDown(e);
    this.boundMouseUp = (e) => this.onMouseUp(e);
    this.boundWheel = (e) => this.onWheel(e);
    this.boundLockChange = () => this.onLockChange();
    this.boundContext = (e) => e.preventDefault();

    window.addEventListener("resize", this.boundResize);
    window.addEventListener("keydown", this.boundKeyDown);
    window.addEventListener("keyup", this.boundKeyUp);
    document.addEventListener("mousemove", this.boundMouseMove);
    document.addEventListener("mousedown", this.boundMouseDown);
    document.addEventListener("mouseup", this.boundMouseUp);
    document.addEventListener("wheel", this.boundWheel, { passive: false });
    document.addEventListener("pointerlockchange", this.boundLockChange);
    this.ctx.renderer.domElement.addEventListener("contextmenu", this.boundContext);
  }

  private onResize() {
    // Delegate to RendererSystem via shared callback
    this.onResizeCb?.();
  }
  onResizeCb?: () => void;

  private onKeyDown(e: KeyboardEvent) {
    this.ctx.keys[e.code] = true;
    if (e.code === "KeyR") this.onReload?.();
    if (e.code === "KeyV") this.onToggleView?.();
    if (e.code === "KeyQ") this.onCycleWeapon?.(-1);
    if (e.code === "KeyE") this.onCycleWeapon?.(1);
    if (e.code === "KeyH") this.onUseMedical?.("bandage");
    if (e.code === "KeyJ") this.onUseMedical?.("splint");
    if (e.code === "KeyK") this.onUseMedical?.("medkit");
    if (e.code === "KeyL") this.onUseMedical?.("epi");
    if (e.code === "KeyZ") this.onRadioMacro?.("contact");
    if (e.code === "KeyX") this.onRadioMacro?.("need_medic");
    if (e.code === "KeyC" && e.ctrlKey) this.onRadioMacro?.("need_ammo");
    if (e.code === "F1") this.onToggleWeatherCycle?.();
    if (e.code === "KeyF") this.onMeleeSlash?.(); // P4.6
    if (e.code === "KeyG") { this.onGrenadeThrow?.(); }
    // Weapon inspect — dedicated key (Y) to show off attachments/skins.
    if (e.code === "KeyY") { this.ctx.weapon.inspectAnim = 2.0; }
    // Task-8: lean left/right is now hold-based (BracketLeft / BracketRight).
    // PhysicsSystem reads keys["BracketLeft"] / ["BracketRight"] every frame
    // and drives a smoothed lean target (slower + smaller in ADS for corner
    // peeking). No keydown-side state mutation needed here.

    // Task-8: slide — pressing crouch (Ctrl or C) WHILE sprinting forward on
    // ground triggers a slide burst. Skip when Ctrl is held with KeyC (that's
    // the radio macro on Ctrl+C).
    //
    // Task-14: dolphin dive — pressing crouch WHILE sprinting forward + airborne
    // triggers a forward dive (COD-style). Mutually exclusive with slide:
    // slide = crouch+sprint+ground; dive = crouch+sprint+airborne. Also skipped
    // while on a ladder (ladder disables sprint/slide/dive).
    if (e.code === "ControlLeft" || (e.code === "KeyC" && !e.ctrlKey)) {
      const p = this.ctx.player;
      if (p.onLadder) {
        // No slide/dive on ladders — movement is handled by tryLadder.
      } else if (
        !p.sliding &&
        !p.diving &&
        !p.crouching &&
        p.onGround &&
        this.ctx.keys["ShiftLeft"] &&
        this.ctx.keys["KeyW"] &&
        canSprint(this.ctx.stamina)
      ) {
        // Slide — sprinting forward on ground.
        p.sliding = true;
        p.slideTime = 0;
      } else if (
        !p.diving &&
        !p.sliding &&
        !p.onGround &&
        this.ctx.keys["ShiftLeft"] &&
        this.ctx.keys["KeyW"] &&
        canSprint(this.ctx.stamina)
      ) {
        // Dolphin dive — sprinting forward airborne.
        // The actual launch impulse is applied on the first updateDive frame
        // (PhysicsSystem) so we have a fresh forward vector from the yaw.
        p.diving = true;
        p.diveTime = 0;
        p.divePhase = "air";
      }
    }
    // Prompt 8 — Direct slot selection: Digit1-4 → primary/secondary/melee/utility.
    // Killstreak deploy keys moved from Digit4/5 to F5/F6 to avoid the conflict.
    if (e.code === "Digit1") this.onSelectSlot?.(0);
    else if (e.code === "Digit2") this.onSelectSlot?.(1);
    else if (e.code === "Digit3") this.onSelectSlot?.(2);
    else if (e.code === "Digit4") this.onSelectSlot?.(3);
    else if (e.code === "F5") this.onDeployRecon?.();
    else if (e.code === "F6") this.onDeployAirstrike?.();
    if (e.code === "Escape") { if (document.pointerLockElement) this.ctx.exitPointerLock(); }
  }

  private onKeyUp(e: KeyboardEvent) { this.ctx.keys[e.code] = false; }

  private onMouseMove(e: MouseEvent) {
    if (!this.ctx.isPointerLocked()) return;
    if (this.ctx.paused || this.ctx.match.matchOver) return;
    const { sensitivity } = this.ctx.settings;
    const w = this.ctx.weapon;
    // ADS sensitivity: when aiming, multiply by the user-configured aimSensitivity
    // (0.2..1.0). This makes tracking targets while scoped feel controlled.
    const aimMult = w.isAiming ? (this.ctx.settings.extended?.aimSensitivity ?? 0.5) : 1;
    const sens = (sensitivity * 0.0022 * aimMult) / (w.isAiming ? w.stats.effectiveZoom : 1);
    this.ctx.player.yaw -= e.movementX * sens;
    this.ctx.player.pitch -= e.movementY * sens;
    const limit = Math.PI / 2 - 0.05;
    this.ctx.player.pitch = Math.max(-limit, Math.min(limit, this.ctx.player.pitch));
  }

  private onMouseDown(e: MouseEvent) {
    const { ctx } = this;
    if (!ctx.isPointerLocked()) {
      ctx.audio.resume();
      if (!ctx.match.matchOver) {
        // Prompt A#2 — count attempts for telemetry.
        const now = performance.now();
        if (this._lockAttempts === 0) this._lockEngageStartT = now;
        this._lockAttempts++;
        ctx.requestPointerLock();
      }
      return;
    }
    if (e.button === 0) { ctx.weapon.fireHeld = true; this.onTryShoot?.(); }
    else if (e.button === 2) {
      // ADS mode: "hold" (default) or "toggle" (configurable in settings).
      const mode = ctx.settings.extended?.adsMode ?? "hold";
      if (mode === "toggle") ctx.weapon.isAiming = !ctx.weapon.isAiming;
      else ctx.weapon.isAiming = true;
    }
  }

  private onMouseUp(e: MouseEvent) {
    if (e.button === 0) this.ctx.weapon.fireHeld = false;
    else if (e.button === 2) {
      // Only release on hold mode (toggle mode persists until next right-click).
      const mode = this.ctx.settings.extended?.adsMode ?? "hold";
      if (mode === "hold") this.ctx.weapon.isAiming = false;
    }
  }

  private onWheel(e: WheelEvent) {
    if (!this.ctx.isPointerLocked()) return;
    e.preventDefault();
    this.onCycleWeapon?.(e.deltaY > 0 ? 1 : -1);
  }

  private onLockChange() {
    const locked = document.pointerLockElement === this.ctx.renderer.domElement;
    this.ctx.onPointerLockChange(locked);
    // Prompt A#2 — emit telemetry on successful engage.
    if (locked && this._lockAttempts > 0) {
      const latencyMs = Math.round(performance.now() - this._lockEngageStartT);
      try {
        track("pointer_lock_engage", {
          attempts: this._lockAttempts,
          latencyMs,
          // Retry rate > 0 means at least one extra click was needed —
          // the dashboard query groups by attempts>1 to compute the retry
          // rate trending to 0 (per acceptance criterion).
          retry: this._lockAttempts > 1 ? 1 : 0,
        });
      } catch {
        // Analytics is best-effort — never break the lock flow.
      }
      this._lockAttempts = 0;
      this._lockEngageStartT = 0;
    }
  }

  update(_dt: number) {
    // No per-frame work — input is event-driven.
  }

  dispose() {
    window.removeEventListener("resize", this.boundResize);
    window.removeEventListener("keydown", this.boundKeyDown);
    window.removeEventListener("keyup", this.boundKeyUp);
    document.removeEventListener("mousemove", this.boundMouseMove);
    document.removeEventListener("mousedown", this.boundMouseDown);
    document.removeEventListener("mouseup", this.boundMouseUp);
    document.removeEventListener("wheel", this.boundWheel);
    document.removeEventListener("pointerlockchange", this.boundLockChange);
    this.ctx.renderer.domElement.removeEventListener("contextmenu", this.boundContext);
  }
}

// Re-export WeaponType for callers wiring the cycle callback
export type { WeaponType };
export { useGameStore };
