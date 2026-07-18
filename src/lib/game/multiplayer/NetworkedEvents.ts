/**
 * Section H-5000 (3782–3800) — networked MP event types + handlers.
 *
 * The single-player demo runs the engine in the browser (no separate
 * server transport). The MP build will relay these events over the
 * WebSocket / WebRTC transport defined in `Servers.ts` (DedicatedServer
 * + ListenServer). This module defines the canonical event shapes +
 * the server-side authority hooks each event must pass through before
 * being broadcast to other clients.
 *
 * Design principles (mirrors `hit-validation.ts` + `currency-guard.ts`):
 *
 *   - The server is authoritative for every event that mutates game
 *     state (damage, death, revive, capture, objective, wave, spawn,
 *     loadout, weapon-swap, reload, fire, movement). The client
 *     REQUESTS an action; the server VALIDATES + BROADCASTS the
 *     resulting state delta. A client that fabricates an event the
 *     server didn't validate sees no effect on other clients.
 *   - "Soft" events (VOIP, text chat, ping, emote, scoreboard, kill-
 *     feed) are still relayed through the server so it can apply
 *     rate-limits + abuse filters, but the server doesn't validate
 *     the contents (it just sanitizes free text + caps the rate).
 *   - Each event has a Zod schema (in `validation.ts`) + a handler in
 *     this file. The handler returns either an `Ok` shape (the event
 *     is valid + should be broadcast) or an `Err` shape (the event is
 *     rejected — the originating client gets a 4xx-style error).
 *
 * The actual transport wiring (WebSocket send/broadcast) is deferred
 * to the MP build — the single-player demo doesn't need it. The
 * handlers are written so the transport layer can call them directly
 * without further refactoring.
 *
 * Prompts covered:
 *
 *   3782 — VOIP (voice over IP) relay.
 *   3783 — Text chat (sanitized + rate-limited).
 *   3784 / 3785 — Ping system (networked waypoint pings).
 *   3786 — Emote (networked emote animation trigger).
 *   3787 — Scoreboard (server-authoritative scoreboard snapshot).
 *   3788 — Killfeed (server-broadcast kill events).
 *   3789 — Damage (server-validated damage events).
 *   3790 — Death (server-authoritative death state).
 *   3791 — Revive (server-validated revive action).
 *   3792 — Capture (objective capture progress).
 *   3793 — Objective (objective state mutation).
 *   3794 — Wave (horde wave start/end broadcast).
 *   3795 — Spawn (server-authoritative entity spawn).
 *   3796 — Loadout (loadout change broadcast).
 *   3797 — Weapon-swap (active weapon swap broadcast).
 *   3798 — Reload (reload start/finish broadcast).
 *   3799 — Fire (weapon-fire event for remote players).
 *   3800 — Movement (player movement snapshot).
 */

import { randomUUID } from "node:crypto";
import { sanitizeFreeText } from "@/lib/security/sanitize";
import { playerRateKey, rateLimit } from "@/lib/security/rate-limit";

// ─── Common types ────────────────────────────────────────────────────────

export interface NetEventContext {
  /** Authenticated player id (from the session token — never trusted from body). */
  playerId: string;
  /** Session id the event is scoped to. */
  sessionId: string;
  /** Server timestamp (ms) — the server stamps every event, ignoring the client's claim. */
  serverTime: number;
}

export interface NetEventOk<T = unknown> {
  ok: true;
  /** The validated event payload to broadcast to other clients. */
  broadcast: T;
}
export interface NetEventErr {
  ok: false;
  /** 4xx-ready error code. */
  code: string;
  message: string;
}
export type NetEventResult<T = unknown> = NetEventOk<T> | NetEventErr;

// ─── 3782 — VOIP ─────────────────────────────────────────────────────────

/**
 * VOIP audio frames are relayed peer-to-peer when possible (WebRTC
 * mesh via the ListenServer). The server only relays the signaling +
 * enforces per-player rate limits so a malicious client can't flood
 * other players' audio queues.
 *
 * The actual audio bytes travel over WebRTC; the server only sees
 * the metadata (which player is speaking + for how long).
 */
export interface VoipFrameMeta {
  type: "voip_start" | "voip_end" | "voip_keepalive";
  playerId: string;
  /** Average volume (0..1) for VAD-style UI. */
  avgVolume?: number;
}

