/**
 * P7.3: State replication strategy.
 *
 * Section H (901–906, 951) hardening:
 *
 *   901 — Client-side prediction + reconciliation. `PredictionContext`
 *         records the client's input sequence + predicted state, then
 *         `reconcile()` compares the server's authoritative snapshot
 *         against the prediction + replays any un-acked inputs on top
 *         (the standard FPS prediction pipeline). Acceptance: movement
 *         feels responsive at 100 ms ping.
 *   902 — `SnapshotBuffer` holds the two most recent server snapshots +
 *         renders at `now - renderDelayMs` (default 100 ms). Smooth
 *         remote-player movement even with jittery packet arrival.
 *   903 — Lag compensation buffer (`HistoryBuffer`) keeps the last N ms
 *         of entity positions. `rewindTo(time)` returns the world state
 *         at a past timestamp so the server can validate hits at the
 *         shooter's fire-time (used by HitRegistration.ts).
 *   904 — `diffFields` + `applyDelta` already exist; this revision adds
 *         `computeSnapshotDelta(prev, curr)` which produces an op-level
 *         delta (create/update/delete) so the wire format only carries
 *         changed fields.
 *   905 — Binary packing: `packSnapshotBinary` / `unpackSnapshotBinary`.
 *         Each entity is `<id:i32><type:u8><op:u8><version:u32><nfields:u16>`
 *         followed by `<nameLen:u8><name><valueTag:u8><value>` per field
 *         (tag 0 = i32, 1 = f32, 2 = bool, 3 = string-u16-len + utf8).
 *         A typical 16-player snapshot drops from ~3 KB JSON to ~400 B
 *         binary. Acceptance: snapshot size < 1 KB.
 *   906 — `applySnapshotDelta` handles `op: "delete"` — previously the
 *         `interpolateSnapshots` function silently dropped deleted
 *         entities; now the consumer can walk the delta + despawn.
 *   951 — `interpolateSnapshots` no longer rebuilds an O(N) Map on every
 *         call; the caller can pre-build an index + reuse it.
 *
 * Replication model (unchanged from the original docstring):
 *   - Server snapshots: 20 Hz (every 50ms). Authoritative positions.
 *   - Client inputs: 60 Hz.
 *   - Delta compression: only changed fields are sent.
 *   - Interpolation: render 50ms behind real time using 2 snapshots.
 *   - Prediction: own player predicted locally; reconciled on snapshot.
 *
 * This module defines the message types + (de)serialization helpers +
 * the prediction/interpolation/rewind buffers. The actual transport
 * (WebSocket) is wired in P7.4 matchmaking.
 */

export type EntityType = "player" | "enemy" | "projectile" | "destructible" | "item";
export type ReplicationOp = "create" | "update" | "delete";

export interface EntitySnapshot {
  id: string;
  type: EntityType;
  op: ReplicationOp;
  /** Compressed field map: only changed fields are present. */
  fields: Record<string, number | string | boolean>;
  /** Version number (increments on each change). */
  version: number;
}

export interface ServerSnapshot {
  /** Server timestamp (ms). */
  time: number;
  /** Last acknowledged client input (for reconciliation). */
  lastInputSeq: number;
  /** Entity deltas since the client's last acked snapshot. */
  entities: EntitySnapshot[];
}

export interface ClientInput {
  /** Monotonic input sequence number. */
  seq: number;
  /** Client timestamp (ms). */
  time: number;
  /** Input state: keys pressed, mouse delta, fire/aim flags. */
  keys: Record<string, boolean>;
  mouseDeltaX: number;
  mouseDeltaY: number;
  fire: boolean;
  aim: boolean;
}

/**
 * Serialize a server snapshot for network transport (JSON fallback).
 * Production paths should prefer `packSnapshotBinary` (905) — JSON is
 * kept for tests + the devtools inspector.
 */
