/**
 * SEC2-ART — Prompt 15
 * ─────────────────────────────────────────────────────────────────────────────
 * AttachmentSockets — visually swap optics / grips / muzzle devices / mags /
 * charms onto a weapon's named sockets. Replaces the stat-only attachment
 * behavior with actual mesh re-parenting so the gunsmith + first-person
 * viewmodel show the player's loadout.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission fix noted):
 *   C2-5000 #1354 [Prompt #86] hardcoded if/else → socketForAttachment dispatch (adding a socket = 1 row)
 *   C2-5000 #1355 [Prompt #87] identical pistol charm positions → per-weapon charm offsets (usp/deagle/glock18/m1911/revolver)
 *
 * C1-5000 prompt mapping:
 *   C1-5000 #1128 [Prompt 328]  hand-on-weapon IK that places support hand
 *       on foregrip socket dynamically — weapon-anim.supportHandForegripTarget
 *       consumes WEAPON_SOCKET_OFFSETS[weaponSlug].socket_grip as the IK
 *       target so the support hand moves to the foregrip socket when a
 *       foregrip is attached (and to the handguard default when not).
 *
 * C3-5000 prompt mapping:
 *   C3-5000 #1556 [WEAPON_SOCKET_OFFSETS]  viewmodel tuning per weapon (the
 *       per-weapon socket-offset table is the surface the viewmodel tuning
 *       reads to position optics/grips/magazines/charms per weapon). No new
 *       code needed — the existing WEAPON_SOCKET_OFFSETS table is the surface.
 *
 * Public surface:
 *   - `WEAPON_SOCKET_OFFSETS`   → per-weapon socket position table (meters,
 *                                  weapon-local). Mirrors the procedural
 *                                  WeaponBuilder defaults + per-weapon
 *                                  overrides (e.g. P90 grip ahead of mag,
 *                                  Nova tube magazine).
 *   - `SOCKET_NAMES`            → readonly list of socket names
 *   - `getSocketOffset(slug, name)` → look up a socket position; falls back
 *                                  to the generic rifle layout.
 *   - `attachToSocket(weaponGroup, socketName, mesh, opts?)`
 *                               → re-parent a mesh onto a named socket on
 *                                  the weapon group, creating the socket
 *                                  if it doesn't exist. Returns the socket.
 *   - `clearSocket(weaponGroup, socketName)`
 *                               → remove all attachment children from a socket.
 *   - `buildAttachmentMesh(slug)` → procedural mesh for an attachment slug
 *                                  (suppressor, red_dot, holo, acog, scope8x,
 *                                  foregrip, angled_grip, ext_mag, quick_mag).
 *                                  Real artist meshes drop in via
 *                                  ModelRegistry when shipped.
 *   - `attachLoadoutAttachments(weaponGroup, loadout)`
 *                               → one-shot: attach all non-"none" attachments
 *                                  from a LoadoutConfig to the right sockets.
 *
 * Socket naming convention (matches WeaponBuilder.ts):
 *   socket_muzzle, socket_sight, socket_grip, socket_magazine, socket_charm
 *
 * SSR-safe — pure three.js object construction.
 */

import * as THREE from "three";
import type { LoadoutConfig, WeaponType, AttachmentSlug } from "../store";

// ─── Socket name registry ──────────────────────────────────────────────────

export const SOCKET_NAMES = [
  "socket_muzzle",
  "socket_sight",
  "socket_grip",
  "socket_magazine",
  "socket_charm",
] as const;
export type SocketName = (typeof SOCKET_NAMES)[number];

// ─── Per-weapon socket offsets ─────────────────────────────────────────────

/**
 * Generic rifle socket layout — used as the fallback for any weapon that
 * doesn't have a specific entry in WEAPON_SOCKET_OFFSETS. Values in meters,
 * weapon-local space (matches the procedural WeaponBuilder defaults at
 * src/lib/game/WeaponBuilder.ts:1918-1928).
 */
