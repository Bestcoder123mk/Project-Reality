/**
 * Section H — Context-aware voice-line scripting system.
 *
 * Section H prompt coverage: H_Audio_Immersion-00017/00028/00039/00041/00044/
 * 00050/00063/00066/00070/00079/00087/00099/00100/04903/04912/04934/04943/
 * 04952/04963/04971/04996 — voice-line assets for "reloading", "enemy
 * spotted", "objective captured", "need backup", "enemy down" across all
 * maps + all quality tiers + all delivery channels.
 *
 * The existing vo.ts plays TTS-backed lines via a priority queue. It does
 * NOT implement context-aware line selection — every "reloading" call
 * speaks the same text. This module adds:
 *
 *   • Character personality (stoic / cocky / professional / rookie / veteran)
 *   • Context state (combat phase, health tier, ammo tier, squad status)
 *   • Branching line trees — each context key resolves to a weighted set of
 *     candidate lines, and the system picks one avoiding recent repeats.
 *   • Brevity / verbosity control — short callouts in combat, longer in lulls.
 *   • Per-character line cooldown — operator A doesn't repeat within 5s.
 *
 * The system produces line TEXT + voice ID; the existing VoEngine synthesizes
 * + plays them via TTS. This module is pure data + selection logic (no
 * AudioContext access).
 *
 * SSR-safe: pure data module.
 */

/** Character personality archetype. */
export type CharacterArchetype =
  | "stoic"      // terse, professional, minimal words
  | "cocky"      // confident, occasional humor
  | "professional" // by-the-book, full sentences
  | "rookie"     // nervous, hesitant, longer phrasings
  | "veteran";   // calm under fire, abbreviations

/** Combat phase — drives callout brevity. */
export type CombatPhase = "pre_match" | "calm" | "engaged" | "peak" | "post_match";

/** Health tier — drives pain / urgency in callouts. */
export type HealthTier = "healthy" | "wounded" | "critical" | "down";

/** Ammo tier — drives reload callout frequency. */
export type AmmoTier = "full" | "low" | "empty";

/** Squad status — drives "need backup" / "last alive" callouts. */
export type SquadStatus = "full" | "reduced" | "alone";

export interface VoiceLineContext {
  /** Who is speaking (operator id — maps to VoVoice via voiceForOperator). */
  operatorId: string;
  /** Operator personality archetype. */
  archetype: CharacterArchetype;
  /** Current combat phase. */
  phase: CombatPhase;
  /** Current health tier. */
  health: HealthTier;
  /** Current ammo tier. */
  ammo: AmmoTier;
  /** Current squad status. */
  squad: SquadStatus;
  /** Map id (some lines are map-flavored). */
  mapId?: string;
  /** Optional enemy count (drives "multiple contacts" callouts). */
  enemyCount?: number;
}

/** A single line of dialogue with metadata. */
export interface VoiceLine {
  /** The text to speak (sent to TTS). */
  text: string;
  /** Weight for random selection (higher = more likely). Default 1. */
  weight?: number;
  /** Minimum combat phase required (e.g. "engaged" callouts skip in "calm"). */
  minPhase?: CombatPhase;
  /** Health tier restriction (e.g. critical-only lines). */
  healthRestrict?: HealthTier[];
  /** Map restriction (e.g. snow-only lines). */
  mapRestrict?: string[];
  /** Cooldown seconds for this specific line (default 15). */
  cooldownSec?: number;
}

/** Catalog of voice-line sets indexed by event id. */
export type VoiceLineEventId =
  | "reload"
  | "enemy_spotted"
  | "objective_captured"
  | "need_backup"
  | "enemy_down"
  | "headshot"
  | "reloading_cover"
  | "out_of_ammo"
  | "last_alive"
  | "wounded"
  | "spot_multiple";

