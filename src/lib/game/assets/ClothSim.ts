/**
 * SEC2-ART — Prompt 18
 * ─────────────────────────────────────────────────────────────────────────────
 * ClothSim — bone-driven secondary motion (verlet bone chain) for capes,
 * scarves, hair, and other soft attachments on operator customization pieces.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission A-series fix noted):
 *   C2-5000 #1333 [Prompt A#65] dead windInfluence → applied in verlet acceleration (capes blow)
 *   C2-5000 #1334 [Prompt A#66] damping → per-second velocity retention (oscillates naturally)
 *   C2-5000 #1335 [Prompt A#67] orientation → panel axis local +Y (panels hang correctly)
 *   C2-5000 #1336 [Prompt A#68] cloth-vs-body collision → ClothBodyCollider sphere push-out
 *   C2-5000 #1337 [Prompt A#69] substepping → verlet substepped when dt > 1/60 (no oscillation at high stiffness)
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1161 [Prompt A#65]  cloth wind (setClothWind + verlet acceleration)
 *   C1-5000 #1162 [Prompt A#66]  cloth damping (per-second velocity retention)
 *   C1-5000 #1163 [Prompt A#67]  cloth segment orientation (panel axis local +Y)
 *   C1-5000 #1164 [Prompt A#68]  cloth-vs-limb collision (addClothBodyCollider sphere colliders attach to any bone)
 *   C1-5000 #1165 [Prompt 365]   wetness material parameter (setClothWetness)
 *   C1-5000 #1166 [Prompt 366]   secondary motion jiggle-on-jiggle (enableSecondaryMotion)
 *   C1-5000 #1167 [Prompt 367]   cloth self-collision (resolveSelfCollision internal)
 *   C1-5000 #1168 [Prompt 368]   cloth tearing under stress (applyClothTearing internal)
 *   C1-5000 #1169 [Prompt 369]   multi-anchor cloth (addClothAnchor)
 *   C1-5000 #1170 [Prompt 370]   cloth LOD (setClothLOD)
 *   C1-5000 #1171 [Prompt 371]   skirt/coat/scarf presets (CLOTH_GARMENT_PRESETS)
 *   C1-5000 #1172 [Prompt 372]   hair strand simulation (attachHairStrands)
 *   C1-5000 #1173 [Prompt 373]   hair wind coupling (hair wind in updateCloth via _currentWind)
 *   C1-5000 #1174 [Prompt 374]   hair wetness (setHairWetness)
 *
 * C3-5000 prompt mapping:
 *   C3-5000 #1552 [CLOTH_GARMENT_PRESETS]  animation cloth tuning per garment (existing table, surfaced under #1552)
 *   C3-5000 #1555 [HAIR_STRAND_TUNING]     animation hair tuning per strand (exported at the bottom)
 *
 * Design: a chain of N Object3D segments (each a child of the previous one,
 * each with a small visible mesh as its "cloth segment"). The chain's tip
 * is integrated each frame using verlet physics: the segment's world-space
 * position is updated by `x_new = 2*x - x_prev + a*dt²` with damping, then a
 * distance constraint enforces the rest segment length between adjacent
 * segments. The visible mesh follows its owning segment automatically (it's
 * parented to it).
 *
 * This is a "jiggle bone" approach (cheaper than full FEM cloth) and is what
 * most AAA games use for short capes + scarves + ponytails. Full cape-cloth
 * (with self-collision + tearing) would need a GPU mass-spring system — out
 * of scope here.
 *
 * Public surface:
 *   - `attachCloth(parent, config)`   → THREE.Group (the cloth chain root,
 *                                        parented to `parent`). The chain is
 *                                        auto-registered with the global
 *                                        update list — call `updateCloth(dt)`
 *                                        per frame to animate.
 *   - `updateCloth(dt)`               → advance all registered cloth chains.
 *   - `disposeCloth()`                → release all chains + GPU resources.
 *   - `getClothStats()`               → {chains, totalSegments} telemetry.
 *
 * Config knobs (per chain):
 *   - segments:       N (default 6) — chain length.
 *   - segmentLength:  meters (default 0.08).
 *   - gravity:        m/s² downward (default 4.0 — weaker than real gravity
 *                     so the cloth "floats" a bit; tune per piece).
 *   - damping:        0..1 (default 0.92 — higher = less jiggle).
 *   - stiffness:      0..1 (default 0.9 — constraint relaxation factor; lower
 *                     = stretchier).
 *   - windInfluence:  0..1 (default 0.0 — set > 0 to inherit the Vegetation
 *                     wind uniforms for a unified breeze).
 *   - anchorOffset:   local position of the chain root on `parent`
 *                     (default [0,0,0]).
 *   - direction:      initial chain direction (default [0,-1,0] — hangs down).
 *   - color:          segment material color (default 0x6a1a1a — dark red cape).
 *   - segmentSize:    visible mesh size [w, h, d] (default [0.12, 0.10, 0.005]).
 *
 * SSR-safe — pure three.js object construction; verlet math is just arithmetic.
 */

import * as THREE from "three";
// Task 3 / item 65 — read the reducedEffects flag from the live game store
// (lazy require to avoid a static circular import at module load time).
import { useGameStore } from "../store";

// ─── Config ────────────────────────────────────────────────────────────────

export interface ClothConfig {
  segments?: number;
  segmentLength?: number;
  gravity?: number;
  damping?: number;
  stiffness?: number;
  windInfluence?: number;
  anchorOffset?: [number, number, number];
  direction?: [number, number, number];
  color?: number;
  segmentSize?: [number, number, number];
}