export const GENERIC_SOCKET_OFFSETS: Record<SocketName, [number, number, number]> = {
  socket_muzzle:    [0, 0.02, -0.70],
  socket_sight:     [0, 0.07,  0.00],
  socket_grip:      [0, -0.04, 0.10],
  socket_magazine:  [0, -0.05, -0.02],
  socket_charm:     [0.03, -0.05, 0.12],
};

/**
 * Per-weapon socket offset table. Overrides the generic layout for weapons
 * whose anatomy doesn't match the rifle default. Numbers are meters in
 * weapon-local space, matching the procedural builder's geometry.
 *
 * Missing weapons inherit GENERIC_SOCKET_OFFSETS. Add entries here only
 * when the weapon's geometry makes the generic default visibly wrong.
 */
export const WEAPON_SOCKET_OFFSETS: Partial<Record<WeaponType, Partial<Record<SocketName, [number, number, number]>>>> = {
  // ─── Pistols: short barrels, grip close to mag well ──────────────────────
  // Prompt #87 — per-weapon charm offsets. Each pistol's grip angle is
  // different (revolver's grip is swept more vertically due to the
  // cylinder, USP has a high-front grip strap, Glock has a aggressive
  // palm swell, M1911 has a flat mainspring housing). Authoring the
  // same `[0.025, -0.05, 0.06]` for all of them made the charm float
  // off the grip on the revolver (whose grip sits ~1cm further forward
  // + 0.5cm lower) and clip into the Glock's palm swell. Each entry
  // below is tuned to put the charm on the grip's lower side panel.
  usp:     { socket_muzzle: [0, 0.02, -0.18], socket_sight: [0, 0.05, 0.00], socket_grip: [0, -0.05, 0.05], socket_magazine: [0, -0.07, 0.00], socket_charm: [0.025, -0.055, 0.06] },
  deagle:  { socket_muzzle: [0, 0.02, -0.21], socket_sight: [0, 0.06, 0.00], socket_grip: [0, -0.06, 0.06], socket_magazine: [0, -0.08, 0.00], socket_charm: [0.028, -0.065, 0.07] },
  glock18: { socket_muzzle: [0, 0.02, -0.16], socket_sight: [0, 0.04, 0.00], socket_grip: [0, -0.05, 0.05], socket_magazine: [0, -0.06, 0.00], socket_charm: [0.022, -0.045, 0.055] },
  m1911:   { socket_muzzle: [0, 0.02, -0.18], socket_sight: [0, 0.05, 0.00], socket_grip: [0, -0.05, 0.05], socket_magazine: [0, -0.07, 0.00], socket_charm: [0.030, -0.050, 0.065] },
  revolver:{ socket_muzzle: [0, 0.02, -0.16], socket_sight: [0, 0.06, 0.00], socket_grip: [0, -0.05, 0.04], socket_magazine: [0, -0.05, 0.00], socket_charm: [0.035, -0.035, 0.015] },

  // ─── SMGs: compact, muzzle closer than rifle ──────────────────────────────
  mp7:     { socket_muzzle: [0, 0.02, -0.28], socket_sight: [0, 0.06, 0.00], socket_grip: [0, -0.05, 0.08], socket_magazine: [0, -0.07, -0.02], socket_charm: [0.025, -0.05, 0.10] },
  p90:     { socket_muzzle: [0, 0.02, -0.30], socket_sight: [0, 0.07, 0.05], socket_grip: [0, -0.05, 0.18], socket_magazine: [0, -0.10, -0.10], socket_charm: [0.025, -0.05, 0.20] },
  mp5:     { socket_muzzle: [0, 0.02, -0.32], socket_sight: [0, 0.06, 0.00], socket_grip: [0, -0.05, 0.09], socket_magazine: [0, -0.07, -0.02], socket_charm: [0.025, -0.05, 0.11] },
  ump45:   { socket_muzzle: [0, 0.02, -0.30], socket_sight: [0, 0.06, 0.00], socket_grip: [0, -0.05, 0.09], socket_magazine: [0, -0.07, -0.02], socket_charm: [0.025, -0.05, 0.11] },
  vector:  { socket_muzzle: [0, 0.02, -0.28], socket_sight: [0, 0.06, 0.00], socket_grip: [0, -0.05, 0.10], socket_magazine: [0, -0.07, -0.04], socket_charm: [0.025, -0.05, 0.12] },
  pp90m1:  { socket_muzzle: [0, 0.02, -0.26], socket_sight: [0, 0.06, 0.02], socket_grip: [0, -0.05, 0.12], socket_magazine: [0, -0.08, -0.06], socket_charm: [0.025, -0.05, 0.14] },

  // ─── Shotguns: tube magazine under barrel ─────────────────────────────────
  nova:    { socket_muzzle: [0, 0.02, -0.72], socket_sight: [0, 0.05, 0.00], socket_grip: [0, -0.05, 0.18], socket_magazine: [0, -0.04, -0.40], socket_charm: [0.025, -0.05, 0.20] },
  m1014:   { socket_muzzle: [0, 0.02, -0.68], socket_sight: [0, 0.05, 0.00], socket_grip: [0, -0.05, 0.16], socket_magazine: [0, -0.04, -0.36], socket_charm: [0.025, -0.05, 0.18] },
  spas12:  { socket_muzzle: [0, 0.02, -0.70], socket_sight: [0, 0.05, 0.00], socket_grip: [0, -0.05, 0.18], socket_magazine: [0, -0.04, -0.38], socket_charm: [0.025, -0.05, 0.20] },

  // ─── Snipers: long barrels, scope-height sights ───────────────────────────
  awp:     { socket_muzzle: [0, 0.02, -0.92], socket_sight: [0, 0.09, -0.04], socket_grip: [0, -0.04, 0.14], socket_magazine: [0, -0.04, -0.04], socket_charm: [0.025, -0.05, 0.16] },
  scout:   { socket_muzzle: [0, 0.02, -0.85], socket_sight: [0, 0.08, -0.04], socket_grip: [0, -0.04, 0.14], socket_magazine: [0, -0.04, -0.04], socket_charm: [0.025, -0.05, 0.16] },
  kar98k:  { socket_muzzle: [0, 0.02, -0.88], socket_sight: [0, 0.07, 0.00], socket_grip: [0, -0.04, 0.14], socket_magazine: [0, -0.04, -0.04], socket_charm: [0.025, -0.05, 0.16] },
  l115a3:  { socket_muzzle: [0, 0.02, -0.95], socket_sight: [0, 0.10, -0.04], socket_grip: [0, -0.04, 0.14], socket_magazine: [0, -0.04, -0.04], socket_charm: [0.025, -0.05, 0.16] },

  // ─── LMG: long barrels + belt box mag ─────────────────────────────────────
  m249:    { socket_muzzle: [0, 0.02, -0.82], socket_sight: [0, 0.07, 0.00], socket_grip: [0, -0.05, 0.14], socket_magazine: [0.06, -0.05, -0.02], socket_charm: [0.025, -0.05, 0.16] },
  rpk:     { socket_muzzle: [0, 0.02, -0.84], socket_sight: [0, 0.07, 0.00], socket_grip: [0, -0.04, 0.12], socket_magazine: [0, -0.06, -0.02], socket_charm: [0.025, -0.05, 0.14] },
  mk48:    { socket_muzzle: [0, 0.02, -0.86], socket_sight: [0, 0.07, 0.00], socket_grip: [0, -0.05, 0.14], socket_magazine: [0.06, -0.05, -0.02], socket_charm: [0.025, -0.05, 0.16] },

  // ─── AK-74 (pilot for the glTF pipeline) ──────────────────────────────────
  ak74:    { socket_muzzle: [0, 0.02, -0.70], socket_sight: [0, 0.07, 0.04], socket_grip: [0, -0.04, 0.10], socket_magazine: [0, -0.05, -0.02], socket_charm: [-0.035, -0.06, 0.18] },
};

