import * as THREE from "three";
import type { GameContext, Enemy, GameSystem } from "./types";
import type { Rarity } from "../store";

/**
 * Task-11 — Finisher animation system.
 *
 * Hooks into the kill flow: ~15% random chance on any kill, OR deliberate
 * via the takedown key when the player is behind a low-health enemy. When
 * triggered, runs a short scripted sequence (~1.5-2s):
 *
 *   1. lockPlayerInput  — InputSystem should call `isInputLocked()`.
 *   2. move/hold camera — system lerps ctx.camera to a cinematic angle.
 *   3. run finisher     — scripted transforms on the enemy (position /
 *      rotation / scale tweens). Slow-mo (5x) is triggered in parallel.
 *   4. restore control  — camera is released, input unlocked, enemy is
 *      marked dead + ragdoll/kill credit applied via the host kill flow.
 *
 * Six finishers — mix of grounded + absurd:
 *   slam, throw, shark, suplex, squish, disintegrate.
 *
 * The SHARK finisher is specifically user-requested. A ~2.5m cartoon great-
 * white emerges from the ground, chomps the enemy, and dives back under.
 *
 * Public API:
 *   - FINISHERS record (catalog for the gunsmith/pack UIs)
 *   - FinisherSystem class (the per-frame driver; constructed by the engine)
 *   - triggerFinisher(ctx, enemy, slug) — convenience entry point that
 *     finds the running FinisherSystem instance on ctx and starts a
 *     finisher. (Engine registers itself: `ctx.finishers = new FinisherSystem(ctx)`.)
 */

export type FinisherSlug = "slam" | "throw" | "shark" | "suplex" | "squish" | "disintegrate";

export interface FinisherConfig {
  slug: FinisherSlug;
  name: string;
  desc: string;
  /** "grounded" (physical) vs "absurd" (cartoon/supernatural). */
  tone: "grounded" | "absurd";
  rarity: Rarity;
  /** Total sequence duration (seconds). */
  duration: number;
}

export const FINISHERS: Record<FinisherSlug, FinisherConfig> = {
  slam: {
    slug: "slam", name: "Body Slam", desc: "Hoist and drive them into the dirt.",
    tone: "grounded", rarity: "RARE", duration: 1.6,
  },
  throw: {
    slug: "throw", name: "Throw", desc: "Hurl them backward like a ragdoll.",
    tone: "grounded", rarity: "RARE", duration: 1.6,
  },
  shark: {
    slug: "shark", name: "Shark Attack", desc: "A great-white lunges from below. They never see it coming.",
    tone: "absurd", rarity: "LEGENDARY", duration: 2.0,
  },
  suplex: {
    slug: "suplex", name: "Suplex", desc: "Wrestling takedown — bridge and drop.",
    tone: "grounded", rarity: "EPIC", duration: 1.7,
  },
  squish: {
    slug: "squish", name: "Squish", desc: "Cartoon flatten. Pancake, dust, done.",
    tone: "absurd", rarity: "EPIC", duration: 1.5,
  },
  disintegrate: {
    slug: "disintegrate", name: "Disintegrate", desc: "Dissolve into a cloud of glowing ash.",
    tone: "absurd", rarity: "LEGENDARY", duration: 1.8,
  },
};

// ─── Helpers ─────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ─── Shark builder (large, for the SHARK finisher) ───────────

/** Build a ~2.5m cartoon great-white shark mesh for the SHARK finisher.
 *  Reuses the charm shark's aesthetic at 100× scale. */