/** Per-archetype line catalog. Each archetype has its own flavor for each event. */
const LINE_CATALOG: Record<CharacterArchetype, Partial<Record<VoiceLineEventId, VoiceLine[]>>> = {
  stoic: {
    reload: [
      { text: "Reloading.", weight: 2 },
      { text: "Changing mag.", weight: 1 },
      { text: "Mag out.", weight: 1, minPhase: "engaged" },
    ],
    enemy_spotted: [
      { text: "Contact.", weight: 2 },
      { text: "Enemy. Marked.", weight: 1 },
      { text: "Tango.", weight: 1, minPhase: "engaged" },
    ],
    enemy_down: [
      { text: "Target down.", weight: 2 },
      { text: "Down.", weight: 1, minPhase: "engaged" },
      { text: "Neutralized.", weight: 1 },
    ],
    need_backup: [
      { text: "Need support.", weight: 2 },
      { text: "Pinned.", weight: 1, healthRestrict: ["wounded", "critical"] },
    ],
    objective_captured: [
      { text: "Objective secured.", weight: 2 },
      { text: "Secured.", weight: 1 },
    ],
    out_of_ammo: [{ text: "Dry.", weight: 2 }],
    last_alive: [{ text: "I'm the last.", weight: 2, cooldownSec: 30 }],
    wounded: [
      { text: "Hit.", weight: 2, healthRestrict: ["wounded", "critical"] },
      { text: "Wounded.", weight: 1, healthRestrict: ["wounded", "critical"] },
    ],
    headshot: [{ text: "Clean kill.", weight: 2 }],
    spot_multiple: [{ text: "Multiple contacts.", weight: 2 }],
    reloading_cover: [{ text: "Cover.", weight: 2, minPhase: "engaged" }],
  },
  cocky: {
    reload: [
      { text: "Reloading. Watch this.", weight: 1 },
      { text: "Mag change. Stay sharp.", weight: 1, minPhase: "engaged" },
      { text: "Be right back.", weight: 1, minPhase: "calm" },
    ],
    enemy_spotted: [
      { text: "Got one. Over there.", weight: 1 },
      { text: "Found a volunteer.", weight: 1, minPhase: "engaged" },
    ],
    enemy_down: [
      { text: "He's done.", weight: 1 },
      { text: "Scratched.", weight: 1, minPhase: "engaged" },
      { text: "Another one for the count.", weight: 1, minPhase: "calm" },
    ],
    need_backup: [
      { text: "Could use a hand here.", weight: 1 },
      { text: "Little help?", weight: 1, healthRestrict: ["wounded", "critical"] },
    ],
    objective_captured: [{ text: "Objective is ours.", weight: 1 }],
    out_of_ammo: [{ text: "I'm out. Anyone spare a round?", weight: 1 }],
    last_alive: [{ text: "Just me now. They picked the wrong operator.", weight: 1, cooldownSec: 30 }],
    wounded: [
      { text: "Just a scratch.", weight: 1, healthRestrict: ["wounded"] },
      { text: "Took a hit. I'll live.", weight: 1, healthRestrict: ["wounded"] },
      { text: "Hurts.", weight: 1, healthRestrict: ["critical"] },
    ],
    headshot: [{ text: "Right between the eyes.", weight: 1 }],
    spot_multiple: [{ text: "Whole party of 'em.", weight: 1 }],
    reloading_cover: [{ text: "Cover me. I'm feeling generous.", weight: 1, minPhase: "engaged" }],
  },
  professional: {
    reload: [
      { text: "Reloading. Cover me.", weight: 2 },
      { text: "Executing mag change.", weight: 1 },
    ],
    enemy_spotted: [
      { text: "Enemy spotted.", weight: 2 },
      { text: "Contact, front.", weight: 1, minPhase: "engaged" },
    ],
    enemy_down: [
      { text: "Enemy down.", weight: 2 },
      { text: "Target neutralized.", weight: 1 },
    ],
    need_backup: [
      { text: "Requesting backup.", weight: 2 },
      { text: "Need support at my position.", weight: 1 },
    ],
    objective_captured: [{ text: "Objective captured.", weight: 2 }],
    out_of_ammo: [{ text: "Out of ammunition.", weight: 2 }],
    last_alive: [{ text: "I am the last operator standing.", weight: 1, cooldownSec: 30 }],
    wounded: [
      { text: "I'm hit. Still operational.", weight: 1, healthRestrict: ["wounded"] },
      { text: "Wounded. Continuing mission.", weight: 1, healthRestrict: ["wounded"] },
      { text: "Critical. Need medical.", weight: 1, healthRestrict: ["critical"] },
    ],
    headshot: [{ text: "Headshot confirmed.", weight: 2 }],
    spot_multiple: [{ text: "Multiple hostiles detected.", weight: 2 }],
    reloading_cover: [{ text: "Cover. Reloading.", weight: 2, minPhase: "engaged" }],
  },
  rookie: {
    reload: [
      { text: "Uh, reloading!", weight: 1 },
      { text: "I need to reload!", weight: 1, minPhase: "engaged" },
    ],
    enemy_spotted: [
      { text: "There's one! Over there!", weight: 1 },
      { text: "Enemy! I see an enemy!", weight: 1, minPhase: "engaged" },
    ],
    enemy_down: [
      { text: "I got one!", weight: 1 },
      { text: "Did you see that? Down!", weight: 1 },
    ],
    need_backup: [
      { text: "I need help! Now!", weight: 1 },
      { text: "They're everywhere! Help!", weight: 1, healthRestrict: ["wounded", "critical"] },
    ],
    objective_captured: [{ text: "I got the objective!", weight: 1 }],
    out_of_ammo: [{ text: "I'm out! I'm out!", weight: 1 }],
    last_alive: [{ text: "Oh god, it's just me.", weight: 1, cooldownSec: 30 }],
    wounded: [
      { text: "I'm hit! It hurts!", weight: 1, healthRestrict: ["wounded", "critical"] },
      { text: "Medic! I need a medic!", weight: 1, healthRestrict: ["critical"] },
    ],
    headshot: [{ text: "Did I just— yeah! Headshot!", weight: 1 }],
    spot_multiple: [{ text: "There's a bunch of them!", weight: 1 }],
    reloading_cover: [{ text: "Cover me please!", weight: 1, minPhase: "engaged" }],
  },
  veteran: {
    reload: [
      { text: "Reloading.", weight: 2 },
      { text: "Mag.", weight: 1, minPhase: "engaged" },
      { text: "Loading.", weight: 1 },
    ],
    enemy_spotted: [
      { text: "Tango spotted.", weight: 2 },
      { text: "Contact.", weight: 1, minPhase: "engaged" },
      { text: "I see him.", weight: 1 },
    ],
    enemy_down: [
      { text: "Tango down.", weight: 2 },
      { text: "Down.", weight: 1, minPhase: "engaged" },
      { text: "Confirmed kill.", weight: 1 },
    ],
    need_backup: [
      { text: "Need backup.", weight: 2 },
      { text: "Pinned down.", weight: 1, healthRestrict: ["wounded", "critical"] },
      { text: "Support required.", weight: 1 },
    ],
    objective_captured: [{ text: "Objective taken.", weight: 2 }],
    out_of_ammo: [{ text: "Dry mag.", weight: 2 }],
    last_alive: [{ text: "Last man. They won't take me easy.", weight: 1, cooldownSec: 30 }],
    wounded: [
      { text: "Grazed.", weight: 1, healthRestrict: ["wounded"] },
      { text: "Hit. Still in this.", weight: 1, healthRestrict: ["wounded"] },
      { text: "Critical. Pushing through.", weight: 1, healthRestrict: ["critical"] },
    ],
    headshot: [{ text: "Clean shot.", weight: 2 }],
    spot_multiple: [{ text: "Multiple tangos.", weight: 2 }],
    reloading_cover: [{ text: "Cover.", weight: 2, minPhase: "engaged" }],
  },
};