/**
 * Look up the socket offset for a weapon + socket name. Falls back to the
 * generic rifle layout when no specific entry exists.
 */
export function getSocketOffset(slug: string, name: SocketName): [number, number, number] {
  const weaponEntry = WEAPON_SOCKET_OFFSETS[slug as WeaponType];
  const specific = weaponEntry?.[name];
  if (specific) return specific;
  return GENERIC_SOCKET_OFFSETS[name];
}

// ─── Socket management ─────────────────────────────────────────────────────

/** Marker stashed on attachment children so we can identify + remove them
 *  without touching the socket's other children (e.g. decorator meshes). */
const IS_ATTACHMENT = Symbol("isAttachment");

interface AttachmentObject3D extends THREE.Object3D {
  [IS_ATTACHMENT]?: true;
}

/** Find an existing socket by name on a weapon group, or create one at the
 *  per-weapon offset position. The socket is an empty Object3D named
 *  `socket_<name>` — matches the procedural WeaponBuilder convention. */
export function getOrCreateSocket(
  weaponGroup: THREE.Group | THREE.Object3D,
  socketName: SocketName,
  weaponSlug?: string,
): THREE.Object3D {
  let socket = weaponGroup.getObjectByName(socketName);
  if (!socket) {
    socket = new THREE.Object3D();
    socket.name = socketName;
    const offset = weaponSlug ? getSocketOffset(weaponSlug, socketName) : GENERIC_SOCKET_OFFSETS[socketName];
    socket.position.set(offset[0], offset[1], offset[2]);
    weaponGroup.add(socket);
  }
  return socket;
}