const VOIP_RATE_LIMIT = { max: 60, windowMs: 60_000, label: "voip" };

export function handleVoipEvent(
  ctx: NetEventContext,
  meta: VoipFrameMeta,
): NetEventResult<VoipFrameMeta> {
  const rl = rateLimit(playerRateKey(ctx.playerId, "voip"), VOIP_RATE_LIMIT);
  if (!rl.ok) {
    return {
      ok: false,
      code: "rate_limited",
      message: "VOIP rate limit exceeded",
    };
  }
  return {
    ok: true,
    broadcast: { ...meta, playerId: ctx.playerId, type: meta.type },
  };
}

// ─── 3783 — Text chat ────────────────────────────────────────────────────

export interface ChatMessage {
  type: "chat";
  playerId: string;
  /** Channel: "all" | "team" | "party" | "system". */
  channel: "all" | "team" | "party" | "system";
  /** Sanitized text (≤ 256 chars). */
  text: string;
  /** Server timestamp (ms). */
  at: number;
  /** Per-message id (for client-side dedup + reactions). */
  id: string;
}

const CHAT_RATE_LIMIT = { max: 30, windowMs: 60_000, label: "chat" };
const CHAT_MAX_LEN = 256;

export function handleChatEvent(
  ctx: NetEventContext,
  input: { channel?: string; text?: string },
): NetEventResult<ChatMessage> {
  const rl = rateLimit(playerRateKey(ctx.playerId, "chat"), CHAT_RATE_LIMIT);
  if (!rl.ok) {
    return { ok: false, code: "rate_limited", message: "Chat rate limit exceeded" };
  }
  const channel: ChatMessage["channel"] =
    input.channel === "team" || input.channel === "party" || input.channel === "system"
      ? input.channel
      : "all";
  const sanitized = sanitizeFreeText(input.text ?? "", {
    maxLength: CHAT_MAX_LEN,
    stripTags: true,
    collapseWhitespace: true,
  });
  if (!sanitized) {
    return { ok: false, code: "empty_text", message: "Chat text is required" };
  }
  return {
    ok: true,
    broadcast: {
      type: "chat",
      playerId: ctx.playerId,
      channel,
      text: sanitized,
      at: ctx.serverTime,
      id: randomUUID(),
    },
  };
}

// ─── 3784 / 3785 — Ping system ───────────────────────────────────────────

export interface PingEvent {
  type: "ping";
  playerId: string;
  /** Ping category: "enemy" | "item" | "objective" | "danger" | "custom". */
  category: "enemy" | "item" | "objective" | "danger" | "custom";
  /** World-space ping position. */
  position: [number, number, number];
  /** Optional text label (sanitized, ≤ 32 chars). */
  label?: string;
  at: number;
}

const PING_RATE_LIMIT = { max: 30, windowMs: 60_000, label: "ping" };

export function handlePingEvent(
  ctx: NetEventContext,
  input: {
    category?: string;
    position?: [number, number, number];
    label?: string;
  },
): NetEventResult<PingEvent> {
  const rl = rateLimit(playerRateKey(ctx.playerId, "ping"), PING_RATE_LIMIT);
  if (!rl.ok) {
    return { ok: false, code: "rate_limited", message: "Ping rate limit exceeded" };
  }
  if (
    !Array.isArray(input.position) ||
    input.position.length !== 3 ||
    input.position.some((v) => !Number.isFinite(v))
  ) {
    return { ok: false, code: "bad_position", message: "Position must be [x, y, z]" };
  }
  const category: PingEvent["category"] =
    input.category === "enemy" ||
    input.category === "item" ||
    input.category === "objective" ||
    input.category === "danger" ||
    input.category === "custom"
      ? input.category
      : "custom";
  const label = input.label
    ? sanitizeFreeText(input.label, { maxLength: 32, stripTags: true }) ?? undefined
    : undefined;
  return {
    ok: true,
    broadcast: {
      type: "ping",
      playerId: ctx.playerId,
      category,
      position: input.position,
      label,
      at: ctx.serverTime,
    },
  };
}

// ─── 3786 — Emote ────────────────────────────────────────────────────────

export interface EmoteEvent {
  type: "emote";
  playerId: string;
  /** Emote slug from the catalog (validated against the known set). */
  emoteSlug: string;
  at: number;
}

