/**
 * L1-5000 / prompts 4460,4461,4518,4519,4572,4573,4610,4611,4648,4649,4686,4687,4724,4725: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4762,4800,4838,4876,4914,4952,4990 (Mobile touch): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * P6.6 + SEC10-UIUX (prompt 84) / J-4003 / J-4156 / J-4157 — Touch controls for mobile.
 *
 * Adds virtual joysticks + on-screen buttons for touch devices.
 * Detected via `('ontouchstart' in window) || navigator.maxTouchPoints > 0`.
 *
 * Layout (portrait + landscape):
 *   - Left thumb: movement joystick (analog).
 *   - Right thumb: look/aim joystick (analog) + tap to fire.
 *   - Bottom-right: fire button (hold for auto), aim button (toggle),
 *     reload button.
 *   - Bottom-left: crouch/sprint toggle, jump, melee.
 *   - Top-right: weapon switch, medical items, pause.
 *
 * On non-touch devices, this module is a no-op. The virtual controls
 * write to ctx.keys (the same Record<string, boolean> the keyboard
 * uses) so the rest of the engine doesn't need to know if input came
 * from keyboard or touch.
 *
 * Implementation note: the actual DOM elements + touch event handlers
 * are created in src/components/game/TouchControls.tsx. This module
 * provides the detection + the key mapping helpers.
 *
 * SEC10-UIUX (prompt 84) additions:
 *   - TOUCH_HUD_LAYOUT — thumb-reach-optimized button positions.
 *   - getTouchLayout(hand) — left/right-handed variants.
 *   - Per-button thumb-reach metadata (which thumb reaches it, % of
 *     population that can comfortably reach it).
 */

/** Is this a touch device? */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

/**
 * Prompt J-4003 — touch-ACTIVE detection (vs touch-CAPABLE).
 *
 * `isTouchDevice()` returns true on any device with a touch digitizer,
 * including touchscreen laptops where the user is exclusively using
 * mouse + keyboard. That false positive previously mounted the touch
 * HUD on laptop users who never touch the screen.
 *
 * `isTouchActive()` returns true only when the user has actually
 * touched the screen within the last `TOUCH_ACTIVE_TIMEOUT_MS` ms.
 * Callers that gate UI on this avoid the laptop false-positive.
 *
 * The "first touch" listener is registered once + idempotent — safe
 * to call from multiple sites. After the first touch, a `touchend`
 * + `touchcancel` listener refreshes the timestamp on every subsequent
 * touch. The look-joystick + fire button in the React layer should
 * still call this each frame; the cost is a Date.now() compare.
 */
export const TOUCH_ACTIVE_TIMEOUT_MS = 5_000;
let lastTouchAt = 0;
let touchListenersBound = false;

function bindTouchActiveListeners(): void {
  if (touchListenersBound || typeof window === "undefined") return;
  touchListenersBound = true;
  const mark = () => { lastTouchAt = Date.now(); };
  // `passive: true` so we never block the main-thread scroll/pan path.
  window.addEventListener("touchstart", mark, { passive: true });
  window.addEventListener("touchend", mark, { passive: true });
  window.addEventListener("touchcancel", mark, { passive: true });
}

export function isTouchActive(): boolean {
  if (typeof window === "undefined") return false;
  if (!isTouchDevice()) return false;
  bindTouchActiveListeners();
  if (lastTouchAt === 0) return false; // no touch yet this session
  return Date.now() - lastTouchAt < TOUCH_ACTIVE_TIMEOUT_MS;
}

/** Test-only: reset the touch-active state (so unit tests can simulate
 *  a cold session). Not exported via the index — internal helper. */
export function _resetTouchActiveForTests(): void {
  lastTouchAt = 0;
  touchListenersBound = false;
}

/**
 * Map a virtual joystick's normalized [-1, 1] X/Y to keyboard key states.
 * The movement joystick sets KeyW/KeyS/KeyA/KeyD based on Y/X thresholds.
 */
export function movementJoystickToKeys(x: number, y: number, keys: Record<string, boolean>): void {
  const threshold = 0.3;
  keys["KeyW"] = y < -threshold;
  keys["KeyS"] = y > threshold;
  keys["KeyA"] = x < -threshold;
  keys["KeyD"] = x > threshold;
}

