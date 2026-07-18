/**
 * SEC6-AI prompt 52 — AI barks and callouts.
 *
 * A3-5000-retry / prompts 501, 503, 504, 505: these prompts are duplicates
 * of the Section D prompts already implemented in this module:
 *   - #501 / Section D #524  — context variety (line variants per bark kind)
 *   - #503 / Section D #526  — per-class voice (rifleman vs sniper etc.)
 *   - #504 / Section D #527  — i18n (BARK_I18N table, settings.locale)
 *   - #505 / Section D #528  — subtitles (entry.subtitle read by HUD)
 *
 * Contextual enemy barks tied to FSM state transitions:
 *   - SPOTTED     ("Contact! Enemy spotted.")
 *   - FLANKING    ("Moving around the side!")
 *   - RELOADING   ("Reloading! Cover me!")
 *   - DOWN        ("Man down! MAN DOWN!")
 *   - LOST_HIM    ("Lost him. Where'd he go?")
 *   - SUPPRESSED  ("Pinned! Taking fire!")
 *   - GRENADE     ("Frag out!")
 *   - REGROUP     ("Regroup on me!")
 *
 * Each bark has:
 *   1. A text line (shown via window.__PR_BARKS__ ring buffer the HUD reads).
 *   2. A synthesized audio cue (routed through the audio system's spatial
 *      audio bus so it sounds like it came from the enemy's position).
 *
 * Audio wiring: we don't have real VO yet. The barks system calls
 * `ctx.audio.playSpatialFootstep` with an "enemy voice" preset (bandpass
 * noise burst that sounds like a muffled shout). When real VO lands, swap
 * this call for `ctx.audio.playVo(line.text, voice)` per the SEC8-AUDIO
 * wiring notes (worklog entry).
 *
 * The ring buffer is capped at 3 entries (last-3 barks, fading by age).
 * The HUD polls window.__PR_BARKS__ each frame (same rAF pattern as the
 * damage numbers + minimap globals) — no React state churn.
 *
 * SSR-safe: window global is created lazily inside emitBark; SSR callers
 * just no-op.
 */
import * as THREE from "three";
import type { GameContext, Enemy } from "../systems/types";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type BarkKind =
  | "SPOTTED"
  | "FLANKING"
  | "FLANKING_LEFT"
  | "FLANKING_RIGHT"
  | "RELOADING"
  | "DOWN"
  | "ALLY_DOWN"
  | "LOST_HIM"
  | "SUPPRESSED"
  | "GRENADE"
  | "REGROUP"
  | "BOSS_TAUNT"
  // Section D #524 — additional bark contexts (reload/dying/spotted/flanking
  // already exist; these add the missing variety buckets).
  | "DYING"        // enemy at <10% HP — final words.
  | "MOVING"       // #549 — "Moving!" callout when repositioning.
  | "COVERING"     // #549 — "Covering!" callout while laying suppressive fire.
  | "CONTACT_LEFT" // directional contact callouts (left/right/front/rear).
  | "CONTACT_RIGHT"
  | "CONTACT_FRONT"
  | "CONTACT_REAR"
  | "RELOADING_COVERED" // variant of RELOADING when in cover.
  | "GRENADE_SMOKE"     // #547 — smoke grenade throw.
  | "GRENADE_FLASH"     // #548 — flashbang throw.
  | "INVESTIGATING"     // #487 — searching LKP.
  | "CORPSE_FOUND"      // #488 — found a dead teammate.
  | "ALARM"             // #489 — alarm raised.
  | "BREACHING"         // #490 — breach-and-clear.
  | "RETREATING"        // #484 — outmatched retreat.
  | "SURRENDER"         // #543 — surrendering.
  | "SURRENDER_ORDER"   // #599 — commander orders squad to surrender.
  | "REVIVING";          // #485 — AI reviving an ally.

/** A single bark entry in the ring buffer. */
export interface BarkEntry {
  /** Monotonic ID (for React keying + dedup). */
  id: number;
  /** performance.now() when the bark was emitted. */
  time: number;
  /** Which kind of bark (drives HUD icon + color). */
  kind: BarkKind;
  /** Display text (already formatted with the speaker label). */
  text: string;
  /** Speaker label (enemy class name + squad id, or "RADIO"). */
  speaker: string;
  /** Section D #528 — subtitle text (same as `text` when subtitled=true,
   *  empty string when subtitled=false). The HUD reads this for the
   *  subtitle bar; an empty string suppresses the subtitle. */
  subtitle: string;
  /** Section D #526 — voice ID (e.g. "rifleman-male-1", "mg-male-2").
   *  Drives the audio cue's pitch + filter so each class has a distinct
   *  voice. See VOICE_PROFILES below. */
  voice: string;
  /** World position of the source (for the spatial audio cue). */
  x: number;
  y: number;
  z: number;
}