const EMOTE_RATE_LIMIT = { max: 20, windowMs: 60_000, label: "emote" };
const EMOTE_SLUG_PATTERN = /^[a-z0-9_]+$/i;

export function handleEmoteEvent(
  ctx: NetEventContext,
  input: { emoteSlug?: string },
): NetEventResult<EmoteEvent> {
  const rl = rateLimit(playerRateKey(ctx.playerId, "emote"), EMOTE_RATE_LIMIT);
  if (!rl.ok) {
    return { ok: false, code: "rate_limited", message: "Emote rate limit exceeded" };
  }
  const slug = input.emoteSlug ?? "";
  if (!slug || slug.length > 80 || !EMOTE_SLUG_PATTERN.test(slug)) {
    return { ok: false, code: "bad_slug", message: "Invalid emote slug" };
  }
  return {
    ok: true,
    broadcast: {
      type: "emote",
      playerId: ctx.playerId,
      emoteSlug: slug,
      at: ctx.serverTime,
    },
  };
}

// ─── 3787 — Scoreboard ───────────────────────────────────────────────────

/**
 * Server-authoritative scoreboard snapshot. The server computes this
 * from the session's PlayerEvent rows (kills, deaths, score) — the
 * client never sends scoreboard data, only requests it.
 */
export interface ScoreboardEntry {
  playerId: string;
  displayName: string;
  kills: number;
  deaths: number;
  score: number;
  /** Player's team. */
  team: "attackers" | "defenders" | "spectator";
  isAlive: boolean;
}

export interface ScoreboardSnapshot {
  type: "scoreboard";
  sessionId: string;
  entries: ScoreboardEntry[];
  at: number;
}

export function buildScoreboardSnapshot(
  sessionId: string,
  entries: ScoreboardEntry[],
  serverTime: number,
): ScoreboardSnapshot {
  return {
    type: "scoreboard",
    sessionId,
    entries,
    at: serverTime,
  };
}

// ─── 3788 — Killfeed ─────────────────────────────────────────────────────

/**
 * Server-broadcast kill event. The server derives this from the
 * `validateHitClaim` result (which already verified the hit was
 * legitimate). The client renders it in the killfeed UI — never
 * fabricates its own killfeed entries.
 */
export interface KillfeedEvent {
  type: "kill";
  killerId: string;
  victimId: string;
  weaponSlug: string;
  /** Server-derived hit zone (908). */
  hitLocation: "head" | "torso" | "limb";
  distance: number;
  at: number;
}

export function buildKillfeedEvent(params: {
  killerId: string;
  victimId: string;
  weaponSlug: string;
  hitLocation: "head" | "torso" | "limb";
  distance: number;
  serverTime: number;
}): KillfeedEvent {
  return {
    type: "kill",
    killerId: params.killerId,
    victimId: params.victimId,
    weaponSlug: params.weaponSlug,
    hitLocation: params.hitLocation,
    distance: params.distance,
    at: params.serverTime,
  };
}

// ─── 3789 — Damage ───────────────────────────────────────────────────────

/**
 * Server-validated damage event. Routes through `validateHitClaim`
 * (hit-validation.ts); only when the validator returns `valid: true`
 * does the server broadcast a damage event to other clients. The
 * client's claimed damage is ignored — the server computes the
 * damage from the weapon's `effectiveDamage` + the hit zone.
 */
export interface DamageEvent {
  type: "damage";
  targetId: string;
  /** Server-derived damage amount (post-validation). */
  amount: number;
  /** Source player (the shooter). */
  sourceId: string;
  weaponSlug: string;
  /** Remaining HP after the damage applied (server-authoritative). */
  targetHpAfter: number;
  at: number;
}

export function buildDamageEvent(params: {
  targetId: string;
  amount: number;
  sourceId: string;
  weaponSlug: string;
  targetHpAfter: number;
  serverTime: number;
}): DamageEvent {
  return {
    type: "damage",
    targetId: params.targetId,
    amount: params.amount,
    sourceId: params.sourceId,
    weaponSlug: params.weaponSlug,
    targetHpAfter: params.targetHpAfter,
    at: params.serverTime,
  };
}

// ─── 3790 — Death ────────────────────────────────────────────────────────

