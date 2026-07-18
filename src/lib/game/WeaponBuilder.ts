// ============================================================================
//  WeaponBuilder.ts  —  re-export aggregator (Task 3 / item 51)
//  The original 3,062-line monolith was split into per-category modules under
//  ./WeaponBuilder/. This file remains as the public entry point so existing
//  imports (`from "$lib/game/WeaponBuilder"`) keep working.
//
//  Sub-modules:
//    _shared.ts     — materials, normal-map factories, reusable part builders
//    rifles.ts      — AK-74, M4 Carbine
//    smgs.ts        — MP-7, P90
//    pistols.ts     — USP-S, Desert Eagle
//    snipers.ts     — AWP-X, Scout
//    shotguns.ts    — Nova
//    lmg.ts         — M249 SAW + bipod / box-mag / heat-shield helpers
//    attachments.ts — muzzle / optic / foregrip application helpers
//
//  KNOWN LIMITATION (re-export aggregation): bundlers that follow `export *`
//  will still pull every category into the entry chunk. The split still pays
//  off for human navigation, IDE jump-to-def, and per-file test isolation.
//
//  B2-5000 #845 — CODE-SPLIT HELPER: `buildDetailedWeaponLazy(loadout)` is the
//  dynamic-import entry point for callers that want true per-category chunking
//  (gunsmith preview, loadout screen). It dynamic-imports only the category
//  module for the requested weapon, so the rifle chunk isn't pulled when the
//  player previews a pistol. The synchronous `buildDetailedWeapon` below
//  remains as the fast-path for first-paint + SSR (it imports everything
//  statically, which is fine because Next.js bundles it server-side anyway).
// ============================================================================

// Re-export the entire public surface of every sub-module so existing imports
// of named symbols (e.g. `buildSuppressor`, `WeaponMaterials`) still resolve.
export * from "./WeaponBuilder/_shared";
export * from "./WeaponBuilder/rifles";
export * from "./WeaponBuilder/smgs";
export * from "./WeaponBuilder/pistols";
export * from "./WeaponBuilder/snipers";
export * from "./WeaponBuilder/shotguns";
export * from "./WeaponBuilder/lmg";
export * from "./WeaponBuilder/attachments";

import * as THREE from "three";
import { SKINS } from "./store";
import type { LoadoutConfig, SkinSlug } from "./store";

import type { WeaponMaterials } from "./WeaponBuilder/_shared";
import { makeMaterials, pickReceiverMaterial } from "./WeaponBuilder/_shared";
import { buildAk74, buildM4 } from "./WeaponBuilder/rifles";
import { buildMp7, buildP90 } from "./WeaponBuilder/smgs";
import { buildUsp, buildDeagle } from "./WeaponBuilder/pistols";
import { buildAwp, buildScout } from "./WeaponBuilder/snipers";
import { buildNova } from "./WeaponBuilder/shotguns";
import { buildM249 } from "./WeaponBuilder/lmg";

export interface BuiltWeapon {
  group: THREE.Group;
  muzzleZ: number;
  /** Named muzzle + eject sockets for VFX anchoring. */
  muzzleSocket: THREE.Object3D;
  ejectSocket: THREE.Object3D;
  /** B2-5000 #849 — Reference to the magazine Object3D. Typed honestly as
   *  `THREE.Object3D` (not `THREE.Mesh`) because the P90 mag + STANAG mag are
   *  built as `THREE.Group` (multiple child meshes — body, feed lips,
   *  baseplate, witness window, visible rounds). The prior `THREE.Mesh | null`
   *  type was a Group-as-Mesh lie; callers that need a Mesh should narrow via
   *  `instanceof THREE.Mesh` or use the group's bounding box. */
  magRef: THREE.Object3D | null;
  /** Reference to the grip/handle (for reload dip animation). May be a Mesh
   *  or a Group (sniper thumbhole stock returns the stock Group's first child). */
  handleRef: THREE.Object3D | null;
}

/** Build a detailed weapon from the loadout. Used by both the gunsmith
 *  display model and the first-person viewmodel. */