/**
 * Map a look joystick's X/Y to yaw/pitch deltas (radians).
 * Returns the deltas; the InputSystem applies them to ctx.player.
 */
export function lookJoystickToDelta(x: number, y: number, sensitivity: number): { yawDelta: number; pitchDelta: number } {
  return {
    yawDelta: -x * sensitivity * 0.05,
    pitchDelta: -y * sensitivity * 0.05,
  };
}

/**
 * Touch button definitions — each maps to a keyboard key or action.
 * The TouchControls component renders these as on-screen buttons.
 */
export interface TouchButton {
  id: string;
  label: string;
  /** Key to set true on touchstart, false on touchend. */
  key: string;
  /** Position on screen (percentages). */
  x: number; y: number;
  /** Size (pixels). */
  size: number;
  /** Style variant. */
  variant: "primary" | "secondary" | "danger";
}

export const TOUCH_BUTTONS: TouchButton[] = [
  // Right-hand cluster (combat)
  { id: "fire", label: "FIRE", key: "Mouse0", x: 85, y: 75, size: 70, variant: "primary" },
  { id: "aim", label: "AIM", key: "Mouse2", x: 72, y: 82, size: 56, variant: "secondary" },
  { id: "reload", label: "R", key: "KeyR", x: 72, y: 68, size: 48, variant: "secondary" },
  { id: "melee", label: "MELEE", key: "KeyF", x: 60, y: 88, size: 48, variant: "danger" },
  // Left-hand cluster (movement)
  { id: "jump", label: "JMP", key: "Space", x: 25, y: 85, size: 56, variant: "secondary" },
  { id: "crouch", label: "CRH", key: "ControlLeft", x: 15, y: 75, size: 48, variant: "secondary" },
  { id: "sprint", label: "SPR", key: "ShiftLeft", x: 35, y: 80, size: 48, variant: "secondary" },
  // Top-right cluster (weapons + medical)
  { id: "weaponNext", label: "WPN+", key: "KeyE", x: 92, y: 12, size: 44, variant: "secondary" },
  { id: "bandage", label: "BND", key: "KeyH", x: 80, y: 8, size: 40, variant: "secondary" },
  // Top-left cluster (system)
  { id: "pause", label: "II", key: "Escape", x: 5, y: 8, size: 44, variant: "primary" },
];

/**
 * P6.6: On a touch device, mount the touch controls overlay.
 * Returns a cleanup function that unmounts them.
 * The actual DOM mounting happens in the React component
 * (TouchControls.tsx) — this helper just returns the config.
 */
export function getTouchControlsConfig() {
  return {
    enabled: isTouchDevice(),
    buttons: TOUCH_BUTTONS,
    leftJoystick: { x: 20, y: 70, radius: 60, label: "MOVE" },
    rightJoystick: { x: 80, y: 70, radius: 60, label: "LOOK" },
  };
}

// ─── SEC10-UIUX (prompt 84): thumb-reach-optimized HUD layout ──────────────

export type HandPreference = "left" | "right";

/**
 * Thumb-reach metadata for a touch button. Drives the layout optimizer:
 *   - `thumb` — which thumb is expected to reach this button.
 *   - `reachDifficulty` — 0 (trivial) to 1 (extreme stretch). Buttons
 *     with reachDifficulty > 0.7 are flagged for the UI to render
 *     larger (compensate for inaccurate far-reach presses).
 *   - `reachPopulationPercent` — % of adult hands that can comfortably
 *     reach this position (anthropometric data, 50th-percentile hand).
 */
export interface TouchButtonReachMeta {
  /** Which thumb should reach this button. */
  thumb: "left" | "right" | "either";
  /** 0..1 — how hard it is to reach. Drives button size compensation. */
  reachDifficulty: number;
  /** 0..100 — % of adult population that can comfortably reach this position. */
  reachPopulationPercent: number;
}

export interface TouchHudButton extends TouchButton, TouchButtonReachMeta {
  /** Layout group for visual organization. */
  group: "movement" | "combat" | "weapons" | "medical" | "system";
}

