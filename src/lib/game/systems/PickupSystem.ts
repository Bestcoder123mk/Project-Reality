import * as THREE from "three";
import type { GameSystem, GameContext } from "./types";

/**
 * PickupSystem — health + ammo pickups that drop from killed enemies.
 *
 * Drop chances (per enemy death):
 *   - Medkit:    1/10 (10%) — rare. Restores health to 100.
 *   - Bandage:   1/3  (33%) — common. Restores 35 health (caps at 100).
 *   - Ammo:      1/3  (33%) — common. Refills 50% of the reserve ammo pool.
 *
 * Pickups spawn at the enemy's death position, float + rotate, emit a soft
 * glow, and despawn after 30s if not collected. The player picks them up by
 * walking within 1.5m (auto-collect on proximity — no keypress needed).
 *
 * Visual design:
 *   - Medkit:    white box with a red cross (classic first-aid iconography).
 *   - Bandage:   small white roll with a red stripe.
 *   - Ammo:      dark olive box with brass rounds visible (ammo can).
 *
 * Each pickup is a small THREE.Group (3-5 meshes) with an emissive glow
 * material so it reads as a gameplay item at a glance. Pickups are NOT
 * colliders — the player can walk through them.
 *
 * The system is self-contained: it owns the pickup array, spawns them from
 * EnemySystem.killEnemy (via a hook), updates them per-frame (rotation + glow
 * pulse + proximity check), and removes them on collect/expire/dispose.
 *
 * Integration: EnemySystem calls `ctx.pickups?.spawnFromKill(pos)` in
 * killEnemy. The engine loop calls `ctx.pickups?.update(dt)`. On dispose,
 * clearPickups() removes all meshes from the scene.
 */

/** Pickup kinds with their drop weights + gameplay effects. */
export type PickupKind = "medkit" | "bandage" | "ammo";

export interface Pickup {
  kind: PickupKind;
  group: THREE.Group;
  pos: THREE.Vector3;
  spawnTime: number;
  collected: boolean;
  /** Glow child mesh (animated pulse). */
  glow: THREE.Mesh;
  /** Per-pickup rotation speed (slight variation). */
  rotSpeed: number;
  /** Per-pickup bob phase (offsets the float animation). */
  bobPhase: number;
}

/** Drop probability table. Evaluated on every enemy death. */
const DROP_TABLE: { kind: PickupKind; weight: number }[] = [
  { kind: "medkit", weight: 1 },    // 1/10 = 10%
  { kind: "bandage", weight: 3.33 }, // ~3.33/10 = 33%
  { kind: "ammo", weight: 3.33 },  // ~3.33/10 = 33%
  // (remaining ~23.34% = no drop)
];

const PICKUP_RADIUS = 1.5; // meters — auto-collect distance (horizontal)
// Prompt A#107 — vertical tolerance for the auto-collect check. Was: Y was
// zeroed (effectively infinite vertical tolerance — pickups grabbed through
// floors). 1.5m is generous for same-level play (player eye ~1.6m, pickup at
// ~0.8m → dy ~0.8m) but blocks collection across floor separations (>2m).
const PICKUP_VERT_TOL = 1.5; // meters
const PICKUP_LIFETIME = 30000; // 30s before despawn
const PICKUP_FLOAT_AMP = 0.12; // float amplitude (meters)
const PICKUP_FLOAT_FREQ = 1.8; // float frequency (Hz)
const PICKUP_ROT_SPEED = 1.2; // rotation speed (rad/s)

export class PickupSystem implements GameSystem {
  private ctx: GameContext;
  private pickups: Pickup[] = [];
  /** Reusable vector for proximity checks (avoids per-frame allocation). */
  private _toPlayer = new THREE.Vector3();

  constructor(ctx: GameContext) {
    this.ctx = ctx;
  }

  /** Spawn a pickup at a kill position (called by EnemySystem.killEnemy). */
  spawnFromKill(pos: THREE.Vector3) {
    // Roll the drop table.
    const roll = Math.random() * 10; // 0..10
    let kind: PickupKind | null = null;
    let acc = 0;
    for (const entry of DROP_TABLE) {
      acc += entry.weight;
      if (roll < acc) { kind = entry.kind; break; }
    }
    if (!kind) return; // no drop (~23% chance)

    this.spawn(kind, pos);
  }