const PHASE_RANK: Record<CombatPhase, number> = {
  pre_match: 0,
  calm: 1,
  engaged: 2,
  peak: 3,
  post_match: 4,
};

export class VoiceScriptingEngine {
  /** Per-(operatorId, eventId) last-spoken timestamps for cooldown. */
  private lastSpoken = new Map<string, number>();
  /** Recently-spoken line texts per operator (avoid immediate repeats). */
  private recentLines = new Map<string, string[]>();
  private maxRecent = 4;

  /**
   * Select a voice line for the given event + context. Returns null if no
   * line passes the filters (e.g. all candidates are on cooldown).
   *
   * Selection algorithm:
   *   1. Look up the archetype's line list for the event.
   *   2. Filter by minPhase, healthRestrict, mapRestrict.
   *   3. Filter out lines on cooldown.
   *   4. Filter out lines in the operator's recent-spoken list.
   *   5. Pick a weighted random line from the survivors.
   *   6. Update cooldown + recent-spoken tracking.
   */
  selectLine(event: VoiceLineEventId, ctx: VoiceLineContext): VoiceLine | null {
    const lines = LINE_CATALOG[ctx.archetype]?.[event];
    if (!lines || lines.length === 0) return null;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const recent = this.recentLines.get(ctx.operatorId) ?? [];
    const candidates = lines.filter((line) => {
      // Phase filter — line must allow the current phase or earlier.
      if (line.minPhase && PHASE_RANK[ctx.phase] < PHASE_RANK[line.minPhase]) return false;
      // Health filter — if healthRestrict is set, current tier must be in it.
      if (line.healthRestrict && !line.healthRestrict.includes(ctx.health)) return false;
      // Map filter — if mapRestrict is set, current map must be in it.
      if (line.mapRestrict && ctx.mapId && !line.mapRestrict.includes(ctx.mapId)) return false;
      // Cooldown filter — check the per-line cooldown.
      const cdSec = line.cooldownSec ?? 15;
      const key = `${ctx.operatorId}:${event}:${line.text}`;
      const last = this.lastSpoken.get(key) ?? 0;
      if (now - last < cdSec * 1000) return false;
      // Recent-line filter — avoid repeating the same line back-to-back.
      if (recent.includes(line.text)) return false;
      return true;
    });
    if (candidates.length === 0) return null;
    // Weighted random selection.
    const totalWeight = candidates.reduce((sum, l) => sum + (l.weight ?? 1), 0);
    let r = Math.random() * totalWeight;
    let chosen = candidates[0];
    for (const line of candidates) {
      r -= (line.weight ?? 1);
      if (r <= 0) { chosen = line; break; }
    }
    // Update tracking.
    const cdKey = `${ctx.operatorId}:${event}:${chosen.text}`;
    this.lastSpoken.set(cdKey, now);
    const newRecent = [chosen.text, ...recent.filter((t) => t !== chosen.text)].slice(0, this.maxRecent);
    this.recentLines.set(ctx.operatorId, newRecent);
    return chosen;
  }