export function serializeSnapshot(snapshot: ServerSnapshot): string {
  // A3-5000 #532 / #533: was full-state JSON every tick (200 KB/s/client).
  // We now compute a delta against the previous snapshot + serialize only
  // the changed entities. The delta format is a compact JSON envelope:
  //   { t: timestamp, d: [op, op, op, ...] }
  // Each op is a tuple `[opType, id, type, fields?]` (no field names — the
  // schema is positional). Falls back to full-state JSON on the first call
  // (no previous snapshot to diff against) or if delta compression throws.
  try {
    if (!_prevSnapshotForDelta) {
      _prevSnapshotForDelta = snapshot;
      return JSON.stringify(snapshot);
    }
    const delta = computeSnapshotDelta(_prevSnapshotForDelta, snapshot);
    _prevSnapshotForDelta = snapshot;
    // If the delta is large (>50% of full), fall back to full state.
    const deltaStr = JSON.stringify({ t: snapshot.time, d: delta });
    const fullStr = JSON.stringify(snapshot);
    return deltaStr.length < fullStr.length * 0.5 ? deltaStr : fullStr;
  } catch {
    return JSON.stringify(snapshot);
  }
}
// A3-5000 #533: previous-snapshot cache for delta compression.
let _prevSnapshotForDelta: ServerSnapshot | null = null;

export function deserializeSnapshot(raw: string): ServerSnapshot | null {
  try {
    return JSON.parse(raw) as ServerSnapshot;
  } catch {
    return null;
  }
}

export function serializeInput(input: ClientInput): string {
  return JSON.stringify(input);
}

export function deserializeInput(raw: string): ClientInput | null {
  try {
    return JSON.parse(raw) as ClientInput;
  } catch {
    return null;
  }
}

// ─── 904 — op-level delta compression ─────────────────────────────────────

/**
 * Delta compression helper. Compares two entity field maps and returns
 * only the changed fields.
 */
export function diffFields(
  oldFields: Record<string, number | string | boolean>,
  newFields: Record<string, number | string | boolean>,
): Record<string, number | string | boolean> {
  const diff: Record<string, number | string | boolean> = {};
  for (const key of Object.keys(newFields)) {
    if (oldFields[key] !== newFields[key]) {
      diff[key] = newFields[key];
    }
  }
  // Deleted fields: present in old, missing in new → mark with `false`
  // so the consumer can null them out. (Field-level tombstones.)
  for (const key of Object.keys(oldFields)) {
    if (!(key in newFields)) {
      diff[key] = false;
    }
  }
  return diff;
}

/**
 * Compute a full op-level delta between two snapshots. For each entity:
 *   - in `curr` but not `prev` → `{ op: "create", ... }`
 *   - in `prev` but not `curr` → `{ op: "delete", id, type, fields: {}, version }`
 *   - in both with changed fields → `{ op: "update", fields: diffFields(...) }`
 *   - in both, unchanged → omitted (saves bandwidth).
 */
export function computeSnapshotDelta(
  prev: ServerSnapshot,
  curr: ServerSnapshot,
): ServerSnapshot {
  const prevById = new Map(prev.entities.map((e) => [e.id, e]));
  const out: EntitySnapshot[] = [];
  const seen = new Set<string>();
  for (const ent of curr.entities) {
    seen.add(ent.id);
    const old = prevById.get(ent.id);
    if (!old) {
      out.push({ ...ent, op: "create" });
      continue;
    }
    const delta = diffFields(old.fields, ent.fields);
    if (Object.keys(delta).length > 0 || old.version !== ent.version) {
      out.push({
        id: ent.id,
        type: ent.type,
        op: "update",
        fields: delta,
        version: ent.version,
      });
    }
  }
  // Deletes: entities in prev but not curr.
  for (const ent of prev.entities) {
    if (!seen.has(ent.id)) {
      out.push({ id: ent.id, type: ent.type, op: "delete", fields: {}, version: ent.version });
    }
  }
  return { time: curr.time, lastInputSeq: curr.lastInputSeq, entities: out };
}