  /** Spawn a specific pickup kind at a position (public — for testing/manual spawns). */
  spawn(kind: PickupKind, pos: THREE.Vector3) {
    const group = this.buildPickupMesh(kind);
    // Prompt A#108 — was `pos.y = 0.8` (hardcoded). If an enemy died on
    // stairs or a raised platform, the pickup floated in mid-air at Y=0.8
    // instead of resting on the surface. Now: spawn at deathPos.y + 0.2
    // (slight lift so the pickup mesh — modeled with its origin at the
    // base — sits ON the surface, not embedded in it).
    group.position.set(pos.x, pos.y + 0.2, pos.z);
    this.ctx.scene.add(group);

    const pickup: Pickup = {
      kind,
      group,
      pos: group.position.clone(),
      spawnTime: performance.now(),
      collected: false,
      glow: group.userData.glow as THREE.Mesh,
      rotSpeed: PICKUP_ROT_SPEED + (Math.random() - 0.5) * 0.4,
      bobPhase: Math.random() * Math.PI * 2,
    };
    this.pickups.push(pickup);
  }

  /** Build the visual mesh for a pickup kind. */
  private buildPickupMesh(kind: PickupKind): THREE.Group {
    const group = new THREE.Group();

    if (kind === "medkit") {
      // White box with a red cross.
      const boxMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.4, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.08 });
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.22), boxMat);
      box.castShadow = true;
      group.add(box);
      // Red cross — two perpendicular red boxes on the top face.
      const crossMat = new THREE.MeshStandardMaterial({ color: 0xc93030, roughness: 0.4, emissive: 0xc93030, emissiveIntensity: 0.3 });
      const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.02, 0.05), crossMat);
      crossH.position.set(0, 0.12, 0);
      group.add(crossH);
      const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.18), crossMat);
      crossV.position.set(0, 0.12, 0);
      group.add(crossV);
      // Glow disc beneath.
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xff6060, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      glow.scale.set(1, 0.3, 1);
      glow.position.y = -0.12;
      group.add(glow);
      group.userData.glow = glow;
    } else if (kind === "bandage") {
      // Small white roll with a red stripe.
      const rollMat = new THREE.MeshStandardMaterial({ color: 0xeaeaea, roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.06 });
      const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 12), rollMat);
      roll.rotation.z = Math.PI / 2; // lay on its side
      roll.castShadow = true;
      group.add(roll);
      // Red stripe.
      const stripeMat = new THREE.MeshStandardMaterial({ color: 0xc93030, roughness: 0.4, emissive: 0xc93030, emissiveIntensity: 0.25 });
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.19, 0.19), stripeMat);
      group.add(stripe);
      // Glow disc.
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xff8080, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      glow.scale.set(1, 0.3, 1);
      glow.position.y = -0.1;
      group.add(glow);
      group.userData.glow = glow;
    } else {
      // Ammo — dark olive box with brass rounds.
      const boxMat = new THREE.MeshStandardMaterial({ color: 0x3a4a2a, roughness: 0.7, metalness: 0.1, emissive: 0x2a3a1a, emissiveIntensity: 0.15 });
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.2), boxMat);
      box.castShadow = true;
      group.add(box);
      // Brass rounds on top (4 small cylinders).
      const brassMat = new THREE.MeshStandardMaterial({ color: 0xb8862a, roughness: 0.35, metalness: 0.85, emissive: 0x6a4a10, emissiveIntensity: 0.2 });
      for (let i = 0; i < 4; i++) {
        const round = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 8), brassMat);
        round.position.set(-0.09 + i * 0.06, 0.12, 0);
        group.add(round);
      }
      // Glow disc.
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.24, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      glow.scale.set(1, 0.3, 1);
      glow.position.y = -0.1;
      group.add(glow);
      group.userData.glow = glow;
    }

    return group;
  }

  update(dt: number) {
    const now = performance.now();
    const player = this.ctx.player;

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (p.collected) {
        this.removePickup(i);
        continue;
      }

      // Expire after lifetime.
      if (now - p.spawnTime > PICKUP_LIFETIME) {
        // Fade out in the last 2s — skip for simplicity, just remove.
        this.removePickup(i);
        continue;
      }

      // Float + rotate.
      const age = (now - p.spawnTime) / 1000;
      // Prompt A#108 — bob around the pickup's authored spawn Y (p.pos.y),
      // not a hardcoded 0.8. A pickup that spawned on a 3m platform now
      // floats around 3.2m, not 0.92m (which would put it through the floor).
      p.group.position.y = p.pos.y + Math.sin(age * PICKUP_FLOAT_FREQ * Math.PI * 2 + p.bobPhase) * PICKUP_FLOAT_AMP;
      p.group.rotation.y += p.rotSpeed * dt;

      // Glow pulse.
      const pulse = 0.7 + Math.sin(age * 4) * 0.3;
      if (p.glow) {
        (p.glow.material as THREE.MeshBasicMaterial).opacity = 0.12 + pulse * 0.1;
        p.glow.scale.setScalar(0.9 + pulse * 0.2);
      }

      // Proximity check — auto-collect.
      // Prompt A#107 — was `set(dx, 0, dz)` which zeroed Y, so pickups
      // were collectible from ANY height (a player on the floor above an
      // enemy's death pickup could grab it through the ceiling). Now:
      // include Y with a vertical tolerance (PICKUP_VERT_TOL). The
      // horizontal radius (PICKUP_RADIUS) is preserved; the vertical is a
      // separate gate so a player within 1.5m horizontally AND within 1.5m
      // vertically collects. A floor (typically 0.2-0.3m thick) blocks
      // pickup through it because the player's eye Y differs from the
      // pickup's rest Y by > PICKUP_VERT_TOL when on different levels.
      const dy = player.pos.y - p.pos.y;
      this._toPlayer.set(player.pos.x - p.pos.x, 0, player.pos.z - p.pos.z);
      const horizDistSq = this._toPlayer.lengthSq();
      if (horizDistSq < PICKUP_RADIUS * PICKUP_RADIUS && Math.abs(dy) < PICKUP_VERT_TOL) {
        this.collect(p);
        this.removePickup(i);
      }
    }
  }

  /** Apply the pickup's gameplay effect + feedback. */
  private collect(p: Pickup) {
    const { player, weapon, audio, match } = this.ctx;
    p.collected = true;

    if (p.kind === "medkit") {
      player.health = Math.min(100, player.health + 100);
      this.ctx.pushHud({ health: player.health, objective: "MEDKIT — Health restored" });
    } else if (p.kind === "bandage") {
      player.health = Math.min(100, player.health + 35);
      this.ctx.pushHud({ health: player.health, objective: "BANDAGE — +35 HP" });
    } else {
      // Ammo — refill 50% of the reserve pool.
      const refill = Math.ceil(weapon.stats.effectiveMagSize * 1.5);
      weapon.reserveAmmo += refill;
      this.ctx.pushHud({ reserveAmmo: weapon.reserveAmmo, objective: `AMMO — +${refill} rounds` });
    }

    // Audio + visual feedback.
    audio.hitMarker?.();
    this.ctx.triggerShake(0.05);
    // Briefly tint the objective text amber (the pushHud objective string will
    // be overwritten by the next wave/score update — fine for a 1-2s flash).
    match.score += 10; // small score bonus for picking up
    this.ctx.pushHud({ score: match.score });
  }

  /** Remove a pickup from the scene + array. */
  private removePickup(index: number) {
    const p = this.pickups[index];
    if (!p) return;
    this.ctx.scene.remove(p.group);
    // Dispose geometries + materials (pickups are short-lived, not pooled).
    p.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose?.();
        const mat = o.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
        else mat?.dispose?.();
      }
    });
    this.pickups.splice(index, 1);
  }

  /** Clear all pickups (on match restart / dispose). */
  clearPickups() {
    while (this.pickups.length > 0) this.removePickup(0);
  }

  /** Current pickup count (for debugging). */
  get count(): number { return this.pickups.length; }

  /** V3 — pickup positions for debugging. Returns [x,y,z] per pickup. */
  pickupPositions(): [number, number, number][] {
    return this.pickups.map((p) => [Math.round(p.pos.x * 10) / 10, Math.round(p.pos.y * 10) / 10, Math.round(p.pos.z * 10) / 10]);
  }

  dispose() {
    this.clearPickups();
  }
}