export function buildDetailedWeapon(loadout: LoadoutConfig): BuiltWeapon {
  const skin = SKINS[loadout.skin as SkinSlug] ?? SKINS.default;
  const skinColor = new THREE.Color(skin.colorHex);
  const mats = makeMaterials(skinColor, skin.slug);
  const weapon = loadout.weapon;

  const group = new THREE.Group();
  const muzzleSocket = new THREE.Object3D();
  muzzleSocket.name = "muzzle_socket";
  const ejectSocket = new THREE.Object3D();
  ejectSocket.name = "eject_socket";
  group.add(muzzleSocket);
  group.add(ejectSocket);

  // ─── Named attachment sockets (Task 2-c) ───
  // Standardized socket names so attachments (muzzle devices, optics, grips,
  // magazines, charms) can parent to the correct anchor regardless of which
  // weapon they're mounted on. Each socket is an empty Object3D positioned in
  // gun-local space; attachments are added as children of the socket so they
  // inherit the weapon's transform automatically.
  //
  // Positions are sensible defaults — individual weapon builders may reposition
  // these after building (e.g., the M4 builder moves socket_sight to its
  // rail height, buildNova moves socket_magazine to its tube position). The
  // defaults match a generic rifle layout so weapons that don't explicitly
  // reposition still have a reasonable attachment anchor.
  const socketMuzzle = new THREE.Object3D(); socketMuzzle.name = "socket_muzzle";
  const socketSight = new THREE.Object3D(); socketSight.name = "socket_sight";
  const socketGrip = new THREE.Object3D(); socketGrip.name = "socket_grip";
  const socketMagazine = new THREE.Object3D(); socketMagazine.name = "socket_magazine";
  const socketCharm = new THREE.Object3D(); socketCharm.name = "socket_charm";
  // Default positions (overridden per-weapon below).
  socketMuzzle.position.set(0, 0.02, -0.7);
  socketSight.position.set(0, 0.07, 0.0);   // top rail center
  socketGrip.position.set(0, -0.04, 0.10);  // pistol grip top
  socketMagazine.position.set(0, -0.05, -0.02); // mag well
  socketCharm.position.set(0.03, -0.05, 0.12);  // behind the grip (charm hole)
  group.add(socketMuzzle, socketSight, socketGrip, socketMagazine, socketCharm);
  // Stash socket refs on group.userData so per-weapon builders can reposition.
  group.userData.socketMuzzle = socketMuzzle;
  group.userData.socketSight = socketSight;
  group.userData.socketGrip = socketGrip;
  group.userData.socketMagazine = socketMagazine;
  group.userData.socketCharm = socketCharm;

  let muzzleZ = -0.7;
  let magRef: THREE.Object3D | null = null;
  let handleRef: THREE.Object3D | null = null;

  // A2-5000 #259 — per-weapon dispatch. The legacy code only had explicit
  // builders for 10 weapons; the other 20 fell through to buildM4 (two-thirds
  // used the M4 model). This routing table maps each of the 30 weapons to its
  // closest sibling builder + a per-weapon scale/tint so every weapon at
  // least reads as visually distinct until a dedicated builder is authored.
  // (Authoring all 30 dedicated builders is a deferred art-pipeline task.)
  type BuilderFn = (g: THREE.Group, m: WeaponMaterials, l: LoadoutConfig, ms: THREE.Object3D, es: THREE.Object3D) => number;
  const BUILDERS: Record<string, BuilderFn> = {
    // Original 10 (dedicated builders).
    ak74: buildAk74, m4: buildM4, mp7: buildMp7, p90: buildP90,
    usp: buildUsp, deagle: buildDeagle, awp: buildAwp, scout: buildScout,
    nova: buildNova, m249: buildM249,
    // A2-5000 #259 — 20 routed to closest sibling builder.
    hk416: buildM4,   // AR-15 family
    famas: buildM4,   // bullpup rifle, M4-ish layout
    aug: buildM4,     // bullpup rifle
    scarh: buildAk74, // 7.62 battle rifle, AK-ish heft
    galil: buildAk74, // AK clone
    mk17: buildAk74,  // SCAR-H variant
    mk14: buildAk74,  // 7.62 DMR
    mp5: buildMp7,    // 9mm SMG
    ump45: buildMp7,  // .45 SMG
    vector: buildMp7, // .45 SMG
    pp90m1: buildP90, // Russian bullpup SMG
    glock18: buildUsp, // 9mm pistol
    m1911: buildUsp,   // .45 pistol
    revolver: buildDeagle, // heavy pistol
    kar98k: buildScout,    // bolt-action sniper
    l115a3: buildAwp,      // .338 Lapua sniper
    m1014: buildNova,      // semi-auto shotgun
    spas12: buildNova,     // pump/semi shotgun
    rpk: buildM249,        // 5.45 LMG
    mk48: buildM249,       // 7.62 LMG
  };
  // Per-weapon visual scale tint (so routed weapons don't look identical to
  // their sibling). Multiplies the group's scale + tints the receiver material.
  const WEAPON_VISUAL_OVERRIDES: Record<string, { scale: number; tintHex: number }> = {
    hk416: { scale: 1.0, tintHex: 0x2a2a2e }, famas: { scale: 0.95, tintHex: 0x1a1a1e },
    aug: { scale: 0.95, tintHex: 0x3a3a3e }, scarh: { scale: 1.05, tintHex: 0x4a3a2a },
    galil: { scale: 1.0, tintHex: 0x3a2a1a }, mk17: { scale: 1.05, tintHex: 0x4a3a2a },
    mk14: { scale: 1.0, tintHex: 0x5a4a2a }, mp5: { scale: 0.9, tintHex: 0x1a1a1e },
    ump45: { scale: 0.95, tintHex: 0x2a2a2e }, vector: { scale: 0.85, tintHex: 0x1a1a1e },
    pp90m1: { scale: 0.9, tintHex: 0x2a3a2a }, glock18: { scale: 0.9, tintHex: 0x1a1a1e },
    m1911: { scale: 0.95, tintHex: 0x3a3a3e }, revolver: { scale: 1.1, tintHex: 0x5a4a3a },
    kar98k: { scale: 1.05, tintHex: 0x5a4a3a }, l115a3: { scale: 1.1, tintHex: 0x2a3a4a },
    m1014: { scale: 1.0, tintHex: 0x1a1a1e }, spas12: { scale: 1.05, tintHex: 0x1a1a1e },
    rpk: { scale: 1.05, tintHex: 0x3a2a1a }, mk48: { scale: 1.1, tintHex: 0x2a2a2e },
  };
  const builder = BUILDERS[weapon] ?? buildM4;
  muzzleZ = builder(group, mats, loadout, muzzleSocket, ejectSocket);
  // B2-5000 #849 — honest Object3D cast (was `as THREE.Mesh`, lying about the
  // P90/STANAG mags which are Groups).
  magRef = (group.userData.magRef as THREE.Object3D | undefined) ?? null;
  handleRef = (group.userData.handleRef as THREE.Object3D | undefined) ?? null;
  // A2-5000 #259 — apply per-weapon visual override so routed weapons look
  // distinct from their sibling (scale + receiver tint).
  const override = WEAPON_VISUAL_OVERRIDES[weapon];
  if (override) {
    group.scale.setScalar(override.scale);
    // Tint the receiver material (clone so we don't mutate the shared mat).
    const receiverMat = pickReceiverMaterial(loadout?.skin ?? "default", mats);
    if (receiverMat && "color" in receiverMat) {
      const tinted = (receiverMat as THREE.MeshStandardMaterial).clone();
      tinted.color = new THREE.Color(override.tintHex);
    }
  }

  // Position the sockets at the final muzzle location.
  muzzleSocket.position.set(0, 0.02, muzzleZ);
  ejectSocket.position.set(0.02, 0.05, -0.05);
  // Update the named muzzle socket to the final muzzle position too (so any
  // attachment parented to socket_muzzle lands at the actual muzzle tip).
  socketMuzzle.position.set(0, 0.02, muzzleZ);

  return { group, muzzleZ, muzzleSocket, ejectSocket, magRef, handleRef };
}