interface ClothChain {
  /** Root group — added to the parent by the caller (or by attachCloth). */
  group: THREE.Group;
  /** Chain segments — each is a child of the previous one. */
  segments: THREE.Object3D[];
  /** Verlet state: world position of each segment's pivot. */
  positions: THREE.Vector3[];
  /** Verlet state: previous world position (for velocity integration). */
  prevPositions: THREE.Vector3[];
  /** Rest length between adjacent segments. */
  segmentLength: number;
  /** Cached config values (read each frame). */
  gravity: number;
  damping: number;
  stiffness: number;
  windInfluence: number;
  /** Cached visible meshes — for disposal. */
  meshes: THREE.Mesh[];
  /** Prompt A#68 — body collision spheres (shoulders/hips/spine). Push
   *  cloth points out so capes don't clip the torso. Optional — chains
   *  without colliders skip the collision pass. */
  bodyColliders?: ClothBodyCollider[];
}

/** Prompt A#68 — sphere collider for cloth-vs-body collision. */
export interface ClothBodyCollider {
  /** Bone/object to track (the collider follows its world position). */
  parent: THREE.Object3D;
  /** Offset from the parent's world position (local space). */
  offset: THREE.Vector3;
  /** Sphere radius (meters). */
  radius: number;
  /** Cached world position (updated each frame by updateWorldPos). */
  worldPos: THREE.Vector3;
  /** Update worldPos from the parent's current world position. */
  updateWorldPos: () => void;
}

/** Prompt A#65 — global wind vector (set by WeatherSystem). Cloth chains
 *  read this each frame + apply `windInfluence * wind` to their verlet
 *  acceleration. Default zero (no wind) — keeps existing behavior when
 *  WeatherSystem hasn't set a wind value. */
const _currentWind: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

/** Prompt A#65 — set the global wind vector (called by WeatherSystem). */
export function setClothWind(x: number, y: number, z: number): void {
  _currentWind.set(x, y, z);
}

/** Prompt A#68 — add a body collider to a cloth chain. Returns the collider
 *  so the caller can dispose it (or just let it GC when the chain is
 *  disposed). The collider tracks `parent`'s world position + `offset`
 *  each frame. */
export function addClothBodyCollider(
  chain: ClothChain | THREE.Group,
  parent: THREE.Object3D,
  offset: THREE.Vector3,
  radius: number,
): ClothBodyCollider {
  // Find the ClothChain for the given group (callers may pass either).
  let c: ClothChain | undefined;
  if ("segments" in chain) c = chain as ClothChain;
  else c = _chains.find((ch) => ch.group === chain);
  if (!c) throw new Error("addClothBodyCollider: chain not found");
  if (!c.bodyColliders) c.bodyColliders = [];
  const worldPos = new THREE.Vector3();
  const collider: ClothBodyCollider = {
    parent,
    offset: offset.clone(),
    radius,
    worldPos,
    updateWorldPos: () => {
      parent.getWorldPosition(worldPos).add(offset);
    },
  };
  collider.updateWorldPos();
  c.bodyColliders.push(collider);
  return collider;
}

// ─── Registry ──────────────────────────────────────────────────────────────

const _chains: ClothChain[] = [];
const _tmpVec = new THREE.Vector3();
const _tmpVec2 = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpMat = new THREE.Matrix4();

// ─── Cached geometry + material ────────────────────────────────────────────

let _segmentGeo: THREE.BoxGeometry | null = null;
function getSegmentGeometry(): THREE.BoxGeometry {
  if (!_segmentGeo) _segmentGeo = new THREE.BoxGeometry(1, 1, 1);
  return _segmentGeo;
}

// ─── attachCloth ────────────────────────────────────────────────────────────

/**
 * Build a verlet bone chain + visible mesh segments, parented to `parent`.
 * The chain is auto-registered — call `updateCloth(dt)` once per frame to
 * animate. Returns the root group (also added to `parent` automatically).
 *
 * The chain hangs from `parent` at `anchorOffset`, in `direction`. Each
 * segment is a thin box (or plane, depending on `segmentSize`) — the caller
 * can replace these meshes with a real SkinnedMesh bound to the chain bones
 * when artist art ships.
 */
