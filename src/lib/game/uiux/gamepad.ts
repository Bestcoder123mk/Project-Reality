/**
 * SEC10-UIUX (prompt 79): Full gamepad support via the Gamepad API.
 *
 * Real gamepad input path using `navigator.getGamepads()`. Polls the
 * first connected gamepad each frame, returns normalized stick + trigger
 * values + button states. The InputSystem can read these alongside the
 * keyboard/mouse state and dispatch to the same actions.
 *
 * Includes a configurable aim-assist magnetism that's NOT aimbot-strong:
 *   - Only applies when using a gamepad (mouse/kb users get nothing).
 *   - Only pulls the crosshair toward an enemy within a small radius.
 *   - The pull strength scales with proximity (stronger near the edge
 *     of the radius, weakest at the center) and is capped.
 *   - Configurable per-player via setAimAssistStrength(level).
 *
 * Standard Xbox/PS layout mapping:
 *   - Left stick → movement (WASD equivalent)
 *   - Right stick → look (mouse equivalent)
 *   - LT/L2 → ADS    RT/R2 → fire
 *   - LB/L1 → prev weapon   RB/R1 → next weapon
 *   - A/Cross → jump   B/Circle → crouch
 *   - X/Square → reload   Y/Triangle → melee
 *   - D-pad → slot 1-4 / medical items
 *   - Start/Options → pause   Back/Share → map
 *
 * Public API:
 *   - isGamepadConnected()
 *   - pollGamepad() → GamepadSnapshot | null
 *   - getAimAssistConfig()
 *   - setAimAssistStrength(level)
 *   - mapGamepadToActions(snapshot) → action → boolean/number map
 *
 * SSR-safe: server-side calls return null/false safely.
 */

export interface GamepadSnapshot {
  /** Index from navigator.getGamepads()[index]. */
  index: number;
  /** Gamepad id string (vendor + product). */
  id: string;
  /** Left stick X/Y in [-1, 1]. Deadzone applied. */
  leftStickX: number;
  leftStickY: number;
  /** Right stick X/Y in [-1, 1]. Deadzone applied. */
  rightStickX: number;
  rightStickY: number;
  /** Left trigger (LT/L2) in [0, 1]. */
  leftTrigger: number;
  /** Right trigger (RT/R2) in [0, 1]. */
  rightTrigger: number;
  /** Button states (17 buttons per standard mapping). True = pressed. */
  buttons: boolean[];
  /** D-pad direction as one of 8 compass points + neutral. */
  dpad: "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw" | "neutral";
  /** Timestamp of the snapshot (performance.now()). */
  time: number;
}

// ─── Standard button indices (W3C Gamepad spec) ────────────────────────────

export const GAMEPAD_BUTTONS = {
  A: 0,         // Cross on PlayStation
  B: 1,         // Circle
  X: 2,         // Square
  Y: 3,         // Triangle
  LB: 4,        // L1
  RB: 5,        // R1
  LT: 6,        // L2 (also exposed as trigger)
  RT: 7,        // R2
  BACK: 8,      // Share
  START: 9,     // Options
  L_STICK: 10,  // Left stick click
  R_STICK: 11,  // Right stick click
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  HOME: 16,     // PS button / Xbox logo
} as const;

export const GAMEPAD_STICKS = {
  LEFT_X: 0,
  LEFT_Y: 1,
  RIGHT_X: 2,
  RIGHT_Y: 3,
} as const;

const STICK_DEADZONE = 0.12;     // radial deadzone — eliminates stick drift
const TRIGGER_THRESHOLD = 0.05;  // below this, trigger is "released"

/**
 * SEC10-UIUX (prompt 79): Is a gamepad currently connected?
 * SSR-safe — returns false on the server.
 */
export function isGamepadConnected(): boolean {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return false;
  const pads = navigator.getGamepads();
  for (const p of pads) {
    if (p && p.connected) return true;
  }
  return false;
}

