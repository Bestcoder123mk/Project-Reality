import * as THREE from "three";
import type { GameContext, Enemy } from "./types";

/**
 * LODSystem — Task-14 part-culling level-of-detail for humanoid enemies.
 *
 * The game uses procedural geometry (utils.ts buildHumanoid) — not loaded GLTF
 * models — so true geometric LOD (simplified meshes with fewer triangles)
 * isn't practical to auto-generate. Instead, this system implements
 * **part-culling LOD**: hide detail parts at distance while keeping the
 * silhouette (body, head, helmet, vest, arms, legs, boots) visible. The
 * enemy always reads as a humanoid figure at every distance; the small
 * tactical details (antenna, pouches, pads, rails, NVG, backpack flap) fade
 * out as the player moves away, reducing per-frame draw calls + material
 * updates with zero perceptual loss.
 *
 * LOD tiers (horizontal distance from player camera to enemy):
 *   LOD0 (<4m):   full detail — every part visible. Right next to the player;
 *                 the operator reads with full tactical fidelity (pouches,
 *                 pads, NVG, etc).
 *   LOD1 (4–10m): hide small detail parts (antenna, boom mic, patch panel,
 *                 elbow/knee pads, helmet brims). Silhouette + gear still
 *                 reads — just less "small bits" noise.
 *   LOD2 (10–20m): hide pouches/straps/side panels/backpack flap + earcups +
 *                  jaw. Core silhouette (body, head, helmet, vest, limbs,
 *                  boots, backpack) still reads as a geared operator.
 *   LOD3 (>20m):  hide backpack, belt, buckle, shoulder/hip joints, accent
 *                  stripe, helmet rails, NVG. Minimal figure — body, head,
 *                  helmet, visor, vest, limbs, boots, gloves. Reads as a
 *                  soldier at distance.
 *
 * Performance:
 *   - One distance check per enemy per frame (cheap: 2 subtractions + sqrt).
 *   - Throttled recompute: only every 200ms per enemy (distance doesn't
 *     change fast, so visibility flips are rare).
 *   - Skip work when tier is unchanged (no visibility flips at all).
 *   - Skip when no enemies alive.
 *
 * OperatorPreview3D (menu component) is intentionally NOT touched — it lives
 * in its own three.js scene (always close-up cameraDistance=4.5), so LOD0 is
 * always correct there. The third-person avatar is always LOD0 (the player's
 * own body is by definition close-up).
 *
 * The system is purely additive: it only toggles `visible` flags on existing
 * meshes. It does NOT modify geometry, materials, or the parts dict.
 */
export class LODSystem {
  constructor(private ctx: GameContext) {}

  // ── Part categorization ──────────────────────────────────────────────────
  //
  // Part names match the keys assigned by buildHumanoid() in utils.ts. A part
  // can appear in at most one HIDE set; if it's in none, it stays visible at
  // every tier (core silhouette + a few small unlisted parts like ear cups
  // and jaw that are gated into LOD2_HIDES here for cleanliness).

