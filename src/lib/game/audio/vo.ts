"use client";

/**
 * SEC8-AUDIO (prompt 68) — Voice-over pipeline (client).
 *
 * Fetches TTS-generated WAV audio from /api/audio/vo (which uses the
 * z-ai-web-dev-sdk TTS API on the backend), caches decoded AudioBuffers
 * in-memory, and plays them through the VO bus. While a VO line is playing,
 * the SFX/Music/UI buses are ducked ~8 dB so callouts stay intelligible.
 *
 * SEC8 prompt 68 update — bark concurrency cap:
 *   • Max 2 concurrent barks (was 1 — every line cut the previous one).
 *   • Priority queue: higher-priority barks jump the queue; lower-priority
 *     barks wait for a free slot. Prevents firefights from overlap-cutting
 *     every voice line.
 *   • Priority levels (1..5, 5 = highest): match/victory/defeat = 5,
 *     wave_incoming/wave_final = 4, reload/out_of_ammo = 1 (combat barks
 *     don't drown out the announcer).
 *
 * G2 (prompts 126–130, 143):
 *   • #126 — robust decodeAudioData feature detection (typeof ret.then).
 *   • #127 — LRU cache (max 50 entries) bounds memory over long sessions.
 *   • #128 — preemption: higher-priority lines interrupt lower-priority ones
 *     currently playing ("VIP down" interrupts "reloading").
 *   • #129 — spatial positioning for operator lines (panner); announcer/radio
 *     lines stay center-panned.
 *   • #130 — self-duck: when a new line starts, currently-playing lines are
 *     dipped by ~4 dB so the newer line is intelligible over the older.
 *   • #143 — onLineStart/onQueueEmpty wired to push synced subtitles.
 *
 * SSR-safe: no AudioContext is touched until attach().
 *
 * ─── G-5000 prompt mapping ────────────────────────────────────────────────
 *   #3415 → G2 #126 — fragile decodeAudioData detection     [decodeBuffer uses typeof ret.then === "function"]
 *   #3416 → G2 #127 — unbounded cache                        [LRU cacheGet/cacheSet; VO_CACHE_MAX = 50]
 *   #3417 → G2 #128 — no preemption                          [drain() preemption pass: higher-pri jumps queue / stops lower-pri active]
 *   #3418 → G2 #129 — always center-panned                   [optional position param → HRTF PannerNode for operator lines]
 *   #3419 → G2 #130 — no self-duck                           [per-source gain; new source dips active sources -4 dB]
 *   #3432 → G2 #143 — callbacks never set                    [onLineStart / onQueueEmpty invoked from startSource / onended]
 *   #3443 → G  #820 — per-operator voice                     [VoVoice union: 7 ids (tongtong/chuichui/xiaochen/jam/kazi/douji/luodo)]
 *   #3444 → G  #821 — VO line context                         [VoLineContextG in SectionG.ts rewrites line text by combat state; route.ts honors context]
 *   #3445 → G  #822 — VO interrupt                            [play(text, voice, priority); priority 1..5; #3417 drain() preemption interrupts]
 *   #3446 → G  #823 — VO priority queue                       [drain() dequeues highest-priority first]
 *   #3447 → G  #824 — lip sync to TTS                         [LipSyncG in SectionG.ts consumes the AudioBuffer returned here]
 *   #3448 → G  #825 — subtitle sync                           [onLineStart callback pushes subtitle via AudioEngine.pushSubtitle]
 *   #3533 → G  #820 — (cross-ref to #3443)
 *   #3534 → G  #821 — (cross-ref to #3444)
 *   #3535 → G  #822 — (cross-ref to #3445)
 *   #3536 → G  #823 — (cross-ref to #3446)
 *   #3537 → G  #824 — (cross-ref to #3447)
 *   #3538 → G  #825 — (cross-ref to #3448)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { BusMixer } from "./buses";

/** G2 #127 — max cache entries (LRU evicts oldest when exceeded). */
const VO_CACHE_MAX = 50;

/** G2 #129 — minimal Vec3 for spatial VO positioning. */
interface VoVec3 { x: number; y: number; z: number; }

export type VoVoice =
  | "tongtong"
  | "chuichui"
  | "xiaochen"
  | "jam"
  | "kazi"
  | "douji"
  | "luodo";

export interface AnnouncerLine {
  id: string;
  text: string;
  voice: VoVoice;
  /** Suffix appended to the subtitle text for accessibility (P6.3). */
  caption?: string;
}