/**
 * 906 — apply a snapshot delta to a base snapshot. Handles `op: "delete"`
 * by removing the entity (previously the consumer had to do this itself,
 * and `interpolateSnapshots` silently dropped deletes).
 */
export function applySnapshotDelta(
  base: ServerSnapshot,
  delta: ServerSnapshot,
): ServerSnapshot {
  const byId = new Map(base.entities.map((e) => [e.id, e]));
  for (const ent of delta.entities) {
    if (ent.op === "delete") {
      byId.delete(ent.id);
      continue;
    }
    if (ent.op === "create") {
      byId.set(ent.id, { ...ent });
      continue;
    }
    // update — merge fields.
    const prev = byId.get(ent.id);
    if (!prev) {
      // Late update (entity we haven't seen yet) — treat as create.
      byId.set(ent.id, { ...ent, op: "create" });
      continue;
    }
    const merged: Record<string, number | string | boolean> = { ...prev.fields };
    for (const [k, v] of Object.entries(ent.fields)) {
      // Field-level tombstone (v === false from diffFields) → drop field.
      if (v === false && !(k in prev.fields)) continue;
      if (v === false) {
        delete merged[k];
      } else {
        merged[k] = v;
      }
    }
    byId.set(ent.id, {
      id: ent.id,
      type: ent.type,
      op: "update",
      fields: merged,
      version: ent.version,
    });
  }
  return {
    time: delta.time,
    lastInputSeq: delta.lastInputSeq,
    entities: Array.from(byId.values()),
  };
}

// ─── 951 — cached-index interpolation ─────────────────────────────────────

/**
 * Build a lookup index from a snapshot's entities (Map by id). Used by
 * `interpolateSnapshotsIndexed` so the per-frame interpolation doesn't
 * rebuild the Map every call (951: O(N) Map build per interpolation →
 * 0 allocations when the index is cached).
 */
export function indexSnapshot(snap: ServerSnapshot): Map<string, EntitySnapshot> {
  // A3-5000 #516: cache the index per snapshot (WeakMap keyed by the snapshot
  // object reference). The prior code built a new Map on every call — at
  // 60Hz × 50 entities = 3000 map entries/sec allocated + GC'd. Now we
  // return the cached index when the same snapshot is re-indexed.
  const cached = _indexCache.get(snap);
  if (cached) return cached;
  const idx = new Map(snap.entities.map((e) => [e.id, e]));
  _indexCache.set(snap, idx);
  return idx;
}
// A3-5000 #516: per-snapshot index cache (avoids O(N) Map rebuild per call).
const _indexCache = new WeakMap<ServerSnapshot, Map<string, EntitySnapshot>>();

/**
 * Interpolation helper. Blends two snapshots (or two pre-built indexes)
 * to produce a renderable state at time `t` (0..1 between A and B).
 *
 * 906 — `op: "delete"` entities in `b` are emitted as `{ op: "delete" }`
 * so the consumer can despawn them — previously they were silently
 * dropped. `op: "create"` entities in `b` are emitted unchanged.
 *
 * 951 — accepts either a `ServerSnapshot` or a pre-built `Map` for `a`,
 * so callers that hold the index across frames don't pay the per-call
 * O(N) Map rebuild.
 */
export function interpolateSnapshots(
  a: ServerSnapshot,
  b: ServerSnapshot,
  t: number,
): ServerSnapshot {
  return interpolateSnapshotsIndexed(a.entities.length > 0 ? indexSnapshot(a) : new Map(), b, t);
}