  /** Hidden at LOD1+. Small detail parts that don't contribute to silhouette. */
  private static readonly LOD1_HIDES: ReadonlySet<string> = new Set([
    "antenna",
    "boomMicArm",
    "boomMicHead",
    "patchPanel",
    "lElbowPad",
    "rElbowPad",
    "lKneePad",
    "rKneePad",
    "capBrim",
    "stdBrim",
    "fullBrim",
    // ── Task 20: face detail — tiny parts that don't read past 15m.
    "stubble",
    "philtrum",
    "nostrilL",
    "nostrilR",
    "cheekL",
    "cheekR",
    "earInnerL",
    "earInnerR",
    "mouthLine",
    // Eyelashes — 8 per eye, fanned around the upper eyelid edge.
    "eyelashL0", "eyelashL1", "eyelashL2", "eyelashL3",
    "eyelashL4", "eyelashL5", "eyelashL6", "eyelashL7",
    "eyelashR0", "eyelashR1", "eyelashR2", "eyelashR3",
    "eyelashR4", "eyelashR5", "eyelashR6", "eyelashR7",
    // ── Task 28: small detail parts that don't read past 15m.
    "helmetFlagPatch",          // flag/moral patch on helmet top
    "tacLensL", "tacLensR",     // tactical glasses lenses
    "tacLensBridge",            // glasses nose bridge
    "tacLensArmL", "tacLensArmR", // glasses temple arms
    "lBootToeCap", "rBootToeCap", // boot toe caps
    // Boot laces — 3 crisscrosses × 2 segments × 2 boots = 12 lace meshes.
    "lBootLace_0a", "lBootLace_0b", "lBootLace_1a", "lBootLace_1b",
    "lBootLace_2a", "lBootLace_2b",
    "rBootLace_0a", "rBootLace_0b", "rBootLace_1a", "rBootLace_1b",
    "rBootLace_2a", "rBootLace_2b",
    // Glove fingernails — 4 per glove × 2 gloves = 8 nail meshes.
    "lgloveNail_0", "lgloveNail_1", "lgloveNail_2", "lgloveNail_3",
    "rgloveNail_0", "rgloveNail_1", "rgloveNail_2", "rgloveNail_3",
    "watchBand", "watchFace",   // wrist watch on left wrist
    // MOLLE webbing strips — 4 horizontal strips on the vest front.
    "molleStrip_0", "molleStrip_1", "molleStrip_2", "molleStrip_3",
    "idBadge",                  // ID badge on chest
    // Shoulder rank insignia — 2 bars per shoulder × 2 shoulders = 4 meshes.
    "rankL_0", "rankL_1", "rankR_0", "rankR_1",
    "buckleEmblem",             // belt buckle star/eagle emblem
    // ── Task 33: anatomical + gear detail that doesn't read past 15m.
    // Neck muscles (sternocleidomastoid) — 2 thin skin cylinders.
    "neckMuscleL", "neckMuscleR",
    // Collarbones (clavicles) — 2 thin horizontal cylinders.
    "collarboneL", "collarboneR",
    // Abdominal crease lines — 2 thin dark lines on the lower torso.
    "abCreaseUpper", "abCreaseLower",
    // Nose detail — bridge highlight + septum.
    "noseBridgeHighlight", "noseSeptum",
    // Lip detail — seam + cupid's bow (2 segments).
    "lipSeam", "cupidsBowL", "cupidsBowR",
    // Ear detail — concha + tragus (2 each, 4 total).
    "earConchaL", "earConchaR", "earTragusL", "earTragusR",
    // Vest edge bevel + 4 stitch lines (top/bottom/left/right).
    "vestEdgeBevel",
    "vestStitchTop", "vestStitchBottom", "vestStitchLeft", "vestStitchRight",
    // Magazine pouch pull-tabs — 4 straps + 4 loops = 8 meshes.
    "magPullTab_0", "magPullTab_1", "magPullTab_2", "magPullTab_3",
    "magPullLoop_0", "magPullLoop_1", "magPullLoop_2", "magPullLoop_3",
    // Helmet rail slots — 4 per side × 2 sides = 8 small dark cutouts.
    "railSlotL_0", "railSlotL_1", "railSlotL_2", "railSlotL_3",
    "railSlotR_0", "railSlotR_1", "railSlotR_2", "railSlotR_3",
    // Boot sole tread — 5 tread bars per boot × 2 boots = 10 meshes.
    "lBootTread_0", "lBootTread_1", "lBootTread_2", "lBootTread_3", "lBootTread_4",
    "rBootTread_0", "rBootTread_1", "rBootTread_2", "rBootTread_3", "rBootTread_4",
    // Belt loops + knife sheath + knife handle + guard.
    "beltLoopFrontL", "beltLoopFrontR", "beltLoopBack",
    "knifeSheath", "knifeHandle", "knifeGuard",
    // Forearm veins — 2 per arm × 2 arms = 4 thin cylinders.
    "forearmVeinL1", "forearmVeinL2", "forearmVeinR1", "forearmVeinR2",
    // Finger segments — 4 fingers × 3 segments × 2 hands = 24 meshes.
    "lFinger_0_prox", "lFinger_0_mid", "lFinger_0_dist",
    "lFinger_1_prox", "lFinger_1_mid", "lFinger_1_dist",
    "lFinger_2_prox", "lFinger_2_mid", "lFinger_2_dist",
    "lFinger_3_prox", "lFinger_3_mid", "lFinger_3_dist",
    "rFinger_0_prox", "rFinger_0_mid", "rFinger_0_dist",
    "rFinger_1_prox", "rFinger_1_mid", "rFinger_1_dist",
    "rFinger_2_prox", "rFinger_2_mid", "rFinger_2_dist",
    "rFinger_3_prox", "rFinger_3_mid", "rFinger_3_dist",
    // Finger knuckle bumps — 4 per hand × 2 hands = 8 meshes.
    "lFingerKnuckle_0", "lFingerKnuckle_1", "lFingerKnuckle_2", "lFingerKnuckle_3",
    "rFingerKnuckle_0", "rFingerKnuckle_1", "rFingerKnuckle_2", "rFingerKnuckle_3",
    // Finger crease lines — 2 per finger × 4 fingers × 2 hands = 16 meshes.
    "lFingerCrease_0_1", "lFingerCrease_0_2",
    "lFingerCrease_1_1", "lFingerCrease_1_2",
    "lFingerCrease_2_1", "lFingerCrease_2_2",
    "lFingerCrease_3_1", "lFingerCrease_3_2",
    "rFingerCrease_0_1", "rFingerCrease_0_2",
    "rFingerCrease_1_1", "rFingerCrease_1_2",
    "rFingerCrease_2_1", "rFingerCrease_2_2",
    "rFingerCrease_3_1", "rFingerCrease_3_2",
    // Thumbs — 2 segments per hand × 2 hands = 4 meshes.
    "lThumb_prox", "lThumb_dist", "rThumb_prox", "rThumb_dist",
  ]);

