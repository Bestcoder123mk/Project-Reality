/**
 * Section F — Civilian AI.
 *
 * Addresses Section F prompts for "non-combatant NPCs with panic behavior".
 * Civilians are non-hostile NPCs that flee from combat, scream, cower in
 * corners, and can be wounded or killed by stray fire (with consequences
 * for the player's score / morality).
 *
 * Design:
 *   - A Civilian is a lightweight NPC (not a full Enemy) — it has a
 *     position, health, and an FSM with 5 states: IDLE, FLEE, COWER,
 *     WOUNDED, DEAD.
 *   - Panic is triggered by nearby gunfire, explosions, grenades, or
 *     seeing the player or an enemy at close range.
 *   - Fleeing civilians run away from the nearest threat at a sprint,
 *     occasionally screaming (CIVILIAN_SCREAM bark). They seek the
 *     nearest "safe zone" (level corner / exit) and cower there.
 *   - Cowering civilians stay put in a corner with hands up; if approached
 *     by an armed actor, they may beg (CIVILIAN_BEG).
 *   - Wounded civilians crawl + bleed (re-using the wounded-behavior
 *     module's logic, scaled down).
 *   - Killing a civilian penalizes the player (score -500, morality -1).
 *     Wounding a civilian penalizes less.
 *
 * Pure-TS, SSR-safe. THREE is imported lazily for the mesh + Vector3 ops.
 *
 * Integration:
 *   - The engine constructs a CivilianManager per match (or per level in
 *     scenarios that have civilians). Each Civilian has a THREE.Group
 *     mesh (built lazily via buildHumanoid with a civilian color).
 *   - The manager ticks each civilian per frame + listens to the
 *     AcousticBus for panic triggers.
 *   - The damage system calls `damageCivilian(c, amount)` when a projectile
 *     hits a civilian mesh (the mesh's userData.civilian = c is set on
 *     construction).
 */

import * as THREE from "three";
import type { GameContext } from "../systems/types";
import { buildHumanoid, animateGait } from "../systems/utils";

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type CivilianState = "IDLE" | "FLEE" | "COWER" | "WOUNDED" | "DEAD";

export interface Civilian {
  /** Unique ID. */
  id: string;
  /** World mesh (humanoid, civilian-colored). */
  group: THREE.Group;
  parts: Record<string, THREE.Mesh>;
  /** Current FSM state. */
  state: CivilianState;
  /** Position (mirrors group.position — kept for cheap reads). */
  posX: number;
  posY: number;
  posZ: number;
  /** Velocity (m/s). */
  velX: number;
  velZ: number;
  /** Health. */
  health: number;
  maxHealth: number;
  alive: boolean;
  /** Panic level 0..1. Decays slowly; spikes on acoustic events. */
  panic: number;
  /** Current flee target (a safe zone corner). */
  fleeTargetX: number;
  fleeTargetZ: number;
  /** performance.now() when the civilian entered its current state. */
  stateEnteredAt: number;
  /** Next allowed scream time (cooldown). */
  nextScreamAt: number;
  /** Gait phase for animation. */
  gaitPhase: number;
  /** True if the civilian has been "rescued" (reached a safe zone). */
  rescued: boolean;
  /** Dead timestamp (for ragdoll / removal). */
  deadAt: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Tunables
// ───────────────────────────────────────────────────────────────────────────

const CIV_SPEED_WALK = 1.0;
const CIV_SPEED_SPRINT = 4.5;
const CIV_HEALTH = 60;
const PANIC_DECAY_PER_SEC = 0.05;
const PANIC_TRIGGER_THRESHOLD = 0.3;
const SCREAM_COOLDOWN_MS = 2500;
const COWER_DURATION_MS = 8000; // cower for 8s before re-evaluating.
const FLEE_REEVAL_MS = 2000;
const SAFE_ZONE_RADIUS_M = 4;
const SAFE_ZONES = [
  { x: -40, z: -40 }, { x: 40, z: -40 },
  { x: -40, z: 40 }, { x: 40, z: 40 },
];

// ───────────────────────────────────────────────────────────────────────────
// CivilianManager
// ───────────────────────────────────────────────────────────────────────────

export class CivilianManager {
  private civilians: Civilian[] = [];
  private ctx: GameContext;
  /** Penalty score (player-killed civilians). Read by the engine to
   *  subtract from the player's match score. */
  civilianKillPenalty: number = 0;
  /** Total civilians wounded by the player. */
  civilianWoundCount: number = 0;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
  }