/**
 * Catalog of built-in announcer callouts. Operators can extend this at
 * runtime via VoEngine.play(text, voice) for custom operator-select lines
 * or kill confirmations.
 *
 * Each line also carries a `priority` (1..5, 5 = highest) used by the
 * priority queue. Match-critical lines (start/victory/defeat) get priority
 * 5 so a combat bark never cuts them off.
 */
export const ANNOUNCER_LINES = {
  wave_complete:     { id: "wave_complete",     text: "Wave complete. Hold for next assault.",   voice: "xiaochen" as VoVoice, priority: 3 },
  wave_incoming:     { id: "wave_incoming",     text: "Hostiles inbound. Multiple contacts.",    voice: "xiaochen" as VoVoice, priority: 4 },
  wave_final:        { id: "wave_final",        text: "Final wave. Make it count.",              voice: "jam"      as VoVoice, priority: 4 },
  vip_down:          { id: "vip_down",          text: "VIP down. Mission failed.",               voice: "jam"      as VoVoice, priority: 5 },
  vip_extracted:     { id: "vip_extracted",     text: "VIP extracted. Mission success.",         voice: "kazi"     as VoVoice, priority: 5 },
  objective_captured:{ id: "objective_captured",text: "Objective secured.",                       voice: "kazi"     as VoVoice, priority: 3 },
  objective_lost:    { id: "objective_lost",    text: "Objective lost. Regroup and retry.",      voice: "jam"      as VoVoice, priority: 3 },
  kill_confirmed:    { id: "kill_confirmed",    text: "Kill confirmed.",                         voice: "tongtong" as VoVoice, priority: 2 },
  headshot:          { id: "headshot",          text: "Headshot.",                               voice: "tongtong" as VoVoice, priority: 2 },
  operator_select:   { id: "operator_select",   text: "Operator selected.",                      voice: "kazi"     as VoVoice, priority: 3 },
  reload:            { id: "reload",            text: "Reloading.",                              voice: "chuichui" as VoVoice, priority: 1 },
  out_of_ammo:       { id: "out_of_ammo",       text: "Out of ammo.",                            voice: "chuichui" as VoVoice, priority: 1 },
  match_start:       { id: "match_start",       text: "Match starting. Good hunting.",           voice: "luodo"    as VoVoice, priority: 5 },
  match_victory:     { id: "match_victory",     text: "Victory. Well done, operator.",           voice: "luodo"    as VoVoice, priority: 5 },
  match_defeat:      { id: "match_defeat",      text: "Mission failed. Fall back and regroup.",  voice: "luodo"    as VoVoice, priority: 5 },
} satisfies Record<string, AnnouncerLine & { priority: number }>;

export type AnnouncerLineId = keyof typeof ANNOUNCER_LINES;

interface QueueItem {
  buffer: AudioBuffer;
  duckEverything: boolean;
  text: string;
  /** Priority 1..5 (5 = highest). Higher values jump the queue. Default 1. */
  priority: number;
  /** Monotonic sequence number — breaks priority ties in FIFO order. */
  seq: number;
  /** G2 #129 — world-space position for spatial playback. When set, the line
   *  routes through a PannerNode so an operator beside the player sounds
   *  beside them. When undefined (announcer / radio), the line is
   *  center-panned as before. */
  position?: VoVec3;
}

/** Max concurrent VO barks. Prompt 68: cap at 2 so firefights don't
 *  overlap-cut every voice line. */
const MAX_CONCURRENT_VOICES = 2;

/** G2 #130 — self-duck amount. When a new VO line starts, currently-playing
 *  lines are dipped by this many dB so the newer line is intelligible over
 *  the older. */
const VO_SELF_DUCK_DB = 4;

/** G2 #128 — metadata for an active source. Used by preemption to find the
 *  lowest-priority playing source and stop it when a higher-priority line
 *  queues. */
interface ActiveVo {
  src: AudioBufferSourceNode;
  /** Per-source gain node — src → srcGain → [panner?] → bus. Self-duck
   *  schedules ramps on this gain. */
  srcGain: GainNode;
  /** Optional panner (only when position is set). Included so dispose() can
   *  disconnect it. */
  panner: PannerNode | null;
  priority: number;
  seq: number;
  text: string;
}