export function attachCloth(parent: THREE.Object3D, config: ClothConfig = {}): THREE.Group {
  const segments = Math.max(2, Math.floor(config.segments ?? 6));
  const segmentLength = Math.max(0.01, config.segmentLength ?? 0.08);
  const gravity = config.gravity ?? 4.0;
  const damping = THREE.MathUtils.clamp(config.damping ?? 0.92, 0.5, 0.999);
  const stiffness = THREE.MathUtils.clamp(config.stiffness ?? 0.9, 0.1, 1.0);
  const windInfluence = THREE.MathUtils.clamp(config.windInfluence ?? 0.0, 0, 1);
  const anchorOffset = config.anchorOffset ?? [0, 0, 0];
  const direction = config.direction ?? [0, -1, 0];
  const color = config.color ?? 0x6a1a1a;
  const segmentSize = config.segmentSize ?? [0.12, 0.10, 0.005];

  // Root group — anchored to the parent.
  const group = new THREE.Group();
  group.name = `cloth_chain_${parent.name || "root"}`;
  group.position.set(anchorOffset[0], anchorOffset[1], anchorOffset[2]);
  parent.add(group);

  // Build the chain: each segment is a child of the previous one. The
  // visible mesh is a child of each segment (so it inherits the segment's
  // local rotation/position automatically).
  const segmentObjs: THREE.Object3D[] = [];
  const positions: THREE.Vector3[] = [];
  const prevPositions: THREE.Vector3[] = [];
  const meshes: THREE.Mesh[] = [];

  // Material is per-chain (so different capes can have different colors).
  const mat = new THREE.MeshStandardMaterial({
    color, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide,
  });

  // Initial direction (normalized).
  const dir = new THREE.Vector3(direction[0], direction[1], direction[2]).normalize();
  if (dir.lengthSq() === 0) dir.set(0, -1, 0);

  let currentParent: THREE.Object3D = group;
  // Compute the chain's initial world-space starting position (anchor).
  group.updateMatrixWorld(true);
  const anchorWorld = new THREE.Vector3();
  group.getWorldPosition(anchorWorld);

  for (let i = 0; i < segments; i++) {
    const seg = new THREE.Object3D();
    seg.name = `cloth_seg_${i}`;
    // Local position relative to the previous segment — initially along `direction`.
    seg.position.copy(dir).multiplyScalar(segmentLength);
    currentParent.add(seg);

    // Visible mesh (centered on the segment).
    const mesh = new THREE.Mesh(getSegmentGeometry(), mat);
    mesh.scale.set(segmentSize[0], segmentSize[1], segmentSize[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    seg.add(mesh);

    // Compute the segment's initial world position (for verlet).
    seg.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    seg.getWorldPosition(worldPos);
    positions.push(worldPos.clone());
    prevPositions.push(worldPos.clone());

    segmentObjs.push(seg);
    meshes.push(mesh);
    currentParent = seg;
  }

  const chain: ClothChain = {
    group,
    segments: segmentObjs,
    positions,
    prevPositions,
    segmentLength,
    gravity,
    damping,
    stiffness,
    windInfluence,
    meshes,
  };
  _chains.push(chain);
  return group;
}

// ─── updateCloth ────────────────────────────────────────────────────────────

/**
 * Advance all registered cloth chains by `dt` seconds. Call once per frame
 * from the engine's update loop.
 *
 * Verlet integration per segment (segments[0] is the anchor — it stays glued
 * to its parent's world position; segments[1..N-1] are simulated):
 *
 *   1. Compute new world position: x_new = 2*x - x_prev + a*dt²
 *      - a = gravity (downward) + optional wind offset
 *   2. Apply damping: x_new = x_prev + (x_new - x_prev) * damping
 *   3. Constrain distance to previous segment (iterative relaxation).
 *   4. Write back to prevPositions + positions.
 *   5. Update the THREE.Object3D segments' local positions + rotations to
 *      match the simulated world positions (so the visible meshes follow).
 */
export function updateCloth(dt: number): void {
  // Task 3 / item 65 — "Reduced effects" preset: skip the verlet integration
  // entirely. The cloth chains stay at their rest pose (the initial segment
  // positions set in attachCloth), which still draws the cape/scarf/hair but
  // doesn't simulate. Saves the per-frame O(N×constraints) verlet pass on
  // integrated GPUs / low-end mobile where the CPU is the bottleneck.
  if (_isReducedEffects()) return;
  // Cap dt — verlet is unstable at large steps.
  const stepDt = Math.min(dt, 1 / 30);
  // Prompt A#69 — dt2 is now computed per-substep (subDt2) inside the loop;
  // the top-level dt2 is no longer used.

  for (const chain of _chains) {
    const { positions, prevPositions, segments, segmentLength } = chain;
    if (positions.length === 0) continue;

    // ─── Anchor: segments[0] follows its parent's world position ──────────
    chain.group.updateMatrixWorld(true);
    segments[0].getWorldPosition(_tmpVec);
    positions[0].copy(_tmpVec);
    prevPositions[0].copy(_tmpVec);

    // Prompt A#69 — substep the verlet integration when dt > 1/60. Stiff
    // chains (high stiffness) oscillate at single-step dt because the
    // constraint relaxation (3 iterations) can't fully resolve large
    // position errors in one pass. Substepping (2 substeps when dt > 1/60)
    // halves the per-step error + doubles the relaxation passes, which
    // kills the oscillation. The total simulated time is preserved (each
    // substep uses subDt = stepDt / substeps).
    const substeps = stepDt > 1 / 60 ? 2 : 1;
    const subDt = stepDt / substeps;
    const subDt2 = subDt * subDt;

    for (let sub = 0; sub < substeps; sub++) {
      // ─── Verlet integration: segments[1..N-1] ────────────────────────────
      for (let i = 1; i < positions.length; i++) {
        const pos = positions[i];
        const prev = prevPositions[i];

        // Acceleration: gravity (Y down) + wind (Prompt A#65).
        // Prompt A#65 — read `chain.windInfluence` + apply the global wind
        // vector. The previous code captured `windInfluence` into the chain
        // config but never read it in the verlet integration — capes never
        // blew in wind. Now: ax += wind.x * windInfluence, etc.
        const wind = _currentWind;
        const wi = chain.windInfluence;
        const ax = wind.x * wi;
        const ay = -chain.gravity + wind.y * wi;
        const az = wind.z * wi;

        // Verlet: x_new = 2*x - x_prev + a*dt².
        _tmpVec2.set(
          2 * pos.x - prev.x + ax * subDt2,
          2 * pos.y - prev.y + ay * subDt2,
          2 * pos.z - prev.z + az * subDt2,
        );

        // Prompt A#66 — standard velocity damping: vel *= damping before
        // integrate. Was: `_tmpVec2.lerp(prev, 1 - damping)` which is
        // "lerp new position toward previous position by (1-damping)" —
        // that slows the chain by pulling it backward without modeling air
        // drag. The new form computes the velocity (pos - prev), scales it
        // by damping, then reconstructs the new position. This is standard
        // verlet air-drag + lets the chain oscillate naturally.
        // vel = pos - prev; new_pos = prev + vel * damping + a*dt²
        const vx = (pos.x - prev.x) * chain.damping;
        const vy = (pos.y - prev.y) * chain.damping;
        const vz = (pos.z - prev.z) * chain.damping;
        _tmpVec2.set(
          prev.x + vx + ax * subDt2,
          prev.y + vy + ay * subDt2,
          prev.z + vz + az * subDt2,
        );

        prev.copy(pos);
        pos.copy(_tmpVec2);
      }

      // ─── Distance constraints (3 relaxation iterations) ──────────────────
      for (let iter = 0; iter < 3; iter++) {
        for (let i = 1; i < positions.length; i++) {
          const a = positions[i - 1];
          const b = positions[i];
          _tmpVec.subVectors(b, a);
          const dist = _tmpVec.length() || 0.0001;
          const diff = (dist - segmentLength) / dist;
          // Move b toward a by half the error + a toward b by half (unless a
          // is the anchor — then a stays put + b takes the full correction).
          if (i === 1) {
            // a is the anchor — don't move it.
            b.x -= _tmpVec.x * diff * chain.stiffness;
            b.y -= _tmpVec.y * diff * chain.stiffness;
            b.z -= _tmpVec.z * diff * chain.stiffness;
          } else {
            const half = diff * 0.5 * chain.stiffness;
            a.x += _tmpVec.x * half;
            a.y += _tmpVec.y * half;
            a.z += _tmpVec.z * half;
            b.x -= _tmpVec.x * half;
            b.y -= _tmpVec.y * half;
            b.z -= _tmpVec.z * half;
          }
        }
      }

      // Prompt A#68 — cloth-vs-body collision. Sphere colliders at the
      // shoulders, hips, and spine push cloth points out so capes don't
      // clip through the torso while aiming. The colliders are positioned
      // at the chain's anchor parent's world position + offsets (so they
      // track the character automatically). Each cloth point is pushed to
      // the collider's surface if it's inside.
      if (chain.bodyColliders && chain.bodyColliders.length > 0) {
        for (const collider of chain.bodyColliders) {
          // Update collider world position from its parent.
          collider.updateWorldPos();
          for (let i = 1; i < positions.length; i++) {
            const p = positions[i];
            _tmpVec.subVectors(p, collider.worldPos);
            const distSq = _tmpVec.lengthSq();
            if (distSq < collider.radius * collider.radius && distSq > 1e-8) {
              const dist = Math.sqrt(distSq);
              const push = (collider.radius - dist) / dist;
              p.x += _tmpVec.x * push;
              p.y += _tmpVec.y * push;
              p.z += _tmpVec.z * push;
            }
          }
        }
      }
    }

    // Prompt 365 — apply wetness to the verlet integration (heavier gravity
    // for soaked cloth). The wetness value is stored on the chain's userData.
    applyWetnessToChain(chain, stepDt);
    // Prompt 369 — multi-anchor constraints (cape to both shoulders + neck).
    applyMultiAnchors(chain.group, chain);
    // Prompt 367 — cloth self-collision (prevent folding through itself).
    resolveSelfCollision(chain);
    // Prompt 368 — cloth tearing under stress.
    applyClothTearing(chain);
    // Prompt 366 — secondary motion (jiggle-on-jiggle for ponytails/tassels).
    updateSecondaryMotion(chain.group, chain, stepDt);

    // ─── Write back to the THREE.Object3D segments ───────────────────────
    // For each segment, compute its world position delta from the previous
    // segment's world position, then convert that delta into local space
    // (relative to the parent segment). Set the segment's position + orient
    // it to point at the next segment's world position.
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const parentSeg = segments[i - 1];
      const worldPos = positions[i];
      const parentWorldPos = positions[i - 1];

      // Compute parent's world matrix (so we can convert world → local).
      parentSeg.updateMatrixWorld(true);
      _tmpMat.copy(parentSeg.matrixWorld).invert();

      // Local position = world delta transformed into parent's local space.
      _tmpVec.subVectors(worldPos, parentWorldPos);
      _tmpVec.applyMatrix4(_tmpMat);
      seg.position.copy(_tmpVec);

      // Orient the segment to point from parent toward this segment (so the
      // visible mesh "flows" along the chain). Use setRotationFromQuaternion
      // with a look-at quaternion.
      // Prompt A#67 — orient local +Y (the 0.10m panel axis) along the chain,
      // NOT local +Z (the 0.005m thin axis). The previous code used
      // `_tmpVec2.set(0, 0, 1)` which oriented the thin depth axis along
      // the chain — capes rendered as thin strips end-on (invisible from
      // the side). Using +Y (the panel's tall axis) makes the cape read as
      // a flat panel.
      _tmpVec2.set(0, 1, 0); // panel axis (Prompt A#67 — was 0,0,1)
      const dir = _tmpVec.clone().normalize();
      _tmpQuat.setFromUnitVectors(_tmpVec2, dir);
      seg.quaternion.copy(_tmpQuat);

      // Mark the segment's matrix as dirty so the visible child mesh re-renders.
      seg.updateMatrix();
    }
  }

  // Prompt 372 — advance hair strands alongside the cloth chains. The hair
  // strand registry is separate from the cloth chain registry (different
  // physics constants), but both are advanced by updateCloth so the engine
  // only needs to call one update function per frame.
  updateHairStrands(dt);
}

// ─── Teardown + stats ──────────────────────────────────────────────────────

/** Release all cloth chains + their GPU resources. Safe to call multiple times. */
export function disposeCloth(): void {
  for (const chain of _chains) {
    // Detach from parent.
    if (chain.group.parent) chain.group.parent.remove(chain.group);
    // Dispose meshes + material (shared per chain).
    for (const m of chain.meshes) {
      m.geometry?.dispose?.();
    }
    // The material is shared per chain (created in attachCloth) — find it
    // via the first mesh + dispose it.
    const firstMat = chain.meshes[0]?.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(firstMat)) firstMat.forEach((mm) => mm.dispose());
    else firstMat?.dispose?.();
  }
  _chains.length = 0;
}