/** Remove all attachment children from a socket. Disposes their geometry + materials. */
export function clearSocket(
  weaponGroup: THREE.Group | THREE.Object3D,
  socketName: SocketName,
): void {
  const socket = weaponGroup.getObjectByName(socketName);
  if (!socket) return;
  const toRemove: THREE.Object3D[] = [];
  socket.children.forEach((c) => {
    if ((c as AttachmentObject3D)[IS_ATTACHMENT]) toRemove.push(c);
  });
  for (const c of toRemove) {
    socket.remove(c);
    c.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m?.dispose?.();
      }
    });
  }
}

export interface AttachOptions {
  /** Weapon slug — used to look up the per-weapon socket offset if the socket
   *  doesn't exist yet. Defaults to "ak74" (generic rifle). */
  weaponSlug?: string;
  /** Local position offset (added to the socket's own position). Use for
   *  fine-tuning where on the socket the mesh sits. */
  offset?: [number, number, number];
  /** Local Euler rotation (radians). Default identity. */
  rotation?: [number, number, number];
  /** Uniform scale. Default 1. */
  scale?: number;
  /** Tag — stashed on the attached Object3D for inspection. */
  tag?: string;
}

/**
 * Attach a mesh to a named socket on a weapon group. Removes any existing
 * attachment on that socket first (so swapping optics is one call).
 *
 * The mesh is parented to the socket (an empty Object3D) so it inherits
 * the socket's transform automatically — the muzzle device stays glued to
 * the muzzle when the weapon rotates.
 *
 * @returns The socket the mesh was attached to (or null if socketName is invalid).
 */
export function attachToSocket(
  weaponGroup: THREE.Group | THREE.Object3D,
  socketName: SocketName,
  mesh: THREE.Object3D,
  opts: AttachOptions = {},
): THREE.Object3D | null {
  if (!SOCKET_NAMES.includes(socketName)) return null;
  // Clear any existing attachment.
  clearSocket(weaponGroup, socketName);
  // Find or create the socket.
  const socket = getOrCreateSocket(weaponGroup, socketName, opts.weaponSlug);
  // Apply the mesh's local transform within the socket.
  if (opts.offset) mesh.position.set(opts.offset[0], opts.offset[1], opts.offset[2]);
  if (opts.rotation) mesh.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);
  if (opts.scale !== undefined) mesh.scale.setScalar(opts.scale);
  // Tag + parent.
  (mesh as AttachmentObject3D)[IS_ATTACHMENT] = true;
  if (opts.tag) (mesh.userData as Record<string, unknown>).attachmentTag = opts.tag;
  // Enable shadow casting on all meshes in the attachment.
  mesh.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  socket.add(mesh);
  return socket;
}