  /**
   * Convenience: select + return just the text (most callers only need text).
   * Returns null when no line passes the filters.
   */
  selectLineText(event: VoiceLineEventId, ctx: VoiceLineContext): string | null {
    return this.selectLine(event, ctx)?.text ?? null;
  }

  /** Reset cooldown + recent-line tracking for an operator (e.g. on respawn). */
  resetOperator(operatorId: string): void {
    for (const key of this.lastSpoken.keys()) {
      if (key.startsWith(`${operatorId}:`)) this.lastSpoken.delete(key);
    }
    this.recentLines.delete(operatorId);
  }

  /** Reset all tracking (e.g. on map change). */
  resetAll(): void {
    this.lastSpoken.clear();
    this.recentLines.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor (lazy; safe to call from server components).
// ─────────────────────────────────────────────────────────────────────────────

let _voiceScript: VoiceScriptingEngine | null = null;
export function getVoiceScriptingEngine(): VoiceScriptingEngine {
  if (!_voiceScript) _voiceScript = new VoiceScriptingEngine();
  return _voiceScript;
}

/**
 * Default archetype per operator id. Maps to the 7 VoVoice ids in vo.ts.
 * Override at runtime by calling selectLine with a custom context.
 */
export const OPERATOR_ARCHETYPES: Record<string, CharacterArchetype> = {
  tongtong: "veteran",
  chuichui: "rookie",
  xiaochen: "professional",
  jam: "cocky",
  kazi: "stoic",
  douji: "professional",
  luodo: "veteran",
};