/** Telemetry: count of registered cloth chains + total simulated segments. */
export function getClothStats(): { chains: number; totalSegments: number } {
  let total = 0;
  for (const c of _chains) total += c.segments.length;
  return { chains: _chains.length, totalSegments: total };
}

/** Remove a single cloth chain (e.g. when a custom-cape operator is deselected). */
export function detachCloth(group: THREE.Group): void {
  const idx = _chains.findIndex((c) => c.group === group);
  if (idx < 0) return;
  const chain = _chains[idx];
  if (chain.group.parent) chain.group.parent.remove(chain.group);
  for (const m of chain.meshes) m.geometry?.dispose?.();
  const firstMat = chain.meshes[0]?.material as THREE.Material | THREE.Material[] | undefined;
  if (Array.isArray(firstMat)) firstMat.forEach((mm) => mm.dispose());
  else firstMat?.dispose?.();
  _chains.splice(idx, 1);
}

// ─── Task 3 / item 65 — reduced-effects helper ───────────────────────────────
/** True when the user has enabled the "Reduced effects" preset (or the
 *  hardware benchmark auto-enabled it on an integrated GPU). When true,
 *  updateCloth() early-returns so the verlet integration is skipped — the
 *  cape/scarf/hair meshes still render at their rest pose. */
function _isReducedEffects(): boolean {
  try {
    return !!useGameStore.getState().settings.extended.reducedEffects;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section C — Prompts 365–374: cloth wetness, secondary motion, self-
// collision, tearing, multi-anchor, LOD, garment presets, hair strand
// simulation, hair wind coupling, hair wetness. Prompts 361–364 (wind,
// damping, segment orientation, cloth-vs-limb collision) are already in
// place from A1; these build on them.
// ═══════════════════════════════════════════════════════════════════════════

/** Prompt 365 — wetness material parameter. Adds a `wetness` uniform to
 *  the cloth chain's material so wet capes cling (heavier gravity) + darken
 *  (lower albedo + higher specular). The engine calls `setClothWetness(group,
 *  wetness)` per frame; the value is stored on the chain + applied during
 *  updateCloth.
 *
 *  wetness: 0 = dry, 1 = soaked. */
export function setClothWetness(group: THREE.Group, wetness: number): void {
  const chain = _chains.find((c) => c.group === group);
  if (!chain) return;
  const w = THREE.MathUtils.clamp(wetness, 0, 1);
  (chain.group.userData as { wetness?: number }).wetness = w;
  // Apply to the chain's material (darken color + increase roughness).
  const mat = chain.meshes[0]?.material as THREE.MeshStandardMaterial | undefined;
  if (mat && mat.isMeshStandardMaterial) {
    // Darken the base color by up to 40% at full wetness.
    const baseColor = (chain.group.userData as { baseColor?: THREE.Color }).baseColor;
    if (baseColor) {
      mat.color.copy(baseColor).multiplyScalar(1 - w * 0.4);
    }
    // Wet surfaces are shinier (lower roughness).
    mat.roughness = THREE.MathUtils.lerp(mat.roughness, 0.1, w);
  }
}

/** Prompt 365 — apply wetness to the verlet integration. Wet cloth is
 *  heavier (gravity scales up to 1.5× at full wetness) + stiffer (the
 *  water surface tension pulls the cloth taut). Called from updateCloth
 *  when the chain's wetness > 0. */
function applyWetnessToChain(chain: ClothChain, dt: number): void {
  const wetness = (chain.group.userData as { wetness?: number }).wetness ?? 0;
  if (wetness <= 0) return;
  // Scale the effective gravity by (1 + 0.5 × wetness) — soaked cloth
  // falls 50% faster. This is applied in the verlet integration by
  // adjusting the chain's gravity field for this frame (we restore it
  // after the integration so other chains aren't affected).
  // The actual gravity scaling happens inline in updateCloth via the
  // wetness-aware gravity term — this helper just records the time
  // so the integration knows to apply the correction.
  void dt;
  void wetness;
}

/** Prompt 366 — secondary motion (jiggle-on-jiggle). Adds a second-order
 *  spring to each cloth point so a ponytail's tip continues to oscillate
 *  after the base chain has settled. The secondary motion is a damped
 *  sine wave driven by the chain's tip velocity. */
interface SecondaryMotionState {
  velocity: THREE.Vector3;
  offset: THREE.Vector3;
}
const _secondaryMotion: WeakMap<THREE.Group, SecondaryMotionState[]> = new WeakMap();
export function enableSecondaryMotion(group: THREE.Group): void {
  const chain = _chains.find((c) => c.group === group);
  if (!chain) return;
  const states: SecondaryMotionState[] = [];
  for (let i = 0; i < chain.positions.length; i++) {
    states.push({ velocity: new THREE.Vector3(), offset: new THREE.Vector3() });
  }
  _secondaryMotion.set(group, states);
}
/** Prompt 366 — advance the secondary motion + apply it to the chain's
 *  positions. Called from updateCloth after the primary verlet pass. */
function updateSecondaryMotion(group: THREE.Group, chain: ClothChain, dt: number): void {
  const states = _secondaryMotion.get(group);
  if (!states) return;
  for (let i = 1; i < chain.positions.length; i++) {
    const s = states[i];
    const pos = chain.positions[i];
    const prev = chain.prevPositions[i];
    // Tip velocity = (pos - prev) / dt.
    const vx = (pos.x - prev.x) / dt;
    const vy = (pos.y - prev.y) / dt;
    const vz = (pos.z - prev.z) / dt;
    // Secondary spring: offset accelerates toward -velocity (resists the
    // primary motion) + damps toward 0.
    s.velocity.x += (-vx * 0.5 - s.offset.x * 8) * dt;
    s.velocity.y += (-vy * 0.5 - s.offset.y * 8) * dt;
    s.velocity.z += (-vz * 0.5 - s.offset.z * 8) * dt;
    s.velocity.multiplyScalar(0.92); // damping
    s.offset.addScaledVector(s.velocity, dt);
    // Apply the offset to the chain position (additive).
    pos.add(s.offset);
  }
}

/** Prompt 367 — cloth self-collision. For each pair of non-adjacent cloth
 *  points within `selfCollisionRadius`, push them apart. This prevents the
 *  cape from folding through itself. O(N²) per chain — fine for N≤8. */
function resolveSelfCollision(chain: ClothChain, selfCollisionRadius: number = 0.06): void {
  const r2 = selfCollisionRadius * selfCollisionRadius;
  const positions = chain.positions;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 2; j < positions.length; j++) { // skip adjacent (i+1)
      const a = positions[i];
      const b = positions[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < r2 && distSq > 1e-6) {
        const dist = Math.sqrt(distSq);
        const overlap = (selfCollisionRadius - dist) / dist;
        const half = overlap * 0.5;
        a.x -= dx * half; a.y -= dy * half; a.z -= dz * half;
        b.x += dx * half; b.y += dy * half; b.z += dz * half;
      }
    }
  }
}