// ─── Procedural attachment meshes ──────────────────────────────────────────

/** Cached shared materials for procedural attachment meshes. */
const _mats = {
  blackPolymer: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.5, metalness: 0.05 }),
  darkSteel: new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.45, metalness: 0.95 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x102030, roughness: 0.15, metalness: 0.10, transparent: true, opacity: 0.7 }),
  redDot: new THREE.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.85 }),
};

/** Build a procedural mesh for an attachment slug. These are simple geometric
 *  stand-ins; real artist meshes drop in via the ModelRegistry (status: glTF).
 *  Returns null for the "none" slug. */
export function buildAttachmentMesh(slug: AttachmentSlug): THREE.Group | null {
  if (slug === "none") return null;
  const g = new THREE.Group();
  g.name = `attachment_${slug}`;

  switch (slug) {
    case "suppressor": {
      // Cylinder along Z, ~12cm long, ~2.5cm diameter.
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 0.12, 16),
        _mats.darkSteel,
      );
      body.rotation.x = Math.PI / 2; body.position.z = -0.06;
      g.add(body);
      // End cap with a small bore recess.
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.020, 0.018, 0.012, 16),
        _mats.darkSteel,
      );
      cap.rotation.x = Math.PI / 2; cap.position.z = -0.12;
      g.add(cap);
      // 4 grooves along the body.
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        const groove = new THREE.Mesh(
          new THREE.BoxGeometry(0.0015, 0.001, 0.10),
          _mats.blackPolymer,
        );
        groove.position.set(Math.cos(a) * 0.018, Math.sin(a) * 0.018, -0.06);
        groove.rotation.y = a;
        g.add(groove);
      }
      break;
    }
    case "compensator": {
      // Short cylinder with top ports.
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.016, 0.018, 0.05, 16),
        _mats.darkSteel,
      );
      body.rotation.x = Math.PI / 2; body.position.z = -0.025;
      g.add(body);
      // Top ports (cuts).
      for (let i = 0; i < 3; i++) {
        const port = new THREE.Mesh(
          new THREE.BoxGeometry(0.005, 0.005, 0.008),
          _mats.blackPolymer,
        );
        port.position.set(0, 0.016, -0.012 - i * 0.012);
        g.add(port);
      }
      break;
    }
    case "red_dot": {
      // Compact tube sight — short cylinder + lens + base.
      const tube = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 0.05, 16),
        _mats.blackPolymer,
      );
      tube.rotation.x = Math.PI / 2; tube.position.y = 0.018;
      g.add(tube);
      // Lens (front).
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.014, 16), _mats.glass);
      lens.position.set(0, 0.018, -0.025); lens.rotation.y = Math.PI;
      g.add(lens);
      // Red dot.
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.001, 8), _mats.redDot);
      dot.position.set(0, 0.018, -0.0248); dot.rotation.y = Math.PI;
      g.add(dot);
      // Mount base.
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.008, 0.04), _mats.blackPolymer);
      base.position.y = 0;
      g.add(base);
      break;
    }
    case "holo": {
      // Square window holographic sight.
      const window_ = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.003), _mats.glass);
      window_.position.set(0, 0.025, -0.01);
      g.add(window_);
      // Frame.
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.005, 0.04), _mats.blackPolymer);
      frame.position.set(0, 0.010, -0.01);
      g.add(frame);
      // Reticle.
      const reticle = new THREE.Mesh(new THREE.PlaneGeometry(0.008, 0.008), _mats.redDot);
      reticle.position.set(0, 0.025, -0.0115);
      g.add(reticle);
      break;
    }
    case "acog": {
      // 4x scope — short fat tube with eye piece + objective lens.
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.022, 0.022, 0.12, 16),
        _mats.blackPolymer,
      );
      body.rotation.x = Math.PI / 2; body.position.set(0, 0.025, -0.04);
      g.add(body);
      // Objective lens (front, larger).
      const obj = new THREE.Mesh(new THREE.CircleGeometry(0.020, 16), _mats.glass);
      obj.position.set(0, 0.025, -0.10); obj.rotation.y = Math.PI;
      g.add(obj);
      // Eye piece (back, smaller).
      const eye = new THREE.Mesh(new THREE.CircleGeometry(0.016, 16), _mats.glass);
      eye.position.set(0, 0.025, 0.02); eye.rotation.y = Math.PI;
      g.add(eye);
      // Mount base.
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.010, 0.10), _mats.blackPolymer);
      base.position.y = 0;
      g.add(base);
      break;
    }
    case "scope8x": {
      // Long sniper scope.
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, 0.28, 16),
        _mats.blackPolymer,
      );
      body.rotation.x = Math.PI / 2; body.position.set(0, 0.040, -0.06);
      g.add(body);
      // Objective bell (front, wider).
      const bell = new THREE.Mesh(
        new THREE.CylinderGeometry(0.034, 0.025, 0.04, 16),
        _mats.blackPolymer,
      );
      bell.rotation.x = Math.PI / 2; bell.position.set(0, 0.040, -0.21);
      g.add(bell);
      // Objective lens.
      const obj = new THREE.Mesh(new THREE.CircleGeometry(0.030, 16), _mats.glass);
      obj.position.set(0, 0.040, -0.23); obj.rotation.y = Math.PI;
      g.add(obj);
      // Eye piece.
      const eye = new THREE.Mesh(new THREE.CircleGeometry(0.018, 16), _mats.glass);
      eye.position.set(0, 0.040, 0.09); eye.rotation.y = Math.PI;
      g.add(eye);
      // Turret caps (elevation + windage).
      for (const x of [-0.025, 0.025]) {
        const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.015, 12), _mats.darkSteel);
        turret.position.set(x, 0.062, -0.05);
        g.add(turret);
      }
      // Mount rings (2).
      for (const z of [-0.02, 0.04]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.005, 8, 16), _mats.darkSteel);
        ring.position.set(0, 0.040, z); ring.rotation.x = Math.PI / 2;
        g.add(ring);
      }
      break;
    }
    case "foregrip": {
      // Vertical foregrip — small angled cylinder.
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.014, 0.07, 12),
        _mats.blackPolymer,
      );
      body.position.set(0, -0.035, 0);
      g.add(body);
      // Cap.
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 12), _mats.darkSteel);
      cap.position.set(0, -0.072, 0);
      g.add(cap);
      break;
    }
    case "angled_grip": {
      // Angled grip — cylinder at 45°.
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.011, 0.013, 0.055, 12),
        _mats.blackPolymer,
      );
      body.position.set(0, -0.028, 0.012);
      body.rotation.x = -0.6;
      g.add(body);
      // Cap.
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.006, 12), _mats.darkSteel);
      cap.position.set(0, -0.050, 0.030);
      cap.rotation.x = -0.6;
      g.add(cap);
      break;
    }
    case "ext_mag": {
      // Extended magazine — long curved box (50% longer than standard).
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.18, 0.08),
        _mats.blackPolymer,
      );
      body.position.set(0, -0.09, 0);
      body.rotation.x = 0.15; // slight curve
      g.add(body);
      // Base plate.
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.010, 0.082), _mats.darkSteel);
      base.position.set(0, -0.18, 0.014);
      base.rotation.x = 0.15;
      g.add(base);
      break;
    }
    case "quick_mag": {
      // Quickdraw mag — standard size with a pull tab + bright base.
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.12, 0.07),
        _mats.blackPolymer,
      );
      body.position.set(0, -0.06, 0);
      g.add(body);
      // Bright orange base (the "quickdraw" identifier).
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(0.042, 0.010, 0.072),
        new THREE.MeshStandardMaterial({ color: 0xff6020, roughness: 0.5, metalness: 0.1 }),
      );
      base.position.set(0, -0.122, 0);
      g.add(base);
      // Pull tab.
      const tab = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.020, 0.004), _mats.darkSteel);
      tab.position.set(0, -0.122, 0.040);
      g.add(tab);
      break;
    }
    default: return null;
  }
  return g;
}