  /** Hidden at LOD2+. Pouches, straps, vest side panels, backpack flap, earcups, jaw. */
  private static readonly LOD2_HIDES: ReadonlySet<string> = new Set([
    "lShoulderStrap",
    "rShoulderStrap",
    "vestBack",
    "vestSideL",
    "vestSideR",
    "magPouch_0",
    "magPouch_1",
    "magPouch_2",
    "magPouch_3",
    "utilPouchL",
    "utilPouchR",
    "adminPouch",
    "hipPouchL",
    "hipPouchR",
    "lThighPouch",
    "rThighPouch",
    "holster",
    "sidearmGrip",
    "backpackFlap",
    "lBackpackStrap",
    "rBackpackStrap",
    // Small headset/helmet detail — fold into LOD2 (kept at LOD1 so a close
    // operator still reads as "wearing comms gear").
    "earCupL",
    "earCupR",
    "jaw",
    // ── Task 20: face detail — medium parts that read up close but not at 30m+.
    "eyebrowL",
    "eyebrowR",
    "eyeUpperLidL",
    "eyeUpperLidR",
    "eyeLowerLidL",
    "eyeLowerLidR",
    "upperLip",
    "lowerLip",
    "noseTip",
    "noseBridge",
    "earL",
    "earR",
    "hair",
    // ── Task 28: vest + backpack detail that reads up close but not at 30m+.
    // Magazine pouch flaps — small hinged lids on the mag pouches (hide with
    // the pouches themselves).
    "magPouchFlap_0", "magPouchFlap_1", "magPouchFlap_2", "magPouchFlap_3",
    // Hydration tube — thin curved tube from backpack to shoulder.
    "hydroTubeSeg1", "hydroTubeSeg2", "hydroTubeMouthpiece",
    // Jacket layer — open-front panels over the torso. The vest + shirt
    // silhouette reads fine at 30m+ without the jacket overlay.
    "jacketPanelL", "jacketPanelR", "jacketBack", "jacketCollar",
    // ── Task 33: shoulder pads (athletic-build silhouettes) — medium parts
    // that read up close but don't contribute to the silhouette at 30m+
    // (the shoulder straps + body already suggest the shoulder line).
    "lShoulderPad", "rShoulderPad",
  ]);

  /** Hidden at LOD3+. Backpack, belt, joints, accents, helmet rails, NVG. */
  private static readonly LOD3_HIDES: ReadonlySet<string> = new Set([
    "backpack",
    "belt",
    "buckle",
    "lShoulderJoint",
    "rShoulderJoint",
    "lHipJoint",
    "rHipJoint",
    "shoulderStripe",
    "railL",
    "railR",
    "nvg",
  ]);