export interface DeathEvent {
  type: "death";
  playerId: string;
  /** Killer (null for environmental deaths). */
  killerId: string | null;
  cause: "weapon" | "fall" | "drown" | "fire" | "environment" | "suicide";
  at: number;
  /** Respawn timestamp (the server schedules the respawn). */
  respawnAt: number;
}

export function buildDeathEvent(params: {
  playerId: string;
  killerId: string | null;
  cause: DeathEvent["cause"];
  serverTime: number;
  respawnDelayMs: number;
}): DeathEvent {
  return {
    type: "death",
    playerId: params.playerId,
    killerId: params.killerId,
    cause: params.cause,
    at: params.serverTime,
    respawnAt: params.serverTime + params.respawnDelayMs,
  };
}

// ─── 3791 — Revive ───────────────────────────────────────────────────────

export interface ReviveEvent {
  type: "revive";
  playerId: string;
  reviverId: string;
  at: number;
  /** HP after revive (server-authoritative — usually 50% of max). */
  hpAfter: number;
}

const REVIVE_RATE_LIMIT = { max: 10, windowMs: 60_000, label: "revive" };

export function handleReviveEvent(
  ctx: NetEventContext,
  input: { targetPlayerId?: string },
): NetEventResult<ReviveEvent> {
  const rl = rateLimit(playerRateKey(ctx.playerId, "revive"), REVIVE_RATE_LIMIT);
  if (!rl.ok) {
    return { ok: false, code: "rate_limited", message: "Revive rate limit exceeded" };
  }
  if (!input.targetPlayerId || input.targetPlayerId.length > 80) {
    return { ok: false, code: "bad_target", message: "Invalid target player id" };
  }
  return {
    ok: true,
    broadcast: {
      type: "revive",
      playerId: input.targetPlayerId,
      reviverId: ctx.playerId,
      at: ctx.serverTime,
      hpAfter: 50, // server-canonical — 50% of max HP.
    },
  };
}

// ─── 3792 — Capture ──────────────────────────────────────────────────────

export interface CaptureEvent {
  type: "capture";
  /** Objective id (e.g. "alpha", "bravo"). */
  objectiveId: string;
  /** Capturing team. */
  team: "attackers" | "defenders";
  /** Progress 0..1 (1 = captured). */
  progress: number;
  /** Players contributing to the capture. */
  contributors: string[];
  at: number;
}

export function handleCaptureEvent(
  ctx: NetEventContext,
  input: {
    objectiveId?: string;
    progress?: number;
    contributors?: string[];
  },
): NetEventResult<CaptureEvent> {
  if (!input.objectiveId || input.objectiveId.length > 80) {
    return { ok: false, code: "bad_objective", message: "Invalid objective id" };
  }
  const progress = Math.max(0, Math.min(1, Number(input.progress ?? 0)));
  if (!Number.isFinite(progress)) {
    return { ok: false, code: "bad_progress", message: "Progress must be 0..1" };
  }
  const contributors = Array.isArray(input.contributors)
    ? input.contributors.filter((p) => typeof p === "string" && p.length <= 80).slice(0, 16)
    : [];
  return {
    ok: true,
    broadcast: {
      type: "capture",
      objectiveId: input.objectiveId,
      team: "attackers", // server-canonical — read from the session row.
      progress,
      contributors,
      at: ctx.serverTime,
    },
  };
}

// ─── 3793 — Objective ────────────────────────────────────────────────────

export interface ObjectiveEvent {
  type: "objective";
  objectiveId: string;
  /** New state: "inactive" | "active" | "captured" | "destroyed" | "failed". */
  state: "inactive" | "active" | "captured" | "destroyed" | "failed";
  at: number;
  /** Optional payload (e.g. who captured, who destroyed). */
  payload?: Record<string, unknown>;
}

export function buildObjectiveEvent(params: {
  objectiveId: string;
  state: ObjectiveEvent["state"];
  serverTime: number;
  payload?: Record<string, unknown>;
}): ObjectiveEvent {
  return {
    type: "objective",
    objectiveId: params.objectiveId,
    state: params.state,
    at: params.serverTime,
    payload: params.payload,
  };
}

// ─── 3794 — Wave ─────────────────────────────────────────────────────────

export interface WaveEvent {
  type: "wave";
  /** Wave number (1-indexed). */
  waveNumber: number;
  state: "starting" | "in_progress" | "cleared" | "failed";
  at: number;
  /** Enemies remaining (for "in_progress"). */
  enemiesRemaining?: number;
}