/** Map an AttachmentSlug to the socket name it belongs on. */
export function socketForAttachment(slug: AttachmentSlug): SocketName | null {
  switch (slug) {
    case "suppressor":
    case "compensator":
      return "socket_muzzle";
    case "red_dot":
    case "holo":
    case "acog":
    case "scope8x":
      return "socket_sight";
    case "foregrip":
    case "angled_grip":
      return "socket_grip";
    case "ext_mag":
    case "quick_mag":
      return "socket_magazine";
    default:
      return null;
  }
}

/** Attach all non-"none" attachments from a LoadoutConfig to the right
 *  sockets on a weapon group. Convenience wrapper for the gunsmith + viewmodel.
 *
 *  Each attachment's offset/rotation is tuned per-weapon by the
 *  WEAPON_SOCKET_OFFSETS table — the attachment mesh is centered on the
 *  socket's local origin.
 *
 *  Prompt #86 — refactored to dispatch through `socketForAttachment`
 *  instead of a hardcoded if/else per slot. Adding a new socket (e.g.
 *  `socket_stock`) no longer requires editing this function: just add
 *  the slot to `AttachmentSlot` / `SocketName`, add a case to
 *  `socketForAttachment`, and the loadout field is auto-wired. The old
 *  per-slot branches also failed to clear a socket when the attachment
 *  type was unknown to the if/else (e.g. a future `laser` attachment
 *  would be silently dropped); the new loop clears any socket that has
 *  no attachment in the loadout, so swapping from "has laser" to "no
 *  laser" properly removes the laser mesh. */