function buildFinisherShark(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a6a82, roughness: 0.38, metalness: 0.2 });
  const bellyMat = new THREE.MeshStandardMaterial({ color: 0xd0d8de, roughness: 0.4, metalness: 0.1 });
  const finMat = bodyMat;
  const toothMat = new THREE.MeshStandardMaterial({ color: 0xf6f6ec, roughness: 0.3 });
  const mouthMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });

  // Body — elongated ellipsoid (1.4m long, 0.4m tall/wide).
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 16), bodyMat);
  body.scale.set(0.7, 0.7, 2.6);
  g.add(body);
  // Belly underside.
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 14), bellyMat);
  belly.scale.set(0.65, 0.5, 2.4);
  belly.position.y = -0.12;
  g.add(belly);
  // Dorsal fin — large triangular prism.
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.7, 4), finMat);
  dorsal.position.set(0, 0.45, 0);
  dorsal.rotation.y = Math.PI / 4;
  dorsal.scale.set(0.7, 1, 0.25);
  g.add(dorsal);
  // Tail fin.
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.85, 4), finMat);
  tail.position.set(0, 0.05, 1.35);
  tail.rotation.x = Math.PI / 2;
  tail.rotation.y = Math.PI / 4;
  tail.scale.set(0.9, 1, 0.2);
  g.add(tail);
  // Pectoral fins.
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.7, 4), finMat);
    fin.position.set(side * 0.35, -0.15, -0.2);
    fin.rotation.z = side * Math.PI / 2.4;
    fin.rotation.x = -Math.PI / 4;
    fin.scale.set(0.6, 1, 0.35);
    g.add(fin);
  }
  // Eyes.
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.3 });
  for (const sx of [-0.22, 0.22]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), eyeMat);
    eye.position.set(sx, 0.1, -1.0);
    g.add(eye);
  }
  // Mouth — dark slit.
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.4), mouthMat);
  mouth.position.set(0, -0.15, -1.15);
  g.add(mouth);
  // Teeth — two rows of triangles.
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 8; i++) {
      const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 4), toothMat);
      tooth.position.set(-0.22 + i * 0.063, row === 0 ? -0.1 : -0.2, -1.25);
      tooth.rotation.x = row === 0 ? Math.PI : 0;
      g.add(tooth);
    }
  }
  // Shadows on.
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return g;
}

// ─── Active sequence state ───────────────────────────────────

interface SequenceState {
  slug: FinisherSlug;
  enemy: Enemy;
  start: number; // performance.now()
  duration: number; // seconds
  // Saved state for restore.
  savedCameraPos: THREE.Vector3;
  savedCameraQuat: THREE.Quaternion;
  savedViewMode: "first" | "third";
  // Per-finisher scratch (set by the trigger).
  scratch: Record<string, THREE.Vector3 | number>;
  // Optional prop (e.g. the finisher shark) added to the scene + cleaned up at end.
  prop?: THREE.Object3D;
  // True once the kill credit has been applied (prevents double-credit on long sequences).
  killed: boolean;
}

// Extend GameContext with the optional finishers field.
declare module "./types" {
  interface GameContext {
    /** Task-11 — finisher animation system. Set by the engine after
     *  construction. Undefined if not yet constructed or disposed. */
    finishers?: FinisherSystem;
  }
}

export class FinisherSystem implements GameSystem {
  private active: SequenceState | null = null;
  /** Slow-mo time scale applied during a finisher. */
  private readonly slowMoScale = 0.25;
  /** Random trigger chance on any kill (0..1). */
  readonly randomTriggerChance = 0.15;
  /** SEC4-ANIM (prompt 37) — cinematic camera helpers (framing + handheld shake). */
  private finisherCam = new FinisherCamera();

  constructor(private ctx: GameContext) {
    // Self-register.
    ctx.finishers = this;
  }

  /** True while a finisher sequence is playing. InputSystem should gate
   *  movement + look + weapon fire on this. */
  isInputLocked(): boolean {
    return this.active !== null;
  }

  /** True while a finisher is running and the camera should NOT be
   *  overwritten by the player's look input. */
  isCameraLocked(): boolean {
    return this.active !== null;
  }