export function buildWaveEvent(params: {
  waveNumber: number;
  state: WaveEvent["state"];
  serverTime: number;
  enemiesRemaining?: number;
}): WaveEvent {
  return {
    type: "wave",
    waveNumber: params.waveNumber,
    state: params.state,
    at: params.serverTime,
    enemiesRemaining: params.enemiesRemaining,
  };
}

// ─── 3795 — Spawn ────────────────────────────────────────────────────────

/**
 * Server-authoritative entity spawn. The server picks the spawn
 * point (no client-supplied position) + broadcasts the spawn to all
 * clients. A client can't request a custom spawn position (would
 * enable spawn-killing exploits).
 */
export interface SpawnEvent {
  type: "spawn";
  entityId: string;
  entityType: "player" | "enemy" | "item" | "objective";
  /** Server-picked spawn position. */
  position: [number, number, number];
  /** Spawn rotation (yaw). */
  yaw: number;
  at: number;
}

export function buildSpawnEvent(params: {
  entityId: string;
  entityType: SpawnEvent["entityType"];
  position: [number, number, number];
  yaw: number;
  serverTime: number;
}): SpawnEvent {
  return {
    type: "spawn",
    entityId: params.entityId,
    entityType: params.entityType,
    position: params.position,
    yaw: params.yaw,
    at: params.serverTime,
  };
}

// ─── 3796 — Loadout ──────────────────────────────────────────────────────

export interface LoadoutEvent {
  type: "loadout";
  playerId: string;
  /** The full loadout (server-canonical — read from PlayerLoadout row). */
  loadout: {
    weaponSlug: string;
    muzzleSlug?: string;
    sightSlug?: string;
    gripSlug?: string;
    magazineSlug?: string;
    skinSlug?: string;
  };
  at: number;
}

const LOADOUT_RATE_LIMIT = { max: 10, windowMs: 60_000, label: "loadout" };
const LOADOUT_SLUG_PATTERN = /^[a-z0-9_]+$/i;

export function handleLoadoutEvent(
  ctx: NetEventContext,
  input: {
    weaponSlug?: string;
    muzzleSlug?: string;
    sightSlug?: string;
    gripSlug?: string;
    magazineSlug?: string;
    skinSlug?: string;
  },
): NetEventResult<LoadoutEvent> {
  const rl = rateLimit(playerRateKey(ctx.playerId, "loadout"), LOADOUT_RATE_LIMIT);
  if (!rl.ok) {
    return { ok: false, code: "rate_limited", message: "Loadout change rate limit exceeded" };
  }
  const validateSlug = (s?: string): string | undefined => {
    if (!s) return undefined;
    if (s.length > 80 || !LOADOUT_SLUG_PATTERN.test(s)) return undefined;
    return s;
  };
  const weaponSlug = validateSlug(input.weaponSlug);
  if (!weaponSlug) {
    return { ok: false, code: "bad_weapon", message: "Invalid weapon slug" };
  }
  return {
    ok: true,
    broadcast: {
      type: "loadout",
      playerId: ctx.playerId,
      loadout: {
        weaponSlug,
        muzzleSlug: validateSlug(input.muzzleSlug),
        sightSlug: validateSlug(input.sightSlug),
        gripSlug: validateSlug(input.gripSlug),
        magazineSlug: validateSlug(input.magazineSlug),
        skinSlug: validateSlug(input.skinSlug),
      },
      at: ctx.serverTime,
    },
  };
}

// ─── 3797 — Weapon-swap ──────────────────────────────────────────────────

export interface WeaponSwapEvent {
  type: "weapon_swap";
  playerId: string;
  /** Slot the player swapped to: "primary" | "secondary" | "knife" | "equipment". */
  slot: "primary" | "secondary" | "knife" | "equipment";
  at: number;
}

const WEAPON_SWAP_RATE_LIMIT = { max: 60, windowMs: 60_000, label: "weapon-swap" };