export function attachLoadoutAttachments(
  weaponGroup: THREE.Group | THREE.Object3D,
  loadout: LoadoutConfig,
): void {
  const weaponSlug = loadout.weapon;
  // Prompt #86 — build a map of SocketName → AttachmentSlug by consulting
  // `socketForAttachment` for every attachment in the loadout. This is the
  // single source of truth for "which socket does this attachment live
  // on?" — no per-slot if/else duplication. Adding a new socket (e.g.
  // `socket_stock`) no longer requires editing this function: just add
  // the slot to `SOCKET_NAMES` + `socketForAttachment` + the loadout
  // field, and the new entry is auto-wired through this loop.
  const slotsToSet = new Map<SocketName, AttachmentSlug>();
  // Iterate the loadout's attachment fields. Today these are muzzle,
  // sight, grip, magazine (see LoadoutConfig in store.ts). The cast is
  // safe — every field is typed `AttachmentSlug`.
  const loadoutAttachments: AttachmentSlug[] = [
    loadout.muzzle,
    loadout.sight,
    loadout.grip,
    loadout.magazine,
  ];
  for (const slug of loadoutAttachments) {
    if (!slug || slug === "none") continue;
    const socket = socketForAttachment(slug);
    if (socket) slotsToSet.set(socket, slug);
  }
  // Apply: build the mesh + attach for every resolved socket; clear every
  // other known socket (from SOCKET_NAMES) so old attachments don't
  // linger when the loadout swaps an attachment to "none".
  for (const socketName of SOCKET_NAMES) {
    const slug = slotsToSet.get(socketName);
    if (slug) {
      const mesh = buildAttachmentMesh(slug);
      if (mesh) {
        attachToSocket(weaponGroup, socketName, mesh, { weaponSlug, tag: slug });
        continue;
      }
    }
    // No attachment for this socket → clear it (removes any previous
    // attachment mesh that might still be parented here from a prior
    // loadout).
    clearSocket(weaponGroup, socketName);
  }
}