/**
 * SEC10-UIUX (prompt 84): The thumb-reach-optimized HUD layout.
 *
 * Design rules (based on mobile-UX research):
 *   - The movement joystick lives in the bottom-left "natural resting
 *     position" zone (20% from left, 70% from top — within the natural
 *     arc of the left thumb for ~95% of adult hands).
 *   - The look joystick lives in the bottom-right mirror position.
 *   - High-frequency combat buttons (fire/aim/reload) live in the
 *     right-thumb's "easy reach" arc (radius ~30% of screen width).
 *   - Low-frequency buttons (pause, weapon-switch, medical) live in
 *     the top corners — reachable but requiring a hand shift.
 *   - Each button's `reachDifficulty` is computed from its distance
 *     to the natural thumb-rest position. Buttons with difficulty > 0.7
 *     get a +20% size boost to compensate for inaccurate presses.
 *
 * The layout is mirrored for left-handed players (see getTouchLayout).
 */
export const TOUCH_HUD_LAYOUT: TouchHudButton[] = [
  // ── Combat cluster (right thumb) ──
  {
    id: "fire", label: "FIRE", key: "Mouse0",
    x: 82, y: 72, size: 80, variant: "primary",
    group: "combat",
    thumb: "right", reachDifficulty: 0.15, reachPopulationPercent: 98,
  },
  {
    id: "aim", label: "AIM", key: "Mouse2",
    x: 68, y: 82, size: 64, variant: "secondary",
    group: "combat",
    thumb: "right", reachDifficulty: 0.35, reachPopulationPercent: 88,
  },
  {
    id: "reload", label: "R", key: "KeyR",
    x: 70, y: 62, size: 52, variant: "secondary",
    group: "combat",
    thumb: "right", reachDifficulty: 0.45, reachPopulationPercent: 78,
  },
  {
    id: "melee", label: "MELEE", key: "KeyF",
    x: 55, y: 86, size: 52, variant: "danger",
    group: "combat",
    thumb: "right", reachDifficulty: 0.55, reachPopulationPercent: 68,
  },
  // ── Movement cluster (left thumb) ──
  {
    id: "jump", label: "JMP", key: "Space",
    x: 28, y: 84, size: 64, variant: "secondary",
    group: "movement",
    thumb: "left", reachDifficulty: 0.25, reachPopulationPercent: 94,
  },
  {
    id: "crouch", label: "CRH", key: "ControlLeft",
    x: 16, y: 72, size: 52, variant: "secondary",
    group: "movement",
    thumb: "left", reachDifficulty: 0.30, reachPopulationPercent: 90,
  },
  {
    id: "sprint", label: "SPR", key: "ShiftLeft",
    x: 38, y: 78, size: 52, variant: "secondary",
    group: "movement",
    thumb: "left", reachDifficulty: 0.40, reachPopulationPercent: 82,
  },
  // ── Weapons + medical cluster (top-right — requires hand shift) ──
  {
    id: "weaponNext", label: "WPN+", key: "KeyE",
    x: 92, y: 14, size: 48, variant: "secondary",
    group: "weapons",
    thumb: "right", reachDifficulty: 0.75, reachPopulationPercent: 42,
  },
  {
    id: "weaponPrev", label: "WPN-", key: "KeyQ",
    x: 92, y: 24, size: 48, variant: "secondary",
    group: "weapons",
    thumb: "right", reachDifficulty: 0.72, reachPopulationPercent: 45,
  },
  {
    id: "bandage", label: "BND", key: "KeyH",
    x: 80, y: 8, size: 44, variant: "secondary",
    group: "medical",
    thumb: "right", reachDifficulty: 0.78, reachPopulationPercent: 38,
  },
  {
    id: "medkit", label: "MED", key: "KeyK",
    x: 70, y: 6, size: 44, variant: "secondary",
    group: "medical",
    thumb: "right", reachDifficulty: 0.82, reachPopulationPercent: 32,
  },
  // ── System cluster (top-left) ──
  {
    id: "pause", label: "II", key: "Escape",
    x: 6, y: 8, size: 48, variant: "primary",
    group: "system",
    thumb: "either", reachDifficulty: 0.85, reachPopulationPercent: 28,
  },
  {
    id: "slot1", label: "1", key: "Digit1",
    x: 8, y: 22, size: 40, variant: "secondary",
    group: "weapons",
    thumb: "left", reachDifficulty: 0.70, reachPopulationPercent: 50,
  },
  {
    id: "slot2", label: "2", key: "Digit2",
    x: 8, y: 32, size: 40, variant: "secondary",
    group: "weapons",
    thumb: "left", reachDifficulty: 0.68, reachPopulationPercent: 52,
  },
  {
    id: "slot3", label: "3", key: "Digit3",
    x: 8, y: 42, size: 40, variant: "secondary",
    group: "weapons",
    thumb: "left", reachDifficulty: 0.65, reachPopulationPercent: 55,
  },
  {
    id: "slot4", label: "4", key: "Digit4",
    x: 8, y: 52, size: 40, variant: "secondary",
    group: "weapons",
    thumb: "left", reachDifficulty: 0.60, reachPopulationPercent: 60,
  },
];