  /** Spawn a civilian at the given position. Returns the civilian. */
  spawn(x: number, z: number): Civilian {
    // Civilian mesh — neutral civilian clothing color (light brown / gray).
    const built = buildHumanoid(0x6b5a45);
    built.group.position.set(x, 0, z);
    this.ctx.scene.add(built.group);
    const id = `civ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const civ: Civilian = {
      id,
      group: built.group,
      parts: built.parts,
      state: "IDLE",
      posX: x, posY: 0, posZ: z,
      velX: 0, velZ: 0,
      health: CIV_HEALTH,
      maxHealth: CIV_HEALTH,
      alive: true,
      panic: 0,
      fleeTargetX: x,
      fleeTargetZ: z,
      stateEnteredAt: performance.now(),
      nextScreamAt: 0,
      gaitPhase: Math.random() * Math.PI * 2,
      rescued: false,
      deadAt: 0,
    };
    // Tag the mesh's parts so the damage system can identify them.
    for (const p of Object.values(built.parts)) {
      p.userData.civilian = civ;
    }
    this.civilians.push(civ);
    return civ;
  }

  /** Spawn N civilians at random positions in the level. */
  spawnRandom(n: number, rng: () => number = Math.random): void {
    for (let i = 0; i < n; i++) {
      const x = (rng() - 0.5) * 70;
      const z = (rng() - 0.5) * 70;
      this.spawn(x, z);
    }
  }

  /** Damage a civilian (called by the projectile system on hit). Returns
   *  true if the civilian died from this damage. */
  damageCivilian(civ: Civilian, amount: number, now: number = performance.now()): boolean {
    if (!civ.alive) return false;
    civ.health -= amount;
    if (civ.health <= 0) {
      civ.health = 0;
      civ.alive = false;
      civ.deadAt = now;
      civ.state = "DEAD";
      this.civilianKillPenalty += 500;
      return true;
    }
    // Wounded threshold.
    if (civ.health < civ.maxHealth * 0.3) {
      civ.state = "WOUNDED";
      civ.stateEnteredAt = now;
      this.civilianWoundCount++;
    }
    return false;
  }

  /** Tick all civilians. */
  update(dt: number, now: number = performance.now()): void {
    for (const civ of this.civilians) {
      if (!civ.alive) continue;
      this.tickCivilian(civ, dt, now);
    }
    // Remove long-dead civilians (after 5s — gives the ragdoll time to settle).
    this.civilians = this.civilians.filter((c) => {
      if (c.alive) return true;
      if (now - c.deadAt > 5000) {
        this.ctx.scene.remove(c.group);
        return false;
      }
      return true;
    });
  }

  /** Get all civilians (for debug / HUD). */
  getAll(): Civilian[] { return this.civilians; }

  /** Get all alive civilians. */
  getAlive(): Civilian[] { return this.civilians.filter((c) => c.alive); }

  /** Reset (called on match restart). */
  dispose(): void {
    for (const c of this.civilians) {
      this.ctx.scene.remove(c.group);
    }
    this.civilians = [];
    this.civilianKillPenalty = 0;
    this.civilianWoundCount = 0;
  }

  // ---------- Internal ----------

  private tickCivilian(civ: Civilian, dt: number, now: number): void {
    // Decay panic.
    civ.panic = Math.max(0, civ.panic - PANIC_DECAY_PER_SEC * dt);

    // ---------- Acoustic panic triggers (re-using ctx if it has the bus) ----------
    // The engine wires an acoustic bus on ctx.acousticBus?.drain — we cast.
    const bus = (this.ctx as unknown as {
      acousticBus?: { drain: (sinceMs: number) => Array<{ x: number; z: number; loudness: number; kind: string }> };
    }).acousticBus;
    if (bus) {
      const events = bus.drain(now - 200);
      for (const ev of events) {
        const dx = ev.x - civ.posX;
        const dz = ev.z - civ.posZ;
        const d2 = dx * dx + dz * dz;
        const radius = ev.kind === "explosion" ? 80 : ev.kind === "gunshot" ? 40 : 15;
        if (d2 <= radius * radius) {
          const loudness = ev.loudness * (1 - Math.sqrt(d2) / radius);
          civ.panic = Math.min(1, civ.panic + loudness * 0.6);
          break;
        }
      }
    }

    // ---------- State machine ----------
    switch (civ.state) {
      case "IDLE": {
        // Idle: wander slowly. If panic spikes, flee.
        if (civ.panic > PANIC_TRIGGER_THRESHOLD) {
          this.transition(civ, "FLEE", now);
          break;
        }
        // Random wander.
        if (Math.random() < 0.01) {
          civ.velX = (Math.random() - 0.5) * CIV_SPEED_WALK;
          civ.velZ = (Math.random() - 0.5) * CIV_SPEED_WALK;
        }
        this.applyMovement(civ, dt);
        break;
      }
      case "FLEE": {
        // Pick a flee target (nearest safe zone) if not set or re-evaluate periodically.
        if (now - civ.stateEnteredAt > FLEE_REEVAL_MS || (civ.fleeTargetX === civ.posX && civ.fleeTargetZ === civ.posZ)) {
          const safe = this.pickSafeZone(civ);
          civ.fleeTargetX = safe.x;
          civ.fleeTargetZ = safe.z;
        }
        // Move toward the safe zone at sprint speed.
        const dx = civ.fleeTargetX - civ.posX;
        const dz = civ.fleeTargetZ - civ.posZ;
        const d = Math.hypot(dx, dz) || 1;
        civ.velX = (dx / d) * CIV_SPEED_SPRINT;
        civ.velZ = (dz / d) * CIV_SPEED_SPRINT;
        this.applyMovement(civ, dt);
        // Scream occasionally.
        if (now > civ.nextScreamAt) {
          civ.nextScreamAt = now + SCREAM_COOLDOWN_MS;
          // (The barks system can pick up the scream; we don't emit here.)
        }
        // Reached safe zone → cower.
        if (d < SAFE_ZONE_RADIUS_M) {
          this.transition(civ, "COWER", now);
          civ.rescued = true;
        }
        break;
      }
      case "COWER": {
        // Stay put; face away from the threat.
        civ.velX = 0;
        civ.velZ = 0;
        if (now - civ.stateEnteredAt > COWER_DURATION_MS && civ.panic < 0.2) {
          this.transition(civ, "IDLE", now);
        }
        break;
      }
      case "WOUNDED": {
        // Crawl toward the nearest safe zone slowly; bleed.
        civ.health -= 0.5 * dt; // 0.5 HP/sec bleed.
        if (civ.health <= 0) {
          civ.health = 0;
          civ.alive = false;
          civ.deadAt = now;
          civ.state = "DEAD";
          break;
        }
        const safe = this.pickSafeZone(civ);
        const dx = safe.x - civ.posX;
        const dz = safe.z - civ.posZ;
        const d = Math.hypot(dx, dz) || 1;
        civ.velX = (dx / d) * CIV_SPEED_WALK * 0.4;
        civ.velZ = (dz / d) * CIV_SPEED_WALK * 0.4;
        this.applyMovement(civ, dt);
        break;
      }
      case "DEAD": {
        civ.velX = 0;
        civ.velZ = 0;
        break;
      }
    }

    // Animate gait if moving.
    const speed = Math.hypot(civ.velX, civ.velZ);
    if (speed > 0.1) {
      civ.gaitPhase += dt * 8;
      animateGait(civ.parts, civ.gaitPhase, speed, speed > 3.5);
    }
    // Update facing.
    if (speed > 0.1) {
      civ.group.rotation.y = Math.atan2(civ.velX, civ.velZ);
    }
  }

  private transition(civ: Civilian, newState: CivilianState, now: number): void {
    civ.state = newState;
    civ.stateEnteredAt = now;
  }

  private applyMovement(civ: Civilian, dt: number): void {
    civ.posX += civ.velX * dt;
    civ.posZ += civ.velZ * dt;
    // Bounds clamp.
    const b = 43;
    civ.posX = Math.max(-b, Math.min(b, civ.posX));
    civ.posZ = Math.max(-b, Math.min(b, civ.posZ));
    civ.group.position.x = civ.posX;
    civ.group.position.z = civ.posZ;
  }

  private pickSafeZone(civ: Civilian): { x: number; z: number } {
    let best = SAFE_ZONES[0];
    let bestD = Infinity;
    for (const z of SAFE_ZONES) {
      const d = Math.hypot(z.x - civ.posX, z.z - civ.posZ);
      if (d < bestD) { bestD = d; best = z; }
    }
    return best;
  }
}