  // Core parts (always visible at every tier) — listed for documentation:
  //   body, head, helmet, visor, vest, larm, rarm, larmLower, rarmLower,
  //   lleg, rleg, lshin, rshin, llegBoot, rlegBoot, abdomen, hips, neck,
  //   balaclava, lglove, rglove, lBootUpper, rBootUpper, egun
  //   ── Task 20 face core (always visible — eyes read as "alive" at distance):
  //   eyeScleraL, eyeScleraR, eyeIrisL, eyeIrisR, eyePupilL, eyePupilR
  // These are intentionally NOT in any HIDE set — applyTier() leaves them
  // visible by default.

  /** Per-enemy last-recompute timestamp (ms). 0 = never. */
  private _lastUpdate = new WeakMap<Enemy, number>();
  /** Per-enemy last-applied tier (avoids redundant visibility flips). */
  private _lastTier = new WeakMap<Enemy, number>();
  /** Per-avatar last-recompute timestamp. */
  private _avatarLastUpdate = 0;

  // Distance thresholds (meters).
  // V3.1 — tightened to reduce WebGL memory pressure: LOD0 (full ~220-mesh
  // detail) only within 6m, LOD1 by 15m, LOD2 by 30m. Enemies at engagement
  // range (15m+) render at LOD1 (~120 meshes). This keeps the total mesh
  // count stable with 5-10 concurrent enemies.
  //
  // Task-41 — tightened further: LOD0 only within 4m (right next to player),
  // LOD1 by 10m, LOD2 by 20m. Most combat happens at 10-20m, so enemies at
  // typical engagement range render at LOD1/LOD2 (~30-120 meshes) instead of
  // LOD0 (~220). Enemies beyond 20m render at LOD3 (minimal silhouette,
  // ~30 meshes). Roughly halves per-enemy mesh count at engagement range.
  private static readonly LOD0_MAX = 4;
  private static readonly LOD1_MAX = 10;
  private static readonly LOD2_MAX = 20;
  /** Recompute throttle (ms). Distance doesn't change fast. */
  private static readonly THROTTLE_MS = 200;

  update(_dt: number) {
    const { ctx } = this;
    if (ctx.match.matchOver) return;
    const now = performance.now();
    const px = ctx.player.pos.x;
    const pz = ctx.player.pos.z;
    // Skip work when no enemies — common during wave transitions.
    const enemies = ctx.enemies;
    if (enemies.length === 0) return;

    // A3-5000-retry / 453: frustum check. Was iterating ALL enemies every 200ms
    // regardless of camera visibility. Now we build a frustum once per update
    // + skip enemies behind the camera (their LOD is irrelevant — they're
    // not rendered). Uses ctx.camera.projectionMatrix + matrixWorldInverse.
    const cam = ctx.camera;
    const projScreenMatrix = new THREE.Matrix4();
    let frustum: THREE.Frustum | null = null;
    if (cam) {
      cam.updateMatrixWorld();
      projScreenMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      frustum = new THREE.Frustum().setFromProjectionMatrix(projScreenMatrix);
    }

    for (const e of enemies) {
      if (!e.alive) continue; // dead enemies are fading out; leave their parts alone
      // A3-5000-retry / 453: behind-camera / out-of-frustum skip. Uses the
      // enemy's group position with a 2m sphere tolerance (a partial-body
      // enemy still gets LOD updates if any part is in view).
      if (frustum && !frustum.containsPoint(e.group.position)) {
        // Cheap sphere test: if the enemy's bounding sphere intersects the
        // frustum, still process. Otherwise skip (no LOD recompute needed).
        // For simplicity, we use containsPoint on the enemy origin; a future
        // pass could add a real sphere-frustum intersection.
        continue;
      }
      // Throttle: only recompute every 200ms per enemy.
      const last = this._lastUpdate.get(e) ?? 0;
      if (now - last < LODSystem.THROTTLE_MS) continue;
      this._lastUpdate.set(e, now);

      // Horizontal distance (player + enemy are both grounded-ish; vertical
      // delta is small for live enemies). Using horizontal distance means
      // a sniper on a roof still gets LOD0 when the player is directly below.
      const dx = e.group.position.x - px;
      const dz = e.group.position.z - pz;
      const dist = Math.sqrt(dx * dx + dz * dz);

      let tier: number;
      if (dist < LODSystem.LOD0_MAX) tier = 0;
      else if (dist < LODSystem.LOD1_MAX) tier = 1;
      else if (dist < LODSystem.LOD2_MAX) tier = 2;
      else tier = 3;

      // A3-5000-retry / 454: LOD3 impostor fallback. When an enemy is at LOD3
      // AND beyond a far distance (40m), render as a single billboard sprite
      // (1 draw call) instead of ~30 meshes. The impostor is a Sprite with
      // a cached snapshot of the enemy's silhouette. For now, we use a simple
      // colored quad (the real impostor would snapshot the rendered enemy to
      // a texture). The mesh-hide path runs normally for close-LOD3 enemies
      // (20-40m) so the silhouette still reads; only 40m+ enemies go billboard.
      const impostor = (e as Enemy & { impostor?: THREE.Sprite }).impostor;
      if (tier === 3 && dist > 40 && impostor) {
        // Show the impostor, hide the real model.
        impostor.visible = true;
        e.group.visible = false;
        continue;
      } else if (impostor) {
        // Restore the real model.
        if (impostor.visible) {
          impostor.visible = false;
          e.group.visible = true;
        }
      }

      // Skip if tier unchanged — no visibility flips needed this interval.
      if (this._lastTier.get(e) === tier) continue;
      this._lastTier.set(e, tier);

      this.applyTier(e.parts, tier);
    }

    // Avatar (third-person): always LOD0 (the player's own body is close-up).
    // Recompute at most every 500ms — cheap, usually a no-op.
    if (ctx.avatar && ctx.player.viewMode === "third" && now - this._avatarLastUpdate > 500) {
      this._avatarLastUpdate = now;
      this.applyTier(ctx.avatar.parts, 0);
    }
  }