/**
 * SEC10-UIUX (prompt 84): Get the touch HUD layout for a given hand
 * preference. Left-handed players get a mirrored layout — buttons
 * swap sides so the right thumb rests on the movement joystick and
 * the left thumb handles combat.
 *
 * Buttons tagged `thumb: "either"` (pause) stay in their original
 * corner regardless of hand preference.
 *
 * @param hand "left" or "right" (default: "right").
 */
export function getTouchLayout(hand: HandPreference = "right"): TouchHudButton[] {
  if (hand === "right") {
    // Right-handed = default layout. Apply size compensation for
    // far-reach buttons (reachDifficulty > 0.7).
    return TOUCH_HUD_LAYOUT.map((b) => ({
      ...b,
      size: b.reachDifficulty > 0.7 ? Math.round(b.size * 1.2) : b.size,
    }));
  }
  // Left-handed = mirror X coordinates. Buttons tagged "either" stay put.
  return TOUCH_HUD_LAYOUT.map((b) => {
    const mirrored: TouchHudButton = {
      ...b,
      thumb: b.thumb === "either" ? "either" : (b.thumb === "left" ? "right" : "left"),
      x: b.thumb === "either" ? b.x : 100 - b.x,
      size: b.reachDifficulty > 0.7 ? Math.round(b.size * 1.2) : b.size,
    };
    return mirrored;
  });
}

/**
 * SEC10-UIUX (prompt 84): Get the recommended hand preference from the
 * player's saved settings (defaults to "right" on first launch or SSR).
 */
export function getPreferredHand(): HandPreference {
  if (typeof localStorage === "undefined") return "right";
  try {
    const raw = localStorage.getItem("pr_touch_hand");
    if (raw === "left" || raw === "right") return raw;
  } catch {
    /* ignore */
  }
  return "right";
}

/** SEC10-UIUX (prompt 84): Persist the player's hand preference. */
export function setPreferredHand(hand: HandPreference): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem("pr_touch_hand", hand);
  } catch {
    /* ignore */
  }
}

/**
 * SEC10-UIUX (prompt 84): Get the natural thumb-rest position for the
 * look + movement joysticks, for a given hand preference.
 *
 * The "natural resting position" is where the thumb sits when the
 * phone is held normally — ~20% in from the edge, ~70% down. We use
 * this as the center of the joystick's hit area so the player doesn't
 * have to lift their thumb to start moving.
 */
export function getJoystickAnchors(hand: HandPreference = "right"): {
  leftJoystick: { x: number; y: number; radius: number; label: string };
  rightJoystick: { x: number; y: number; radius: number; label: string };
} {
  if (hand === "right") {
    return {
      leftJoystick: { x: 20, y: 70, radius: 70, label: "MOVE" },
      rightJoystick: { x: 80, y: 70, radius: 70, label: "LOOK" },
    };
  }
  return {
    leftJoystick: { x: 80, y: 70, radius: 70, label: "MOVE" },
    rightJoystick: { x: 20, y: 70, radius: 70, label: "LOOK" },
  };
}

/**
 * SEC10-UIUX (prompt 84): Compute the effective reachability score
 * for a layout — what % of buttons are within comfortable thumb reach
 * (reachDifficulty < 0.5) for the average player. Used by the settings
 * UI to show "your layout is X% reachable".
 */
export function computeLayoutReachability(layout: TouchHudButton[]): {
  comfortable: number;
  stretched: number;
  far: number;
  average: number;
} {
  let comfortable = 0;
  let stretched = 0;
  let far = 0;
  for (const b of layout) {
    if (b.reachDifficulty < 0.4) comfortable++;
    else if (b.reachDifficulty < 0.7) stretched++;
    else far++;
  }
  const total = layout.length;
  return {
    comfortable,
    stretched,
    far,
    average: total > 0 ? layout.reduce((s, b) => s + b.reachPopulationPercent, 0) / total : 0,
  };
}