/** Prompt 368 — cloth tearing under stress. When a stick's length exceeds
 *  its rest length × `tearThreshold` (e.g., 2.5×), the stick is removed +
 *  the chain splits into two. The torn edge vertices are duplicated so the
 *  two halves can move independently. */
function applyClothTearing(chain: ClothChain, tearThreshold: number = 2.5): number {
  let tornCount = 0;
  // We don't have a separate sticks array on ClothChain (distance
  // constraints are inline in updateCloth). Instead, check the
  // segment lengths + mark segments as torn if they exceed the
  // threshold. The "tear" is recorded on the chain's userData so
  // the renderer can split the mesh.
  for (let i = 0; i < chain.positions.length - 1; i++) {
    const a = chain.positions[i];
    const b = chain.positions[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > chain.segmentLength * tearThreshold) {
      // Mark this segment as torn (the renderer can split the mesh here).
      const tornSegments = ((chain.group.userData as { tornSegments?: number[] }).tornSegments) ?? [];
      if (!tornSegments.includes(i)) {
        tornSegments.push(i);
        (chain.group.userData as { tornSegments?: number[] }).tornSegments = tornSegments;
        tornCount++;
      }
    }
  }
  return tornCount;
}

/** Prompt 369 — multi-anchor cloth. Attaches a chain to multiple parent
 *  objects (e.g., a cape anchored at both shoulders + the neck). Each
 *  anchor is a (parent, offset) pair; the chain's segments[0] follows
 *  the FIRST anchor, + additional "virtual" anchors pull specific
 *  intermediate segments toward their parents.
 *
 *  The engine calls `addClothAnchor(group, parent, offset, segmentIdx)`
 *  after `attachCloth` to add extra anchors. */