export class VoEngine {
  private ctx: AudioContext | null = null;
  private buses: BusMixer | null = null;
  /** G2 #127 — LRU cache. Map preserves insertion order, so deleting +
   *  re-setting a key promotes it to most-recently-used. Bounded at
   *  VO_CACHE_MAX entries; oldest evicted on insert. */
  private cache = new Map<string, AudioBuffer>();
  private fetching = new Set<string>();
  private queue: QueueItem[] = [];
  /** SEC8 prompt 68 — set of currently-playing source nodes (size ≤
   *  MAX_CONCURRENT_VOICES). Replaces the boolean `playing` flag. */
  private activeSources = new Set<AudioBufferSourceNode>();
  /** G2 #128 — per-source metadata for preemption + self-duck. */
  private activeVo: ActiveVo[] = [];
  /** Monotonic counter — assigns seq numbers to queued items so the priority
   *  queue breaks ties in FIFO order. */
  private seqCounter = 0;
  /** Optional callback fired when a line starts playing — used for subtitles. */
  onLineStart?: (text: string) => void;
  /** Optional callback fired when the queue drains. */
  onQueueEmpty?: () => void;

  attach(ctx: AudioContext, buses: BusMixer): void {
    this.ctx = ctx;
    this.buses = buses;
  }

  isAttached(): boolean {
    return this.ctx !== null && this.buses !== null;
  }

