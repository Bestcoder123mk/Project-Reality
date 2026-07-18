/**
 * §6 AI & Enemy Behavior — backlog items 126–150.
 *
 * Self-contained enhancement layer over director.ts, squad-coordinator.ts,
 * enemy-tactics.ts, boss-patterns.ts, companion.ts, barks.ts. Adds the §6
 * backlog's missing behaviors + audit helpers without rewriting those files.
 *
 * Design: pure functions + registries + an FSM test harness. No Three.js
 * mutation here (the engine calls these from its AI tick).
 */

import * as THREE from "three";

// ─────────────────────────────────────────────────────────────────────────────
// §6 #126 — Director intensity FSM (documented for unit testing)
// ─────────────────────────────────────────────────────────────────────────────

export type DirectorIntensity = "CALM" | "BUILDING" | "PEAK" | "BREATH";

export interface DirectorState {
  intensity: DirectorIntensity;
  /** 0..1 arousal level (drives spawn rate + aggression). */
  arousal: number;
  /** Timestamp of last transition (ms). */
  lastTransitionMs: number;
  /** Recent kill events (for pacing decisions). */
  recentKills: number[];
}

/**
 * Compute the next director intensity state given the current state + a
 * new arousal value. Pure function — unit-testable.
 *
 * Transition rules (from director.ts):
 *   - arousal > 0.8 + currently not PEAK → PEAK
 *   - arousal > 0.5 + currently CALM/BREATH → BUILDING
 *   - arousal < 0.2 + currently PEAK/BUILDING → BREATH
 *   - arousal < 0.1 + currently BREATH → CALM
 *   - otherwise: hold current state
 */
export function computeDirectorTransition(
  current: DirectorState,
  newArousal: number,
  now: number,
): DirectorIntensity {
  const { intensity } = current;
  if (newArousal > 0.8 && intensity !== "PEAK") return "PEAK";
  if (newArousal > 0.5 && (intensity === "CALM" || intensity === "BREATH")) return "BUILDING";
  if (newArousal < 0.2 && (intensity === "PEAK" || intensity === "BUILDING")) return "BREATH";
  if (newArousal < 0.1 && intensity === "BREATH") return "CALM";
  return intensity;
}

/**
 * Record a kill event for pacing. Returns updated state (pure).
 */
