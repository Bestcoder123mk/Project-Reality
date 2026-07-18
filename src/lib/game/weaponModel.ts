import * as THREE from "three";
import { buildDetailedWeapon } from "./WeaponBuilder";
import { WEAPONS, computeWeaponStats, type LoadoutConfig } from "./store";
import { loadModel, hasModel, getArtStatus } from "./assets/ModelRegistry";

/**
 * A2-5000 #270 — shared presentation transform (was duplicated between
 * buildWeaponModel + loadWeaponModelAsync). Single source of truth.
 */
export const WEAPON_PRESENTATION_SCALE = 6;
export const WEAPON_PRESENTATION_ROT_Y = -0.4;
export const WEAPON_PRESENTATION_ROT_X = 0.05;

function applyPresentationTransform(group: THREE.Group): void {
  group.scale.setScalar(WEAPON_PRESENTATION_SCALE);
  group.rotation.y = WEAPON_PRESENTATION_ROT_Y;
  group.rotation.x = WEAPON_PRESENTATION_ROT_X;
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

/** Build a standalone, centered, rotatable weapon model for the gunsmith view.
 *  Uses the detailed WeaponBuilder — 30-60+ parts per weapon with realistic
 *  anatomy (receivers, barrel + gas block, handguard + rails, magazine, stock,
 *  grip, trigger group, charging handle, iron sights, muzzle device). */
export function buildWeaponModel(loadout: LoadoutConfig): THREE.Group {
  const built = buildDetailedWeapon(loadout);
  const group = built.group;
  // A2-5000 #270 — shared transform helper.
  applyPresentationTransform(group);
  return group;
}

/**
 * SEC2-ART — async weapon-model loader. Probes the ModelRegistry for a real
 * `.glb` for the loadout's weapon slug; if one ships (status: "glTF"), loads
 * it via GLTFLoader + DRACO + KTX2. Falls back to the procedural
 * `buildWeaponModel` for any slug not flagged glTF, or when the load fails,
 * or on the server.
 *
 * A2-5000 #269 — wrapped in try/catch. A broken GLB (corrupt file, decoder
 * failure, network error) used to break the gunsmith UI (unhandled promise
 * rejection). Now falls back to the procedural builder + logs the error.
 *
 * Use this in the gunsmith + shop previews to surface real artist art when it
 * ships. The synchronous `buildWeaponModel` above remains as the fast-path for
 * first-paint + server rendering.
 *
 * @returns A THREE.Group with the same presentation transform as
 *          `buildWeaponModel` (scaled + rotated for display). The group's
 *          `userData.assetSource` field tells you which path produced it:
 *          `"glb"` (real art) or `"procedural"` (fallback).
 */
export async function loadWeaponModelAsync(loadout: LoadoutConfig): Promise<THREE.Group> {
  const slug = loadout.weapon;
  // If the manifest says procedural, skip the network — go straight to the
  // synchronous procedural builder. This is the common case (29/30 weapons
  // today are procedural).
  if (!hasModel(slug)) {
    const proc = buildWeaponModel(loadout);
    proc.userData.assetSource = "procedural";
    return proc;
  }
  // A2-5000 #269 — real-art path wrapped in try/catch. Broken GLB / decoder
  // failure / network error falls back to procedural so the gunsmith UI stays
  // functional.
  try {
    const raw = await loadModel(slug);
    // A2-5000 #270 — shared transform helper.
    applyPresentationTransform(raw);
    raw.userData.assetSource = "glb";
    return raw;
  } catch (err) {
    console.warn(`[weaponModel] loadModel("${slug}") failed — falling back to procedural:`, err);
    const proc = buildWeaponModel(loadout);
    proc.userData.assetSource = "procedural";
    return proc;
  }
}

/** Synchronous head-check: does this loadout's weapon ship as a real .glb?
 *  Use to decide whether to show a "real art" badge in the gunsmith UI. */
export function loadoutHasGLTFModel(loadout: LoadoutConfig): boolean {
  return hasModel(loadout.weapon);
}

/** Art-direction status for a loadout's weapon (procedural or glTF). Mirrors
 *  ModelRegistry.getArtStatus but takes a LoadoutConfig for ergonomics. */
export function getLoadoutArtStatus(loadout: LoadoutConfig) {
  return getArtStatus(loadout.weapon);
}

export function getWeaponList(): { slug: keyof typeof WEAPONS; name: string }[] {
  return Object.values(WEAPONS).map((w) => ({ slug: w.id, name: w.name }));
}

// Re-export for backward compat.
export { computeWeaponStats };