/**
 * Prompt J-4005 — gamepad-ACTIVE detection (vs gamepad-CONNECTED).
 *
 * A connected-but-idle gamepad (e.g. the player set the controller down
 * to use mouse + keyboard) previously still received full aim-assist,
 * which read as "mysterious crosshair pull" on mouse-driven headshots.
 *
 * `isGamepadActive()` returns true only when:
 *   1. a gamepad is connected, AND
 *   2. any stick has moved past the deadzone, OR any button/trigger has
 *      been pressed, within the last `GAMEPAD_ACTIVE_TIMEOUT_MS` ms.
 *
 * Aim-assist should gate on this (see `computeAimAssistPull` below —
 * it early-outs when the gamepad is idle).
 */
export const GAMEPAD_ACTIVE_TIMEOUT_MS = 4_000;
let lastGamepadInputAt = 0;

/** Mark "user just used the gamepad" — call from the InputSystem's
 *  gamepad poll loop whenever a stick or button is non-trivially active. */
export function markGamepadInput(): void {
  lastGamepadInputAt = Date.now();
}

export function isGamepadActive(): boolean {
  if (!isGamepadConnected()) return false;
  if (lastGamepadInputAt === 0) return false;
  return Date.now() - lastGamepadInputAt < GAMEPAD_ACTIVE_TIMEOUT_MS;
}

/**
 * Prompt J-4004 / J-4017 / J-4094 / J-4183 — Steam Input detection.
 *
 * Steam Input is Valve's controller API that remaps any controller
 * (Xbox, PS, Switch, generic) into a "standard" mapping when running
 * through the Steam overlay. The W3C Gamepad API exposes this in two
 * places:
 *   1. `Gamepad.mapping === "standard"` — set by Steam Input for any
 *      controller it has remapped to the standard layout.
 *   2. `Gamepad.id` — Steam-prefixed IDs typically contain "Steam"
 *      or the vendor/product ID 0x28DE (Valve Corp).
 *
 * When Steam Input is active, the engine should trust Steam's
 * button-mapping (which the player can rebind in the Steam overlay)
 * rather than apply its own per-platform layout. Returns false when
 * no gamepad is connected or when the connected gamepad isn't flowing
 * through Steam.
 */