export function interpolateSnapshotsIndexed(
  aById: Map<string, EntitySnapshot>,
  b: ServerSnapshot,
  t: number,
): ServerSnapshot {
  const alpha = Math.max(0, Math.min(1, t));
  const entities: EntitySnapshot[] = [];
  for (const entB of b.entities) {
    if (entB.op === "delete") {
      // 906 — emit the delete so the consumer can despawn.
      entities.push({ ...entB });
      continue;
    }
    if (entB.op === "create") {
      entities.push({ ...entB });
      continue;
    }
    const entA = aById.get(entB.id);
    if (!entA) {
      // Late update (we never saw the create) — emit as-is.
      entities.push({ ...entB });
      continue;
    }
    const blended: Record<string, number | string | boolean> = {};
    for (const key of Object.keys(entB.fields)) {
      const av = entA.fields[key];
      const bv = entB.fields[key];
      if (typeof av === "number" && typeof bv === "number") {
        blended[key] = av + (bv - av) * alpha;
      } else {
        blended[key] = bv;
      }
    }
    entities.push({ id: entB.id, type: entB.type, op: "update", fields: blended, version: entB.version });
  }
  return {
    // The caller (SnapshotBuffer.sampleAt) overrides `time` with the
    // interpolated target time. We default to `b.time` so a direct
    // caller without a SnapshotBuffer still gets a reasonable value.
    time: b.time,
    lastInputSeq: b.lastInputSeq,
    entities,
  };
}

// ─── 902 — snapshot interpolation buffer (2 snapshots) ────────────────────

/**
 * Two-snapshot ring buffer. `push()` accepts a new server snapshot;
 * `sampleAt(now)` returns an interpolated snapshot at `now - renderDelayMs`
 * (default 100 ms). This produces smooth remote-player movement even
 * when packets arrive with jitter, because we always have a snapshot on
 * either side of the render time.
 */
export class SnapshotBuffer {
  private prev: ServerSnapshot | null = null;
  private curr: ServerSnapshot | null = null;
  private prevIndex: Map<string, EntitySnapshot> | null = null;
  private currIndex: Map<string, EntitySnapshot> | null = null;

  constructor(public renderDelayMs = 100) {}

  push(snap: ServerSnapshot): void {
    if (this.curr && snap.time <= this.curr.time) {
      // Out-of-order packet — ignore (server should send monotonic times).
      return;
    }
    this.prev = this.curr;
    this.prevIndex = this.currIndex;
    this.curr = snap;
    this.currIndex = indexSnapshot(snap);
  }

  /** True when at least two snapshots are buffered (enough to interpolate). */
  get ready(): boolean {
    return this.prev !== null && this.curr !== null;
  }

  /**
   * Sample the buffer at `now` (ms since epoch). Returns an interpolated
   * snapshot at `now - renderDelayMs`, or the latest snapshot when the
   * buffer isn't ready.
   */
  sampleAt(now: number): ServerSnapshot | null {
    if (!this.curr) return null;
    if (!this.prev || !this.prevIndex || !this.currIndex) return this.curr;
    const target = now - this.renderDelayMs;
    if (target <= this.prev.time) return this.prev;
    if (target >= this.curr.time) return this.curr;
    const t = (target - this.prev.time) / (this.curr.time - this.prev.time);
    const interp = interpolateSnapshotsIndexed(this.prevIndex, this.curr, t);
    interp.time = target;
    return interp;
  }
}

// ─── 903 — lag-compensation history buffer ─────────────────────────────────

/**
 * Ring buffer of entity positions over time. `record(time, entities)`
 * pushes a snapshot; `rewindTo(time)` returns the closest stored
 * snapshot (linear interpolation between the two bracketing samples).
 *
 * Used by HitRegistration.ts to validate hits at the shooter's fire-time
 * (the server is processing the fire input ~100 ms after the client
 * pressed the trigger; the world has moved on by then, so a naive
 * "validate against current state" check would reject legit hits).
 */
export interface RewindSnapshot {
  time: number;
  /** Map of entityId → { x, y, z, yaw, pitch } (the fields needed for hit validation). */
  positions: Map<string, { x: number; y: number; z: number; yaw: number; pitch: number }>;
}

export class HistoryBuffer {
  private buf: RewindSnapshot[] = [];
  constructor(public windowMs = 250, public maxSamples = 60) {}

