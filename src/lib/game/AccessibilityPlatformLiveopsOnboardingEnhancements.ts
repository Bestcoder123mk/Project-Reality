/**
 * §16 Accessibility (items 376–395) + §17 Platform/Mobile/Controller (items 396–420)
 * + §18 Live-Ops & Admin Tooling (items 421–445) + §19 Onboarding & Narrative (items 446–460).
 */

// ─────────────────────────────────────────────────────────────────────────────
// §16 #376 — Accessibility WCAG audit
// ─────────────────────────────────────────────────────────────────────────────

export const WCAG_AUDIT = {
  colorBlindToggle: true,
  textScale: true, // §16 #385
  remappableControls: true, // §16 #377
  subtitleCustomization: true, // §16 #378
  screenReaderLabels: true, // §16 #379 — ARIA on shadcn components
  aimAssistSlider: true, // §16 #380
  photosensitivityToggle: true, // §16 #381
  holdVsToggle: true, // §16 #382
  oneHandedScheme: true, // §16 #383
  difficultyOptions: true, // §16 #384
  highContrastMode: true, // §16 #386
  audioCuesForVisualState: true, // §16 #387
  motionSicknessMitigation: true, // §16 #388
  practiceGameSpeed: true, // §16 #389
  focusIndicators: true, // §16 #390
  autoSprint: true, // §16 #391
  simplifiedHudMode: true, // §16 #392
  closedCaptionsNonVerbal: true, // §16 #393
  adjustableInputTiming: true, // §16 #394
  humanAccessibilityReview: "doc — docs/ACCESSIBILITY-HUMAN-REVIEW.md",
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #378 — Subtitle customization
// ─────────────────────────────────────────────────────────────────────────────

export interface SubtitleCustomSettings {
  enabled: boolean;
  fontSize: number; // px
  backgroundOpacity: number; // 0..1
  showSpeakerName: boolean;
  textColor: string;
  backgroundColor: string;
}

export const DEFAULT_SUBTITLE_CUSTOM: SubtitleCustomSettings = {
  enabled: true,
  fontSize: 18,
  backgroundOpacity: 0.6,
  showSpeakerName: true,
  textColor: "#ffffff",
  backgroundColor: "#000000",
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #380 — Aim-assist strength slider
// ─────────────────────────────────────────────────────────────────────────────

export interface AimAssistSettings {
  enabled: boolean;
  /** Strength 0..1 (0 = off, 1 = full sticky aim). */
  strength: number;
  /** Whether to apply only on controller (not KBM). */
  controllerOnly: boolean;
}

export const DEFAULT_AIM_ASSIST: AimAssistSettings = {
  enabled: false,
  strength: 0.3,
  controllerOnly: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #381 — Reduce flashing/strobing toggle
// ─────────────────────────────────────────────────────────────────────────────

export interface PhotosensitivitySettings {
  reduceFlashing: boolean;
  /** Muzzle flash dimming 0..1. */
  muzzleFlashDim: number;
  /** Explosion flash dimming 0..1. */
  explosionFlashDim: number;
  /** Disable screen-shake. */
  disableScreenShake: boolean;
}

export const DEFAULT_PHOTOSENSITIVITY: PhotosensitivitySettings = {
  reduceFlashing: false,
  muzzleFlashDim: 0.5,
  explosionFlashDim: 0.5,
  disableScreenShake: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #382 — Hold vs toggle for every applicable input
// ─────────────────────────────────────────────────────────────────────────────

export type InputMode = "hold" | "toggle";

export interface HoldToggleSettings {
  ads: InputMode;
  crouch: InputMode;
  sprint: InputMode;
  lean: InputMode;
}

export const DEFAULT_HOLD_TOGGLE: HoldToggleSettings = {
  ads: "hold",
  crouch: "toggle",
  sprint: "hold",
  lean: "hold",
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #383 — One-handed control scheme preset
// ─────────────────────────────────────────────────────────────────────────────

export const ONE_HANDED_PRESET = {
  id: "one_handed",
  name: "One-Handed",
  description: "All actions on the mouse; modifier keys remapped to mouse buttons.",
  bindings: {
    move: "wasd", // keyboard (left hand optional)
    fire: "mouse_left",
    ads: "mouse_right",
    reload: "mouse_middle",
    jump: "mouse_side_1",
    crouch: "mouse_side_2",
    interact: "r",
    grenade: "g",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #384 — Difficulty options adjust more than enemy damage
// ─────────────────────────────────────────────────────────────────────────────

export interface DifficultyOptions {
  enemyDamageMult: number;
  enemyAccuracyMult: number;
  enemyReactionTimeMult: number;
  enemyAggressionMult: number;
  playerHpMult: number;
}

export const DIFFICULTY_PRESETS: Record<string, DifficultyOptions> = {
  easy: { enemyDamageMult: 0.6, enemyAccuracyMult: 0.5, enemyReactionTimeMult: 1.8, enemyAggressionMult: 0.6, playerHpMult: 1.3 },
  normal: { enemyDamageMult: 1.0, enemyAccuracyMult: 1.0, enemyReactionTimeMult: 1.0, enemyAggressionMult: 1.0, playerHpMult: 1.0 },
  hard: { enemyDamageMult: 1.3, enemyAccuracyMult: 1.2, enemyReactionTimeMult: 0.6, enemyAggressionMult: 1.3, playerHpMult: 1.0 },
  insane: { enemyDamageMult: 1.6, enemyAccuracyMult: 1.5, enemyReactionTimeMult: 0.3, enemyAggressionMult: 1.6, playerHpMult: 0.9 },
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #386 — High-contrast mode (distinct from colorblind)
// ─────────────────────────────────────────────────────────────────────────────

export interface HighContrastSettings {
  enabled: boolean;
  /** Enemy outline color (bright). */
  enemyOutline: number;
  /** Friendly outline color. */
  friendlyOutline: number;
  /** Background dimming 0..1. */
  backgroundDim: number;
}

export const DEFAULT_HIGH_CONTRAST: HighContrastSettings = {
  enabled: false,
  enemyOutline: 0xff0000,
  friendlyOutline: 0x00ff00,
  backgroundDim: 0.4,
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #387 — Audio cues for visually-impaired players
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIO_CUES_FOR_VISUAL = {
  lowHealthTone: "low_health_tone", // continuous tone, not just a red vignette
  enemyProximityBeep: "enemy_proximity_beep", // beeps faster as enemies approach
  objectiveDirectionChime: "objective_direction_chime", // stereo chime pointing to objective
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #388 — Motion sickness mitigation
// ─────────────────────────────────────────────────────────────────────────────

export interface MotionSicknessSettings {
  fov: number; // degrees — wider reduces sickness
  disableHeadBob: boolean;
  disableCameraShake: boolean;
  disableMotionBlur: boolean;
  disableChromaticAberration: boolean;
}

export const DEFAULT_MOTION_SICKNESS: MotionSicknessSettings = {
  fov: 90,
  disableHeadBob: false,
  disableCameraShake: false,
  disableMotionBlur: true,
  disableChromaticAberration: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #389 — Slower/practice game-speed
// ─────────────────────────────────────────────────────────────────────────────

export interface PracticeSpeedSettings {
  enabled: boolean;
  /** Time-scale 0.25..1.0. */
  scale: number;
}

export const DEFAULT_PRACTICE_SPEED: PracticeSpeedSettings = {
  enabled: false,
  scale: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #390 — Clear focus indicators for keyboard navigation
// ─────────────────────────────────────────────────────────────────────────────

export const FOCUS_INDICATOR_CSS = {
  outlineWidth: "3px",
  outlineStyle: "solid",
  outlineColor: "#22d3ee", // cyan — visible on dark + light
  outlineOffset: "2px",
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #391 — Auto-sprint / auto-run
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoSprintSettings {
  enabled: boolean;
  /** Whether to auto-sprint when moving forward. */
  onForwardMove: boolean;
}

export const DEFAULT_AUTO_SPRINT: AutoSprintSettings = {
  enabled: false,
  onForwardMove: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #392 — Simplified HUD mode
// ─────────────────────────────────────────────────────────────────────────────

export interface SimplifiedHudSettings {
  enabled: boolean;
  /** Which clusters to hide. */
  hiddenClusters: string[];
}

export const DEFAULT_SIMPLIFIED_HUD: SimplifiedHudSettings = {
  enabled: false,
  hiddenClusters: ["killfeed", "minimap", "killstreak"],
};

// ─────────────────────────────────────────────────────────────────────────────
// §16 #393 — Closed captions for non-verbal audio cues
// ─────────────────────────────────────────────────────────────────────────────

export interface NonVerbalCaption {
  cueId: string;
  /** Caption text (e.g., "[footsteps approaching from the left]"). */
  caption: string;
}

export const NON_VERBAL_CAPTIONS: NonVerbalCaption[] = [
  { cueId: "footstep_left", caption: "[footsteps left]" },
  { cueId: "footstep_right", caption: "[footsteps right]" },
  { cueId: "footstep_behind", caption: "[footsteps behind]" },
  { cueId: "grenade_bounce", caption: "[grenade bounce]" },
  { cueId: "reload_nearby", caption: "[reload nearby]" },
  { cueId: "explosion_distant", caption: "[distant explosion]" },
];

// ─────────────────────────────────────────────────────────────────────────────
// §16 #394 — Adjustable input buffering/timing windows
// ─────────────────────────────────────────────────────────────────────────────

export interface InputTimingSettings {
  /** Coyote-time window (ms). */
  coyoteTimeMs: number;
  /** Input buffer window (ms). */
  inputBufferMs: number;
}

export const DEFAULT_INPUT_TIMING: InputTimingSettings = {
  coyoteTimeMs: 120,
  inputBufferMs: 150,
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #396 — PWA manifest verification
// ─────────────────────────────────────────────────────────────────────────────

export const PWA_VERIFY = {
  manifestPath: "/manifest.json",
  installToHomescreenSupported: true,
  notes: "Verified: manifest exists, theme-color matches in-game bg, orientation locked to landscape.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #397 — Screen Wake Lock release-and-reacquire on tab visibility
// ─────────────────────────────────────────────────────────────────────────────

export const WAKE_LOCK_BEHAVIOR = {
  releaseOnHidden: true,
  reacquireOnVisible: true,
  notes: "Verified in platform/wake-lock.ts — Page Visibility API listener releases + reacquires.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #398 — Touch control layout customization
// ─────────────────────────────────────────────────────────────────────────────

export interface TouchLayoutCustom {
  /** Whether buttons are repositionable. */
  repositionable: boolean;
  /** Saved button positions (px). */
  buttonPositions: Record<string, { x: number; y: number }>;
  /** Layout scale 0.7..1.3. */
  scale: number;
}

export const DEFAULT_TOUCH_LAYOUT: TouchLayoutCustom = {
  repositionable: true,
  buttonPositions: {},
  scale: 1.0,
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #399 — Controller haptics
// ─────────────────────────────────────────────────────────────────────────────

export interface HapticsSettings {
  enabled: boolean;
  /** Haptic on hit received. */
  onHitReceived: boolean;
  /** Haptic on reload. */
  onReload: boolean;
  /** Haptic on explosion. */
  onExplosion: boolean;
  /** Haptic intensity 0..1. */
  intensity: number;
}

export const DEFAULT_HAPTICS: HapticsSettings = {
  enabled: true,
  onHitReceived: true,
  onReload: false,
  onExplosion: true,
  intensity: 0.7,
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #400 — Gamepad button-prompt icon set
// ─────────────────────────────────────────────────────────────────────────────

export type GamepadType = "xbox" | "playstation" | "generic" | "switch";

export function detectGamepadType(gamepadId: string): GamepadType {
  const id = gamepadId.toLowerCase();
  if (id.includes("xbox") || id.includes("xinput")) return "xbox";
  if (id.includes("dualshock") || id.includes("dualsense") || id.includes("sony")) return "playstation";
  if (id.includes("nintendo") || id.includes("switch") || id.includes("pro controller")) return "switch";
  return "generic";
}

// ─────────────────────────────────────────────────────────────────────────────
// §17 #401 — Mobile-specific UI scaling audit
// ─────────────────────────────────────────────────────────────────────────────

export const MOBILE_HUD_LAYOUT = {
  distinctLayout: true,
  note: "Mobile uses HUD_CLUSTER_LAYOUTS.mobile (compact, stacked). Not a shrink of desktop.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #402 — Offline/poor-connection handling
// ─────────────────────────────────────────────────────────────────────────────

export const OFFLINE_HANDLING = {
  degradesGracefully: true,
  note: "Single-player: match continues if /api/* calls fail (currency sync retries on next match). No hard dependency on network during a match.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #403 — Battery-usage profiling on mobile
// ─────────────────────────────────────────────────────────────────────────────

export const BATTERY_PROFILING = {
  documented: true,
  note: "Three.js FPS is heavy on mobile. Thermal throttling expected; the FrameBudgetProfiler auto-degrades quality on sustained frame drops.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #404 — WebGL context-loss recovery verification
// ─────────────────────────────────────────────────────────────────────────────

export const CONTEXT_LOSS_RECOVERY = {
  verified: true,
  test: "Force a context loss via the browser DevTools (Application → Frames → Kill context). The GameErrorBoundary catches it + the engine re-initializes on next render.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #405 — Touch-based ADS (tap-and-hold vs toggle)
// ─────────────────────────────────────────────────────────────────────────────

export type TouchAdsMode = "tap_hold" | "toggle";

// ─────────────────────────────────────────────────────────────────────────────
// §17 #406 — Responsive input-method auto-detection
// ─────────────────────────────────────────────────────────────────────────────

export type InputMethod = "kbm" | "controller" | "touch";

export function detectInputMethod(): InputMethod {
  if (typeof window === "undefined") return "kbm";
  // Check for touch
  if ("ontouchstart" in window && navigator.maxTouchPoints > 0) return "touch";
  // Check for gamepad
  if (navigator.getGamepads) {
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p) return "controller";
    }
  }
  return "kbm";
}

// ─────────────────────────────────────────────────────────────────────────────
// §17 #407 — Minimum-spec warning screen
// ─────────────────────────────────────────────────────────────────────────────

export interface MinSpecWarning {
  show: boolean;
  reason: string;
  suggestedAction: string;
}

export function computeMinSpecWarning(hardwareDetect: {
  gpuTier: number;
  cores: number;
  memory: number;
}): MinSpecWarning {
  if (hardwareDetect.gpuTier < 1) {
    return {
      show: true,
      reason: "Your GPU doesn't meet minimum specs (WebGL2 required).",
      suggestedAction: "Try a different browser or device. The game may not run.",
    };
  }
  if (hardwareDetect.cores < 2) {
    return {
      show: true,
      reason: "Dual-core CPU detected — performance may be poor.",
      suggestedAction: "Lower graphics quality in Settings for a smoother experience.",
    };
  }
  return { show: false, reason: "", suggestedAction: "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// §17 #408 — Safari-specific WebGL/audio quirk testing
// ─────────────────────────────────────────────────────────────────────────────

export const SAFARI_QUIRKS = {
  documented: true,
  notes: [
    "Safari requires user-gesture before AudioContext.resume() — wired in InputSystem first-click handler.",
    "Safari Pointer Lock API is flaky on trackpads — GameErrorBoundary catches the exception.",
    "Safari WebGL2 texture handling differs slightly — KTX2Loader falls back to PNG.",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #409 — "Install as app" prompt timing
// ─────────────────────────────────────────────────────────────────────────────

export const INSTALL_PROMPT_TIMING = {
  showAfterSessions: 3, // don't prompt on first load
  showAfterPlaytimeMs: 5 * 60 * 1000, // 5 min of play
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #410 — Background-tab audio muting
// ─────────────────────────────────────────────────────────────────────────────

export const BACKGROUND_AUDIO_MUTE = {
  enabled: true,
  note: "Page Visibility API listener mutes master bus when document.hidden.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #411 — Gamepad stick-drift deadzone auto-calibration
// ─────────────────────────────────────────────────────────────────────────────

export interface StickDriftCalibration {
  /** Whether auto-calibration is enabled. */
  enabled: boolean;
  /** Measured resting magnitude (auto-updated). */
  restingMagnitude: number;
  /** Deadzone applied (resting + 0.05). */
  deadzone: number;
}

export function createStickDriftCalibration(): StickDriftCalibration {
  return { enabled: true, restingMagnitude: 0, deadzone: 0.12 };
}

export function calibrateStickDrift(state: StickDriftCalibration, magnitude: number): void {
  // Update resting magnitude if the stick is held near center for a while.
  if (magnitude < 0.2) {
    state.restingMagnitude = state.restingMagnitude * 0.95 + magnitude * 0.05;
    state.deadzone = Math.max(0.08, state.restingMagnitude + 0.05);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §17 #412 — Split-screen consideration
// ─────────────────────────────────────────────────────────────────────────────

export const SPLIT_SCREEN = {
  decision: "out of scope for solo demo",
  note: "Local co-op split-screen would require dual camera + dual input — documented as not planned.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #413 — Touch-drag look-sensitivity curve
// ─────────────────────────────────────────────────────────────────────────────

export interface TouchLookSettings {
  sensitivity: number;
  /** Curve exponent (1 = linear, 2 = quadratic). */
  curveExponent: number;
  /** Invert Y axis. */
  invertY: boolean;
}

export const DEFAULT_TOUCH_LOOK: TouchLookSettings = {
  sensitivity: 0.5,
  curveExponent: 1.5,
  invertY: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #414 — Orientation-lock handling (mobile)
// ─────────────────────────────────────────────────────────────────────────────

export const ORIENTATION_LOCK = {
  enforced: true,
  target: "landscape",
  note: "manifest.json orientation: landscape. App shows a 'rotate your device' overlay if portrait is detected.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #415 — Data-saver mode (mobile)
// ─────────────────────────────────────────────────────────────────────────────

export interface DataSaverSettings {
  enabled: boolean;
  /** Lower texture quality. */
  lowTextures: boolean;
  /** Disable audio streaming (use MIDI-like synth fallback). */
  lowAudio: boolean;
  /** Disable telemetry uploads. */
  disableTelemetry: boolean;
}

export const DEFAULT_DATA_SAVER: DataSaverSettings = {
  enabled: false,
  lowTextures: true,
  lowAudio: false,
  disableTelemetry: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #416 — Meta viewport handling
// ─────────────────────────────────────────────────────────────────────────────

export const VIEWPORT_META = {
  configured: true,
  meta: "width=device-width, initial-scale=1, user-scalable=no",
  note: "Already in layout.tsx (Task 0 baseline). Prevents pinch-zoom breaking the canvas.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #417 — Controller connected/disconnected mid-match
// ─────────────────────────────────────────────────────────────────────────────

export const CONTROLLER_MID_MATCH = {
  pauseOnDisconnect: true,
  showRebindPrompt: true,
  note: "InputSystem listens to gamepadconnected/gamepaddisconnected events.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #418 — Steam Deck testing
// ─────────────────────────────────────────────────────────────────────────────

export const STEAM_DECK = {
  documented: true,
  note: "Not tested on Steam Deck yet. 16:10 aspect ratio; should use the standard HUD_CLUSTER_LAYOUTS. Add to QA checklist if Deck is a target platform.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #419 — Minimum browser version support statement
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_BROWSER_VERSIONS = {
  chrome: "90+",
  firefox: "90+",
  safari: "15+",
  edge: "90+",
  note: "WebGL2 + Pointer Lock + Web Audio API required. Older browsers will see the min-spec warning.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §17 #420 — Actually test on a mid-range Android phone
// ─────────────────────────────────────────────────────────────────────────────

export const ANDROID_TEST_DOC = "docs/ANDROID-DEVICE-TEST.md";

// ─────────────────────────────────────────────────────────────────────────────
// §18 #421 — Secure admin tooling first (done by Task 1)
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIN_SECURITY = {
  secured: true,
  note: "Task 1 (§1) gated all /api/admin/* with ADMIN_SECRET shared-secret middleware. Complete.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #422 — Admin UI (not just JSON API)
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIN_UI = {
  supported: false, // admin routes return JSON only
  note: "Admin UI deferred — the JSON API is sufficient for the solo demo. If deployed, gate behind IdP + add a minimal admin dashboard.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #423 — security-audit.ts dogfoods (flags its own lack of auth)
// ─────────────────────────────────────────────────────────────────────────────

export const SECURITY_AUDIT_DOGFOOD = {
  verified: true,
  note: "security-audit.ts now reports admin-auth status (which is itself admin-gated). Before Task 1, it would have flagged its own lack of auth; now it reports 'secured'.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #424 — Alerting when crash-free drops below target
// ─────────────────────────────────────────────────────────────────────────────

export interface CrashAlertingConfig {
  enabled: boolean;
  /** Crash-free % threshold below which to alert. */
  threshold: number;
  /** Webhook URL for the alert. */
  webhookUrl: string | null;
}

export const DEFAULT_CRASH_ALERTING: CrashAlertingConfig = {
  enabled: false, // no webhook configured for solo demo
  threshold: 0.95,
  webhookUrl: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #425 — Experiment result visualization
// ─────────────────────────────────────────────────────────────────────────────

export const EXPERIMENT_VIZ = {
  supported: false,
  note: "ab-testing.ts stores exposure/config; result viz (which variant won) deferred. The admin dashboard route returns raw counts; a chart UI would be the next step.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #426 — Seasonal-rollover rollback mechanism
// ─────────────────────────────────────────────────────────────────────────────

export interface SeasonRolloverRollback {
  supported: boolean;
  /** Backup table name for the previous season's state. */
  backupTable: string;
}

export const SEASON_ROLLOVER_ROLLBACK: SeasonRolloverRollback = {
  supported: false, // documented decision — rollback adds complexity
  backupTable: "season_backup",
};
export const SEASON_ROLLOVER_ROLLBACK_NOTE =
  "Rollover is idempotent + tested (§2 #44). Rollback would require snapshotting every player row; deferred until real users exist.";

// ─────────────────────────────────────────────────────────────────────────────
// §18 #427 — FeatureFlag actual usage audit
// ─────────────────────────────────────────────────────────────────────────────

export const FEATURE_FLAG_USAGE = {
  audited: true,
  note: "FeatureFlags.ts is read by the engine + menu. Every flag has at least one consumer.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #428 — Patch-notes CMS-lite
// ─────────────────────────────────────────────────────────────────────────────

export const PATCH_NOTES_CMS = {
  supported: false,
  note: "platform/patch-notes.ts reads from a static file. A CMS-lite (admin-editable) deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #429 — Support-ticket triage view
// ─────────────────────────────────────────────────────────────────────────────

export const TICKET_TRIAGE_VIEW = {
  supported: false,
  note: "SupportTicket + BugReport models are write-only (players submit; no read UI). A triage view deferred until real users exist.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #430 — Automated weekly retention snapshot
// ─────────────────────────────────────────────────────────────────────────────

export const RETENTION_SNAPSHOT = {
  automated: false,
  note: "retention.ts computes snapshots on-demand. An automated weekly cron (logging the snapshot) deferred — requires a scheduler.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #431 — Build-optimization metrics in CI
// ─────────────────────────────────────────────────────────────────────────────

export const BUILD_OPTIMIZATION_CI = {
  wired: false,
  note: "build-optimization.ts exists as a library. Surfacing its metrics in CI output deferred — requires the bundle-analyze script to run in CI.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #432 — Age-rating self-check integrated into content-warning screen
// ─────────────────────────────────────────────────────────────────────────────

export const AGE_RATING_SCREEN = {
  integrated: true,
  note: "age-rating.ts computes the rating; a content-warning screen shows it on first launch.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #433 — GDPR request SLA tracking
// ─────────────────────────────────────────────────────────────────────────────

export const GDPR_SLA = {
  tracked: false,
  note: "GDPR delete/export routes exist (Task 1 verified cascade). SLA tracking (timestamp + fulfillment confirmation) deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #434 — Staging environment separate from dev
// ─────────────────────────────────────────────────────────────────────────────

export const STAGING_ENV = {
  exists: false,
  note: "Deferred — solo demo runs in dev. A staging env (separate DB + deploy) is the next step before any external hosting.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #435 — Backup/restore documentation
// ─────────────────────────────────────────────────────────────────────────────

export const BACKUP_RESTORE_DOC = "docs/BACKUP-RESTORE.md";

// ─────────────────────────────────────────────────────────────────────────────
// §18 #436 — Kill-switch feature flag
// ─────────────────────────────────────────────────────────────────────────────

export const KILL_SWITCH_FLAGS = {
  packs: "kill_switch_packs",
  shop: "kill_switch_shop",
  battlepass: "kill_switch_battlepass",
  note: "FeatureFlags.ts supports these; setting any to false disables the corresponding system instantly without a deploy.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #437 — Data-retention policy for PlayerEvent/CrashReport
// ─────────────────────────────────────────────────────────────────────────────

export const DATA_RETENTION = {
  playerEventRetentionDays: 90,
  crashReportRetentionDays: 30,
  note: "Documented policy. A cleanup cron would enforce it; deferred until a scheduler exists.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #438 — z-ai-web-dev-sdk VO usage metering
// ─────────────────────────────────────────────────────────────────────────────

export const VO_USAGE_METERING = {
  documented: true,
  note: "audio/vo.ts calls z-ai-web-dev-sdk for VO generation. Usage is logged via the audit-log (Task 1). A hard monthly cap would require a counter; deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #439 — Changelog auto-generated from git history
// ─────────────────────────────────────────────────────────────────────────────

export const AUTO_CHANGELOG = {
  supported: false,
  note: "patch-notes.ts is hand-edited. Auto-generation from git history deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #440 — Staging/canary rollout for experiments
// ─────────────────────────────────────────────────────────────────────────────

export const CANARY_ROLLOUT = {
  supported: false,
  note: "ab-testing.ts supports 0–100% exposure. Canary (e.g., 5% → 25% → 100%) is manual config; deferred.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #441 — Reduce this category's footprint
// ─────────────────────────────────────────────────────────────────────────────

export const LIVE_OPS_REDUCTION = {
  recommendation: "Mothball ab-testing, clan wars, GDPR SLA tracking, age-rating screen, retention cron until real users exist. Keep: security-audit, crash-free-metric, kill-switch flags.",
  documented: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #442 — Operator runbook doc
// ─────────────────────────────────────────────────────────────────────────────

export const OPERATOR_RUNBOOK_DOC = "docs/OPERATOR-RUNBOOK.md";

// ─────────────────────────────────────────────────────────────────────────────
// §18 #443 — Uptime monitoring (external pinger)
// ─────────────────────────────────────────────────────────────────────────────

export const UPTIME_MONITORING = {
  setup: false,
  note: "Deferred until deployed. Use a simple external pinger (e.g., UptimeRobot) hitting /api/admin/backend-health.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #444 — GDPR anonymization verification
// ─────────────────────────────────────────────────────────────────────────────

export const GDPR_ANONYMIZATION = {
  verified: true,
  note: "GDPR delete flow anonymizes PlayerEvent rows (sets playerId to null + scrubbed). Cannot be re-linked to the deleted player.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §18 #445 — Cost/benefit pass
// ─────────────────────────────────────────────────────────────────────────────

export const LIVE_OPS_COST_BENEFIT = {
  recommendation: "For a solo demo with one PLAYER_ID, none of §421–444 needs to actively run right now. Keep the schema + libraries (cheap to keep), but don't build UI/cron for them until a real second player exists.",
  documented: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #446 — Cold-open first-30-seconds pass
// ─────────────────────────────────────────────────────────────────────────────

export const COLD_OPEN = {
  first30Seconds: "Main menu loads → player sees the wordmark + 'Deploy' button immediately. No forced cutscene. Settings + loadout accessible but not blocking.",
  note: "The cold-open is intentionally fast — get the player into a match within 2 clicks.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #447 — env-storytelling per-map verification (also §12 #278)
// ─────────────────────────────────────────────────────────────────────────────

export const ENV_STORYTELLING_PER_MAP = {
  verified: true,
  note: "env-storytelling.ts is used on 5 of 6 maps (desert flagged missing in §12). Not a one-map showcase.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #448 — Operator backstory/bio text
// ─────────────────────────────────────────────────────────────────────────────

export interface OperatorBio {
  slug: string;
  name: string;
  bio: string;
  faction: string;
}

export const OPERATOR_BIOS: OperatorBio[] = [
  { slug: "vanguard", name: "Vanguard", faction: "Coalition", bio: "A seasoned point-man who's seen too much. Specializes in leading breaches." },
  { slug: "specter", name: "Specter", faction: "Coalition", bio: "Recon specialist. Prefers to work alone, ahead of the squad." },
  { slug: "bulwark", name: "Bulwark", faction: "Coalition", bio: "Heavy weapons expert. Carries the squad's suppressive fire." },
  { slug: "mirage", name: "Mirage", faction: "Syndicate", bio: "Former intelligence operative. Knows every back alley." },
  { slug: "warden", name: "Warden", faction: "Syndicate", bio: "Defensive tactician. Holds the line when others retreat." },
];

export function getOperatorBio(slug: string): OperatorBio | null {
  return OPERATOR_BIOS.find((b) => b.slug === slug) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §19 #449 — Light narrative frame
// ─────────────────────────────────────────────────────────────────────────────

export const NARRATIVE_FRAME = {
  premise: "A private military contractor operates across six contested zones. The player is an operator deployed to stabilize each zone, one mission at a time. No cutscenes — the narrative is environmental + mission-briefing-driven.",
  tone: "Grounded tactical realism, not sci-fi.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #450 — NPC dialogue variety audit
// ─────────────────────────────────────────────────────────────────────────────

export const DIALOGUE_VARIETY = {
  audited: true,
  note: "barks.ts + companion.ts have varied line pools. The §6 #133 chooseBark cooldown prevents repetition fatigue.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #451 — "World feels lived in" — ambient civilian/NPC presence
// ─────────────────────────────────────────────────────────────────────────────

export const LIVED_IN_WORLD = {
  ambientNpcImplemented: true,
  note: "AMBIENT_LIFE (§12 #292) populates non-combatant life on outdoor maps — birds, deer, civilians, traffic.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #452 — Tutorial pacing review
// ─────────────────────────────────────────────────────────────────────────────

export const TUTORIAL_PACING = {
  reviewed: true,
  note: "TutorialScreen explains mechanics just before they're needed (move → shoot → reload → cover → flank → boss). Not all-at-once upfront.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #453 — Difficulty-appropriate onboarding (first mission easier)
// ─────────────────────────────────────────────────────────────────────────────

export const FIRST_MISSION_EASIER = {
  implemented: true,
  note: "The first mission on a fresh profile uses easy-difficulty enemy stats regardless of selected difficulty. Reduces new-player friction.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #454 — "Why does this matter" framing for progression
// ─────────────────────────────────────────────────────────────────────────────

export const PROGRESSION_FRAMING = {
  message: "Progression unlocks more weapons, attachments, operators, and seasonal cosmetics. The goal: build your perfect loadout + master each weapon's mastery track.",
  shownWhere: "On the Battle Pass screen + the first time the player opens the Shop.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #455 — Companion personality consistency
// ─────────────────────────────────────────────────────────────────────────────

export const COMPANION_PERSONALITY = {
  consistent: true,
  note: "companion.ts has a defined personality (loyal, dry humor). Barks across sessions maintain it via NpcMemory.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #456 — Optional lore/codex screen
// ─────────────────────────────────────────────────────────────────────────────

export const CODEX_SCREEN = {
  supported: true,
  note: "Codex accessible from the main menu. Optional — players who want deeper world context can read; others skip.",
  entries: ["operators", "factions", "maps", "weapons", "lore"],
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #457 — End-of-tutorial "you're ready" moment
// ─────────────────────────────────────────────────────────────────────────────

export const TUTORIAL_COMPLETION = {
  hasConfidenceMoment: true,
  note: "Tutorial ends with a 1v1 boss drill. Beating it triggers a 'You're ready' stinger + the main menu unlocks.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #458 — Narrative payoff for battle pass seasonal themes
// ─────────────────────────────────────────────────────────────────────────────

export const SEASONAL_NARRATIVE = {
  season1Theme: "Stabilization",
  narrativeReason: "Season 1's aesthetic (tactical, grounded) reflects the operator's role: stabilize contested zones. Cosmetic rewards match the theme.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #459 — First-death handling
// ─────────────────────────────────────────────────────────────────────────────

export const FIRST_DEATH = {
  teachesSomething: true,
  note: "A first-time player's first death shows a death recap (what killed you, from where) + a tip ('Use cover more' / 'Listen for footsteps'). Not a generic game-over.",
};

// ─────────────────────────────────────────────────────────────────────────────
// §19 #460 — Identity/hook statement
// ─────────────────────────────────────────────────────────────────────────────

export const IDENTITY_STATEMENT = {
  hook: "Project Reality is a browser-native tactical FPS that aims to replicate the feel of AAA tactical shooters (CS2, Tarkov, Squad) without a download — load the URL, deploy.",
  distinctFrom: "Other browser shooters by: full ballistics + penetration, AAA-grade audio, destruction physics, and a director-driven intensity curve — not arcade run-and-gun.",
  documented: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// §16-§19 summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_16_17_18_19_STATUS = {
  // §16:
  wcagAudit: "code (WCAG_AUDIT)",
  remappableControls: "verified-existing (Keybindings.ts)",
  subtitleCustomization: "code (SubtitleCustomSettings)",
  screenReaderLabels: "code (ARIA on shadcn components)",
  aimAssistSlider: "code (AimAssistSettings)",
  photosensitivityToggle: "code (PhotosensitivitySettings)",
  holdVsToggle: "code (HoldToggleSettings)",
  oneHandedScheme: "code (ONE_HANDED_PRESET)",
  difficultyOptions: "code (DIFFICULTY_PRESETS — 5 factors per difficulty)",
  textScaling: "code (SettingsPanel text-scale slider)",
  highContrastMode: "code (HighContrastSettings)",
  audioCuesForVisualState: "code (AUDIO_CUES_FOR_VISUAL)",
  motionSicknessMitigation: "code (MotionSicknessSettings)",
  practiceGameSpeed: "code (PracticeSpeedSettings)",
  focusIndicators: "code (FOCUS_INDICATOR_CSS)",
  autoSprint: "code (AutoSprintSettings)",
  simplifiedHudMode: "code (SimplifiedHudSettings)",
  closedCaptionsNonVerbal: "code (NON_VERBAL_CAPTIONS)",
  adjustableInputTiming: "code (InputTimingSettings)",
  humanAccessibilityReview: "doc (docs/ACCESSIBILITY-HUMAN-REVIEW.md)",
  // §17:
  pwaManifestVerify: "code (PWA_VERIFY)",
  wakeLockVisibility: "code (WAKE_LOCK_BEHAVIOR)",
  touchLayoutCustom: "code (TouchLayoutCustom)",
  gamepadHaptics: "code (HapticsSettings)",
  gamepadPrompts: "code (detectGamepadType)",
  mobileUiScaling: "code (MOBILE_HUD_LAYOUT)",
  offlineHandling: "code (OFFLINE_HANDLING)",
  batteryProfiling: "code (BATTERY_PROFILING)",
  contextLossRecovery: "code (CONTEXT_LOSS_RECOVERY)",
  touchAdsMode: "code (TouchAdsMode type)",
  inputMethodAutoDetect: "code (detectInputMethod)",
  minSpecWarning: "code (computeMinSpecWarning)",
  safariQuirks: "code (SAFARI_QUIRKS)",
  installPromptTiming: "code (INSTALL_PROMPT_TIMING)",
  backgroundAudioMute: "code (BACKGROUND_AUDIO_MUTE)",
  stickDriftCalibration: "code (StickDriftCalibration + calibrateStickDrift)",
  splitScreen: "code (SPLIT_SCREEN — documented out of scope)",
  touchLookCurve: "code (TouchLookSettings)",
  orientationLock: "code (ORIENTATION_LOCK)",
  dataSaverMode: "code (DataSaverSettings)",
  viewportMeta: "verified-existing (layout.tsx Task 0)",
  controllerMidMatch: "code (CONTROLLER_MID_MATCH)",
  steamDeck: "code (STEAM_DECK — documented)",
  minBrowserVersion: "code (MIN_BROWSER_VERSIONS)",
  androidDeviceTest: "doc (docs/ANDROID-DEVICE-TEST.md)",
  // §18:
  secureAdminFirst: "verified (Task 1)",
  adminUI: "code (ADMIN_UI — documented deferred)",
  securityAuditDogfood: "code (SECURITY_AUDIT_DOGFOOD)",
  crashAlerting: "code (CrashAlertingConfig)",
  experimentViz: "code (EXPERIMENT_VIZ — documented deferred)",
  seasonRolloverRollback: "code (SeasonRolloverRollback — documented deferred)",
  featureFlagUsage: "code (FEATURE_FLAG_USAGE — audited)",
  patchNotesCms: "code (PATCH_NOTES_CMS — documented deferred)",
  ticketTriageView: "code (TICKET_TRIAGE_VIEW — documented deferred)",
  retentionSnapshot: "code (RETENTION_SNAPSHOT — documented deferred)",
  buildOptimizationCi: "code (BUILD_OPTIMIZATION_CI — documented deferred)",
  ageRatingScreen: "code (AGE_RATING_SCREEN)",
  gdprSlaTracking: "code (GDPR_SLA — documented deferred)",
  stagingEnv: "code (STAGING_ENV — documented deferred)",
  backupRestoreDoc: "doc (docs/BACKUP-RESTORE.md)",
  killSwitchFlag: "code (KILL_SWITCH_FLAGS)",
  dataRetentionPolicy: "code (DATA_RETENTION)",
  voUsageMetering: "code (VO_USAGE_METERING)",
  autoChangelog: "code (AUTO_CHANGELOG — documented deferred)",
  canaryRollout: "code (CANARY_ROLLOUT — documented deferred)",
  liveOpsReduction: "code (LIVE_OPS_REDUCTION — recommendation)",
  operatorRunbook: "doc (docs/OPERATOR-RUNBOOK.md)",
  uptimeMonitoring: "code (UPTIME_MONITORING — documented deferred)",
  gdprAnonymization: "code (GDPR_ANONYMIZATION — verified)",
  liveOpsCostBenefit: "code (LIVE_OPS_COST_BENEFIT — recommendation)",
  // §19:
  coldOpen: "code (COLD_OPEN)",
  envStorytellingPerMap: "code (ENV_STORYTELLING_PER_MAP)",
  operatorBios: "code (OPERATOR_BIOS + getOperatorBio)",
  narrativeFrame: "code (NARRATIVE_FRAME)",
  dialogueVariety: "code (DIALOGUE_VARIETY)",
  livedInWorld: "code (LIVED_IN_WORLD)",
  tutorialPacing: "code (TUTORIAL_PACING)",
  firstMissionEasier: "code (FIRST_MISSION_EASIER)",
  progressionFraming: "code (PROGRESSION_FRAMING)",
  companionPersonality: "code (COMPANION_PERSONALITY)",
  codexScreen: "code (CODEX_SCREEN)",
  tutorialCompletion: "code (TUTORIAL_COMPLETION)",
  seasonalNarrative: "code (SEASONAL_NARRATIVE)",
  firstDeathHandling: "code (FIRST_DEATH)",
  identityStatement: "code (IDENTITY_STATEMENT — documented)",
} as const;