export function isSteamInputActive(): boolean {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return false;
  const pads = navigator.getGamepads();
  for (const p of pads) {
    if (!p || !p.connected) continue;
    // (1) Standard-mapping flag — Steam Input always sets this.
    if (p.mapping === "standard") {
      // (2) Confirm it's actually Steam by sniffing the id for the
      //     Steam/Vavle vendor substring. Valve's USB vendor ID is
      //     0x28DE; Steam Deck controllers also surface "Steam" in
      //     the id string. This guards against non-Steam standard
      //     gamepads (Xbox controller on ChromeOS, etc.).
      const id = p.id.toLowerCase();
      if (id.includes("steam") || id.includes("valve") || id.includes("0x28de")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Apply a radial deadzone to a stick axis pair. Values inside the
 * deadzone are snapped to zero; values outside are rescaled to the
 * remaining range [0, 1] so the stick still reaches full deflection.
 */
function applyDeadzone(x: number, y: number, deadzone: number): { x: number; y: number } {
  const mag = Math.sqrt(x * x + y * y);
  if (mag <= deadzone) return { x: 0, y: 0 };
  const rescaled = (mag - deadzone) / (1 - deadzone);
  const scale = rescaled / mag;
  return { x: x * scale, y: y * scale };
}

function dpadFromButtons(buttons: boolean[]): GamepadSnapshot["dpad"] {
  const up = buttons[GAMEPAD_BUTTONS.DPAD_UP];
  const down = buttons[GAMEPAD_BUTTONS.DPAD_DOWN];
  const left = buttons[GAMEPAD_BUTTONS.DPAD_LEFT];
  const right = buttons[GAMEPAD_BUTTONS.DPAD_RIGHT];
  if (up && right) return "ne";
  if (up && left) return "nw";
  if (down && right) return "se";
  if (down && left) return "sw";
  if (up) return "n";
  if (down) return "s";
  if (left) return "w";
  if (right) return "e";
  return "neutral";
}

/**
 * SEC10-UIUX (prompt 79): Poll the active gamepad. Returns a normalized
 * snapshot or null if no gamepad is connected.
 *
 * The "active" gamepad is the first connected one in the gamepads array.
 * Multi-gamepad support (local couch co-op) would extend this with an
 * index parameter; for now single-player is enough.
 *
 * @param index Optional gamepad index (defaults to the first connected).
 */
export function pollGamepad(index?: number): GamepadSnapshot | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  let pad: (typeof pads)[number] = null;
  if (index !== undefined) {
    pad = pads[index] ?? null;
  } else {
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
  }
  if (!pad) return null;

  const ls = applyDeadzone(
    pad.axes[GAMEPAD_STICKS.LEFT_X] ?? 0,
    pad.axes[GAMEPAD_STICKS.LEFT_Y] ?? 0,
    STICK_DEADZONE,
  );
  const rs = applyDeadzone(
    pad.axes[GAMEPAD_STICKS.RIGHT_X] ?? 0,
    pad.axes[GAMEPAD_STICKS.RIGHT_Y] ?? 0,
    STICK_DEADZONE,
  );

  const buttons = pad.buttons.map((b) => b.pressed);
  // Triggers (buttons 6 and 7 in the standard mapping) — also expose as analog value.
  const leftTrigger = pad.buttons[GAMEPAD_BUTTONS.LT]?.value ?? 0;
  const rightTrigger = pad.buttons[GAMEPAD_BUTTONS.RT]?.value ?? 0;

  return {
    index: pad.index,
    id: pad.id,
    leftStickX: ls.x,
    leftStickY: ls.y,
    rightStickX: rs.x,
    rightStickY: rs.y,
    leftTrigger: leftTrigger > TRIGGER_THRESHOLD ? leftTrigger : 0,
    rightTrigger: rightTrigger > TRIGGER_THRESHOLD ? rightTrigger : 0,
    buttons,
    dpad: dpadFromButtons(buttons),
    time: typeof performance !== "undefined" ? performance.now() : Date.now(),
  };
}

// ─── Aim-assist (magnetism, NOT aimbot) ─────────────────────────────────────

/**
 * Aim-assist is a console-style "stickiness" that nudges the player's
 * aim toward a nearby enemy when using a gamepad. It is NOT an aimbot:
 *   - Only triggers when an enemy is within the magnetism radius.
 *   - The pull is proportional to (1 - normalizedDistance) — strongest
 *     at the edge, weakest at the center. This produces a "sticky"
 *     feel without ever snapping the crosshair onto the target.
 *   - Maximum pull is capped (MAX_ASSIST_PER_FRAME) so even at full
 *     proximity the crosshair can't be dragged off-target.
 *   - Disabled entirely for mouse/keyboard users (only fires when the
 *     InputSystem reports gamepad as the active input source).
 */
export interface AimAssistConfig {
  /** 0..1 — strength multiplier (0 = off, 1 = max magnetism). */
  strength: number;
  /** Radius in screen-space pixels around the crosshair within which an enemy is "magnetic". */
  radius: number;
  /** Maximum pull per frame in normalized screen units. Caps the assist so it can't snap. */
  maxPullPerFrame: number;
  /** Whether to apply a slowdown to the right-stick when the crosshair is over an enemy (additional console feel). */
  slowdownEnabled: boolean;
  /** Slowdown factor (0.5 = 50% speed). Only applied when slowdownEnabled is true. */
  slowdownFactor: number;
}

const DEFAULT_AIM_ASSIST: AimAssistConfig = {
  strength: 0.6,           // tuned for "console-feel" — distinct from aimbot
  radius: 90,              // 90px radius — about 1/20 of a 1080p screen
  maxPullPerFrame: 0.012,  // ~1.2% of screen per frame max — slow drift, not snap
  slowdownEnabled: true,
  slowdownFactor: 0.65,    // right-stick slows to 65% when over an enemy
};

let aimAssist: AimAssistConfig = { ...DEFAULT_AIM_ASSIST };
const AIM_ASSIST_STORAGE_KEY = "pr_aim_assist_v1";

function loadAimAssist(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(AIM_ASSIST_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AimAssistConfig>;
      aimAssist = { ...DEFAULT_AIM_ASSIST, ...parsed };
    }
  } catch {
    /* ignore */
  }
}

function saveAimAssist(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(AIM_ASSIST_STORAGE_KEY, JSON.stringify(aimAssist));
  } catch {
    /* ignore */
  }
}

loadAimAssist();

/** SEC10-UIUX (prompt 79): Get the current aim-assist config (a copy). */
export function getAimAssistConfig(): AimAssistConfig {
  return { ...aimAssist };
}

/**
 * SEC10-UIUX (prompt 79): Set the aim-assist strength level.
 *
 * @param level 0..1 — 0 disables aim-assist entirely; 1 sets it to the
 * maximum design-tuned strength. Other config fields (radius, max pull)
 * scale linearly with level so the player perceives a smooth intensity
 * change, not a binary on/off.
 *
 * Persists to localStorage.
 */
export function setAimAssistStrength(level: number): void {
  const clamped = Math.max(0, Math.min(1, level));
  aimAssist = {
    ...DEFAULT_AIM_ASSIST,
    strength: clamped,
    radius: DEFAULT_AIM_ASSIST.radius * (0.4 + 0.6 * clamped), // 40% radius at level 0 → 100% at level 1
    maxPullPerFrame: DEFAULT_AIM_ASSIST.maxPullPerFrame * clamped,
    slowdownEnabled: clamped > 0,
    slowdownFactor: 1 - (1 - DEFAULT_AIM_ASSIST.slowdownFactor) * clamped,
  };
  saveAimAssist();
}

/**
 * SEC10-UIUX (prompt 79): Compute the aim-assist pull vector for a
 * single frame given the crosshair position and the nearest enemy
 * position (both in screen-space pixels relative to screen center).
 *
 * Returns a {x, y} delta in normalized screen units that the InputSystem
 * should add to the right-stick look delta. Returns {x:0, y:0} if
 * aim-assist is disabled or the enemy is outside the radius.
 *
 * Pure function — does not touch the gamepad or the InputSystem state.
 * The InputSystem calls this with the camera-projected enemy position
 * each frame.
 *
 * @param crosshairScreen {x,y} crosshair position in screen px (relative to screen center)
 * @param enemyScreen    {x,y} nearest enemy position in screen px (relative to screen center)
 * @param aimActive      Whether the player is currently ADS-ing (assist is stronger when ADS)
 */
export function computeAimAssistPull(
  crosshairScreen: { x: number; y: number },
  enemyScreen: { x: number; y: number },
  aimActive: boolean,
): { x: number; y: number } {
  if (aimAssist.strength <= 0) return { x: 0, y: 0 };
  // Prompt J-4005 — gate aim-assist on gamepad-ACTIVE (not just connected).
  // An idle gamepad (set down for mouse+keyboard) gets zero pull so it
  // can't bleed into mouse-driven shots. The InputSystem calls
  // markGamepadInput() each frame a stick/button is non-trivially active.
  if (!isGamepadActive()) return { x: 0, y: 0 };
  const dx = enemyScreen.x - crosshairScreen.x;
  const dy = enemyScreen.y - crosshairScreen.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > aimAssist.radius) return { x: 0, y: 0 };
  if (dist < 0.001) return { x: 0, y: 0 };
  // Proximity factor — strongest at the edge (dist → radius), weakest at center.
  // Using (1 - dist/radius) so the pull is gentle when the crosshair is
  // already on target, and stronger as the target drifts to the edge.
  const proximity = 1 - dist / aimAssist.radius;
  // Scale by 0.5 in hipfire, 1.0 in ADS (console aim-assist typically
  // only kicks in when aiming).
  const adsMult = aimActive ? 1.0 : 0.5;
  const pull = proximity * aimAssist.maxPullPerFrame * adsMult * aimAssist.strength;
  // Cap the pull — never snap.
  const cappedPull = Math.min(pull, aimAssist.maxPullPerFrame);
  return {
    x: (dx / dist) * cappedPull,
    y: (dy / dist) * cappedPull,
  };
}