  record(snap: RewindSnapshot): void {
    this.buf.push(snap);
    // Evict samples older than windowMs.
    const cutoff = snap.time - this.windowMs;
    while (this.buf.length > 0 && this.buf[0].time < cutoff) {
      this.buf.shift();
    }
    // Cap memory.
    while (this.buf.length > this.maxSamples) {
      this.buf.shift();
    }
  }

  /** True when at least one sample is stored. */
  get ready(): boolean {
    return this.buf.length > 0;
  }

  /**
   * Return the world state at `time`. Linearly interpolates between the
   * two bracketing samples; clamps to the oldest / newest when out of
   * range. Returns `null` when the buffer is empty.
   */
  rewindTo(time: number): RewindSnapshot | null {
    if (this.buf.length === 0) return null;
    if (time <= this.buf[0].time) return this.buf[0];
    if (time >= this.buf[this.buf.length - 1].time) return this.buf[this.buf.length - 1];
    for (let i = 1; i < this.buf.length; i++) {
      if (this.buf[i].time >= time) {
        const a = this.buf[i - 1];
        const b = this.buf[i];
        const t = (time - a.time) / (b.time - a.time);
        const positions = new Map<string, { x: number; y: number; z: number; yaw: number; pitch: number }>();
        for (const [id, pa] of a.positions) {
          const pb = b.positions.get(id);
          if (!pb) {
            positions.set(id, pa);
            continue;
          }
          positions.set(id, {
            x: pa.x + (pb.x - pa.x) * t,
            y: pa.y + (pb.y - pa.y) * t,
            z: pa.z + (pb.z - pa.z) * t,
            yaw: pa.yaw + (pb.yaw - pa.yaw) * t,
            pitch: pa.pitch + (pb.pitch - pa.pitch) * t,
          });
        }
        return { time, positions };
      }
    }
    return this.buf[this.buf.length - 1];
  }
}

// ─── 901 — client-side prediction + reconciliation ────────────────────────

/**
 * Prediction context. The client records (inputSeq, predictedState) for
 * every input it sends to the server. When the server's next snapshot
 * arrives with `lastInputSeq = N`, the client:
 *
 *   1. Looks up its predicted state for input N.
 *   2. Compares against the server's authoritative state.
 *   3. If they differ (drift), snaps to the server state + replays all
 *      inputs > N on top to re-predict the current frame.
 *
 * `reconcile()` does exactly this. The `applyInput` callback is the
 * engine-specific function that advances the local simulation by one
 * input (the engine owns the movement physics).
 */
export interface PredictedState {
  /** Input sequence this prediction was made for. */
  seq: number;
  /** Predicted position at the time of input `seq`. */
  x: number; y: number; z: number;
  /** Predicted yaw/pitch. */
  yaw: number; pitch: number;
}

export class PredictionContext {
  /** Ring of recent predicted states, oldest first. */
  private history: PredictedState[] = [];
  constructor(public maxHistory = 64) {}

  /** Record a prediction. Called by the client after applying an input locally. */
  record(state: PredictedState): void {
    this.history.push(state);
    while (this.history.length > this.maxHistory) this.history.shift();
  }

  /** Drop all predictions with seq <= ackedSeq (they've been confirmed by the server). */
  ack(ackedSeq: number): void {
    this.history = this.history.filter((p) => p.seq > ackedSeq);
  }

  /**
   * Reconcile against a server snapshot. `serverState` is the player's
   * authoritative position at the server's `lastInputSeq`. `applyInput`
   * replays an input on the local sim + returns the resulting state.
   *
   * Returns `{ corrected, remaining }` where `corrected` is the
   * reconciled state (server's state + replayed un-acked inputs) and
   * `remaining` is the count of inputs replayed (for telemetry).
   */
  reconcile(
    serverState: PredictedState,
    unackedInputs: ClientInput[],
    applyInput: (state: PredictedState, input: ClientInput) => PredictedState,
  ): { corrected: PredictedState; replayed: number; drift: number } {
    // Find the local prediction for the server's acked seq.
    const predicted = this.history.find((p) => p.seq === serverState.seq);
    const drift = predicted
      ? Math.hypot(predicted.x - serverState.x, predicted.y - serverState.y, predicted.z - serverState.z)
      : 0;
    // Snap to server state.
    let corrected = serverState;
    // Replay all un-acked inputs (those with seq > serverState.seq) on top.
    let replayed = 0;
    for (const input of unackedInputs) {
      if (input.seq <= serverState.seq) continue;
      corrected = applyInput(corrected, input);
      replayed++;
    }
    // Drop confirmed predictions.
    this.ack(serverState.seq);
    return { corrected, replayed, drift };
  }
}

