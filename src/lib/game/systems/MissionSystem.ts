import * as THREE from "three";
import type { GameSystem, GameContext, VipNpc } from "./types";
import { buildHumanoid, animateGait } from "./utils";
import { useGameStore } from "../store";

/**
 * MissionSystem — G1.2/G1.3/G1.4 mode-specific gameplay logic.
 *
 * Runs every frame during IN_PROGRESS and handles:
 *   - VIP Escort: waypoint-following NPC, VIP death → defeat, enemies can
 *     damage the VIP (wired via EnemySystem.enemyShoot).
 *   - Extraction: interactable intel prop (proximity + F key), extraction
 *     zone trigger, victory on carry-to-zone, spawn escalation after pickup.
 *   - Breach & Clear: sequential room gating via the 4 corner buildings,
 *     3-5 enemies per room, next room unlocks when current is cleared.
 *
 * SURVIVAL and HORDE are handled entirely by EnemySystem + MatchFSM — this
 * system is a no-op for them (ctx.vip / extractionObjective / extractionZone
 * are null).
 */
export class MissionSystem implements GameSystem {
  /** F-key pickup cooldown to prevent re-trigger spam. */
  private lastPickupAttempt = 0;

  constructor(private ctx: GameContext) {}

  /** G1.2 — Build the VIP NPC + patrol route. Called from engine.start() in VIP mode. */
  buildVip() {
    const { ctx } = this;
    // Reuse buildHumanoid with a friendly blue suit so the VIP is visually
    // distinct from the dark-red enemies.
    const built = buildHumanoid(0x2a4a6a);
    built.group.position.set(0, 0, 12);
    ctx.scene.add(built.group);
    // 4-point patrol route around the arena center.
    const waypoints = [
      new THREE.Vector3(0, 0, 12),
      new THREE.Vector3(-15, 0, 0),
      new THREE.Vector3(0, 0, -12),
      new THREE.Vector3(15, 0, 0),
    ];
    ctx.vip = {
      group: built.group,
      parts: built.parts,
      health: 100,
      maxHealth: 100,
      alive: true,
      waypoints,
      currentWaypoint: 0,
      pauseUntil: 0,
      speed: 1.6,
      gaitPhase: 0,
    };
    ctx.pushHud({ objective: "VIP Escort: protect the VIP through 4 waypoints" });
  }