  /** Trigger a finisher on the given enemy. Returns true if started.
   *  Caller is responsible for choosing the slug (random or deliberate). */
  trigger(enemy: Enemy, slug: FinisherSlug): boolean {
    if (this.active) return false;
    if (!enemy || !enemy.alive) return false;
    const cfg = FINISHERS[slug];
    if (!cfg) return false;
    const { ctx } = this;

    // ── 1. Lock player input (InputSystem checks isInputLocked). ──
    // ── 2. Save + move camera. Switch to 3rd-person for the cinematic. ──
    const savedViewMode = ctx.player.viewMode;
    ctx.player.viewMode = "third";
    if (ctx.avatar) ctx.avatar.group.visible = true;

    this.active = {
      slug,
      enemy,
      start: performance.now(),
      duration: cfg.duration,
      savedCameraPos: ctx.camera.position.clone(),
      savedCameraQuat: ctx.camera.quaternion.clone(),
      savedViewMode,
      scratch: {},
      killed: false,
    };

    // ── 3. Trigger slow-mo (engine ramps timeScale back at the end). ──
    ctx.triggerSlowMotion?.(cfg.duration * 1000);
    // Engine may not respect our exact timeScale; we also set ctx.timeScale
    // for systems that read it directly.
    ctx.timeScale = this.slowMoScale;

    // ── Per-finisher setup ──
    const enemyPos = enemy.group.position.clone();
    const playerPos = ctx.player.pos.clone();
    // Direction from player to enemy (horizontal).
    const toEnemy = new THREE.Vector3().subVectors(enemyPos, playerPos);
    toEnemy.y = 0;
    toEnemy.normalize();
    // Place enemy ~1.5m in front of player.
    const enemyTarget = playerPos.clone().addScaledVector(toEnemy, 1.5);
    enemyTarget.y = enemyPos.y;
    enemy.group.position.copy(enemyTarget);
    // Face the player.
    const faceYaw = Math.atan2(-toEnemy.x, -toEnemy.z);
    enemy.group.rotation.y = faceYaw;

    if (slug === "shark") {
      // Build the shark prop, place it underground beneath the enemy.
      const shark = buildFinisherShark();
      shark.position.set(enemyTarget.x, -2.5, enemyTarget.z);
      shark.rotation.y = faceYaw + Math.PI; // nose pointing up at the enemy
      ctx.scene.add(shark);
      this.active.prop = shark;
      this.active.scratch.startY = -2.5;
      this.active.scratch.peakY = enemyTarget.y + 0.6;
      this.active.scratch.diveY = -3.0;
    } else if (slug === "disintegrate") {
      this.active.scratch.startScale = 1.0;
    } else if (slug === "squish") {
      this.active.scratch.startScale = 1.0;
    }

    // Push a HUD objective banner so the player sees the finisher name.
    ctx.pushHud({ objective: `FINISHER — ${cfg.name.toUpperCase()}` });

    // SEC4-ANIM (prompt 37) — apply rule-of-thirds framing + start a slight
    // handheld shake for the cinematic. The framing is a starting pose; the
    // orbit in update() will continue to drift the camera from there.
    const framing = this.finisherCam.frameKill(playerPos, enemyTarget);
    ctx.camera.position.copy(framing.position);
    ctx.camera.lookAt(framing.target);
    if (ctx.camera.fov !== framing.fov) {
      ctx.camera.fov = framing.fov;
      ctx.camera.updateProjectionMatrix();
    }
    this.finisherCam.addHandheldShake(0.5);

    return true;
  }