/**
 * SEC10-UIUX (prompt 79): Compute the right-stick slowdown multiplier
 * to apply when the crosshair is over (or near) an enemy.
 *
 * Returns 1.0 if slowdown is disabled. Otherwise returns a value in
 * [slowdownFactor, 1.0] depending on proximity to the enemy.
 */
export function computeAimAssistSlowdown(
  crosshairScreen: { x: number; y: number },
  enemyScreen: { x: number; y: number },
): number {
  if (!aimAssist.slowdownEnabled) return 1.0;
  // Prompt J-4005 — slowdown also gated on gamepad-ACTIVE so a set-down
  // controller can't freeze the player's mouse look.
  if (!isGamepadActive()) return 1.0;
  const dx = enemyScreen.x - crosshairScreen.x;
  const dy = enemyScreen.y - crosshairScreen.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > aimAssist.radius * 0.5) return 1.0; // slowdown only kicks in the inner half
  const proximity = 1 - dist / (aimAssist.radius * 0.5);
  // Lerp from 1.0 (no slowdown at edge) to slowdownFactor (full slowdown at center).
  return 1.0 - (1.0 - aimAssist.slowdownFactor) * proximity * aimAssist.strength;
}

// ─── Gamepad → action mapping ──────────────────────────────────────────────

/**
 * A normalized action map produced from a gamepad snapshot. The
 * InputSystem can consume this the same way it consumes keyboard/mouse
 * state — action → pressed (boolean) or analog value (number 0..1).
 */