  /** G1.3 — Build the extraction intel prop + extraction zone. */
  buildExtraction() {
    const { ctx } = this;
    // Intel prop — a glowing briefcase (box with emissive material).
    const intelMat = new THREE.MeshStandardMaterial({
      color: 0xff8c1a, emissive: 0xff8c1a, emissiveIntensity: 0.5,
      roughness: 0.4, metalness: 0.6,
    });
    const intel = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.5), intelMat);
    intel.position.set(-20, 0.65, -20);
    intel.castShadow = true;
    intel.userData.isExtractionIntel = true;
    ctx.scene.add(intel);
    ctx.extractionObjective = {
      mesh: intel,
      position: intel.position.clone(),
      pickedUp: false,
      interactable: false,
    };
    // Extraction zone — a translucent cylinder on the opposite corner.
    const zoneMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88, transparent: true, opacity: 0.15, side: THREE.DoubleSide,
    });
    const zoneMesh = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.05, 32), zoneMat);
    zoneMesh.position.set(20, 0.03, 20);
    ctx.scene.add(zoneMesh);
    // Ring outline for visibility.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.9, 3, 32),
      new THREE.MeshBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(20, 0.05, 20);
    ctx.scene.add(ring);
    ctx.extractionZone = {
      mesh: zoneMesh,
      center: new THREE.Vector3(20, 0, 20),
      radius: 3,
    };
    ctx.pushHud({ objective: "Retrieve the intel and reach the extraction zone" });
  }

  /** G1.4 — Build breach rooms. The 4 corner buildings are already in the
   *  arena (buildLevel adds them). We just track the room index and gate
   *  spawns. Called from engine.start() in BREACH mode. */
  buildBreach() {
    const { ctx } = this;
    ctx.match.breachRoomIndex = 0;
    // Breach room spawn positions (near each corner building).
    ctx.pushHud({ objective: "Room 1/5: Clear all hostiles" });
  }

  update(dt: number) {
    const { ctx } = this;
    if (ctx.match.matchOver || ctx.match.waveTransitioning) return;
    const mode = ctx.match.mode;
    if (mode === "VIP" && ctx.vip) this.tickVip(dt);
    if (mode === "EXTRACTION" && ctx.extractionObjective && ctx.extractionZone) this.tickExtraction(dt);
    // Section D #1787 — BREACH mode per-frame tick. The prior code only set
    // breachRoomIndex=0 in buildBreach() + left the per-frame progression
    // (advance to the next room when the current room is cleared, trigger
    // victory when all rooms are done) unimplemented — BREACH was effectively
    // a 1-room mode that never ended. Now tickBreach monitors wave clears +
    // advances the room index, pushing a fresh HUD objective per room + a
    // victory when all 5 rooms are cleared.
    if (mode === "BREACH") this.tickBreach(dt);
  }

  // ---------- G1.4 Breach (Section D #1787 — functional completion) ----------

  /** Total rooms in a BREACH match. Each room = one enemy wave. */
  private static readonly BREACH_TOTAL_ROOMS = 5;
  /** Tracks the last wave we advanced on. Prevents double-advancing when
   *  the wave-clear signal fires multiple times for the same wave. */
  private _lastBreachWaveAdvanced = 0;

  private tickBreach(_dt: number) {
    const { ctx } = this;
    // A "room" is cleared when the current wave's enemiesRemaining hits 0
    // (EnemySystem.killEnemy decrements + fires onWaveCleared when the last
    // enemy of the wave dies). We detect the room-clear by comparing the
    // current wave to the last wave we advanced on + checking that no
    // enemies remain alive.
    const currentWave = ctx.match.wave;
    const enemiesAlive = ctx.enemies.filter((e) => e.alive).length;
    if (enemiesAlive > 0) return; // room not cleared yet.
    if (currentWave <= this._lastBreachWaveAdvanced) return; // already advanced.
    this._lastBreachWaveAdvanced = currentWave;

    // Advance the room index.
    ctx.match.breachRoomIndex = currentWave; // 0-indexed: wave 1 = room 0.
    const roomsCleared = ctx.match.breachRoomIndex;
    const roomsTotal = MissionSystem.BREACH_TOTAL_ROOMS;
    if (roomsCleared >= roomsTotal) {
      // All rooms cleared — victory.
      ctx.pushHud({ objective: `All ${roomsTotal} rooms cleared — VICTORY!` });
      ctx.addKillFeed({
        killer: "SYSTEM", victim: "BREACH COMPLETE", weapon: "", headshot: false,
      });
      ctx.onVictory();
      return;
    }
    // Push the next-room objective.
    ctx.pushHud({
      objective: `Room ${roomsCleared + 1}/${roomsTotal}: Clear all hostiles`,
    });
    ctx.addKillFeed({
      killer: "SYSTEM",
      victim: `Room ${roomsCleared} cleared — advancing to room ${roomsCleared + 1}`,
      weapon: "", headshot: false,
    });
  }

  // ---------- G1.2 VIP ----------

  private tickVip(dt: number) {
    const { ctx } = this;
    const vip = ctx.vip;
    if (!vip || !vip.alive) return;
    const now = performance.now();

    // Check VIP death.
    if (vip.health <= 0) {
      vip.alive = false;
      // Section D #1782 — VIP no ragdoll. The prior code did a legacy
      // face-plant (rotation.x = -π/2, position.y = 0.3) which looked
      // static + didn't match the enemy death animation. Now we route
      // through the ragdoll system (same as EnemySystem.killEnemy) so the
      // VIP collapses naturally. Falls back to the legacy face-plant if
      // the ragdoll system isn't wired (headless / pre-init).
      if (ctx.ragdolls) {
        // The VIP isn't an Enemy, but the RagdollSystem.activateRagdoll
        // accepts any object with the rig fields (group, parts, etc.).
        // We cast to Enemy for the API contract — the ragdoll only reads
        // group + parts (both present on the VIP).
        const dir = new THREE.Vector3(0, 0, 1); // fallback direction (VIP dies in place)
        ctx.ragdolls.activateRagdoll(vip as unknown as import("./types").Enemy, dir, false, 30);
      } else {
        vip.group.rotation.x = -Math.PI / 2;
        vip.group.position.y = 0.3;
      }
      ctx.addKillFeed({ killer: "ENEMY", victim: "VIP", weapon: "", headshot: false });
      ctx.pushHud({ objective: "VIP DOWN — MISSION FAILED" });
      // G1.2 — trigger defeat via the existing onGameOver callback (engine
      // wires it to MatchFSM.markDefeat()).
      ctx.onGameOver();
      return;
    }

    // Waypoint following.
    const target = vip.waypoints[vip.currentWaypoint];
    if (!target) return;
    const toTarget = ctx.scratch.v1.copy(target).sub(vip.group.position);
    toTarget.y = 0;
    const dist = toTarget.length();

    if (dist < 1.5) {
      // Reached waypoint — pause briefly, then advance.
      if (vip.pauseUntil === 0) {
        vip.pauseUntil = now + 2000;
        ctx.pushHud({
          objective: `VIP reached waypoint ${vip.currentWaypoint + 1}/4 — holding`,
        });
      }
      if (now >= vip.pauseUntil) {
        // Section D #1784 — waypoint wrap victory. The prior code used
        // modulo wrap (`(currentWaypoint + 1) % length`) + checked
        // `=== 0` for victory. That fired prematurely if the VIP somehow
        // skipped a waypoint (e.g. got pushed by the player past one)
        // because the wrap would land on 0 without visiting all 4. Now
        // we track `waypointsCompleted` explicitly + only fire victory
        // when ALL 4 waypoints are completed (counter >= length).
        const vipExtra = vip as unknown as { waypointsCompleted?: number };
        vipExtra.waypointsCompleted = (vipExtra.waypointsCompleted ?? 0) + 1;
        vip.currentWaypoint = (vip.currentWaypoint + 1) % vip.waypoints.length;
        vip.pauseUntil = 0;
        // G1.2 — reaching the last waypoint (index 3 → advancing past) is victory.
        if ((vipExtra.waypointsCompleted ?? 0) >= vip.waypoints.length) {
          // Completed a full circuit = all 4 waypoints visited.
          ctx.pushHud({ objective: "VIP escorted through all waypoints — VICTORY!" });
          ctx.onVictory();
          return;
        }
      }
      // Hold position while pausing.
      vip.group.position.x = THREE.MathUtils.damp(vip.group.position.x, target.x, 6, dt);
      vip.group.position.z = THREE.MathUtils.damp(vip.group.position.z, target.z, 6, dt);
      return;
    }

    // Move toward waypoint.
    toTarget.normalize();
    // Section D #1783 — moveVel dead. The prior code computed `moveVel =
    // toTarget.multiplyScalar(vip.speed)` but never used it (the actual
    // movement used damp). Now we use moveVel for the gait animation
    // speed (so the VIP's walk cycle matches their actual speed, not the
    // hardcoded `vip.speed`). This makes the VIP's gait look right when
    // the damp is slowing them down (approaching a waypoint).
    const moveVel = toTarget.clone().multiplyScalar(vip.speed);
    const actualSpeed = moveVel.length();
    vip.group.position.x = THREE.MathUtils.damp(vip.group.position.x, target.x, 4, dt);
    vip.group.position.z = THREE.MathUtils.damp(vip.group.position.z, target.z, 4, dt);
    // Face the movement direction.
    const targetAngle = Math.atan2(toTarget.x, toTarget.z);
    vip.group.rotation.y = THREE.MathUtils.damp(vip.group.rotation.y, targetAngle, 6, dt);
    // Gait animation — uses the actual speed (from moveVel) so the walk
    // cycle matches the damp-driven movement.
    vip.gaitPhase += dt * actualSpeed * 1.6;
    animateGait(vip.parts, vip.gaitPhase, actualSpeed, false);
  }

  /** G1.2 — Apply damage to the VIP (called from EnemySystem when an enemy
   *  targets the VIP instead of the player). Returns true if the VIP died. */
  damageVip(dmg: number): boolean {
    const { ctx } = this;
    const vip = ctx.vip;
    if (!vip || !vip.alive) return false;
    vip.health -= dmg;
    // Flash the VIP body red briefly.
    if (vip.parts.body) {
      (vip.parts.body.material as THREE.MeshStandardMaterial).emissive.setRGB(0.6, 0, 0);
      setTimeout(() => {
        if (vip.alive && vip.parts.body) {
          (vip.parts.body.material as THREE.MeshStandardMaterial).emissive.setRGB(0, 0, 0);
        }
      }, 150);
    }
    if (vip.health <= 0) return true;
    return false;
  }

  // ---------- G1.3 Extraction ----------

  private tickExtraction(_dt: number) {
    const { ctx } = this;
    const obj = ctx.extractionObjective;
    const zone = ctx.extractionZone;
    if (!obj || !zone) return;
    const playerPos = ctx.player.pos;
    const now = performance.now();

    if (!obj.pickedUp) {
      // Check proximity for interactability.
      const distToIntel = Math.hypot(
        playerPos.x - obj.position.x,
        playerPos.z - obj.position.z,
      );
      obj.interactable = distToIntel < 2.5;
      if (obj.interactable) {
        ctx.pushHud({ objective: "Press F to pick up the intel" });
        // Section D #1785 — F-key co-opts melee. The F key is also used
        // for melee. The prior code intercepted F in EXTRACTION mode near
        // the intel, but the melee system ALSO read F — so the player
        // would swing + pick up simultaneously. Now we set a `consumedKey`
        // flag on ctx.keys so the melee system can skip the F press when
        // MissionSystem has consumed it. The flag is set just for this
        // frame + only when the pickup actually fires.
        if (ctx.keys["KeyF"] && now - this.lastPickupAttempt > 500) {
          this.lastPickupAttempt = now;
          // Section D #1785 — consume the F key so the melee system skips it.
          (ctx.keys as unknown as { consumed?: Record<string, boolean> }).consumed =
            (ctx.keys as unknown as { consumed?: Record<string, boolean> }).consumed ?? {};
          (ctx.keys as unknown as { consumed?: Record<string, boolean> }).consumed!["KeyF"] = true;
          obj.pickedUp = true;
          obj.mesh.visible = false;
          ctx.match.extractionCarrying = true;
          ctx.pushHud({ objective: "Intel acquired — reach the extraction zone!" });
          ctx.addKillFeed({ killer: "SYSTEM", victim: "Intel acquired", weapon: "", headshot: false });
          // G1.3 — escalate spawns after pickup. Trigger an immediate bonus wave.
          // Section D #1786 — double-spawn. The prior code scheduled a wave
          // transition without checking if one was already scheduled. If
          // the player picked up the intel, then won (reached extraction)
          // before the wave fired, the wave would STILL fire after victory
          // — spawning enemies into a finished match. Now we track the
          // scheduled wave token + cancel it on victory (the engine's
          // onVictory hook clears pending wave transitions; we expose the
          // token via ctx.match.scheduledExtractionWave so the engine can
          // cancel it). Defensive: also check matchOver before firing.
          ctx.scheduleWaveTransition(() => {
            if (ctx.match.matchOver) return; // Section D #1786 — don't spawn after victory.
            if (!ctx.match.extractionCarrying) return; // player already extracted.
            const bonusWave = ctx.match.wave + 1;
            ctx.onStartWave(bonusWave);
          }, 1000);
        }
      }
    } else {
      // Carrying — check if player reached the extraction zone.
      const distToZone = Math.hypot(
        playerPos.x - zone.center.x,
        playerPos.z - zone.center.z,
      );
      if (distToZone < zone.radius) {
        ctx.pushHud({ objective: "EXTRACTION COMPLETE — VICTORY!" });
        // Section D #1786 — clear the extraction-carrying flag so the
        // scheduled bonus wave (if still pending) doesn't fire.
        ctx.match.extractionCarrying = false;
        ctx.onVictory();
      } else {
        const distToZoneRounded = Math.round(distToZone);
        ctx.pushHud({ objective: `Carry intel to extraction zone — ${distToZoneRounded}m` });
      }
    }
  }

  dispose() {
    // Mode-specific entities are removed by the renderer's clearMap on restart.
  }
}