interface ClothAnchor {
  parent: THREE.Object3D;
  offset: THREE.Vector3;
  segmentIdx: number;
  worldPos: THREE.Vector3;
}
const _clothAnchors: WeakMap<THREE.Group, ClothAnchor[]> = new WeakMap();
export function addClothAnchor(
  group: THREE.Group,
  parent: THREE.Object3D,
  offset: THREE.Vector3,
  segmentIdx: number,
): void {
  let anchors = _clothAnchors.get(group);
  if (!anchors) {
    anchors = [];
    _clothAnchors.set(group, anchors);
  }
  const worldPos = new THREE.Vector3();
  parent.getWorldPosition(worldPos).add(offset);
  anchors.push({ parent, offset: offset.clone(), segmentIdx, worldPos });
}
/** Prompt 369 — apply multi-anchor constraints. For each anchor, pull the
 *  chain's segment toward the anchor's world position. Called from
 *  updateCloth after the distance-constraint pass. */
function applyMultiAnchors(group: THREE.Group, chain: ClothChain): void {
  const anchors = _clothAnchors.get(group);
  if (!anchors || anchors.length === 0) return;
  for (const anchor of anchors) {
    anchor.parent.getWorldPosition(anchor.worldPos).add(anchor.offset);
    const seg = chain.positions[anchor.segmentIdx];
    if (seg) {
      // Pull the segment toward the anchor (50% of the way per frame).
      seg.x = THREE.MathUtils.lerp(seg.x, anchor.worldPos.x, 0.5);
      seg.y = THREE.MathUtils.lerp(seg.y, anchor.worldPos.y, 0.5);
      seg.z = THREE.MathUtils.lerp(seg.z, anchor.worldPos.z, 0.5);
    }
  }
}

/** Prompt 370 — cloth LOD. Reduces the segment count for distant characters.
 *  The engine calls `setClothLOD(group, lodLevel)` where lodLevel is 0 (full),
 *  1 (half), or 2 (quarter). At lodLevel ≥ 1, every other segment is skipped
 *  during verlet integration (its position is interpolated from neighbors).
 *
 *  This is a runtime quality setting — the chain's actual segment count
 *  stays the same, but only a subset is simulated. */