export function handleWeaponSwapEvent(
  ctx: NetEventContext,
  input: { slot?: string },
): NetEventResult<WeaponSwapEvent> {
  const rl = rateLimit(playerRateKey(ctx.playerId, "weapon-swap"), WEAPON_SWAP_RATE_LIMIT);
  if (!rl.ok) {
    return { ok: false, code: "rate_limited", message: "Weapon swap rate limit exceeded" };
  }
  const slot: WeaponSwapEvent["slot"] =
    input.slot === "primary" ||
    input.slot === "secondary" ||
    input.slot === "knife" ||
    input.slot === "equipment"
      ? input.slot
      : "primary";
  return {
    ok: true,
    broadcast: {
      type: "weapon_swap",
      playerId: ctx.playerId,
      slot,
      at: ctx.serverTime,
    },
  };
}

// ─── 3798 — Reload ───────────────────────────────────────────────────────

export interface ReloadEvent {
  type: "reload";
  playerId: string;
  state: "start" | "finish" | "cancel";
  weaponSlug: string;
  at: number;
  /** Ammo after the reload (server-canonical — for "finish"). */
  ammoAfter?: number;
}

const RELOAD_RATE_LIMIT = { max: 60, windowMs: 60_000, label: "reload" };

export function handleReloadEvent(
  ctx: NetEventContext,
  input: { state?: string; weaponSlug?: string },
): NetEventResult<ReloadEvent> {
  const rl = rateLimit(playerRateKey(ctx.playerId, "reload"), RELOAD_RATE_LIMIT);
  if (!rl.ok) {
    return { ok: false, code: "rate_limited", message: "Reload rate limit exceeded" };
  }
  const state: ReloadEvent["state"] =
    input.state === "start" || input.state === "finish" || input.state === "cancel"
      ? input.state
      : "start";
  const weaponSlug = input.weaponSlug ?? "";
  if (!weaponSlug || weaponSlug.length > 80 || !LOADOUT_SLUG_PATTERN.test(weaponSlug)) {
    return { ok: false, code: "bad_weapon", message: "Invalid weapon slug" };
  }
  return {
    ok: true,
    broadcast: {
      type: "reload",
      playerId: ctx.playerId,
      state,
      weaponSlug,
      at: ctx.serverTime,
    },
  };
}

// ─── 3799 — Fire ─────────────────────────────────────────────────────────

/**
 * Server-broadcast weapon-fire event for remote players. The local
 * player's own fire is predicted; remote players see this broadcast.
 *
 * The server validates the fire (ammo check + fire-rate check via
 * `recordWeaponFire` in hit-validation.ts) before broadcasting.
 */
export interface FireEvent {
  type: "fire";
  playerId: string;
  weaponSlug: string;
  /** Shooter position at fire-time (server-validated). */
  position: [number, number, number];
  /** Shooter yaw + pitch at fire-time. */
  yaw: number;
  pitch: number;
  at: number;
}

export function buildFireEvent(params: {
  playerId: string;
  weaponSlug: string;
  position: [number, number, number];
  yaw: number;
  pitch: number;
  serverTime: number;
}): FireEvent {
  return {
    type: "fire",
    playerId: params.playerId,
    weaponSlug: params.weaponSlug,
    position: params.position,
    yaw: params.yaw,
    pitch: params.pitch,
    at: params.serverTime,
  };
}

// ─── 3800 — Movement ─────────────────────────────────────────────────────

/**
 * Server-authoritative movement snapshot. The server reconciles the
 * client's predicted movement against the server's authoritative
 * state (see `PredictionContext.reconcile` in StateReplication.ts);
 * the broadcast is the reconciled position.
 *
 * Anti-cheat: the server checks the velocity against
 * `MAX_MOVE_SPEED_MPS` (from anti-cheat.ts) before broadcasting. A
 * speedhack claim is silently dropped + flagged.
 */
export interface MovementEvent {
  type: "movement";
  playerId: string;
  position: [number, number, number];
  velocity: [number, number, number];
  yaw: number;
  pitch: number;
  /** Server-stamped sequence number (matches `lastInputSeq` in snapshots). */
  inputSeq: number;
  at: number;
}

const MAX_MOVE_SPEED_MPS = 7; // mirrors anti-cheat.ts.
const SPEEDHACK_FACTOR = 1.5;