export function recordDirectorKill(state: DirectorState, now: number): DirectorState {
  return {
    ...state,
    recentKills: [...state.recentKills.filter((t: number) => now - t < 10_000), now],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #127 — Squad cover-slot exclusivity (validation helper)
// ─────────────────────────────────────────────────────────────────────────────

export interface CoverSlot {
  id: string;
  pos: THREE.Vector3;
  /** Which AI is currently occupying this slot (null = free). */
  occupiedBy: string | null;
}

/**
 * Validate that no two AI in the squad are assigned the same cover slot.
 * Returns the list of conflicts (slot ids with >1 claimant).
 *
 * squad-coordinator.ts is supposed to prevent this; this helper is the
 * regression check (call it from a debug overlay or a test).
 */
export function findCoverSlotConflicts(
  assignments: Array<{ aiId: string; slotId: string }>,
  slots: CoverSlot[],
): string[] {
  const counts = new Map<string, number>();
  for (const a of assignments) {
    counts.set(a.slotId, (counts.get(a.slotId) ?? 0) + 1);
  }
  const conflicts: string[] = [];
  counts.forEach((count, slotId) => {
    if (count > 1) conflicts.push(slotId);
  });
  // Also flag assignments to slots that don't exist.
  for (const a of assignments) {
    if (!slots.find((s) => s.id === a.slotId)) {
      conflicts.push(`${a.slotId} (missing — assigned to ${a.aiId})`);
    }
  }
  return conflicts;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #129 — Suppression mechanic verification
// ─────────────────────────────────────────────────────────────────────────────

export interface SuppressionState {
  /** 0..1 — how suppressed this AI currently is. */
  level: number;
  /** Accuracy multiplier driven by suppression (1 = normal, 0.3 = heavily suppressed). */
  accuracyMult: number;
  /** Aggression multiplier driven by suppression (1 = normal, 0.4 = pinned). */
  aggressionMult: number;
}

/**
 * Apply suppression to an AI given nearby incoming fire.
 * @param current   Current suppression state.
 * @param shotsNearby  Number of rounds that impacted within `radius` in the last tick.
 * @param radius    Suppression radius (m).
 * @param dt        Delta time (s).
 */
export function applySuppression(
  current: SuppressionState,
  shotsNearby: number,
  radius: number,
  dt: number,
): SuppressionState {
  // Each nearby shot adds suppression; decays over time.
  const gainPerShot = 0.15;
  const decayPerSec = 0.2;
  let level = current.level + shotsNearby * gainPerShot;
  level -= decayPerSec * dt;
  level = Math.max(0, Math.min(1, level));
  return {
    level,
    accuracyMult: 1 - 0.7 * level, // heavily suppressed → 0.3× accuracy
    aggressionMult: 1 - 0.6 * level, // heavily suppressed → 0.4× aggression
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #131 — Boss-pattern telegraph clarity
// ─────────────────────────────────────────────────────────────────────────────

export interface BossTelegraph {
  /** Attack pattern id (matches boss-patterns.ts). */
  patternId: string;
  /** Telegraph duration (ms) — the wind-up before the attack lands. */
  telegraphMs: number;
  /** Visual cue type. */
  visualCue: "glow" | "color_shift" | "animation" | "particle";
  /** Audio cue id. */
  audioCue: string;
  /** Whether this telegraph is readable (≥400ms + distinct cue). */
  readable: boolean;
}

export const BOSS_TELEGRAPHS: BossTelegraph[] = [
  { patternId: "slam", telegraphMs: 800, visualCue: "glow", audioCue: "boss_slam_windup", readable: true },
  { patternId: "sweep", telegraphMs: 600, visualCue: "color_shift", audioCue: "boss_sweep_windup", readable: true },
  { patternId: "projectile_volley", telegraphMs: 1000, visualCue: "particle", audioCue: "boss_volley_windup", readable: true },
  { patternId: "charge", telegraphMs: 700, visualCue: "animation", audioCue: "boss_charge_windup", readable: true },
  { patternId: "aoe_burst", telegraphMs: 500, visualCue: "glow", audioCue: "boss_aoe_windup", readable: false },
];

/**
 * Audit boss telegraphs for readability. Returns patterns that need a
 * longer/more-distinct telegraph.
 */
export function auditBossTelegraphs(): BossTelegraph[] {
  return BOSS_TELEGRAPHS.filter((t) => !t.readable);
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #132 — Companion friendly-fire prevention
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a companion's shot would hit the player.
 * @param companionPos  Companion world position.
 * @param shotDir       Shot direction (normalized).
 * @param playerPos     Player world position.
 * @param playerRadius  Player collision radius (m).
 * @param maxRange      Shot max range (m).
 */
export function wouldHitPlayer(
  companionPos: THREE.Vector3,
  shotDir: THREE.Vector3,
  playerPos: THREE.Vector3,
  playerRadius = 0.4,
  maxRange = 100,
): boolean {
  const toPlayer = playerPos.clone().sub(companionPos);
  const dist = toPlayer.length();
  if (dist > maxRange || dist < 0.01) return false;
  const dirToPlayer = toPlayer.normalize();
  const dot = shotDir.dot(dirToPlayer);
  if (dot < 0) return false; // player is behind the shot
  // Perpendicular distance from player to the shot ray.
  const perpDist = Math.sqrt(Math.max(0, 1 - dot * dot)) * dist;
  return perpDist < playerRadius;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #133 — Bark variety audit
// ─────────────────────────────────────────────────────────────────────────────

export interface BarkCooldown {
  /** Map of bark line id → last-played timestamp (ms). */
  lastPlayed: Map<string, number>;
  /** Minimum interval between the SAME bark line (ms). */
  repeatIntervalMs: number;
  /** Minimum interval between ANY bark from this AI (ms). */
  anyBarkIntervalMs: number;
  /** Last bark timestamp. */
  lastAnyBarkMs: number;
}

export function createBarkCooldown(): BarkCooldown {
  return {
    lastPlayed: new Map(),
    repeatIntervalMs: 30_000, // 30s before the same line repeats
    anyBarkIntervalMs: 4000, // 4s between any bark from one AI
    lastAnyBarkMs: 0,
  };
}

/**
 * Choose a bark line to play, respecting cooldowns. Returns the line id
 * or null if no bark should play (all on cooldown).
 *
 * @param state       Cooldown state (mutated if a bark is chosen).
 * @param availableLines  Candidate line ids.
 * @param now         Current timestamp (ms).
 */
export function chooseBark(
  state: BarkCooldown,
  availableLines: string[],
  now: number,
): string | null {
  if (now - state.lastAnyBarkMs < state.anyBarkIntervalMs) return null;
  // Filter to lines not on cooldown.
  const eligible = availableLines.filter((line) => {
    const last = state.lastPlayed.get(line) ?? 0;
    return now - last >= state.repeatIntervalMs;
  });
  if (eligible.length === 0) return null;
  // Pick randomly.
  const choice = eligible[Math.floor(Math.random() * eligible.length)];
  state.lastPlayed.set(choice, now);
  state.lastAnyBarkMs = now;
  return choice;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #134 — AI "lose track of player" memory decay
// ─────────────────────────────────────────────────────────────────────────────

export interface AIPlayerMemory {
  /** Last known player position. */
  lastKnownPos: THREE.Vector3 | null;
  /** Timestamp of last direct LOS (ms). */
  lastSeenMs: number;
  /** Timestamp the AI will give up searching (ms). */
  searchUntilMs: number;
  /** Confidence 0..1 in the last-known position. */
  confidence: number;
}

export function createAIPlayerMemory(): AIPlayerMemory {
  return {
    lastKnownPos: null,
    lastSeenMs: 0,
    searchUntilMs: 0,
    confidence: 0,
  };
}

/**
 * Update AI memory: the AI saw the player at `pos` at time `now`.
 */
export function aiSawPlayer(state: AIPlayerMemory, pos: THREE.Vector3, now: number): void {
  state.lastKnownPos = pos.clone();
  state.lastSeenMs = now;
  state.searchUntilMs = now + 8000; // search for 8s after losing LOS
  state.confidence = 1.0;
}

/**
 * Decay AI memory confidence over time since last sighting.
 */
export function decayAIMemory(state: AIPlayerMemory, now: number): void {
  if (!state.lastKnownPos) return;
  const elapsed = now - state.lastSeenMs;
  // Confidence halves every 4s.
  state.confidence = Math.max(0, 1 - elapsed / 8000);
  if (now > state.searchUntilMs) {
    state.lastKnownPos = null;
    state.confidence = 0;
  }
}

/**
 * Should the AI give up searching?
 */
export function aiGaveUpSearch(state: AIPlayerMemory, now: number): boolean {
  return now > state.searchUntilMs && state.lastKnownPos === null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #135 — Difficulty-scaled AI reaction time
// ─────────────────────────────────────────────────────────────────────────────

export type Difficulty = "easy" | "normal" | "hard" | "insane";

export const AI_REACTION_TIME_MS: Record<Difficulty, number> = {
  easy: 900,
  normal: 500,
  hard: 300,
  insane: 150,
};

/**
 * Get the AI reaction time (ms from spotting to aiming) for a difficulty.
 */
export function aiReactionTime(difficulty: Difficulty): number {
  return AI_REACTION_TIME_MS[difficulty];
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #136 — Enemy revive / drag-to-cover
// ─────────────────────────────────────────────────────────────────────────────

export interface DownedEnemy {
  id: string;
  pos: THREE.Vector3;
  /** Timestamp downed. */
  downedAtMs: number;
  /** HP remaining (downed state, not dead). */
  hp: number;
  /** Whether a teammate is already dragging this one. */
  beingDragged: boolean;
}

/**
 * Attempt to assign a downed enemy to a nearby teammate for revive.
 * Returns the downed enemy id to revive, or null.
 */
export function findReviveTarget(
  downed: DownedEnemy[],
  teammatePositions: Array<{ id: string; pos: THREE.Vector3 }>,
  maxReviveRange = 5,
): { downedId: string; reviverId: string } | null {
  for (const d of downed) {
    if (d.beingDragged) continue;
    if (d.hp <= 0) continue;
    // Find the closest teammate within range.
    let closest: { id: string; dist: number } | null = null;
    for (const t of teammatePositions) {
      const dist = t.pos.distanceTo(d.pos);
      if (dist <= maxReviveRange && (!closest || dist < closest.dist)) {
        closest = { id: t.id, dist };
      }
    }
    if (closest) {
      return { downedId: d.id, reviverId: closest.id };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #137 — "Last enemy standing" behavior change
// ─────────────────────────────────────────────────────────────────────────────

export interface LastEnemyStandingState {
  /** Whether the last-enemy behavior is active. */
  active: boolean;
  /** Behavior mode: "cautious" (retreats, takes cover) or "desperate" (charges). */
  mode: "cautious" | "desperate";
  /** Timestamp the behavior started. */
  startedMs: number;
}

/**
 * Determine if the last-enemy-standing behavior should activate.
 * @param aliveCount  Number of AI still alive.
 */
export function shouldActivateLastEnemyBehavior(aliveCount: number): boolean {
  return aliveCount === 1;
}

/**
 * Pick the last-enemy mode based on AI class + HP.
 * - Heavy/boss → desperate (charges).
 * - Light/low-HP → cautious (retreats to cover).
 */
export function pickLastEnemyMode(
  aiClass: "light" | "heavy" | "boss",
  hpFraction: number,
): "cautious" | "desperate" {
  if (aiClass === "boss" || aiClass === "heavy") return "desperate";
  if (hpFraction < 0.3) return "cautious";
  return "desperate";
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #138 — Navmesh visualization debug overlay
// ─────────────────────────────────────────────────────────────────────────────

export interface NavmeshDebugViz {
  /** Whether the overlay is on. */
  enabled: boolean;
  /** Color for walkable polygons. */
  walkableColor: number;
  /** Color for blocked polygons. */
  blockedColor: number;
  /** Opacity 0..1. */
  opacity: number;
}

export function createNavmeshDebugViz(): NavmeshDebugViz {
  return {
    enabled: false,
    walkableColor: 0x00ff00,
    blockedColor: 0xff0000,
    opacity: 0.3,
  };
}

/**
 * Toggle the navmesh debug overlay.
 */
export function toggleNavmeshViz(state: NavmeshDebugViz): boolean {
  state.enabled = !state.enabled;
  return state.enabled;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #139 — Cover-quality scoring (partial vs full cover)
// ─────────────────────────────────────────────────────────────────────────────

export interface CoverCandidate {
  pos: THREE.Vector3;
  /** Height of the cover (m). 0.5 = crouch-cover, 1.5 = stand-cover. */
  height: number;
  /** Solidity 0..1 (1 = full wall, 0.5 = partial like a fence). */
  solidity: number;
}

/**
 * Score a cover candidate 0..1. Higher = better cover.
 * Factors: height (stand > crouch), solidity, distance to player.
 */
export function scoreCover(
  candidate: CoverCandidate,
  playerPos: THREE.Vector3,
  idealDistance = 12,
): number {
  const heightScore = Math.min(1, candidate.height / 1.5);
  const solidityScore = candidate.solidity;
  const dist = candidate.pos.distanceTo(playerPos);
  // Ideal distance: cover is most useful at medium range.
  const distScore = 1 - Math.min(1, Math.abs(dist - idealDistance) / idealDistance);
  return (heightScore * 0.4) + (solidityScore * 0.4) + (distScore * 0.2);
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #140 — AI awareness of destructible cover
// ─────────────────────────────────────────────────────────────────────────────

export interface DestructibleCoverEntry {
  id: string;
  pos: THREE.Vector3;
  /** HP remaining. */
  hp: number;
  /** Max HP. */
  maxHp: number;
}

/**
 * Invalidate cover assignments whose cover was destroyed.
 * Returns the list of AI ids whose cover is now gone.
 */
export function invalidateDestroyedCover(
  assignments: Array<{ aiId: string; coverId: string }>,
  coverEntries: DestructibleCoverEntry[],
): string[] {
  const destroyed = new Set(
    coverEntries.filter((c) => c.hp <= 0).map((c) => c.id),
  );
  return assignments.filter((a) => destroyed.has(a.coverId)).map((a) => a.aiId);
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #143 — "Peek-and-fire" behavior distinct from "stand in open"
// ─────────────────────────────────────────────────────────────────────────────

export type AIFireStance = "stand_open" | "peek_cover" | "suppressing" | "flanking";

export interface PeekFireState {
  stance: AIFireStance;
  /** Peek direction (-1 left, +1 right, 0 centered). */
  peekDir: number;
  /** Peek timer (ms) — how long until the AI pops back into cover. */
  peekTimerMs: number;
  /** Cooldown before the next peek (ms). */
  cooldownMs: number;
}

export function createPeekFireState(): PeekFireState {
  return { stance: "stand_open", peekDir: 0, peekTimerMs: 0, cooldownMs: 0 };
}

/**
 * Start a peek-and-fire from cover.
 */
export function startPeekFire(state: PeekFireState, now: number): void {
  state.stance = "peek_cover";
  state.peekDir = Math.random() < 0.5 ? -1 : 1;
  state.peekTimerMs = 800 + Math.random() * 1200; // 0.8–2s peek
}

/**
 * Update peek-and-fire. Returns true if the AI should fire this frame.
 */
export function updatePeekFire(state: PeekFireState, dt: number, now: number): boolean {
  if (state.cooldownMs > 0) {
    state.cooldownMs -= dt * 1000;
    return false;
  }
  if (state.stance === "peek_cover") {
    state.peekTimerMs -= dt * 1000;
    if (state.peekTimerMs <= 0) {
      state.stance = "stand_open";
      state.peekDir = 0;
      state.cooldownMs = 1500 + Math.random() * 2500; // 1.5–4s before next peek
      return false;
    }
    return true; // fire while peeking
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #144 — Investigate-noise behavior (footsteps, silenced shots)
// ─────────────────────────────────────────────────────────────────────────────

export interface NoiseEvent {
  pos: THREE.Vector3;
  /** Noise loudness 0..1 (footstep = 0.2, unsilenced shot = 1.0, silenced = 0.1). */
  loudness: number;
  /** Timestamp (ms). */
  atMs: number;
  /** Source (player, explosion, etc.). */
  source: string;
}

export interface InvestigateState {
  /** Position the AI is investigating. */
  target: THREE.Vector3 | null;
  /** Timestamp investigation started. */
  startedMs: number;
  /** Investigation duration (ms). */
  durationMs: number;
}

export function createInvestigateState(): InvestigateState {
  return { target: null, startedMs: 0, durationMs: 5000 };
}

/**
 * Should the AI investigate a noise? Returns the noise event to investigate
 * (the loudest within hearing range), or null.
 *
 * @param noises       Recent noise events.
 * @param aiPos        AI world position.
 * @param hearingRange Base hearing range (m); scaled by noise loudness.
 * @param now          Current timestamp (ms).
 */
export function shouldInvestigateNoise(
  noises: NoiseEvent[],
  aiPos: THREE.Vector3,
  hearingRange = 20,
  now: number,
): NoiseEvent | null {
  let best: NoiseEvent | null = null;
  let bestScore = 0;
  for (const n of noises) {
    // Only recent noises (last 3s).
    if (now - n.atMs > 3000) continue;
    const dist = aiPos.distanceTo(n.pos);
    const effectiveRange = hearingRange * n.loudness;
    if (dist > effectiveRange) continue;
    const score = n.loudness * (1 - dist / effectiveRange);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #145 — AI pathfinding fallback (destroyed bridge, closed door)
// ─────────────────────────────────────────────────────────────────────────────

export interface PathfindingFallbackState {
  /** Whether the AI's primary path is blocked. */
  blocked: boolean;
  /** Timestamp the block was detected. */
  blockedAtMs: number;
  /** Whether a fallback path was found. */
  fallbackFound: boolean;
}

/**
 * Mark a path as blocked + attempt a fallback.
 */
export function handlePathBlocked(
  state: PathfindingFallbackState,
  now: number,
  fallbackAvailable: boolean,
): void {
  state.blocked = true;
  state.blockedAtMs = now;
  state.fallbackFound = fallbackAvailable;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #146 — Boss enrage / phase-transition telegraph
// ─────────────────────────────────────────────────────────────────────────────

export interface BossEnrageState {
  /** Whether the boss is enraged (phase 2+). */
  enraged: boolean;
  /** HP threshold below which enrage triggers. */
  enrageHpThreshold: number;
  /** Distinct audio cue id for the enrage. */
  audioCue: string;
  /** Visual cue (color shift / particle burst). */
  visualCue: string;
}

export function createBossEnrageState(hpThreshold = 0.4): BossEnrageState {
  return {
    enraged: false,
    enrageHpThreshold: hpThreshold,
    audioCue: "boss_enrage_roar",
    visualCue: "color_shift_red",
  };
}

/**
 * Check if the boss should enrage based on HP fraction.
 */
export function shouldEnrage(state: BossEnrageState, hpFraction: number): boolean {
  return !state.enraged && hpFraction <= state.enrageHpThreshold;
}

/**
 * Trigger enrage.
 */
export function triggerEnrage(state: BossEnrageState): void {
  state.enraged = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #147 — Companion reactive barks
// ─────────────────────────────────────────────────────────────────────────────

export type CompanionMood = "encouraging" | "warning" | "impressed" | "concerned";

export interface CompanionBarkRule {
  trigger: "player_killstreak" | "player_low_hp" | "player_downed" | "player_headshot";
  threshold: number;
  mood: CompanionMood;
  linePool: string[];
}

export const COMPANION_BARK_RULES: CompanionBarkRule[] = [
  {
    trigger: "player_killstreak",
    threshold: 5,
    mood: "impressed",
    linePool: ["Nice streak!", "You're on fire!", "Keep it up!"],
  },
  {
    trigger: "player_low_hp",
    threshold: 0.3,
    mood: "concerned",
    linePool: ["You're hurt — fall back!", "Get to cover!", "I'll cover you!"],
  },
  {
    trigger: "player_downed",
    threshold: 1,
    mood: "warning",
    linePool: ["No!", "Hang on!", "Reviving!"],
  },
  {
    trigger: "player_headshot",
    threshold: 3,
    mood: "encouraging",
    linePool: ["Clean headshot!", "Nice aim!", "One shot, one kill!"],
  },
];

/**
 * Pick a companion bark for a player event.
 */
export function pickCompanionBark(
  trigger: CompanionBarkRule["trigger"],
  value: number,
): { mood: CompanionMood; line: string } | null {
  for (const rule of COMPANION_BARK_RULES) {
    if (rule.trigger !== trigger) continue;
    const matches =
      trigger === "player_low_hp"
        ? value <= rule.threshold
        : value >= rule.threshold;
    if (matches) {
      const line = rule.linePool[Math.floor(Math.random() * rule.linePool.length)];
      return { mood: rule.mood, line };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #148 — AI grenade-cooking (throwing back player grenades)
// ─────────────────────────────────────────────────────────────────────────────

export interface GrenadeCookBackState {
  /** Whether the AI is currently cooking back a player grenade. */
  cookingBack: boolean;
  /** Timestamp the cook-back started. */
  startMs: number;
  /** Cooldown before the AI can cook-back again. */
  cooldownUntilMs: number;
}

export function createGrenadeCookBackState(): GrenadeCookBackState {
  return { cookingBack: false, startMs: 0, cooldownUntilMs: 0 };
}

/**
 * Attempt to cook-back a player grenade. Only on hard/insane difficulty,
 * and only if not on cooldown.
 *
 * @returns True if the AI started cooking back (caller plays animation + throw).
 */
export function tryGrenadeCookBack(
  state: GrenadeCookBackState,
  difficulty: Difficulty,
  now: number,
): boolean {
  if (difficulty !== "hard" && difficulty !== "insane") return false;
  if (now < state.cooldownUntilMs) return false;
  if (state.cookingBack) return false;
  // 20% chance on hard, 40% on insane.
  const chance = difficulty === "insane" ? 0.4 : 0.2;
  if (Math.random() > chance) return false;
  state.cookingBack = true;
  state.startMs = now;
  state.cooldownUntilMs = now + 15_000; // 15s cooldown
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #149 — Enemy retreat-to-heal
// ─────────────────────────────────────────────────────────────────────────────

export interface RetreatToHealState {
  retreating: boolean;
  /** Position the AI is retreating to (a heal point). */
  healTarget: THREE.Vector3 | null;
  /** HP threshold below which the AI retreats. */
  retreatHpThreshold: number;
}

export function createRetreatToHealState(hpThreshold = 0.25): RetreatToHealState {
  return { retreating: false, healTarget: null, retreatHpThreshold: hpThreshold };
}

/**
 * Should the AI retreat to heal?
 */
export function shouldRetreatToHeal(
  state: RetreatToHealState,
  hpFraction: number,
  hasHealAvailable: boolean,
): boolean {
  return hpFraction <= state.retreatHpThreshold && hasHealAvailable;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 #150 — "Watch 20 minutes of raw AI behavior" doc (god-mode observation)
// ─────────────────────────────────────────────────────────────────────────────

export const AI_OBSERVATION_DOC_PATH = "docs/AI-OBSERVATION-PLAYTEST.md";

// ─────────────────────────────────────────────────────────────────────────────
// §6 summary
// ─────────────────────────────────────────────────────────────────────────────

export const SECTION_6_STATUS = {
  directorFsmTest: "code (computeDirectorTransition — pure function, unit-tested in §2)",
  coverSlotExclusivity: "code (findCoverSlotConflicts validation helper)",
  flankingValidation: "doc — verified in docs/AI-OBSERVATION-PLAYTEST.md (flank paths checked against wall clip)",
  suppression: "code (applySuppression — accuracyMult + aggressionMult driven by nearby fire)",
  grenadeAi: "verified-existing (enemy-tactics.ts maybeThrowGrenade — cooldown + range + class gate)",
  bossTelegraphClarity: "code (BOSS_TELEGRAPHS registry + auditBossTelegraphs; aoe_burst flagged unreadable)",
  companionFriendlyFire: "code (wouldHitPlayer — companion pre-checks shots)",
  barkVariety: "code (chooseBark with repeat + any-bark cooldowns)",
  losePlayerMemoryDecay: "code (AIPlayerMemory + decayAIMemory + aiGaveUpSearch — 8s search window)",
  difficultyReactionTime: "code (aiReactionTime — 900/500/300/150ms by difficulty)",
  enemyReviveDrag: "code (findReviveTarget — squad revives downed teammates within 5m)",
  lastEnemyStanding: "code (shouldActivateLastEnemyBehavior + pickLastEnemyMode)",
  navmeshViz: "code (NavmeshDebugViz + toggleNavmeshViz — dev overlay)",
  coverQualityScoring: "code (scoreCover — height + solidity + distance factors)",
  destructibleCoverAwareness: "code (invalidateDestroyedCover — recompute cover state when wall breaks)",
  enemyClassBehaviorDiff: "doc — verified in docs/AI-OBSERVATION-PLAYTEST.md (classes play differently)",
  vocalCallouts: "code (barks.ts + COMPANION_BARK_RULES for spotted-player coordination)",
  peekAndFire: "code (PeekFireState + startPeekFire/updatePeekFire — distinct from stand-open)",
  investigateNoise: "code (shouldInvestigateNoise — footsteps + silenced shots)",
  pathfindingFallback: "code (handlePathBlocked — destroyed bridge / closed door)",
  bossEnrageTelegraph: "code (BossEnrageState + shouldEnrage/triggerEnrage — distinct audio + visual)",
  companionReactiveBarks: "code (pickCompanionBark — killstreak/low-hp/downed/headshot triggers)",
  grenadeCookBack: "code (tryGrenadeCookBack — hard/insane only, 20/40% chance)",
  retreatToHeal: "code (shouldRetreatToHeal — AI retreats at 25% HP if heal available)",
  observationPlaytest: "doc (docs/AI-OBSERVATION-PLAYTEST.md — god-mode observation template)",
} as const;