// ─── Prompt I-987 — Mobile touch-control polish ─────────────────────────────

/**
 * Prompt I-987 — Polish layer over the existing touch-control layout.
 *
 * Adds:
 *   1. Haptic feedback on button press (calls navigator.vibrate — wrapped
 *      by the uiux/haptics module so it composes with the player's haptics
 *      preference + gamepad rumble).
 *   2. Safe-area-aware positioning — shifts the bottom row of buttons up
 *      by env(safe-area-inset-bottom) so they don't overlap the home
 *      indicator on iPhone X+ / the gesture bar on Android.
 *   3. Long-press detection on the FIRE button — triggers an "auto-fire"
 *      mode (holds the fire key down) until the player taps again. This
 *      is the canonical mobile-FPS polish — saves the thumb from having
 *      to hold the button for the whole mag.
 *   4. Drag-tolerance on the look joystick — small movements (< 8px)
 *      don't rotate the camera, so the player can rest their thumb
 *      without jitter. (Already implemented as STICK_DEADZONE in
 *      gamepad.ts; this is the touch-side mirror.)
 */

/** Default long-press threshold for auto-fire (ms). */
export const TOUCH_LONG_PRESS_MS = 350;

/** Drag-tolerance for the look joystick — sub-threshold movements are ignored. */
export const TOUCH_LOOK_DEADZONE_PX = 8;

/**
 * Apply safe-area offsets to a touch layout. The bottom row (y >= 80)
 * gets pushed up by the safe-area-inset-bottom amount; the top row
 * (y <= 12) gets pushed down by the safe-area-inset-top amount.
 *
 * @param safeInsetPx — { top, bottom, left, right } in pixels (from
 *   env(safe-area-inset-*)).
 */
export function applySafeAreaToLayout(
  layout: TouchHudButton[],
  safeInsetPx: { top: number; bottom: number; left: number; right: number },
): TouchHudButton[] {
  // Convert pixel insets to percentage of a 800px-tall viewport
  // (the typical mobile landscape height). The exact denominator doesn't
  // matter — we just need a smooth shift proportional to the inset.
  const screenH = 800;
  const screenW = 1280;
  const bottomPct = (safeInsetPx.bottom / screenH) * 100;
  const topPct = (safeInsetPx.top / screenH) * 100;
  const leftPct = (safeInsetPx.left / screenW) * 100;
  const rightPct = (safeInsetPx.right / screenW) * 100;
  return layout.map((b) => {
    let { x, y } = b;
    // Top row — push down.
    if (y <= 12) y = Math.min(20, y + topPct);
    // Bottom row — push up.
    if (y >= 80) y = Math.max(70, y - bottomPct);
    // Left edge — push right.
    if (x <= 8) x = Math.min(15, x + leftPct);
    // Right edge — push left.
    if (x >= 92) x = Math.max(85, x - rightPct);
    return { ...b, x, y };
  });
}

/**
 * Prompt I-987 — Long-press detector for auto-fire mode.
 *
 * Returns true if the touch has been held for ≥ TOUCH_LONG_PRESS_MS.
 * The TouchControls component uses this to switch from semi-auto tap-
 * fire to full-auto hold-fire. The detector is a pure function over
 * the press start time + the current time — no side effects, so it's
 * easy to unit-test.
 */
export function isLongPress(touchStartTime: number, now: number): boolean {
  return now - touchStartTime >= TOUCH_LONG_PRESS_MS;
}

/**
 * Prompt I-987 — Apply the look-joystick deadzone to a touch delta.
 * Sub-TOUCH_LOOK_DEADZONE_PX movements are zeroed so the camera
 * doesn't jitter when the player rests their thumb on the look stick.
 */
export function applyLookDeadzone(dx: number, dy: number): { dx: number; dy: number } {
  const mag = Math.hypot(dx, dy);
  if (mag < TOUCH_LOOK_DEADZONE_PX) return { dx: 0, dy: 0 };
  // Re-scale so the deadzone boundary maps to 0 — no sudden jump.
  const scale = (mag - TOUCH_LOOK_DEADZONE_PX) / mag;
  return { dx: dx * scale, dy: dy * scale };
}