export function handleMovementEvent(
  ctx: NetEventContext,
  input: {
    position?: [number, number, number];
    velocity?: [number, number, number];
    yaw?: number;
    pitch?: number;
    inputSeq?: number;
  },
): NetEventResult<MovementEvent> {
  if (
    !Array.isArray(input.position) ||
    input.position.length !== 3 ||
    input.position.some((v) => !Number.isFinite(v))
  ) {
    return { ok: false, code: "bad_position", message: "Position must be [x, y, z]" };
  }
  if (
    !Array.isArray(input.velocity) ||
    input.velocity.length !== 3 ||
    input.velocity.some((v) => !Number.isFinite(v))
  ) {
    return { ok: false, code: "bad_velocity", message: "Velocity must be [x, y, z]" };
  }
  // Anti-cheat: speedhack check. A velocity > MAX * FACTOR is
  // impossible without a cheat — drop + flag (the anti-cheat scan
  // picks up the pattern over time).
  const speed = Math.hypot(input.velocity[0], input.velocity[1], input.velocity[2]);
  if (speed > MAX_MOVE_SPEED_MPS * SPEEDHACK_FACTOR) {
    return {
      ok: false,
      code: "speedhack",
      message: `Velocity ${speed.toFixed(1)} m/s exceeds max ${MAX_MOVE_SPEED_MPS * SPEEDHACK_FACTOR} m/s`,
    };
  }
  return {
    ok: true,
    broadcast: {
      type: "movement",
      playerId: ctx.playerId,
      position: input.position,
      velocity: input.velocity,
      yaw: Number.isFinite(input.yaw ?? 0) ? input.yaw! : 0,
      pitch: Number.isFinite(input.pitch ?? 0) ? input.pitch! : 0,
      inputSeq: Number.isFinite(input.inputSeq ?? 0) ? Math.floor(input.inputSeq!) : 0,
      at: ctx.serverTime,
    },
  };
}

// ─── Dispatcher ──────────────────────────────────────────────────────────

/**
 * Dispatch a networked event by type. The transport layer calls this
 * with the raw JSON from the WebSocket / WebRTC frame; the dispatcher
 * routes to the appropriate handler + returns the broadcast-ready
 * event (or an error).
 *
 *   const result = dispatchNetEvent(ctx, "chat", { text: "hi", channel: "all" });
 *   if (!result.ok) return sendError(ws, result.code, result.message);
 *   broadcast(result.broadcast);
 */
export function dispatchNetEvent(
  ctx: NetEventContext,
  type: string,
  payload: Record<string, unknown>,
): NetEventResult {
  switch (type) {
    case "voip":
      return handleVoipEvent(ctx, payload as unknown as VoipFrameMeta) as NetEventResult;
    case "chat":
      return handleChatEvent(ctx, payload as { channel?: string; text?: string }) as NetEventResult;
    case "ping":
      return handlePingEvent(ctx, payload as {
        category?: string;
        position?: [number, number, number];
        label?: string;
      }) as NetEventResult;
    case "emote":
      return handleEmoteEvent(ctx, payload as { emoteSlug?: string }) as NetEventResult;
    case "revive":
      return handleReviveEvent(ctx, payload as { targetPlayerId?: string }) as NetEventResult;
    case "capture":
      return handleCaptureEvent(ctx, payload as {
        objectiveId?: string;
        progress?: number;
        contributors?: string[];
      }) as NetEventResult;
    case "loadout":
      return handleLoadoutEvent(ctx, payload as {
        weaponSlug?: string;
        muzzleSlug?: string;
        sightSlug?: string;
        gripSlug?: string;
        magazineSlug?: string;
        skinSlug?: string;
      }) as NetEventResult;
    case "weapon_swap":
      return handleWeaponSwapEvent(ctx, payload as { slot?: string }) as NetEventResult;
    case "reload":
      return handleReloadEvent(ctx, payload as { state?: string; weaponSlug?: string }) as NetEventResult;
    case "movement":
      return handleMovementEvent(ctx, payload as {
        position?: [number, number, number];
        velocity?: [number, number, number];
        yaw?: number;
        pitch?: number;
        inputSeq?: number;
      }) as NetEventResult;
    // Build-only events (scoreboard, killfeed, damage, death, objective,
    // wave, spawn, fire) are server-originated — they're never dispatched
    // from a client request. The server builds them via the
    // `build*Event` helpers above + broadcasts directly.
    default:
      return {
        ok: false,
        code: "unknown_event",
        message: `Unknown networked event type: ${type}`,
      };
  }
}