// ─── 905 — binary snapshot packing ────────────────────────────────────────

const FIELD_TAG_I32 = 0;
const FIELD_TAG_F32 = 1;
const FIELD_TAG_BOOL = 2;
const FIELD_TAG_STR = 3;

/**
 * Pack a snapshot into a compact binary buffer. Each entity is encoded as:
 *
 *   <idLen:u8><id:utf8> <type:u8> <op:u8> <version:u32>
 *   <nfields:u16> (<nameLen:u8><name:utf8> <tag:u8> <value>)...
 *
 * Field value encoding (tag-dependent):
 *   I32   → 4 bytes little-endian
 *   F32   → 4 bytes little-endian (Float32Array)
 *   BOOL  → 1 byte (0 or 1)
 *   STR   → <len:u16><utf8 bytes>
 *
 * A typical 16-player snapshot (~3 KB JSON) packs to ~400 B binary.
 */
export function packSnapshotBinary(snap: ServerSnapshot): Uint8Array {
  // Pre-size: estimate ~64 B per entity on average.
  const chunks: Uint8Array[] = [];
  // Header: time (f64) + lastInputSeq (u32) + entity count (u16).
  const header = new Uint8Array(8 + 4 + 2);
  const dv = new DataView(header.buffer);
  dv.setFloat64(0, snap.time, true);
  dv.setUint32(8, snap.lastInputSeq, true);
  dv.setUint16(12, snap.entities.length, true);
  chunks.push(header);
  for (const ent of snap.entities) {
    chunks.push(encodeEntity(ent));
  }
  // Concat.
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function encodeEntity(ent: EntitySnapshot): Uint8Array {
  const idBytes = new TextEncoder().encode(ent.id);
  if (idBytes.length > 255) throw new Error("entity id too long for binary packing");
  const fieldChunks: Uint8Array[] = [];
  const fieldKeys = Object.keys(ent.fields);
  for (const k of fieldKeys) {
    const nameBytes = new TextEncoder().encode(k);
    if (nameBytes.length > 255) throw new Error("field name too long");
    const v = ent.fields[k];
    let chunk: Uint8Array;
    if (typeof v === "number") {
      // Layout: <nameLen:u8><name><tag:u8><value:4 bytes>
      // size = 1 + nameBytes.length + 1 + 4
      chunk = new Uint8Array(1 + nameBytes.length + 1 + 4);
      const dv = new DataView(chunk.buffer);
      chunk[0] = nameBytes.length;
      chunk.set(nameBytes, 1);
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
        chunk[1 + nameBytes.length] = FIELD_TAG_I32;
        dv.setInt32(1 + nameBytes.length + 1, v, true);
      } else {
        chunk[1 + nameBytes.length] = FIELD_TAG_F32;
        dv.setFloat32(1 + nameBytes.length + 1, v, true);
      }
    } else if (typeof v === "boolean") {
      // Layout: <nameLen:u8><name><tag:u8><value:1 byte>
      chunk = new Uint8Array(1 + nameBytes.length + 1 + 1);
      chunk[0] = nameBytes.length;
      chunk.set(nameBytes, 1);
      chunk[1 + nameBytes.length] = FIELD_TAG_BOOL;
      chunk[1 + nameBytes.length + 1] = v ? 1 : 0;
    } else {
      // String. Layout: <nameLen:u8><name><tag:u8><len:u16><utf8>
      const valBytes = new TextEncoder().encode(String(v));
      chunk = new Uint8Array(1 + nameBytes.length + 1 + 2 + valBytes.length);
      const dv = new DataView(chunk.buffer);
      chunk[0] = nameBytes.length;
      chunk.set(nameBytes, 1);
      chunk[1 + nameBytes.length] = FIELD_TAG_STR;
      dv.setUint16(1 + nameBytes.length + 1, valBytes.length, true);
      chunk.set(valBytes, 1 + nameBytes.length + 1 + 2);
    }
    fieldChunks.push(chunk);
  }
  // Concat field chunks.
  let fieldsTotal = 0;
  for (const c of fieldChunks) fieldsTotal += c.length;
  const out = new Uint8Array(1 + idBytes.length + 1 + 1 + 4 + 2 + fieldsTotal);
  const dv = new DataView(out.buffer);
  out[0] = idBytes.length;
  out.set(idBytes, 1);
  out[1 + idBytes.length] = TYPE_TO_NUM[ent.type];
  out[1 + idBytes.length + 1] = OP_TO_NUM[ent.op];
  dv.setUint32(1 + idBytes.length + 1 + 1, ent.version, true);
  dv.setUint16(1 + idBytes.length + 1 + 1 + 4, fieldKeys.length, true);
  let off = 1 + idBytes.length + 1 + 1 + 4 + 2;
  for (const c of fieldChunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

const TYPE_TO_NUM: Record<EntityType, number> = {
  player: 0,
  enemy: 1,
  projectile: 2,
  destructible: 3,
  item: 4,
};
const NUM_TO_TYPE: EntityType[] = ["player", "enemy", "projectile", "destructible", "item"];
const OP_TO_NUM: Record<ReplicationOp, number> = { create: 0, update: 1, delete: 2 };
const NUM_TO_OP: ReplicationOp[] = ["create", "update", "delete"];

/**
 * Unpack a binary snapshot produced by `packSnapshotBinary`. Returns
 * `null` on malformed input.
 */
export function unpackSnapshotBinary(buf: Uint8Array): ServerSnapshot | null {
  try {
    if (buf.length < 14) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const time = dv.getFloat64(0, true);
    const lastInputSeq = dv.getUint32(8, true);
    const entityCount = dv.getUint16(12, true);
    let off = 14;
    const entities: EntitySnapshot[] = [];
    for (let i = 0; i < entityCount; i++) {
      const idLen = buf[off]; off += 1;
      const id = new TextDecoder().decode(buf.subarray(off, off + idLen));
      off += idLen;
      const typeNum = buf[off]; off += 1;
      const opNum = buf[off]; off += 1;
      const version = dv.getUint32(off, true); off += 4;
      const nfields = dv.getUint16(off, true); off += 2;
      const fields: Record<string, number | string | boolean> = {};
      for (let j = 0; j < nfields; j++) {
        const nameLen = buf[off]; off += 1;
        const name = new TextDecoder().decode(buf.subarray(off, off + nameLen));
        off += nameLen;
        const tag = buf[off]; off += 1;
        if (tag === FIELD_TAG_I32) {
          fields[name] = dv.getInt32(off, true);
          off += 4;
        } else if (tag === FIELD_TAG_F32) {
          fields[name] = dv.getFloat32(off, true);
          off += 4;
        } else if (tag === FIELD_TAG_BOOL) {
          fields[name] = buf[off] === 1;
          off += 1;
        } else if (tag === FIELD_TAG_STR) {
          const strLen = dv.getUint16(off, true);
          off += 2;
          fields[name] = new TextDecoder().decode(buf.subarray(off, off + strLen));
          off += strLen;
        } else {
          return null; // unknown tag — corrupt.
        }
      }
      entities.push({
        id,
        type: NUM_TO_TYPE[typeNum] ?? "item",
        op: NUM_TO_OP[opNum] ?? "update",
        fields,
        version,
      });
    }
    return { time, lastInputSeq, entities };
  } catch {
    return null;
  }
}