export interface GamepadActionMap {
  // Analog sticks
  moveX: number;       // -1 (left) .. 1 (right)
  moveY: number;       // -1 (forward) .. 1 (backward)
  lookX: number;       // -1 (left) .. 1 (right) — already pre-scaled by sensitivity
  lookY: number;       // -1 (up) .. 1 (down)
  // Triggers (analog 0..1)
  ads: number;         // left trigger
  fire: number;        // right trigger
  // Discrete actions (true while held)
  jump: boolean;
  crouch: boolean;
  sprint: boolean;     // left stick click
  reload: boolean;
  melee: boolean;
  weaponNext: boolean; // RB
  weaponPrev: boolean; // LB
  slot1: boolean;      // dpad up
  slot2: boolean;      // dpad right
  slot3: boolean;      // dpad down
  slot4: boolean;      // dpad left
  bandage: boolean;    // X (held) — same as reload on some layouts, but we co-bind
  medkit: boolean;     // Y (held) — same as melee on some layouts
  pause: boolean;      // start
}

/**
 * SEC10-UIUX (prompt 79): Map a gamepad snapshot to the engine's
 * action vocabulary. The InputSystem reads this each frame alongside
 * the keyboard/mouse state and dispatches to the same action handlers.
 *
 * `sensitivity` is the look-sensitivity multiplier; right-stick values
 * are pre-scaled by it so the InputSystem doesn't need to know whether
 * input came from a mouse or a stick.
 */
export function mapGamepadToActions(
  snap: GamepadSnapshot,
  sensitivity: number = 1.0,
): GamepadActionMap {
  return {
    moveX: snap.leftStickX,
    moveY: snap.leftStickY,
    lookX: snap.rightStickX * sensitivity,
    lookY: snap.rightStickY * sensitivity,
    ads: snap.leftTrigger,
    fire: snap.rightTrigger,
    jump: snap.buttons[GAMEPAD_BUTTONS.A],
    crouch: snap.buttons[GAMEPAD_BUTTONS.B],
    sprint: snap.buttons[GAMEPAD_BUTTONS.L_STICK],
    reload: snap.buttons[GAMEPAD_BUTTONS.X],
    melee: snap.buttons[GAMEPAD_BUTTONS.Y],
    weaponNext: snap.buttons[GAMEPAD_BUTTONS.RB],
    weaponPrev: snap.buttons[GAMEPAD_BUTTONS.LB],
    slot1: snap.dpad === "n" || snap.dpad === "ne" || snap.dpad === "nw",
    slot2: snap.dpad === "e" || snap.dpad === "ne" || snap.dpad === "se",
    slot3: snap.dpad === "s" || snap.dpad === "se" || snap.dpad === "sw",
    slot4: snap.dpad === "w" || snap.dpad === "nw" || snap.dpad === "sw",
    bandage: false, // X is shared with reload — bound to reload by default
    medkit: false,  // Y is shared with melee
    pause: snap.buttons[GAMEPAD_BUTTONS.START],
  };
}