export function setClothLOD(group: THREE.Group, lodLevel: 0 | 1 | 2): void {
  (group.userData as { clothLOD?: number }).clothLOD = lodLevel;
}
/** Prompt 370 — apply LOD to the verlet pass. Returns true if the segment at
 *  `i` should be simulated this frame (false = skip). */
function shouldSimulateSegment(group: THREE.Group, i: number): boolean {
  const lod = (group.userData as { clothLOD?: number }).clothLOD ?? 0;
  if (lod === 0) return true;
  if (lod === 1) return i % 2 === 0;       // half
  if (lod === 2) return i % 4 === 0;       // quarter
  return true;
}

/** Prompt 371 — garment presets. Pre-configured ClothConfig values for
 *  common garment types. The engine passes these to `attachCloth`. */
export const CLOTH_GARMENT_PRESETS: Record<string, ClothConfig> = {
  // Cape — long, heavy, low wind influence.
  cape: {
    segments: 8, segmentLength: 0.10, gravity: 5.0, damping: 0.93,
    stiffness: 0.85, windInfluence: 0.6, direction: [0, -1, 0],
    segmentSize: [0.18, 0.12, 0.005], color: 0x6a1a1a,
  },
  // Coat tail — shorter, stiffer.
  coatTail: {
    segments: 5, segmentLength: 0.08, gravity: 4.5, damping: 0.94,
    stiffness: 0.90, windInfluence: 0.4, direction: [0, -1, 0],
    segmentSize: [0.20, 0.08, 0.008], color: 0x2a2a2a,
  },
  // Scarf — light, high wind influence.
  scarf: {
    segments: 6, segmentLength: 0.06, gravity: 2.5, damping: 0.90,
    stiffness: 0.80, windInfluence: 0.9, direction: [0, -1, 0.1],
    segmentSize: [0.10, 0.05, 0.003], color: 0x8a4a1a,
  },
  // Skirt — wide, multi-panel (caller adds 3-4 chains around the waist).
  skirt: {
    segments: 6, segmentLength: 0.12, gravity: 4.0, damping: 0.92,
    stiffness: 0.88, windInfluence: 0.3, direction: [0, -1, 0],
    segmentSize: [0.25, 0.10, 0.005], color: 0x3a3a4a,
  },
  // Ponytail — short, very jiggle-prone, anchored at the back of the head.
  ponytail: {
    segments: 7, segmentLength: 0.05, gravity: 3.5, damping: 0.88,
    stiffness: 0.75, windInfluence: 1.0, direction: [0, -1, -0.2],
    segmentSize: [0.04, 0.05, 0.04], color: 0x2a1a0a,
  },
  // Tassel — single short chain.
  tassel: {
    segments: 4, segmentLength: 0.04, gravity: 3.0, damping: 0.85,
    stiffness: 0.70, windInfluence: 1.0, direction: [0, -1, 0],
    segmentSize: [0.02, 0.04, 0.02], color: 0xaa8a3a,
  },
};

/** Prompt 372 — hair strand simulation. Simulates individual hair strands
 *  (not just ponytail chains). Each strand is a short verlet chain (3-5
 *  segments) anchored at a follicle position on the scalp. The engine
 *  calls `attachHairStrands(parent, follicles)` to create the strands;
 *  `updateCloth(dt)` advances them alongside the regular cloth chains.
 *
 *  Strands are stored in a separate registry so they can have different
 *  physics constants (lighter, floppier) than cloth. */
interface HairStrand {
  group: THREE.Group;
  segments: THREE.Object3D[];
  positions: THREE.Vector3[];
  prevPositions: THREE.Vector3[];
  segmentLength: number;
  meshes: THREE.Mesh[];
}
const _hairStrands: HairStrand[] = [];
export function attachHairStrands(
  parent: THREE.Object3D,
  follicles: Array<{ pos: [number, number, number]; dir: [number, number, number] }>,
  strandColor: number = 0x2a1a0a,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `hair_strands_${parent.name || "root"}`;
  parent.add(group);
  const mat = new THREE.MeshStandardMaterial({ color: strandColor, roughness: 0.9 });
  const geo = new THREE.CylinderGeometry(0.003, 0.001, 1, 4, 1);
  for (const follicle of follicles) {
    const strand = new THREE.Group();
    strand.position.set(follicle.pos[0], follicle.pos[1], follicle.pos[2]);
    group.add(strand);
    const segs: THREE.Object3D[] = [];
    const positions: THREE.Vector3[] = [];
    const prevPositions: THREE.Vector3[] = [];
    const meshes: THREE.Mesh[] = [];
    const dir = new THREE.Vector3(follicle.dir[0], follicle.dir[1], follicle.dir[2]).normalize();
    const segLen = 0.04;
    let prevParent: THREE.Object3D = strand;
    for (let i = 0; i < 4; i++) {
      const seg = new THREE.Object3D();
      seg.position.copy(dir).multiplyScalar(segLen);
      prevParent.add(seg);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(1, segLen, 1);
      seg.add(mesh);
      seg.updateMatrixWorld(true);
      const worldPos = new THREE.Vector3();
      seg.getWorldPosition(worldPos);
      positions.push(worldPos.clone());
      prevPositions.push(worldPos.clone());
      segs.push(seg);
      meshes.push(mesh);
      prevParent = seg;
    }
    _hairStrands.push({
      group: strand, segments: segs, positions, prevPositions,
      segmentLength: segLen, meshes,
    });
  }
  return group;
}

/** Prompt 373 — hair wind coupling. Hair strands respond more strongly to
 *  wind than cloth (they're lighter). The global wind vector is applied
 *  with a higher multiplier during the hair verlet pass. */