  /** Per-frame driver. Active = run the sequence; otherwise no-op. */
  update(_dt: number) {
    if (!this.active) return;
    const seq = this.active;
    const elapsed = (performance.now() - seq.start) / 1000;
    const t = clamp01(elapsed / seq.duration);

    const { ctx } = this;
    const enemy = seq.enemy;
    const enemyPos = enemy.group.position;
    const playerPos = ctx.player.pos;

    // ── Camera: orbit slightly around the enemy + player mid-point. ──
    const focus = new THREE.Vector3().addVectors(playerPos, enemyPos).multiplyScalar(0.5);
    const camAngle = -Math.PI * 0.5 + t * Math.PI * 0.3; // slight orbit
    const camRadius = 3.2;
    const camHeight = 1.4 + Math.sin(t * Math.PI) * 0.4;
    const desiredCamPos = new THREE.Vector3(
      focus.x + Math.cos(camAngle) * camRadius,
      focus.y + camHeight,
      focus.z + Math.sin(camAngle) * camRadius,
    );
    ctx.camera.position.lerp(desiredCamPos, 0.1);
    ctx.camera.lookAt(focus);

    // SEC4-ANIM (prompt 37) — apply handheld shake on top of the orbit.
    const shake = this.finisherCam.tickShake(_dt);
    ctx.camera.position.add(shake.offset);
    ctx.camera.rotation.z += shake.roll;
    ctx.camera.rotation.x += shake.pitch;
    ctx.camera.rotation.y += shake.yaw;

    // ── Per-finisher animation ──
    switch (seq.slug) {
      case "slam":
        this.animSlam(seq, t, enemyPos);
        break;
      case "throw":
        this.animThrow(seq, t, enemyPos, playerPos);
        break;
      case "shark":
        this.animShark(seq, t, enemyPos);
        break;
      case "suplex":
        this.animSuplex(seq, t, enemyPos, playerPos);
        break;
      case "squish":
        this.animSquish(seq, t, enemy);
        break;
      case "disintegrate":
        this.animDisintegrate(seq, t, enemy, ctx);
        break;
    }

    // ── Kill credit at ~70% of the sequence (so death + score lands before restore). ──
    if (!seq.killed && t >= 0.7) {
      seq.killed = true;
      // Apply lethal damage via the host kill flow. We use a fallback: mark
      // the enemy dead + grant kill credit directly, since we don't have a
      // direct reference to EnemySystem here. The engine will pick up the
      // dead state + ragdoll next tick.
      enemy.health = 0;
      enemy.alive = false;
      enemy.state = "dead";
      enemy.deadTime = performance.now();
      enemy.fsm?.markDead();
      ctx.match.kills++;
      ctx.match.score += 250; // finisher bonus
      ctx.match.meleeKills++;
      ctx.match.killstreak++;
      if (ctx.match.killstreak > ctx.match.killstreakBest) {
        ctx.match.killstreakBest = ctx.match.killstreak;
      }
      ctx.audio.enemyDeath();
      ctx.addKillFeed({
        killer: "YOU",
        victim: enemy.className || "ENEMY",
        weapon: `FINISHER:${seq.slug}`,
        headshot: false,
      });
      // Shake for impact.
      ctx.triggerShake?.(0.8);
    }

    // ── End of sequence — restore. ──
    if (t >= 1) {
      // Remove any prop.
      if (seq.prop) {
        ctx.scene.remove(seq.prop);
        seq.prop.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.geometry.dispose();
            const m = o.material as THREE.Material | THREE.Material[];
            if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
            else m.dispose();
          }
        });
      }
      // Restore camera + view mode.
      ctx.camera.position.copy(seq.savedCameraPos);
      ctx.camera.quaternion.copy(seq.savedCameraQuat);
      ctx.player.viewMode = seq.savedViewMode;
      if (ctx.avatar) ctx.avatar.group.visible = seq.savedViewMode === "third";
      ctx.timeScale = 1.0;
      this.active = null;
      ctx.pushHud({ objective: "Eliminate all hostiles" });
    }
  }

  // ─── Per-finisher animation tweens ─────────────────────────

  /** SLAM — lift the enemy ~1m, then drop them fast. */
  private animSlam(seq: SequenceState, t: number, enemyPos: THREE.Vector3) {
    const lift = easeInOutCubic(t < 0.4 ? t / 0.4 : 1) * 1.0;
    const drop = t > 0.5 ? Math.pow((t - 0.5) / 0.5, 2) * 1.2 : 0;
    enemyPos.y = 0 + lift - drop;
    // Tilt forward as they're slammed.
    const enemyGroup = seq.enemy.group;
    enemyGroup.rotation.x = t > 0.5 ? -Math.PI / 2 * Math.pow((t - 0.5) / 0.5, 1.5) : 0;
  }

  /** THROW — launch the enemy backward in an arc. */
  private animThrow(seq: SequenceState, t: number, enemyPos: THREE.Vector3, playerPos: THREE.Vector3) {
    const dir = new THREE.Vector3().subVectors(enemyPos, playerPos);
    dir.y = 0;
    dir.normalize();
    const dist = Math.sin(t * Math.PI) * 2.5 + t * 3.0; // arc backward
    enemyPos.x = playerPos.x + dir.x * (1.5 + dist);
    enemyPos.z = playerPos.z + dir.z * (1.5 + dist);
    enemyPos.y = 0 + Math.sin(t * Math.PI) * 1.5; // arc up
    seq.enemy.group.rotation.x = -t * Math.PI * 0.7; // tumble forward
    seq.enemy.group.rotation.z = t * Math.PI * 1.5;
  }

  /** SHARK — shark lunges up from below, chomps the enemy, dives back. */
  private animShark(seq: SequenceState, t: number, enemyPos: THREE.Vector3) {
    const prop = seq.prop;
    if (!prop) return;
    const startY = (seq.scratch.startY as number) ?? -2.5;
    const peakY = (seq.scratch.peakY as number) ?? enemyPos.y + 0.6;
    const diveY = (seq.scratch.diveY as number) ?? -3.0;
    let sharkY: number;
    let sharkPitch = 0;
    if (t < 0.45) {
      // Lunge up — shark rises from underground to peak.
      const u = easeOutCubic(t / 0.45);
      sharkY = startY + (peakY - startY) * u;
      sharkPitch = -Math.PI / 3 * (1 - u); // tilt nose-up as it rises
    } else if (t < 0.6) {
      // Chomp pause — shark holds at peak, mouth snaps.
      sharkY = peakY;
      sharkPitch = 0;
      // Enemy gets yanked into the mouth.
      enemyPos.y = peakY - 0.3;
    } else {
      // Dive back down — shark drags enemy under.
      const u = easeInOutCubic((t - 0.6) / 0.4);
      sharkY = peakY + (diveY - peakY) * u;
      sharkPitch = Math.PI / 3 * u;
      // Enemy goes under too (fade).
      enemyPos.y = peakY * (1 - u) + diveY * u;
      // Scale the enemy down as they're dragged under.
      const s = 1 - u * 0.9;
      seq.enemy.group.scale.setScalar(s);
    }
    prop.position.set(enemyPos.x, sharkY, enemyPos.z);
    prop.rotation.x = sharkPitch;
    // Open/close the mouth via a scale tweak on the body (cartoon chomp).
    const body = prop.children[0];
    if (body) {
      const chomp = t > 0.4 && t < 0.55 ? Math.sin((t - 0.4) * 60) * 0.05 + 1 : 1;
      body.scale.set(0.7 * chomp, 0.7 * chomp, 2.6);
    }
  }

  /** SUPLEX — player lifts enemy overhead, then drops backward. */
  private animSuplex(seq: SequenceState, t: number, enemyPos: THREE.Vector3, playerPos: THREE.Vector3) {
    const enemyGroup = seq.enemy.group;
    if (t < 0.5) {
      // Lift — enemy rises above + behind the player's head.
      const u = easeOutCubic(t / 0.5);
      enemyPos.x = playerPos.x;
      enemyPos.z = playerPos.z;
      enemyPos.y = 0 + u * 1.6;
      enemyGroup.rotation.x = -u * Math.PI * 0.4; // lean back
    } else {
      // Drop — enemy swings overhead + slams down behind player.
      const u = easeInOutCubic((t - 0.5) / 0.5);
      enemyPos.y = 1.6 - u * 1.6;
      enemyGroup.rotation.x = -Math.PI * 0.4 - u * Math.PI * 0.9; // full rotation overhead
    }
  }

  /** SQUISH — cartoon flatten. Enemy y-scale collapses to ~0.05. */
  private animSquish(seq: SequenceState, t: number, enemy: Enemy) {
    const enemyGroup = enemy.group;
    if (t < 0.3) {
      // Anticipation — enemy rises slightly.
      enemyGroup.position.y = t * 0.3;
      enemyGroup.scale.setScalar(1.0);
    } else {
      // Squish — y-scale collapses with a bounce.
      const u = clamp01((t - 0.3) / 0.7);
      const sy = Math.max(0.05, 1 - easeOutCubic(u) * 0.95);
      const sxz = 1 + easeOutCubic(u) * 0.7; // spread sideways
      enemyGroup.scale.set(sxz, sy, sxz);
      enemyGroup.position.y = 0;
    }
  }

  /** DISINTEGRATE — enemy dissolves into glowing particles. */
  private animDisintegrate(seq: SequenceState, t: number, enemy: Enemy, ctx: GameContext) {
    const enemyGroup = enemy.group;
    // Scale + fade the enemy as t→1.
    const s = Math.max(0.05, 1 - t);
    enemyGroup.scale.setScalar(s);
    // Tint: walk meshes, increase emissive over time.
    enemyGroup.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshStandardMaterial;
      if (m && m.isMaterial && "emissive" in m) {
        m.emissive = new THREE.Color(0xff8030).multiplyScalar(t * 0.8);
        if ("emissiveIntensity" in m) (m as any).emissiveIntensity = t * 1.5;
        if ("transparent" in m) { m.transparent = true; m.opacity = Math.max(0, 1 - t); }
      }
    });
    // Spawn a few ember particles each frame in the upper half of the sequence.
    if (t > 0.2 && t < 0.9 && Math.random() < 0.5) {
      this.spawnEmber(ctx, enemyGroup.position);
    }
  }

  private _emberGeo?: THREE.SphereGeometry;
  private spawnEmber(ctx: GameContext, origin: THREE.Vector3) {
    if (!this._emberGeo) this._emberGeo = new THREE.SphereGeometry(0.04, 6, 4);
    const mat = new THREE.MeshBasicMaterial({
      color: Math.random() < 0.5 ? 0xff8030 : 0xffd040,
      transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const m = new THREE.Mesh(this._emberGeo, mat);
    m.position.copy(origin);
    m.position.x += (Math.random() - 0.5) * 0.5;
    m.position.y += Math.random() * 1.2;
    m.position.z += (Math.random() - 0.5) * 0.5;
    ctx.scene.add(m);
    // Animate up + fade, then remove after 1s.
    const startT = performance.now();
    const tick = () => {
      const dt = (performance.now() - startT) / 1000;
      if (dt > 1.0) {
        ctx.scene.remove(m);
        mat.dispose();
        return;
      }
      m.position.y += 0.018;
      mat.opacity = 0.9 * (1 - dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Called by the engine on a normal kill. ~15% chance to hijack the
   *  kill flow with a random finisher. Returns true if hijacked (the
   *  engine should NOT then run the normal death sequence — the finisher
   *  will apply the kill credit itself). */
  maybeTriggerOnKill(enemy: Enemy): boolean {
    if (this.active) return false;
    if (!enemy || !enemy.alive) return false;
    if (Math.random() > this.randomTriggerChance) return false;
    // Pick a weighted random finisher.
    const pool: FinisherSlug[] = ["slam", "throw", "suplex", "squish", "disintegrate", "shark"];
    const slug = pool[Math.floor(Math.random() * pool.length)];
    return this.trigger(enemy, slug);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEC4-ANIM (prompt 37) — FinisherCamera
//
// Cinematic camera helpers for finisher sequences:
//   - frameKill(killerPos, victimPos) — rule-of-thirds framing on the kill.
//   - addHandheldShake(intensity) — start a multi-frequency handheld shake.
//   - tickShake(dt) — advance the shake + return the offset/rotation deltas.
//
// The framing rule: place the camera off to one side at ~60-90° from the
// killer→victim line, so both subjects sit on the rule-of-thirds verticals.
// The victim (the more visually-interesting subject during a finisher) sits
// on the LEFT third; the killer on the RIGHT third. Camera height is chest-
// level (1.4m); FOV widens at close range so both subjects fit.
//
// The handheld shake is a sum of incommensurate-frequency sines (Perlin-
// like) that fades out over 0.5s — gives a handheld camera feel without
// being nauseating. The engine calls addHandheldShake() once at finisher
// start, then tickShake(dt) every frame.
// ═══════════════════════════════════════════════════════════════════════════

export interface FinisherFraming {
  /** World-space camera position. */
  position: THREE.Vector3;
  /** World-space camera look-at target (mid-point between killer + victim). */
  target: THREE.Vector3;
  /** Recommended FOV (degrees). */
  fov: number;
}

export interface FinisherShakeSample {
  /** Position offset (meters) to add to camera.position. */
  offset: THREE.Vector3;
  /** Roll (radians) to add to camera.rotation.z. */
  roll: number;
  /** Pitch (radians) to add to camera.rotation.x. */
  pitch: number;
  /** Yaw (radians) to add to camera.rotation.y. */
  yaw: number;
}

export class FinisherCamera {
  private shakeIntensity = 0;
  private shakeTime = 0;
  private readonly shakeDecay = 0.5; // seconds
  private noiseSeed = Math.random() * 1000;

  /**
   * Frame a kill using rule-of-thirds composition. Places the camera off to
   * the side at ~60-90° from the killer→victim line, with both subjects on
   * the vertical thirds. Returns the camera position, look-at target, and FOV.
   */
  frameKill(killerPos: THREE.Vector3, victimPos: THREE.Vector3): FinisherFraming {
    // Horizontal killer→victim direction.
    const toVictim = new THREE.Vector3().subVectors(victimPos, killerPos);
    toVictim.y = 0;
    const dist = toVictim.length();
    if (dist < 0.001) {
      // Coincident — place camera behind the killer, looking forward.
      return {
        position: killerPos.clone().add(new THREE.Vector3(0, 1.5, 3)),
        target: killerPos.clone().add(new THREE.Vector3(0, 1, 0)),
        fov: 50,
      };
    }
    toVictim.normalize();
    // Right-perpendicular (rotate +Y by 90°): (x,z) → (−z, x).
    const right = new THREE.Vector3(-toVictim.z, 0, toVictim.x);

    // Camera distance scales with subject separation — both must fit.
    const camDist = Math.max(2.5, dist * 1.8);
    const camHeight = 1.4; // chest-level
    // Place camera to the right + slightly behind the victim (rule-of-thirds:
    // victim on the LEFT third, killer on the RIGHT third from the camera's POV).
    const camPos = victimPos.clone()
      .addScaledVector(toVictim, -camDist * 0.3) // slightly behind victim
      .addScaledVector(right, camDist * 0.9)     // to the right
      .add(new THREE.Vector3(0, camHeight, 0));
    camPos.y = Math.max(camPos.y, victimPos.y + 0.6); // never below the victim

    // Focus point: midpoint of killer + victim, biased toward the victim
    // (the more visually-interesting subject during a finisher).
    const focus = killerPos.clone().add(victimPos).multiplyScalar(0.5);
    focus.y += 0.8; // chest height

    // FOV widens at close range so both subjects fit comfortably.
    const fov = THREE.MathUtils.clamp(75 - dist * 4, 35, 75);

    return { position: camPos, target: focus, fov };
  }

  /**
   * Add handheld camera shake. Call once at the start of a cinematic; the
   * shake fades out over `shakeDecay` seconds. Subsequent calls while a
   * shake is active boost the intensity (max wins) + reset the timer.
   *
   * @param intensity 0..1 — 0.3 = subtle documentary feel, 0.6 = noticeable
   *                  handheld, 1.0 = very shaky (action cam).
   */
  addHandheldShake(intensity: number): void {
    this.shakeIntensity = Math.max(this.shakeIntensity, Math.max(0, intensity));
    this.shakeTime = Math.max(this.shakeTime, this.shakeDecay);
  }

  /**
   * Advance the shake by dt seconds + return the per-frame deltas to apply
   * to the camera (position offset + roll/pitch/yaw rotation deltas).
   * Returns zeros when no shake is active.
   */
  tickShake(dt: number): FinisherShakeSample {
    if (this.shakeTime <= 0) {
      return {
        offset: new THREE.Vector3(),
        roll: 0, pitch: 0, yaw: 0,
      };
    }
    this.shakeTime = Math.max(0, this.shakeTime - dt);
    if (this.shakeTime <= 0) {
      this.shakeIntensity = 0;
      return {
        offset: new THREE.Vector3(),
        roll: 0, pitch: 0, yaw: 0,
      };
    }

    // Multi-frequency noise (sum of incommensurate sines = Perlin-like).
    // The frequencies are deliberately non-integer multiples so the noise
    // doesn't repeat visibly.
    const t = this.noiseSeed + performance.now() * 0.001;
    const fade = this.shakeTime / this.shakeDecay; // 1 → 0
    const amp = this.shakeIntensity * fade;

    const offsetX = (Math.sin(t * 5.3) * 0.5 + Math.sin(t * 13.7) * 0.3) * amp * 0.05;
    const offsetY = (Math.sin(t * 7.1) * 0.4 + Math.sin(t * 11.3) * 0.2) * amp * 0.05;
    const offsetZ = (Math.sin(t * 4.7) * 0.3) * amp * 0.05;
    const roll = Math.sin(t * 6.1) * amp * 0.01;
    const pitch = Math.sin(t * 8.3) * amp * 0.005;
    const yaw = Math.sin(t * 5.7) * amp * 0.005;

    return {
      offset: new THREE.Vector3(offsetX, offsetY, offsetZ),
      roll, pitch, yaw,
    };
  }

  /** Get the current shake intensity (0..1, fades to 0 over time). Useful
   *  for the engine to decide whether to apply the offset at all. */
  get currentShakeIntensity(): number {
    if (this.shakeTime <= 0) return 0;
    return this.shakeIntensity * (this.shakeTime / this.shakeDecay);
  }

  /** Reset the shake (call when the camera is released). */
  clearShake(): void {
    this.shakeIntensity = 0;
    this.shakeTime = 0;
  }
}

// ─── Convenience entry point ─────────────────────────────────

/** Trigger a finisher by slug. Looks up the running FinisherSystem on ctx
 *  and starts the sequence. Returns true if started. */
export function triggerFinisher(
  ctx: GameContext,
  enemy: Enemy,
  finisherSlug: FinisherSlug,
): boolean {
  if (!ctx.finishers) return false;
  return ctx.finishers.trigger(enemy, finisherSlug);
}

/** Maybe trigger a random finisher on a kill (engine calls this in
 *  EnemySystem.killEnemy before applying the death). Returns true if the
 *  finisher hijacked the kill. */
export function maybeTriggerFinisherOnKill(
  ctx: GameContext,
  enemy: Enemy,
): boolean {
  if (!ctx.finishers) return false;
  return ctx.finishers.maybeTriggerOnKill(enemy);
}

/** Check whether input should be locked (engine/InputSystem polls this). */
export function isFinisherInputLocked(ctx: GameContext): boolean {
  return ctx.finishers?.isInputLocked() ?? false;
}

/** Check whether the camera is locked by a finisher (engine polls this
 *  to skip the normal camera update). */
export function isFinisherCameraLocked(ctx: GameContext): boolean {
  return ctx.finishers?.isCameraLocked() ?? false;
}