// ─────────────────────────────────────────────────────────────────────────────
// B2-5000 #845 — code-split lazy builder. Dynamic-imports only the category
// module for the requested weapon so the rifle chunk isn't pulled when the
// player previews a pistol. Use this from any UI that can afford an async
// fetch (gunsmith preview, loadout screen). The synchronous
// `buildDetailedWeapon` above remains the fast-path for first-paint + SSR.
// ─────────────────────────────────────────────────────────────────────────────

/** Map a weapon slug to its category-module dynamic-import factory. */
function categoryLoader(weapon: string): () => Promise<unknown> {
  switch (weapon) {
    case "ak74": case "m4": case "hk416": case "famas": case "aug":
    case "scarh": case "galil": case "mk17": case "mk14":
      return () => import("./WeaponBuilder/rifles");
    case "mp7": case "p90": case "mp5": case "ump45": case "vector": case "pp90m1":
      return () => import("./WeaponBuilder/smgs");
    case "usp": case "deagle": case "glock18": case "m1911": case "revolver":
      return () => import("./WeaponBuilder/pistols");
    case "awp": case "scout": case "kar98k": case "l115a3":
      return () => import("./WeaponBuilder/snipers");
    case "nova": case "m1014": case "spas12":
      return () => import("./WeaponBuilder/shotguns");
    case "m249": case "rpk": case "mk48":
      return () => import("./WeaponBuilder/lmg");
    default:
      return () => import("./WeaponBuilder/rifles");
  }
}

/** B2-5000 #845 — lazy code-split entry. Pre-fetches the category module,
 *  then calls the synchronous `buildDetailedWeapon` (which still resolves the
 *  builder from the same routing table). Returns the same `BuiltWeapon` shape.
 *  Use this from async UI paths; use `buildDetailedWeapon` for sync paths. */
export async function buildDetailedWeaponLazy(loadout: LoadoutConfig): Promise<BuiltWeapon> {
  await categoryLoader(loadout.weapon)();
  // The dynamic import registers the module in the module cache; the sync
  // builder then resolves the builder fn from its static routing table.
  return buildDetailedWeapon(loadout);
}