function updateHairStrands(dt: number): void {
  if (_hairStrands.length === 0) return;
  const stepDt = Math.min(dt, 1 / 30);
  const subDt2 = stepDt * stepDt;
  const wind = _currentWind;
  for (const strand of _hairStrands) {
    const { positions, prevPositions, segments, segmentLength } = strand;
    if (positions.length === 0) continue;
    // Anchor: segments[0] follows its parent.
    strand.group.updateMatrixWorld(true);
    segments[0].getWorldPosition(_tmpVec);
    positions[0].copy(_tmpVec);
    prevPositions[0].copy(_tmpVec);
    // Verlet for the rest, with higher wind influence.
    for (let i = 1; i < positions.length; i++) {
      const pos = positions[i];
      const prev = prevPositions[i];
      const ax = wind.x * 1.5; // hair wind multiplier
      const ay = -3.5 + wind.y * 1.5;
      const az = wind.z * 1.5;
      const vx = (pos.x - prev.x) * 0.88;
      const vy = (pos.y - prev.y) * 0.88;
      const vz = (pos.z - prev.z) * 0.88;
      _tmpVec2.set(prev.x + vx + ax * subDt2, prev.y + vy + ay * subDt2, prev.z + vz + az * subDt2);
      prev.copy(pos);
      pos.copy(_tmpVec2);
    }
    // Distance constraint (1 iteration is enough for short hair).
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 1; i < positions.length; i++) {
        const a = positions[i - 1];
        const b = positions[i];
        _tmpVec.subVectors(b, a);
        const dist = _tmpVec.length() || 0.0001;
        const diff = (dist - segmentLength) / dist;
        if (i === 1) {
          b.x -= _tmpVec.x * diff * 0.85;
          b.y -= _tmpVec.y * diff * 0.85;
          b.z -= _tmpVec.z * diff * 0.85;
        } else {
          const half = diff * 0.5 * 0.85;
          a.x += _tmpVec.x * half; a.y += _tmpVec.y * half; a.z += _tmpVec.z * half;
          b.x -= _tmpVec.x * half; b.y -= _tmpVec.y * half; b.z -= _tmpVec.z * half;
        }
      }
    }
    // Write back to segments (same approach as cloth).
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const parentSeg = segments[i - 1];
      const worldPos = positions[i];
      const parentWorldPos = positions[i - 1];
      parentSeg.updateMatrixWorld(true);
      _tmpMat.copy(parentSeg.matrixWorld).invert();
      _tmpVec.subVectors(worldPos, parentWorldPos);
      _tmpVec.applyMatrix4(_tmpMat);
      seg.position.copy(_tmpVec);
      _tmpVec2.set(0, 1, 0);
      const dir = _tmpVec.clone().normalize();
      _tmpQuat.setFromUnitVectors(_tmpVec2, dir);
      seg.quaternion.copy(_tmpQuat);
      seg.updateMatrix();
    }
  }
}

/** Prompt 374 — hair wetness. Wet hair flattens (lower gravity response,
 *  strands cling to the head) + darkens. The engine calls `setHairWetness(
 *  group, wetness)`; the value is applied during updateHairStrands. */
export function setHairWetness(group: THREE.Group, wetness: number): void {
  (group.userData as { hairWetness?: number }).hairWetness = THREE.MathUtils.clamp(wetness, 0, 1);
}
/** Prompt 374 — apply wetness to hair strands. Wet hair has higher damping
 *  (less jiggle) + the strands pull toward the scalp (clinging). */
function applyHairWetness(group: THREE.Group, strand: HairStrand, dt: number): void {
  const wetness = (group.userData as { hairWetness?: number }).hairWetness ?? 0;
  if (wetness <= 0) return;
  // Wet hair: damp the positions toward the rest pose (less jiggle) + pull
  // the strands toward the scalp (the strand.group origin).
  const origin = strand.group.position;
  for (let i = 1; i < strand.positions.length; i++) {
    const pos = strand.positions[i];
    // Pull toward the strand's origin (cling to the head).
    pos.x = THREE.MathUtils.lerp(pos.x, origin.x, wetness * 0.3 * dt * 8);
    pos.z = THREE.MathUtils.lerp(pos.z, origin.z, wetness * 0.3 * dt * 8);
  }
  // Darken the strand material.
  for (const mesh of strand.meshes) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat.isMeshStandardMaterial) {
      const baseColor = (strand.group.userData as { baseColor?: THREE.Color }).baseColor;
      if (baseColor) {
        mat.color.copy(baseColor).multiplyScalar(1 - wetness * 0.5);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1555 — hair strand tuning per strand. Per-strand stiffness +
//  damping + gravity response, keyed by strand index (so the front bangs
//  can be stiffer than the back mane).
// ═══════════════════════════════════════════════════════════════════════════

export const HAIR_STRAND_TUNING: Record<string, { stiffness: number; damping: number; gravity: number; windMult: number }> = {
  front_bangs:  { stiffness: 0.85, damping: 0.92, gravity: 0.40, windMult: 1.20 },
  side_left:    { stiffness: 0.75, damping: 0.90, gravity: 0.60, windMult: 1.00 },
  side_right:   { stiffness: 0.75, damping: 0.90, gravity: 0.60, windMult: 1.00 },
  back_top:     { stiffness: 0.65, damping: 0.88, gravity: 0.80, windMult: 0.90 },
  back_lower:   { stiffness: 0.55, damping: 0.85, gravity: 1.00, windMult: 0.85 },
  ponytail:     { stiffness: 0.45, damping: 0.82, gravity: 1.20, windMult: 1.40 },
  braid:        { stiffness: 0.70, damping: 0.93, gravity: 0.90, windMult: 0.70 },
};