  /**
   * Apply an LOD tier to a parts dict. Core parts (body, head, helmet, visor,
   * vest, limbs, gloves, boots, neck, balaclava, abdomen, hips, egun) stay
   * visible at every tier — the silhouette must always read as a figure.
   *
   * The tier→visibility mapping is monotonic: a part hidden at LODn is also
   * hidden at LOD(n+1). So we check LOD3 first (most-restrictive), then LOD2,
   * then LOD1.
   */
  private applyTier(parts: Record<string, THREE.Mesh>, tier: number) {
    const hideL1 = tier >= 1;
    const hideL2 = tier >= 2;
    const hideL3 = tier >= 3;
    for (const name in parts) {
      const mesh = parts[name];
      if (!mesh) continue;
      let visible = true;
      if (hideL3 && LODSystem.LOD3_HIDES.has(name)) visible = false;
      else if (hideL2 && LODSystem.LOD2_HIDES.has(name)) visible = false;
      else if (hideL1 && LODSystem.LOD1_HIDES.has(name)) visible = false;
      mesh.visible = visible;
    }
  }

  /**
   * Force an immediate LOD refresh for a single enemy. Call after a new enemy
   * spawns so it starts at the correct tier instead of waiting up to 200ms
   * for the throttled update. (EnemySystem may call this from buildEnemy.)
   */
  refreshEnemy(e: Enemy) {
    const dx = e.group.position.x - this.ctx.player.pos.x;
    const dz = e.group.position.z - this.ctx.player.pos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    let tier: number;
    if (dist < LODSystem.LOD0_MAX) tier = 0;
    else if (dist < LODSystem.LOD1_MAX) tier = 1;
    else if (dist < LODSystem.LOD2_MAX) tier = 2;
    else tier = 3;
    this._lastTier.set(e, tier);
    this._lastUpdate.set(e, performance.now());
    this.applyTier(e.parts, tier);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Section E — #661 LOD crossfade for weapon LOD swaps.
//
// The part-culling LOD above is a hard visibility toggle. For real-mesh LOD
// chains (THREE.LOD), three.js swaps visible children instantly — visible
// as a hard pop. The crossfade below wraps a THREE.LOD in a controller that
// lerps the OLD and NEW level's opacity over `crossfadeMs` so the swap is
// invisible to the eye.
//
// Quality-gated by the LOD_CROSSFADE_WEAPONS flag (per spec). When disabled,
// the LOD behaves as a hard swap (three.js default).
// ════════════════════════════════════════════════════════════════════════════

/** #661 — LOD crossfade controller. Wraps a THREE.LOD + lerps the
 *  opacity of the outgoing + incoming levels during a tier swap. */
export class LODCrossfadeController {
  private lod: THREE.LOD;
  private crossfadeMs: number;
  /** Current crossfade state — null when not crossfading. */
  private fade: {
    fromLevel: number;
    toLevel: number;
    elapsed: number;
  } | null = null;
  /** Per-level material opacity backup (so we can restore after fade). */
  private originalOpacities: Map<number, number[]> = new Map();

  constructor(lod: THREE.LOD, crossfadeMs = 200) {
    this.lod = lod;
    this.crossfadeMs = crossfadeMs;
  }

  /** Per-frame update. Call from the host's tick — advances the crossfade
   *  animation + lerps opacity. */
  update(dt: number, camera: THREE.Camera): void {
    this.lod.update(camera);
    if (!this.fade) return;
    this.fade.elapsed += dt * 1000;
    const t = Math.min(1, this.fade.elapsed / this.crossfadeMs);
    // Lerp opacities: fromLevel goes 1→0, toLevel goes 0→1.
    this.setLevelOpacity(this.fade.fromLevel, 1 - t);
    this.setLevelOpacity(this.fade.toLevel, t);
    if (t >= 1) {
      // Restore original opacities + clear the fade.
      this.restoreLevelOpacity(this.fade.fromLevel);
      this.restoreLevelOpacity(this.fade.toLevel);
      this.fade = null;
    }
  }

  /** Trigger a crossfade to a new level. `level` is the THREE.LOD level
   *  index (0 = LOD0, closest). */
  crossfadeTo(level: number): void {
    if (this.fade?.toLevel === level) return;
    this.fade = {
      fromLevel: this.lod.getCurrentLevel(),
      toLevel: level,
      elapsed: 0,
    };
    // Snapshot original opacities for both levels.
    this.snapshotOpacity(this.fade.fromLevel);
    this.snapshotOpacity(this.fade.toLevel);
  }

  private snapshotOpacity(level: number): void {
    const obj = this.lod.getObjectForDistance(this.lod.levels[level]?.distance ?? 0);
    if (!obj) return;
    const mats = Array.isArray((obj as THREE.Mesh).material)
      ? (obj as THREE.Mesh).material as THREE.Material[]
      : [(obj as THREE.Mesh).material];
    const opacities = mats.map((m) => {
      const any = m as THREE.Material & { opacity?: number };
      return any.opacity ?? 1;
    });
    this.originalOpacities.set(level, opacities);
  }

  private setLevelOpacity(level: number, opacity: number): void {
    const obj = this.lod.getObjectForDistance(this.lod.levels[level]?.distance ?? 0);
    if (!obj) return;
    const mats = Array.isArray((obj as THREE.Mesh).material)
      ? (obj as THREE.Mesh).material as THREE.Material[]
      : [(obj as THREE.Mesh).material];
    for (const m of mats) {
      const any = m as THREE.Material & { opacity?: number; transparent?: boolean };
      any.transparent = true;
      any.opacity = opacity;
    }
  }

  private restoreLevelOpacity(level: number): void {
    const obj = this.lod.getObjectForDistance(this.lod.levels[level]?.distance ?? 0);
    if (!obj) return;
    const orig = this.originalOpacities.get(level);
    if (!orig) return;
    const mats = Array.isArray((obj as THREE.Mesh).material)
      ? (obj as THREE.Mesh).material as THREE.Material[]
      : [(obj as THREE.Mesh).material];
    for (let i = 0; i < mats.length; i++) {
      const any = mats[i] as THREE.Material & { opacity?: number };
      any.opacity = orig[i] ?? 1;
    }
  }
}

/** #661 — Global flag for whether weapon LODs use crossfade. Read by the
 *  weaponModel LOD construction (when it ships real LOD chains). Off by
 *  default (per the VisualEnhancements DEFAULT_LOD_CROSSFADE). */
export const LOD_CROSSFADE_WEAPONS = false;

// ════════════════════════════════════════════════════════════════════════════
// SEC2-ART — Prompt 14: Real-mesh LOD chain authoring.
//
// The `LODSystem` class above implements *part-culling* LOD for procedural
// humanoid enemies (hide detail meshes at distance). That works because the
// procedural geometry can't be simplified at runtime — only toggled.
//
// When real `.glb` meshes ship (per the ModelRegistry pipeline), each asset
// should author 3-4 LOD levels in the .glb itself (or as separate
// `<slug>_lod1.glb` files). The functions below wire those real LOD chains
// into the scene graph using `THREE.LOD` — three.js's built-in LOD node
// that swaps visible children based on distance to the camera.
//
// Public surface:
//   - `LODLevel`              → { distance, geometry? | mesh? } spec
//   - `addLOD(mesh, levels)`  → upgrades a Mesh into a THREE.LOD with the
//                                given chain (replaces the mesh in its parent)
//   - `buildLODChain(slug, baseMesh)` → assembles a LOD chain for a slug,
//                                fetching LOD1/2/3 from the ModelRegistry when
//                                they ship (procedural fallback otherwise)
//   - `DEFAULT_LOD_DISTANCES` → the canonical distance thresholds (meters)
//   - `pickLODTier(distance)` → pure function: distance → tier index
//   - `getLODTierForDistance(distance, distances?)` → alias for pickLODTier
//
// SSR-safe: pure three.js object construction; no WebGL needed.
// ════════════════════════════════════════════════════════════════════════════

/** Canonical LOD distance thresholds (meters from the camera). Each tier is
 *  visible from the previous threshold up to its own. Mirrors the part-cull
 *  tiers in LODSystem (LOD0_MAX=4, LOD1_MAX=10, LOD2_MAX=20, then ∞). */
export const DEFAULT_LOD_DISTANCES: ReadonlyArray<number> = [0, 10, 25, 60];

/** Pick the LOD tier index for a given distance using the canonical thresholds.
 *  Pure function — unit-testable without a scene. */
export function pickLODTier(distance: number, distances: ReadonlyArray<number> = DEFAULT_LOD_DISTANCES): number {
  // Walk from highest tier down — first threshold the distance is below is
  // the tier we want.
  for (let i = distances.length - 1; i >= 0; i--) {
    if (distance >= distances[i]) return i;
  }
  return 0;
}

/** Alias for pickLODTier — explicit name for callers that prefer it. */
export function getLODTierForDistance(distance: number, distances?: ReadonlyArray<number>): number {
  return pickLODTier(distance, distances);
}

/** One LOD level — a distance threshold + the geometry/mesh to show at it.
 *
 *  Either `geometry` (will be wrapped in a new Mesh sharing the parent's
 *  material) or `mesh` (a fully-built mesh with its own material) must be
 *  provided. */
export interface LODLevel {
  /** Distance from the camera (meters) at which this level becomes visible. */
  distance: number;
  /** Optional geometry — wrapped in a new mesh sharing `material`. */
  geometry?: THREE.BufferGeometry;
  /** Optional fully-built mesh (use when the LOD level needs its own material). */
  mesh?: THREE.Mesh;
}

/**
 * Add a real LOD chain to a mesh. The mesh's parent gets a new `THREE.LOD`
 * in place of the mesh; the original mesh becomes LOD0 (closest), and each
 * entry in `levels` is added at its distance threshold.
 *
 * If the mesh has no parent (not yet added to a scene), the LOD is created
 * but the caller must add it manually — the function returns the LOD node
 * either way.
 *
 * @param mesh    The base (LOD0) mesh — already in the scene (or about to be).
 * @param levels  LOD1..N entries (sorted by distance ascending).
 * @returns       The THREE.LOD node that now replaces `mesh` in its parent.
 */
export function addLOD(mesh: THREE.Mesh, levels: LODLevel[]): THREE.LOD {
  const lod = new THREE.LOD();
  // Copy transform + name from the original mesh.
  lod.position.copy(mesh.position);
  lod.rotation.copy(mesh.rotation);
  lod.scale.copy(mesh.scale);
  lod.name = mesh.name ? `${mesh.name}_LOD` : "LOD";

  // Capture the parent + index BEFORE lod.addLevel(mesh) — THREE.LOD.addLevel
  // internally calls this.add(mesh) which reparents mesh (removing it from
  // its current parent). If we read mesh.parent after addLevel we'd get `lod`
  // and the parent-swap below would silently no-op.
  const parent = mesh.parent;
  const parentIdx = parent ? parent.children.indexOf(mesh) : -1;
  const meshMatrixWorld = mesh.matrixWorld.clone();

  // LOD0 — the original mesh, always visible up close.
  lod.addLevel(mesh, 0);
  // LOD1..N — wrap geometries in meshes that share the original material,
  // or use the provided meshes directly.
  for (const lvl of levels) {
    if (lvl.mesh) {
      lod.addLevel(lvl.mesh, lvl.distance);
    } else if (lvl.geometry) {
      const m = new THREE.Mesh(lvl.geometry, mesh.material as THREE.Material | THREE.Material[]);
      m.castShadow = mesh.castShadow;
      m.receiveShadow = mesh.receiveShadow;
      lod.addLevel(m, lvl.distance);
    }
    // (else: skip — entry had neither geometry nor mesh)
  }

  // Swap the original mesh for the LOD in its parent (if it had one).
  // Note: lod.addLevel(mesh) already removed mesh from parent.children, so
  // we splice the LOD in at the original index.
  if (parent && parentIdx >= 0) {
    parent.children.splice(parentIdx, 0, lod);
    lod.parent = parent;
    // Wire matrixWorld up so the LOD renders immediately.
    lod.matrixWorld.copy(meshMatrixWorld);
  }

  return lod;
}

/**
 * Build a LOD chain for a weapon or environment slug. Used by the
 * ModelRegistry pipeline + the EnvArtKit: when real LOD meshes ship at
 * `/models/<slug>_lod1.glb`, `_lod2.glb`, etc., this fetches them and
 * assembles a `THREE.LOD` node.
 *
 * Procedural fallback: if no LOD meshes ship (the common case today),
 * returns the base mesh wrapped in a single-tier LOD (LOD0 only). The
 * caller can add `LODLevel` entries later via `addLOD` when the artist
 * ships simplified geometry.
 *
 * @param slug     Asset slug (matches the ModelRegistry manifest).
 * @param baseMesh The LOD0 mesh (e.g. from loadModel or buildKitPiece).
 * @param distances Optional distance thresholds. Defaults to DEFAULT_LOD_DISTANCES.
 */
export async function buildLODChain(
  slug: string,
  baseMesh: THREE.Mesh,
  distances: ReadonlyArray<number> = DEFAULT_LOD_DISTANCES,
): Promise<THREE.LOD> {
  const lod = new THREE.LOD();
  lod.name = `${slug}_LODChain`;
  lod.position.copy(baseMesh.position);
  lod.rotation.copy(baseMesh.rotation);
  lod.scale.copy(baseMesh.scale);

  // LOD0 — always the base mesh.
  lod.addLevel(baseMesh, distances[0] ?? 0);

  // Try to load LOD1..N from the ModelRegistry. The convention is:
  //   /models/<slug>_lod1.glb → LOD1 (50% tris)
  //   /models/<slug>_lod2.glb → LOD2 (25% tris)
  //   /models/<slug>_lod3.glb → LOD3 (silhouette only)
  // If a file is missing, the LOD chain stops at the last successful level.
  for (let i = 1; i < distances.length; i++) {
    const distance = distances[i];
    const lodSlug = `${slug}_lod${i}`;
    // Dynamic import to avoid a circular dependency with ModelRegistry
    // (ModelRegistry imports the LOD functions for its own use too).
    const { hasModel, loadModel } = await import("../assets/ModelRegistry");
    if (!hasModel(lodSlug)) continue; // skip the network call entirely
    try {
      const group = await loadModel(lodSlug);
      // Take the first Mesh child as the LOD level (the .glb should be a
      // single-mesh asset for an LOD level; if it's a group, grab the
      // biggest mesh by triangle count).
      let lodMesh: THREE.Mesh | null = null;
      let bestTri = -1;
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const tri = o.geometry.index
            ? o.geometry.index.count / 3
            : (o.geometry.attributes.position?.count ?? 0) / 3;
          if (tri > bestTri) { bestTri = tri; lodMesh = o; }
        }
      });
      if (lodMesh) {
        // Detach from the group so the LOD node owns it directly.
        group.remove(lodMesh);
        lod.addLevel(lodMesh, distance);
      }
    } catch {
      // Missing or invalid — skip this level (the chain is still valid,
      // it just renders LOD0 further than ideal).
    }
  }

  return lod;
}