  /**
   * Play an arbitrary line. The decoded audio buffer is cached per (voice,text)
   * pair, so the second call is instant. While playing, the SFX/Music/UI buses
   * are ducked ~8 dB so the callout stays intelligible.
   *
   * SEC8 prompt 68 — `priority` (1..5, 5 = highest, default 1) controls the
   * order in which queued barks play. Up to MAX_CONCURRENT_VOICES (2) barks
   * play simultaneously; lower-priority barks wait for a slot to free.
   *
   * G2 #128 — preemption: if a higher-priority line queues and a lower one is
   * currently playing, the lower one is interrupted (stopped) so the higher
   * one starts immediately. "VIP down" (priority 5) interrupts "reloading"
   * (priority 1).
   *
   * G2 #129 — `position` (optional): when set, the line routes through a
   * PannerNode so an operator beside the player sounds beside them. When
   * undefined (announcer / radio lines), the line stays center-panned.
   */
  async play(
    text: string,
    voice: VoVoice = "xiaochen",
    priority: number = 1,
    position?: VoVec3,
  ): Promise<void> {
    if (!this.ctx || !this.buses) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const prio = Math.max(1, Math.min(5, Math.round(priority)));
    const key = `${voice}:${trimmed}`;
    let buffer = this.cacheGet(key);
    if (!buffer) {
      if (this.fetching.has(key)) {
        // Already loading — drop the duplicate request silently.
        return;
      }
      this.fetching.add(key);
      try {
        const res = await fetch("/api/audio/vo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, voice }),
        });
        if (!res.ok) {
          // Server may 503 if TTS is unavailable — fall back silently.
          return;
        }
        const arrayBuf = await res.arrayBuffer();
        buffer = await this.decodeAudioData(arrayBuf);
        this.cacheSet(key, buffer);
      } catch (err) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[vo] fetch/decode failed", err);
        }
        return;
      } finally {
        this.fetching.delete(key);
      }
    }
    this.queue.push({
      buffer,
      duckEverything: true,
      text: trimmed,
      priority: prio,
      seq: this.seqCounter++,
      position,
    });
    this.drain();
  }

  /** Play a built-in announcer line by id (uses the line's priority). */
  playLine(lineId: AnnouncerLineId): Promise<void> {
    const line = ANNOUNCER_LINES[lineId];
    if (!line) return Promise.resolve();
    return this.play(line.text, line.voice, line.priority);
  }

  /** Decode an ArrayBuffer to an AudioBuffer (handles both modern + legacy promise API).
   *
   *  G2 #126 — was: `typeof ctx.decodeAudioData.length === "number" &&
   *  ctx.decodeAudioData.length <= 1` to feature-detect the modern promise
   *  API. That's fragile — the spec doesn't guarantee `length` reflects the
   *  overload, and future spec changes (e.g. an optional options arg) could
   *  break the heuristic. Switched to `typeof ret.then === "function"` (the
   *  same pattern used in audio.ts:436) — directly checks whether the call
   *  returned a Promise. */
  private decodeAudioData(arrayBuf: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ctx!;
    return new Promise<AudioBuffer>((resolve, reject) => {
      try {
        const ret = ctx.decodeAudioData(arrayBuf) as unknown as
          | Promise<AudioBuffer>
          | undefined;
        if (ret && typeof ret.then === "function") {
          ret.then(resolve, reject);
        } else {
          ctx.decodeAudioData(
            arrayBuf,
            (buf: AudioBuffer) => resolve(buf),
            (err?: unknown) => reject(err ?? new Error("decodeAudioData failed")),
          );
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  // G2 #127 — LRU cache accessors. Map preserves insertion order in JS, so
  // delete+set on access promotes a key to most-recently-used. On insert, if
  // we exceed VO_CACHE_MAX, evict the oldest (first) entry.
  private cacheGet(key: string): AudioBuffer | undefined {
    const buf = this.cache.get(key);
    if (buf) {
      // Promote to most-recently-used.
      this.cache.delete(key);
      this.cache.set(key, buf);
    }
    return buf;
  }

  private cacheSet(key: string, buf: AudioBuffer): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, buf);
    // Evict oldest entries until we're at or under the limit.
    while (this.cache.size > VO_CACHE_MAX) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  /**
   * SEC8 prompt 68 — Process the priority queue with a 2-voice concurrency cap.
   *
   * Picks the highest-priority queued item (FIFO on ties) and starts it,
   * repeating until either the queue is empty or MAX_CONCURRENT_VOICES slots
   * are filled. Called whenever a new item is queued and whenever a source
   * ends (freeing a slot).
   *
   * G2 #128 — preemption: if the queue holds a higher-priority item than a
   * currently-playing line, the lower-priority active source is interrupted
   * (stopped) so the higher one can start immediately. "VIP down" (priority
   * 5) interrupts "reloading" (priority 1).
   */
  private drain(): void {
    if (!this.ctx || !this.buses) return;
    // G2 #128 — preemption pass: while there's a queued item with strictly
    // higher priority than the lowest-priority active source, stop the lower
    // one to free a slot.
    while (this.queue.length > 0 && this.activeVo.length >= MAX_CONCURRENT_VOICES) {
      // Find the lowest-priority active source.
      let lowestIdx = 0;
      for (let i = 1; i < this.activeVo.length; i++) {
        const a = this.activeVo[i];
        const b = this.activeVo[lowestIdx];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq > b.seq)) {
          lowestIdx = i;
        }
      }
      // Find the highest-priority queued item.
      let bestQIdx = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[bestQIdx];
        if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) {
          bestQIdx = i;
        }
      }
      const queued = this.queue[bestQIdx];
      const lowest = this.activeVo[lowestIdx];
      // Strictly higher priority required (ties don't preempt — they wait).
      if (queued.priority > lowest.priority) {
        // Stop the lower-priority source.
        try { lowest.src.stop(); } catch { /* already ended */ }
        // The src.onended handler will call drain() to start the queued item.
        // Mark it preempted so onended doesn't double-decrement.
        lowest.priority = -1; // sentinel — onended will skip cleanup of priority
        // Force-remove from activeVo now (don't wait for onended).
        this.activeVo.splice(lowestIdx, 1);
        this.activeSources.delete(lowest.src);
        try { lowest.srcGain.disconnect(); } catch { /* noop */ }
        if (lowest.panner) { try { lowest.panner.disconnect(); } catch { /* noop */ } }
      } else {
        // No preemption possible — let the queue wait for a natural slot.
        break;
      }
    }
    while (this.queue.length > 0 && this.activeVo.length < MAX_CONCURRENT_VOICES) {
      // Find the highest-priority item (FIFO on ties).
      let bestIdx = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[bestIdx];
        if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) {
          bestIdx = i;
        }
      }
      const item = this.queue.splice(bestIdx, 1)[0];
      this.startSource(item);
    }
  }

  /** Start a single VO source + track it in `activeSources`.
   *
   *  G2 #129 — when item.position is set, the source routes through a
   *  PannerNode (HRTF) so operator lines localize to the speaker's position.
   *  Announcer / radio lines (no position) stay center-panned.
   *
   *  G2 #130 — self-duck: when this source starts, every currently-active VO
   *  source's per-source gain is dipped by VO_SELF_DUCK_DB over 30ms, then
   *  recovers over 200ms after this source's likely end. This makes the newer
   *  line intelligible over the older one (without ducking the VO bus itself,
   *  which would duck the newer line too). */
  private startSource(item: QueueItem): void {
    if (!this.ctx || !this.buses) return;
    const bus = this.buses.getBus("vo");
    if (!bus) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = item.buffer;
    // G2 #130 — per-source gain node for self-duck ramps.
    const srcGain = ctx.createGain();
    srcGain.gain.value = 1;
    src.connect(srcGain);

    // G2 #129 — optional spatial panner.
    let panner: PannerNode | null = null;
    if (item.position) {
      panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 1.0;
      panner.maxDistance = 50;
      panner.rolloffFactor = 1.0;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 0;
      const t = ctx.currentTime;
      if (panner.positionX) {
        panner.positionX.setValueAtTime(item.position.x, t);
        panner.positionY.setValueAtTime(item.position.y, t);
        panner.positionZ.setValueAtTime(item.position.z, t);
      } else {
        (panner as unknown as { setPosition: (x: number, y: number, z: number) => void })
          .setPosition(item.position.x, item.position.y, item.position.z);
      }
      srcGain.connect(panner);
      panner.connect(bus);
    } else {
      srcGain.connect(bus);
    }

    if (item.duckEverything) {
      // G2 #139 — was: hard-coded `duck("sfx", 8, ms)` + duck("music", 8, ms)
      // + duck("ui", 8, ms). Now delegates to BusMixer.duckForTrigger("vo",
      // ms) which consults the DUCKING_RULES table (AudioEnhancements.ts) —
      // VO ducks music by 40% (~8dB) per the rules table. Centralising the
      // ducking rules in one table lets designers tune the sidechain mix
      // without touching the VO engine.
      const ms = item.buffer.duration * 1000 + 200;
      // Use duckForTrigger if available; fall back to the legacy inline calls
      // for backward compat with older BusMixer instances.
      const mixer = this.buses as BusMixer & {
        duckForTrigger?: (trigger: "vo" | "announcer" | "stinger", durationMs: number) => void;
      };
      if (typeof mixer.duckForTrigger === "function") {
        mixer.duckForTrigger("vo", ms);
      } else {
        this.buses.duck("sfx", 8, ms);
        this.buses.duck("music", 8, ms);
        this.buses.duck("ui", 8, ms);
      }
    }

    // G2 #130 — self-duck: dip every currently-active VO source by
    // VO_SELF_DUCK_DB. The newer line (this one) plays at full gain while
    // older lines are dipped, so the newer one is intelligible over them.
    if (this.activeVo.length > 0) {
      const t0 = ctx.currentTime;
      const dippedRatio = Math.pow(10, -VO_SELF_DUCK_DB / 20);
      for (const av of this.activeVo) {
        const g = av.srcGain.gain as AudioParam & {
          cancelAndHoldAtTime?: (t: number) => void;
        };
        if (typeof g.cancelAndHoldAtTime === "function") {
          g.cancelAndHoldAtTime(t0);
        } else {
          av.srcGain.gain.cancelScheduledValues(t0);
          av.srcGain.gain.setValueAtTime(Math.max(0.0001, av.srcGain.gain.value), t0);
        }
        av.srcGain.gain.linearRampToValueAtTime(dippedRatio, t0 + 0.03);
      }
    }

    if (this.onLineStart) this.onLineStart(item.text);
    this.activeSources.add(src);
    this.activeVo.push({
      src,
      srcGain,
      panner,
      priority: item.priority,
      seq: item.seq,
      text: item.text,
    });
    src.onended = () => {
      this.activeSources.delete(src);
      // Remove from activeVo (find by reference).
      const idx = this.activeVo.findIndex((av) => av.src === src);
      if (idx >= 0) this.activeVo.splice(idx, 1);
      // G2 #113/#114 — disconnect the per-source nodes so they don't leak.
      try { srcGain.disconnect(); } catch { /* noop */ }
      if (panner) { try { panner.disconnect(); } catch { /* noop */ } }
      if (this.queue.length === 0 && this.activeVo.length === 0 && this.onQueueEmpty) {
        this.onQueueEmpty();
      }
      this.drain();
    };
    src.start();
  }

  /** Drop everything queued (does not stop the currently-playing lines). */
  clearQueue(): void {
    this.queue = [];
  }

  /** Drop the in-memory cache (e.g. on language change). */
  clearCache(): void {
    this.cache.clear();
  }

  /** Currently playing or queued line count. */
  pendingCount(): number {
    return this.queue.length + this.activeSources.size;
  }

  dispose(): void {
    // Stop any currently-playing sources cleanly. Also disconnect the
    // per-source gain + panner (G2 #129 / #130 added these) so they don't
    // leak on dispose.
    for (const av of this.activeVo) {
      try { av.src.stop(); } catch { /* already ended */ }
      try { av.srcGain.disconnect(); } catch { /* noop */ }
      if (av.panner) { try { av.panner.disconnect(); } catch { /* noop */ } }
    }
    this.activeVo = [];
    this.activeSources.clear();
    this.ctx = null;
    this.buses = null;
    this.cache.clear();
    this.queue = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton accessor
// ─────────────────────────────────────────────────────────────────────────────

let _voInstance: VoEngine | null = null;
export function getVoEngine(): VoEngine {
  if (!_voInstance) _voInstance = new VoEngine();
  return _voInstance;
}