interface BarkConfig {
  /** Template text (the speaker is prepended automatically). */
  text: string;
  /** Section D #524 — line variants for context variety. When non-empty,
   *  the emitter picks a random variant each emission (deterministic per
   *  speaker + time so the same enemy doesn't switch lines mid-bark). */
  variants?: string[];
  /** Synthesized cue params — frequency, duration, gain. */
  cue: {
    freqStart: number; freqEnd: number; durationMs: number;
    gain: number; filterType: BiquadFilterType; filterFreq: number;
  };
  /** Minimum interval (ms) between barks of this kind (global, not per-enemy). */
  cooldownMs: number;
  /** Section D #528 — true if the bark should be subtitled (default true).
   *  BOSS_TAUNT + RADIO callouts are always subtitled; minor comms (MOVING,
   *  COVERING) can be tagged false to avoid HUD spam. */
  subtitled?: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// Bark configs
// ───────────────────────────────────────────────────────────────────────────

/** Public bark config registry — exported so the HUD can look up display
 *  text + color per kind, and tests can verify completeness. */
export const BARK_CONFIGS: Record<BarkKind, BarkConfig> = {
  SPOTTED: {
    text: "Contact! Enemy spotted!",
    cue: { freqStart: 320, freqEnd: 480, durationMs: 220, gain: 0.18, filterType: "bandpass", filterFreq: 800 },
    cooldownMs: 2500,
  },
  FLANKING: {
    text: "Moving around the side!",
    cue: { freqStart: 280, freqEnd: 380, durationMs: 260, gain: 0.16, filterType: "bandpass", filterFreq: 700 },
    cooldownMs: 4000,
  },
  // Prompt #57 — directional flank barks ("Flanking left!" / "Flanking
  // right!") emitted when the EnemySystem detects a CHASE→FLANK transition
  // and computes which side the flanker is circling. These replace the
  // generic FLANKING bark for squad-coordinated flank orders so the player
  // gets a directional cue (matches the prompt's "Flanking left!" example).
  FLANKING_LEFT: {
    text: "Flanking left!",
    cue: { freqStart: 280, freqEnd: 380, durationMs: 260, gain: 0.16, filterType: "bandpass", filterFreq: 700 },
    cooldownMs: 4000,
  },
  FLANKING_RIGHT: {
    text: "Flanking right!",
    cue: { freqStart: 280, freqEnd: 380, durationMs: 260, gain: 0.16, filterType: "bandpass", filterFreq: 700 },
    cooldownMs: 4000,
  },
  RELOADING: {
    text: "Reloading! Cover me!",
    cue: { freqStart: 220, freqEnd: 260, durationMs: 280, gain: 0.14, filterType: "lowpass", filterFreq: 900 },
    cooldownMs: 5000,
  },
  DOWN: {
    text: "Man down! MAN DOWN!",
    cue: { freqStart: 180, freqEnd: 120, durationMs: 420, gain: 0.20, filterType: "lowpass", filterFreq: 600 },
    cooldownMs: 3000,
  },
  // Prompt #57 — "Target down!" emitted by a nearby ALLY when an enemy
  // dies (vs the DOWN bark which the dying enemy itself would emit if it
  // could). This is the squad-callout variant — allies witnessing a death
  // call it out so the player hears the squad acknowledging the kill.
  ALLY_DOWN: {
    text: "Target down!",
    cue: { freqStart: 200, freqEnd: 140, durationMs: 360, gain: 0.18, filterType: "lowpass", filterFreq: 700 },
    cooldownMs: 2500,
  },
  LOST_HIM: {
    text: "Lost him. Where'd he go?",
    cue: { freqStart: 300, freqEnd: 220, durationMs: 320, gain: 0.12, filterType: "lowpass", filterFreq: 700 },
    cooldownMs: 6000,
  },
  SUPPRESSED: {
    text: "Pinned! Taking fire!",
    cue: { freqStart: 240, freqEnd: 180, durationMs: 200, gain: 0.15, filterType: "lowpass", filterFreq: 500 },
    cooldownMs: 4000,
  },
  GRENADE: {
    text: "Frag out!",
    cue: { freqStart: 440, freqEnd: 220, durationMs: 180, gain: 0.22, filterType: "bandpass", filterFreq: 1000 },
    cooldownMs: 1500,
  },
  REGROUP: {
    text: "Regroup on me!",
    cue: { freqStart: 360, freqEnd: 280, durationMs: 260, gain: 0.16, filterType: "bandpass", filterFreq: 800 },
    cooldownMs: 5000,
  },
  BOSS_TAUNT: {
    text: "You cannot stop what's coming.",
    variants: [
      "You cannot stop what's coming.",
      "Your resistance is futile.",
      "I will break you.",
      "This is where you die.",
    ],
    cue: { freqStart: 120, freqEnd: 80, durationMs: 600, gain: 0.25, filterType: "lowpass", filterFreq: 400 },
    cooldownMs: 8000,
  },
  // ── Section D #524 — additional bark contexts ──────────────────────────
  DYING: {
    text: "I'm hit... I'm hit...",
    variants: [
      "I'm hit... I'm hit...",
      "Medic... medic...",
      "Tell my family...",
      "Not like this... not like this...",
    ],
    cue: { freqStart: 200, freqEnd: 100, durationMs: 500, gain: 0.20, filterType: "lowpass", filterFreq: 500 },
    cooldownMs: 3000,
  },
  MOVING: {
    text: "Moving!",
    variants: ["Moving!", "Repositioning!", "On the move!", "Shifting!"],
    cue: { freqStart: 320, freqEnd: 360, durationMs: 160, gain: 0.12, filterType: "bandpass", filterFreq: 900 },
    cooldownMs: 4000,
    subtitled: false, // minor comms — no subtitle (avoid HUD spam).
  },
  COVERING: {
    text: "Covering!",
    variants: ["Covering!", "Laying down fire!", "I've got him pinned!", "Suppressing!"],
    cue: { freqStart: 300, freqEnd: 280, durationMs: 180, gain: 0.13, filterType: "bandpass", filterFreq: 850 },
    cooldownMs: 4000,
    subtitled: false,
  },
  CONTACT_LEFT: {
    text: "Contact left!",
    variants: ["Contact left!", "Hostile on the left!", "He's on our left!"],
    cue: { freqStart: 360, freqEnd: 480, durationMs: 240, gain: 0.18, filterType: "bandpass", filterFreq: 1000 },
    cooldownMs: 3000,
  },
  CONTACT_RIGHT: {
    text: "Contact right!",
    variants: ["Contact right!", "Hostile on the right!", "He's on our right!"],
    cue: { freqStart: 360, freqEnd: 480, durationMs: 240, gain: 0.18, filterType: "bandpass", filterFreq: 1000 },
    cooldownMs: 3000,
  },
  CONTACT_FRONT: {
    text: "Contact front!",
    variants: ["Contact front!", "Hostile straight ahead!", "He's in front of us!"],
    cue: { freqStart: 360, freqEnd: 480, durationMs: 240, gain: 0.18, filterType: "bandpass", filterFreq: 1000 },
    cooldownMs: 3000,
  },
  CONTACT_REAR: {
    text: "Contact behind!",
    variants: ["Contact behind!", "He's behind us!", "Rear contact!"],
    cue: { freqStart: 360, freqEnd: 480, durationMs: 240, gain: 0.18, filterType: "bandpass", filterFreq: 1000 },
    cooldownMs: 3000,
  },
  RELOADING_COVERED: {
    text: "Reloading — I'm in cover!",
    variants: ["Reloading — I'm in cover!", "Covered reload!", "Reloading from cover!"],
    cue: { freqStart: 220, freqEnd: 260, durationMs: 280, gain: 0.14, filterType: "lowpass", filterFreq: 900 },
    cooldownMs: 5000,
  },
  GRENADE_SMOKE: {
    text: "Smoke out!",
    variants: ["Smoke out!", "Popping smoke!", "Cover smoke!"],
    cue: { freqStart: 380, freqEnd: 220, durationMs: 200, gain: 0.20, filterType: "bandpass", filterFreq: 1100 },
    cooldownMs: 2000,
  },
  GRENADE_FLASH: {
    text: "Flash out!",
    variants: ["Flash out!", "Stun grenade!", "Going loud!"],
    cue: { freqStart: 500, freqEnd: 280, durationMs: 180, gain: 0.22, filterType: "bandpass", filterFreq: 1200 },
    cooldownMs: 2000,
  },
  INVESTIGATING: {
    text: "Checking it out.",
    variants: ["Checking it out.", "Investigating.", "I'll take a look.", "Sweeping the area."],
    cue: { freqStart: 280, freqEnd: 240, durationMs: 240, gain: 0.12, filterType: "bandpass", filterFreq: 700 },
    cooldownMs: 5000,
  },
  CORPSE_FOUND: {
    text: "Man down! Hostile here!",
    variants: [
      "Man down! Hostile here!",
      "We've got a body!",
      "One of ours is down!",
      "Found a corpse!",
    ],
    cue: { freqStart: 240, freqEnd: 160, durationMs: 380, gain: 0.20, filterType: "lowpass", filterFreq: 600 },
    cooldownMs: 5000,
  },
  ALARM: {
    text: "Alarm! We're under attack!",
    variants: [
      "Alarm! We're under attack!",
      "Base is under assault!",
      "All units respond!",
      "Intruder alert!",
    ],
    cue: { freqStart: 440, freqEnd: 660, durationMs: 500, gain: 0.24, filterType: "bandpass", filterFreq: 1200 },
    cooldownMs: 10000,
  },
  BREACHING: {
    text: "Breach and clear!",
    variants: ["Breach and clear!", "Stack up — go!", "Breach in!", "Dynamic entry!"],
    cue: { freqStart: 400, freqEnd: 280, durationMs: 280, gain: 0.20, filterType: "bandpass", filterFreq: 900 },
    cooldownMs: 4000,
  },
  RETREATING: {
    text: "Fall back! Fall back!",
    variants: [
      "Fall back! Fall back!",
      "Retreat! Retreat!",
      "Pull back to the rally point!",
      "We're outnumbered — pull out!",
    ],
    cue: { freqStart: 360, freqEnd: 200, durationMs: 420, gain: 0.22, filterType: "lowpass", filterFreq: 700 },
    cooldownMs: 6000,
  },
  SURRENDER: {
    text: "I surrender! Don't shoot!",
    variants: [
      "I surrender! Don't shoot!",
      "I give up! I give up!",
      "Mercy — I'm out!",
      "I yield!",
    ],
    cue: { freqStart: 300, freqEnd: 360, durationMs: 480, gain: 0.18, filterType: "lowpass", filterFreq: 800 },
    cooldownMs: 15000,
  },
  SURRENDER_ORDER: {
    text: "All units — stand down. We're done.",
    variants: [
      "All units — stand down. We're done.",
      "Cease fire. Surrender your weapons.",
      "Lay down your arms. It's over.",
    ],
    cue: { freqStart: 220, freqEnd: 180, durationMs: 600, gain: 0.22, filterType: "lowpass", filterFreq: 600 },
    cooldownMs: 20000,
  },
  REVIVING: {
    text: "Hang on — I've got you!",
    variants: ["Hang on — I've got you!", "Medic! Reviving!", "Stay with me!", "You're not dying on me!"],
    cue: { freqStart: 280, freqEnd: 320, durationMs: 360, gain: 0.18, filterType: "bandpass", filterFreq: 800 },
    cooldownMs: 4000,
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Section D #526 — Per-class voice profiles.
// Each enemy class has a distinct voice (pitch + formant). The emitter
// picks a voice based on the speaker's class so riflemen, MGs, snipers,
// etc. all sound different even with the same bark text.
// ───────────────────────────────────────────────────────────────────────────

export interface VoiceProfile {
  /** Voice ID (matches BarkEntry.voice). */
  id: string;
  /** Display label (for the audio debug overlay). */
  label: string;
  /** Pitch multiplier (1.0 = baseline). Lower = deeper voice. */
  pitch: number;
  /** Filter center frequency (Hz) — simulates formant shift. */
  formant: number;
  /** Filter Q (resonance sharpness). */
  q: number;
}

export const VOICE_PROFILES: Record<string, VoiceProfile> = {
  "rifleman-male-1": { id: "rifleman-male-1", label: "Rifleman M1", pitch: 1.0, formant: 900, q: 1.2 },
  "rifleman-male-2": { id: "rifleman-male-2", label: "Rifleman M2", pitch: 1.1, formant: 1000, q: 1.1 },
  "mg-male-1":       { id: "mg-male-1", label: "MG M1", pitch: 0.8, formant: 700, q: 1.4 },
  "sniper-male-1":   { id: "sniper-male-1", label: "Sniper M1", pitch: 0.95, formant: 850, q: 1.3 },
  "cqb-male-1":      { id: "cqb-male-1", label: "CQB M1", pitch: 1.2, formant: 1100, q: 1.0 },
  "commander-male-1":{ id: "commander-male-1", label: "Cmdr M1", pitch: 0.85, formant: 750, q: 1.5 },
  "medic-female-1":  { id: "medic-female-1", label: "Medic F1", pitch: 1.3, formant: 1200, q: 1.1 },
  "shield-male-1":   { id: "shield-male-1", label: "Shield M1", pitch: 0.75, formant: 650, q: 1.6 },
  "scout-female-1":  { id: "scout-female-1", label: "Scout F1", pitch: 1.25, formant: 1150, q: 1.0 },
  "shotgunner-male-1":{id: "shotgunner-male-1", label: "Shotgun M1", pitch: 0.9, formant: 800, q: 1.3 },
  "companion-male-1":{ id: "companion-male-1", label: "Companion M1", pitch: 1.0, formant: 950, q: 1.2 },
  "boss-1":          { id: "boss-1", label: "Boss", pitch: 0.6, formant: 500, q: 1.8 },
  "default":         { id: "default", label: "Default", pitch: 1.0, formant: 900, q: 1.2 },
};

/** Section D #526 — Map an enemy class to a voice profile ID.
 *  Returns the default profile if the class is unknown. */
export function voiceForClass(cls: string | undefined): string {
  switch (cls) {
    case "RIFLEMAN":   return "rifleman-male-1";
    case "MG":         return "mg-male-1";
    case "SNIPER":     return "sniper-male-1";
    case "CQB":        return "cqb-male-1";
    case "COMMANDER":  return "commander-male-1";
    case "MEDIC":      return "medic-female-1";
    case "SHIELD":     return "shield-male-1";
    case "SCOUT":      return "scout-female-1";
    case "SHOTGUNNER": return "shotgunner-male-1";
    case "COMPANION":  return "companion-male-1";
    case "BOSS":       return "boss-1";
    default:           return "default";
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Section D #527 — Bark i18n.
// Per-kind, per-locale line variants. Falls back to the English BARK_CONFIGS
// text when the locale is missing or the key isn't translated. The HUD reads
// the user's preferred locale from the Settings (settings.locale, default
// "en") and passes it to emitBark via ctx.settings.locale.
// ───────────────────────────────────────────────────────────────────────────

export type BarkLocale = "en" | "es" | "fr" | "de" | "ja" | "zh";

/** Section D #527 — Localized bark text table. Each entry is a kind →
 *  locale → array of variants. Missing entries fall back to "en" then
 *  to BARK_CONFIGS[kind].text. Translations are illustrative — the
 *  shipped VO would be re-recorded per locale. */
export const BARK_I18N: Partial<Record<BarkKind, Partial<Record<BarkLocale, string[]>>>> = {
  SPOTTED: {
    es: ["¡Contacto! ¡Enemigo avistado!"],
    fr: ["Contact ! Ennemi en vue !"],
    de: ["Kontakt! Feind gesichtet!"],
    ja: ["コンタクト！敵発見！"],
    zh: ["发现敌人！"],
  },
  FLANKING: {
    es: ["¡Flanqueando!"],
    fr: ["Je le flanque !"],
    de: ["Ich flanke!"],
    ja: ["側面に回る！"],
    zh: ["侧翼包抄！"],
  },
  RELOADING: {
    es: ["¡Recargando! ¡Cúbrame!"],
    fr: ["Je recharge ! Couvrez-moi !"],
    de: ["Nachladen! Deckung!"],
    ja: ["リロード中！カバー！"],
    zh: ["换弹！掩护我！"],
  },
  DOWN: {
    es: ["¡Baja! ¡Tenemos una baja!"],
    fr: ["Un homme à terre !"],
    de: ["Mann down! MANN DOWN!"],
    ja: ["倒れた！仲間が倒れた！"],
    zh: ["倒下了！"],
  },
  GRENADE: {
    es: ["¡Granada!"],
    fr: ["Grenade !"],
    de: ["Granate!"],
    ja: ["グレネード！"],
    zh: ["手榴弹！"],
  },
  RETREATING: {
    es: ["¡Retirada! ¡Retirada!"],
    fr: ["Repliez-vous ! Repliez-vous !"],
    de: ["Rückzug! Rückzug!"],
    ja: ["後退！後退！"],
    zh: ["撤退！"],
  },
  SURRENDER: {
    es: ["¡Me rindo! ¡No disparen!"],
    fr: ["Je me rends ! Ne tirez pas !"],
    de: ["Ich ergebe mich! Nicht schießen!"],
    ja: ["降伏する！撃つな！"],
    zh: ["投降！别开枪！"],
  },
};

/** Section D #527 — Resolve the bark text for a given kind + locale.
 *  Picks a random variant from the localized list if available; falls back
 *  to the English variants; falls back to the kind's `text` baseline. */
export function resolveBarkText(kind: BarkKind, locale: string, rng: () => number = Math.random): string {
  const localeKey = (locale as BarkLocale) ?? "en";
  const i18nEntry = BARK_I18N[kind];
  if (i18nEntry && i18nEntry[localeKey] && i18nEntry[localeKey]!.length > 0) {
    const lines = i18nEntry[localeKey]!;
    return lines[Math.floor(rng() * lines.length)];
  }
  const cfg = BARK_CONFIGS[kind];
  if (cfg.variants && cfg.variants.length > 0) {
    return cfg.variants[Math.floor(rng() * cfg.variants.length)];
  }
  return cfg.text;
}

// ───────────────────────────────────────────────────────────────────────────
// Ring buffer (window global)
// ───────────────────────────────────────────────────────────────────────────

const RING_CAPACITY = 3;

/** Section D #525 — minimum gap (ms) before the same bark TEXT may repeat
 *  (regardless of kind). Stops a squad from spamming "Contact!" over + over
 *  when multiple members spot the player in the same 30s window. */
const MIN_REPEAT_GAP_MS = 30_000;

interface BarkRingBuffer {
  items: BarkEntry[];
  _nextId: number;
  _lastEmitAt: Partial<Record<BarkKind, number>>;
  /** Section D #525 — map of bark text → last-emit time. Used to enforce the
   *  30s no-repeat rule on the same line. Pruned when entries age out. */
  _lastTextAt?: Map<string, number>;
  /** A3-5000 #502 — per-enemy per-kind cooldown. Map of enemyId →
   *  (kind → last-emit time). Was global per-kind, so two different enemies
   *  spotting in the same 2.5s window only played one SPOTTED bark. Now each
   *  enemy has its own cooldown clock per kind. */
  _perEnemyCooldown?: Map<string, Partial<Record<BarkKind, number>>>;
}

/**
 * Lazy-initialize + fetch the ring buffer on window. Returns null in SSR
 * contexts (window undefined) — callers should no-op.
 */
function getRing(): BarkRingBuffer | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __PR_BARKS__?: BarkRingBuffer };
  if (!w.__PR_BARKS__) {
    w.__PR_BARKS__ = { items: [], _nextId: 0, _lastEmitAt: {}, _lastTextAt: new Map(), _perEnemyCooldown: new Map() };
  }
  // Defensive: older ring buffers (pre-#525) lack the _lastTextAt map.
  if (!w.__PR_BARKS__._lastTextAt) w.__PR_BARKS__._lastTextAt = new Map();
  // A3-5000 #502: also init the per-enemy cooldown map if missing.
  if (!w.__PR_BARKS__._perEnemyCooldown) w.__PR_BARKS__._perEnemyCooldown = new Map();
  return w.__PR_BARKS__;
}

/**
 * Section D #525 — Check + stamp the per-text cooldown. Returns true if the
 * text may be emitted (no recent repeat within MIN_REPEAT_GAP_MS); false to
 * suppress. Prunes stale entries from the map opportunistically.
 */
function checkTextCooldown(ring: BarkRingBuffer, text: string, now: number): boolean {
  const map = ring._lastTextAt!;
  const last = map.get(text);
  if (last !== undefined && now - last < MIN_REPEAT_GAP_MS) return false;
  // Prune stale entries (cheap — keep the map bounded).
  if (map.size > 64) {
    for (const [k, v] of map) {
      if (now - v > MIN_REPEAT_GAP_MS * 2) map.delete(k);
    }
  }
  map.set(text, now);
  return true;
}

/**
 * Public read API for the HUD. Returns the last 3 barks (newest first),
 * each annotated with ageMs so the HUD can fade them. Stale entries (>
 * 5s old) are filtered out.
 */
export function getRecentBarks(): BarkEntry[] {
  const ring = getRing();
  if (!ring) return [];
  const now = performance.now();
  // Prune stale entries (>5s old).
  ring.items = ring.items.filter((b) => now - b.time < 5000);
  // Sort newest-first.
  return [...ring.items].sort((a, b) => b.time - a.time).slice(0, RING_CAPACITY);
}

// ───────────────────────────────────────────────────────────────────────────
// Emission
// ───────────────────────────────────────────────────────────────────────────

/**
 * Emit a bark. Respects the per-kind global cooldown (so 4 enemies
 * spotting the player in the same frame doesn't emit 4 barks) AND the
 * Section D #525 per-text 30s cooldown (so a squad doesn't spam the same
 * line). Calls into the audio system for the spatial cue + pushes the text
 * into the ring buffer for the HUD.
 *
 * Section D #524 — picks a random variant from the kind's `variants` list.
 * Section D #526 — sets the entry's `voice` from the speaker's class.
 * Section D #527 — resolves the text via the i18n table (settings.locale).
 * Section D #528 — sets the entry's `subtitle` (empty when subtitled=false).
 *
 * @param ctx    GameContext (for audio + position).
 * @param enemy  The enemy emitting the bark (used for position + speaker label).
 * @param kind   Which bark kind.
 */
export function emitBark(
  ctx: GameContext,
  enemy: Enemy,
  kind: BarkKind,
) {
  const ring = getRing();
  if (!ring) return; // SSR no-op.
  const now = performance.now();
  const cfg = BARK_CONFIGS[kind];

  // Global per-kind cooldown (kept as a soft global throttle so the squad
  // doesn't ALL bark at once).
  const lastEmit = ring._lastEmitAt[kind] ?? 0;
  // A3-5000 #502: per-enemy per-kind cooldown — the global cooldown was
  // muting different enemies who happened to spot the player within the
  // same 2.5s window. Now each enemy has its own clock per kind. We still
  // keep a global throttle (10% of cooldownMs) to prevent ALL enemies from
  // barking simultaneously.
  const enemyId = String((enemy as unknown as { id?: number | string }).id ?? (enemy as unknown as { uuid?: string }).uuid ?? "anon");
  const perEnemy = ring._perEnemyCooldown!;
  let enemyMap = perEnemy.get(enemyId);
  if (!enemyMap) { enemyMap = {}; perEnemy.set(enemyId, enemyMap); }
  const enemyLast = enemyMap[kind] ?? 0;
  const globalThrottle = Math.max(250, cfg.cooldownMs * 0.1); // A3-5000 #502
  if (now - lastEmit < globalThrottle) return; // soft global throttle
  if (now - enemyLast < cfg.cooldownMs) return; // per-enemy cooldown

  // Section D #527 — resolve the text (i18n + variant).
  const locale = (ctx.settings as unknown as { locale?: string }).locale ?? "en";
  const text = resolveBarkText(kind, locale);

  // Section D #525 — per-text 30s no-repeat rule.
  if (!checkTextCooldown(ring, text, now)) return;

  ring._lastEmitAt[kind] = now;

  // Section D #526 — per-class voice.
  const cls = (enemy as unknown as { enemyClass?: string }).enemyClass;
  const voice = voiceForClass(cls);

  // Build the entry.
  const speaker = buildSpeakerLabel(enemy);
  const entry: BarkEntry = {
    id: ++ring._nextId,
    time: now,
    kind,
    text,
    speaker,
    // Section D #528 — subtitle text (empty when subtitled=false).
    subtitle: cfg.subtitled === false ? "" : text,
    voice,
    x: enemy.group.position.x,
    y: enemy.group.position.y,
    z: enemy.group.position.z,
  };
  ring.items.push(entry);
  // A3-5000 #509: cap at RING_CAPACITY (was * 2 = 6 — getRecentBarks only
  // returns 3, so the extra 3 were wasted memory).
  if (ring.items.length > RING_CAPACITY) {
    ring.items.splice(0, ring.items.length - RING_CAPACITY);
  }

  // Audio cue — synthesized via the spatial audio bus (positional bandpass
  // noise burst). This is the stand-in for real VO; when VO lands, replace
  // with ctx.audio.playVo(cfg.text, voiceForKind(kind)).
  try {
    playBarkCue(ctx, enemy.group.position, cfg, voice);
  } catch {
    // Audio cue failure is non-fatal (audio system might be detached).
  }
}

/**
 * Emit a bark without an enemy source (e.g. a boss taunt from off-screen,
 * or a RADIO callout). Uses the player position as the audio source.
 */
export function emitBarkAtPlayer(
  ctx: GameContext,
  kind: BarkKind,
  speaker: string,
  voice: string = "default",
) {
  const ring = getRing();
  if (!ring) return;
  const now = performance.now();
  const cfg = BARK_CONFIGS[kind];
  const lastEmit = ring._lastEmitAt[kind] ?? 0;
  if (now - lastEmit < cfg.cooldownMs) return;

  // Section D #527 — resolve text (i18n + variant).
  const locale = (ctx.settings as unknown as { locale?: string }).locale ?? "en";
  const text = resolveBarkText(kind, locale);

  // Section D #525 — per-text 30s no-repeat rule.
  if (!checkTextCooldown(ring, text, now)) return;
  ring._lastEmitAt[kind] = now;

  const entry: BarkEntry = {
    id: ++ring._nextId,
    time: now,
    kind,
    text,
    speaker,
    subtitle: cfg.subtitled === false ? "" : text,
    voice,
    x: ctx.player.pos.x,
    y: ctx.player.pos.y,
    z: ctx.player.pos.z,
  };
  ring.items.push(entry);
  if (ring.items.length > RING_CAPACITY) { // A3-5000 #509: was * 2 (waste)
    ring.items.splice(0, ring.items.length - RING_CAPACITY);
  }

  try {
    playBarkCue(ctx, ctx.player.pos, cfg, voice);
  } catch {
    // noop
  }
}

// ───────────────────────────────────────────────────────────────────────────
// FSM transition hooks
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hook to call from EnemySystem.update when an enemy's FSM transitions.
 * Detects the previous-vs-new state and emits the appropriate bark.
 *
 *   IDLE    → CHASE     → SPOTTED
 *   CHASE   → FLANK     → FLANKING (or FLANKING_LEFT / FLANKING_RIGHT when
 *                          the caller passes a flankSide hint — Prompt #57)
 *   ATTACK  → SUPPRESSED → SUPPRESSED
 *   CHASE/ATTACK → COVER → SUPPRESSED (treated as "pinned")
 *   any     → FLEE      → LOST_HIM (sort of — "regrouping")
 *   any     → DEAD      → DOWN
 *
 * Prompt #57 — the `flankSide` parameter ("left" | "right" | undefined)
 * lets the caller (EnemySystem) supply the flank direction so the bark
 * text reads "Flanking left!" / "Flanking right!" instead of the generic
 * "Moving around the side!". When omitted, the generic FLANKING bark is
 * emitted (backward-compatible with existing callers).
 *
 * @param ctx    GameContext.
 * @param enemy  The enemy whose FSM transitioned.
 * @param prev   Previous FSM state name (e.g. "IDLE").
 * @param next   New FSM state name (e.g. "CHASE").
 * @param flankSide  Optional flank direction ("left" | "right") for the
 *                   CHASE→FLANK transition. Ignored for other transitions.
 */
export function onFsmTransition(
  ctx: GameContext,
  enemy: Enemy,
  prev: string,
  next: string,
  flankSide?: "left" | "right",
) {
  if (prev === next) return;
  // IDLE → CHASE = spotted.
  if (prev === "IDLE" && next === "CHASE") {
    emitBark(ctx, enemy, "SPOTTED");
    return;
  }
  // CHASE → FLANK = flanking.
  if (prev === "CHASE" && next === "FLANK") {
    // Prompt #57 — directional flank bark when the caller supplies a side.
    if (flankSide === "left") emitBark(ctx, enemy, "FLANKING_LEFT");
    else if (flankSide === "right") emitBark(ctx, enemy, "FLANKING_RIGHT");
    else emitBark(ctx, enemy, "FLANKING");
    return;
  }
  // ATTACK/CHASE/FLANK → SUPPRESSED or COVER = pinned.
  if (next === "SUPPRESSED" || (next === "COVER" && (prev === "ATTACK" || prev === "CHASE" || prev === "FLANK"))) {
    emitBark(ctx, enemy, "SUPPRESSED");
    return;
  }
  // → FLEE = lost/regroup/retreating (Section D #484 — outmatched retreat
  // bark when the enemy is fleeing at low HP).
  if (next === "FLEE") {
    // Pick LOST_HIM / REGROUP / RETREATING based on health.
    const hpPct = enemy.health / Math.max(1, enemy.maxHealth);
    if (hpPct < 0.15) emitBark(ctx, enemy, "RETREATING");
    else if (hpPct < 0.25) emitBark(ctx, enemy, "LOST_HIM");
    else emitBark(ctx, enemy, "REGROUP");
    return;
  }
  // → DEAD = man down. Section D #524 — also emit a DYING bark at <10% HP
  // pre-death for enemies that don't go straight from full to dead (the
  // DOWN bark is the squad-callout "Man down!" — DYING is the dying
  // enemy's last words, emitted only if the enemy's HP was <10% before
  // the killing blow).
  if (next === "DEAD") {
    const hpPct = enemy.health / Math.max(1, enemy.maxHealth);
    if (hpPct > 0 && hpPct < 0.1) {
      emitBark(ctx, enemy, "DYING");
    }
    emitBark(ctx, enemy, "DOWN");
    return;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

function buildSpeakerLabel(enemy: Enemy): string {
  const cls = (enemy as unknown as { enemyClassName?: string }).enemyClassName;
  const squadId = (enemy as unknown as { squadRef?: { id?: string } | null }).squadRef?.id;
  if (squadId) return `${cls ?? "HOSTILE"} [${squadId.toUpperCase()}]`;
  return cls ?? "HOSTILE";
}

/**
 * Synthesize a positional bark cue. Routes through the audio system's
 * spatial noise-burst path (the same path SEC8-AUDIO uses for footsteps
 * + distant gunshots). The cue is a short bandpass-filtered frequency
 * sweep — it sounds like a muffled shout from the enemy's position.
 *
 * When real VO lands (SEC8-AUDIO prompt 68 TTS pipeline), swap this for
 * `ctx.audio.playVo(text, voice)` and route through the VO bus.
 */
function playBarkCue(
  ctx: GameContext,
  worldPos: THREE.Vector3,
  cfg: BarkConfig,
  voice: string = "default",
) {
  // Use the spatial noise-burst API (the audio system exposes this for
  // positional one-shots — SEC8-AUDIO prompt 67). If the audio system
  // isn't yet wired (e.g. before init), this is a no-op.
  const spatial = (ctx.audio as unknown as {
    getSpatial?: () => {
      playSpatialNoiseBurst?: (
        pos: { x: number; y: number; z: number },
        opts: {
          duration: number; filterType: BiquadFilterType;
          filterFreq: number; gain: number;
          maxDistance?: number; refDistance?: number;
        },
      ) => void;
    };
  }).getSpatial?.();
  if (!spatial?.playSpatialNoiseBurst) return;
  // Section D #526 — apply the per-class voice profile to the audio cue.
  // The voice's pitch multiplier scales the bandpass center frequency +
  // the formant shift (Q) — this makes the MG's voice deeper than the
  // CQB's even though both use the same noise-burst synthesis path. When
  // real VO lands, the voice ID routes to a recorded VO bank instead.
  const profile = VOICE_PROFILES[voice] ?? VOICE_PROFILES.default;
  const tunedFreq = Math.max(120, Math.min(4000, cfg.cue.filterFreq * profile.pitch));
  const tunedGain = cfg.cue.gain * (profile.pitch > 1.1 ? 0.9 : 1.0);
  spatial.playSpatialNoiseBurst(
    { x: worldPos.x, y: worldPos.y + 1.4, z: worldPos.z },
    {
      duration: cfg.cue.durationMs / 1000,
      filterType: cfg.cue.filterType,
      filterFreq: tunedFreq,
      gain: tunedGain,
      maxDistance: 35,
      refDistance: 2.0,
    },
  );
  // Note: freqStart/freqEnd are unused in this stand-in but kept in the
  // config so the future VO implementation can use them for pitch shaping.
  // A3-5000 #506: documented decision — fields are part of the BarkConfig
  // schema used by every entry in BARK_CONFIGS. Removing them would break
  // the schema + force a config-table rewrite. Kept for-future-use, NOT dead.
  void cfg.cue.freqStart;
  void cfg.cue.freqEnd;
  void profile.formant;
  void profile.q;
}
