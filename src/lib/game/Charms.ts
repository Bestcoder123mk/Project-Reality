import * as THREE from "three";
import type { Rarity } from "./store";

/**
 * Charms — cosmetic weapon charms that hang from the `socket_charm` socket
 * on the weapon's receiver. Each charm builder returns a small THREE.Group
 * (~2-3cm scale) with detailed geometry + materials.
 *
 * `attachCharm(weaponGroup, slug)` parents the charm to the socket_charm
 * node (creating one if missing — anchored just below the magazine well on
 * the left side of the receiver, where real-weapon charms typically hang).
 *
 * Task-10 — the SHARK charm is specifically requested. It's a chunky
 * cartoon shark ~3cm long, sculpted from box + cone + cone primitives
 * with a tail fin + dorsal fin + teeth. The most ridiculous charm in the
 * set.
 */

export type CharmSlug =
  | "none"
  | "dice_charm"
  | "skull_charm"
  | "feather_charm"
  | "dogtag_charm"
  | "shark_charm"
  | "lightning_charm"
  | "flame_charm";

export interface CharmConfig {
  slug: CharmSlug;
  name: string;
  desc: string;
  /** Builder — returns a small THREE.Group ready to parent to the socket. */
  build: () => THREE.Group;
  rarity: Rarity;
  price: number;
}

// ─── Shared material helpers ─────────────────────────────────

function metal(color: number, rough = 0.35, metal = 0.95): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}
function polymer(color: number, rough = 0.5): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 });
}
function glow(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false });
}

// ─── Charm builders ──────────────────────────────────────────

/** Dice — a 6mm cube with pips on each face, hanging from a small ring. */
function buildDice(): THREE.Group {
  const g = new THREE.Group();
  // Hanging ring (small torus).
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.005, 0.0015, 8, 16), metal(0xc0a060));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.012;
  g.add(ring);
  // Link chain (3 tiny segments).
  for (let i = 0; i < 3; i++) {
    const link = new THREE.Mesh(new THREE.TorusGeometry(0.0025, 0.0008, 6, 12), metal(0xc0a060));
    link.position.y = 0.009 - i * 0.004;
    link.rotation.x = i % 2 === 0 ? Math.PI / 2 : 0;
    g.add(link);
  }
  // Die cube.
  const die = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.012), polymer(0xf4f4ec, 0.3));
  die.position.y = -0.002;
  die.castShadow = true;
  g.add(die);
  // Pip dots (one face — 5 pips for the iconic "5" face).
  const pipMat = polymer(0x101010, 0.4);
  const pipGeo = new THREE.CircleGeometry(0.0012, 8);
  const pipPositions = [[-0.0025, 0.0025], [0.0025, 0.0025], [0, 0], [-0.0025, -0.0025], [0.0025, -0.0025]];
  pipPositions.forEach(([x, y]) => {
    const pip = new THREE.Mesh(pipGeo, pipMat);
    pip.position.set(x, y, 0.0061);
    die.add(pip);
  });
  return g;
}

/** Skull — tiny skull ~8mm wide. Cartoonish, hanging from a chain. */
function buildSkull(): THREE.Group {
  const g = new THREE.Group();
  // Chain.
  for (let i = 0; i < 4; i++) {
    const link = new THREE.Mesh(new THREE.TorusGeometry(0.0025, 0.0008, 6, 12), metal(0x8a8a8a, 0.5, 0.85));
    link.position.y = 0.014 - i * 0.004;
    link.rotation.x = i % 2 === 0 ? Math.PI / 2 : 0;
    g.add(link);
  }
  // Skull dome.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 12, 0, Math.PI * 2, 0, Math.PI / 1.7), polymer(0xeae6dc, 0.45));
  dome.position.y = 0;
  dome.castShadow = true;
  g.add(dome);
  // Jaw — slightly smaller box below.
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.003, 0.006), polymer(0xeae6dc, 0.45));
  jaw.position.y = -0.004;
  g.add(jaw);
  // Eye sockets — dark spheres inset.
  const socketMat = polymer(0x0a0a0a, 0.9);
  for (const sx of [-0.0022, 0.0022]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0018, 10, 8), socketMat);
    eye.position.set(sx, 0.001, 0.0048);
    g.add(eye);
  }
  // Nose — small dark cone.
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.0008, 0.0018, 6), socketMat);
  nose.position.set(0, -0.002, 0.0055);
  nose.rotation.x = Math.PI;
  g.add(nose);
  return g;
}

/** Feather — slim feather with a central rachis + curved barb vanes. */
function buildFeather(): THREE.Group {
  const g = new THREE.Group();
  // Top loop.
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.004, 0.0008, 6, 16), metal(0xb09040, 0.4, 0.9));
  loop.position.y = 0.014;
  g.add(loop);
  // Central rachis (thin cylinder).
  const rachis = new THREE.Mesh(new THREE.CylinderGeometry(0.0006, 0.0004, 0.022, 8), polymer(0x9a8050, 0.5));
  rachis.position.y = 0.003;
  g.add(rachis);
  // Vanes — two flattened ellipses (cone segments) on either side of the rachis.
  const vaneMat = new THREE.MeshStandardMaterial({ color: 0xc84030, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const vane = new THREE.Mesh(new THREE.SphereGeometry(0.005, 12, 8), vaneMat);
    vane.scale.set(0.5, 1.6, 0.15);
    vane.position.set(side * 0.0022, -0.002, 0);
    g.add(vane);
  }
  // Tip.
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.001, 0.003, 6), vaneMat);
  tip.position.y = -0.011;
  tip.rotation.x = Math.PI;
  g.add(tip);
  return g;
}

/** Dog tag — stamped metal tag on a beaded chain. */
function buildDogtag(): THREE.Group {
  const g = new THREE.Group();
  // Beaded chain — 6 small spheres.
  const chainMat = metal(0x9a9a9a, 0.4, 0.85);
  for (let i = 0; i < 6; i++) {
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0012, 8, 6), chainMat);
    bead.position.set(Math.sin(i * 0.7) * 0.002, 0.014 - i * 0.0028, 0);
    g.add(bead);
  }
  // Tag — rounded rectangle (squashed box).
  const tag = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.009, 0.0015), metal(0xb0a878, 0.4, 0.85));
  tag.position.y = -0.003;
  tag.castShadow = true;
  g.add(tag);
  // Stamp lines — slightly darker thin boxes on the tag face (engraved text).
  const stampMat = metal(0x605030, 0.5, 0.9);
  for (let i = 0; i < 3; i++) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.0006, 0.0003), stampMat);
    line.position.set(0, -0.001 - i * 0.002, 0.0009);
    g.add(line);
  }
  // Hole at top of tag.
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.001, 0.001, 0.002, 8), polymer(0x101010));
  hole.rotation.x = Math.PI / 2;
  hole.position.y = 0.0035;
  g.add(hole);
  return g;
}

/** SHARK — the user-requested charm. A chunky cartoon great-white ~3cm long
 *  with a tail fin, dorsal fin, pectoral fins, and visible teeth. The most
 *  ridiculous charm in the set. */
function buildShark(): THREE.Group {
  const g = new THREE.Group();
  // Chain at top.
  for (let i = 0; i < 3; i++) {
    const link = new THREE.Mesh(new THREE.TorusGeometry(0.0025, 0.0008, 6, 12), metal(0x9a9a9a, 0.4, 0.85));
    link.position.y = 0.014 - i * 0.004;
    link.rotation.x = i % 2 === 0 ? Math.PI / 2 : 0;
    g.add(link);
  }
  // Body — elongated ellipsoid, oriented so the shark's nose points -Z
  // (forward along the weapon). Steely grey-blue.
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a6a82, roughness: 0.38, metalness: 0.2 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.006, 16, 12), bodyMat);
  body.scale.set(0.7, 0.7, 2.4);
  body.position.y = 0;
  body.castShadow = true;
  g.add(body);
  // Belly — lighter underside (slightly smaller ellipsoid offset down).
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.005, 14, 10), new THREE.MeshStandardMaterial({ color: 0xd0d8de, roughness: 0.4, metalness: 0.1 }));
  belly.scale.set(0.65, 0.5, 2.2);
  belly.position.set(0, -0.002, 0);
  g.add(belly);
  // Dorsal fin — triangular prism on top.
  const dorsalGeo = new THREE.ConeGeometry(0.003, 0.005, 4);
  const dorsal = new THREE.Mesh(dorsalGeo, bodyMat);
  dorsal.position.set(0, 0.0055, 0);
  dorsal.rotation.y = Math.PI / 4;
  dorsal.scale.set(0.7, 1, 1);
  g.add(dorsal);
  // Tail fin — flat cone at the back (+Z), rotated.
  const tailMat = bodyMat;
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.006, 4), tailMat);
  tail.position.set(0, 0.002, 0.014);
  tail.rotation.x = Math.PI / 2;
  tail.rotation.y = Math.PI / 4;
  tail.scale.set(0.8, 1, 0.25);
  g.add(tail);
  // Pectoral fins — two flattened cones on either side.
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.0025, 0.005, 4), tailMat);
    fin.position.set(side * 0.0045, -0.002, -0.002);
    fin.rotation.z = side * Math.PI / 2.5;
    fin.rotation.x = -Math.PI / 4;
    fin.scale.set(0.6, 1, 0.4);
    g.add(fin);
  }
  // Eyes — small dark spheres near the nose.
  const eyeMat = polymer(0x080808, 0.3);
  for (const sx of [-0.0028, 0.0028]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0007, 8, 6), eyeMat);
    eye.position.set(sx, 0.0012, -0.010);
    g.add(eye);
  }
  // Mouth — dark slit + tiny teeth (alternating white triangles).
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.0006, 0.003), polymer(0x0a0a0a, 0.9));
  mouth.position.set(0, -0.0018, -0.0125);
  g.add(mouth);
  const toothMat = polymer(0xf6f6ec, 0.3);
  for (let i = 0; i < 5; i++) {
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.0003, 0.0008, 4), toothMat);
    tooth.position.set(-0.0016 + i * 0.0008, -0.0018, -0.0138);
    tooth.rotation.x = Math.PI;
    g.add(tooth);
  }
  // Slight downward tilt so the shark "hangs" naturally.
  g.rotation.x = -0.15;
  return g;
}

/** Lightning — a glowing yellow lightning bolt with a chain. */
function buildLightning(): THREE.Group {
  const g = new THREE.Group();
  // Chain.
  for (let i = 0; i < 3; i++) {
    const link = new THREE.Mesh(new THREE.TorusGeometry(0.0025, 0.0008, 6, 12), metal(0xc0c0a0, 0.4, 0.9));
    link.position.y = 0.014 - i * 0.004;
    link.rotation.x = i % 2 === 0 ? Math.PI / 2 : 0;
    g.add(link);
  }
  // Bolt — flattened box stack in a zig-zag (3 segments).
  const boltMat = new THREE.MeshStandardMaterial({
    color: 0xffd840, emissive: 0xffa818, emissiveIntensity: 0.8, roughness: 0.35, metalness: 0.3,
  });
  const segGeo = new THREE.BoxGeometry(0.0035, 0.005, 0.0012);
  const s1 = new THREE.Mesh(segGeo, boltMat); s1.position.set(0, 0.003, 0); s1.rotation.z = 0.4; g.add(s1);
  const s2 = new THREE.Mesh(segGeo, boltMat); s2.position.set(0.0015, -0.002, 0); s2.rotation.z = -0.4; g.add(s2);
  const s3 = new THREE.Mesh(segGeo, boltMat); s3.position.set(-0.0005, -0.007, 0); s3.rotation.z = 0.4; g.add(s3);
  // Inner additive glow core.
  const glowBolt = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.014, 0.0008), glow(0xfff080));
  glowBolt.position.y = -0.002;
  g.add(glowBolt);
  return g;
}

/** Flame — a stylized teardrop flame, glowing orange→red, with a chain. */
function buildFlame(): THREE.Group {
  const g = new THREE.Group();
  // Chain.
  for (let i = 0; i < 3; i++) {
    const link = new THREE.Mesh(new THREE.TorusGeometry(0.0025, 0.0008, 6, 12), metal(0x9a8050, 0.4, 0.9));
    link.position.y = 0.014 - i * 0.004;
    link.rotation.x = i % 2 === 0 ? Math.PI / 2 : 0;
    g.add(link);
  }
  // Outer flame — tall teardrop (cone + sphere base).
  const outerMat = new THREE.MeshStandardMaterial({
    color: 0xff4018, emissive: 0xff2010, emissiveIntensity: 0.7, roughness: 0.35, metalness: 0.1,
  });
  const outer = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.012, 12), outerMat);
  outer.position.y = 0;
  outer.castShadow = true;
  g.add(outer);
  // Inner flame — smaller yellow core.
  const innerMat = new THREE.MeshStandardMaterial({
    color: 0xffe040, emissive: 0xffc020, emissiveIntensity: 0.9, roughness: 0.3,
  });
  const inner = new THREE.Mesh(new THREE.ConeGeometry(0.0022, 0.008, 10), innerMat);
  inner.position.y = 0.001;
  g.add(inner);
  // Base sphere (rounded bottom).
  const base = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 12, 8), outerMat);
  base.position.y = -0.004;
  g.add(base);
  // Tip glow point.
  const tipGlow = new THREE.Mesh(new THREE.SphereGeometry(0.0008, 8, 6), glow(0xffff80));
  tipGlow.position.y = 0.006;
  g.add(tipGlow);
  return g;
}

// ─── Catalog ─────────────────────────────────────────────────

export const CHARMS: Record<CharmSlug, CharmConfig | null> = {
  none: null,
  dice_charm: {
    slug: "dice_charm", name: "Lucky Dice", desc: "Polyhedral pal. Hangs from the mag well.",
    build: buildDice, rarity: "COMMON", price: 600,
  },
  skull_charm: {
    slug: "skull_charm", name: "Skull Charm", desc: "Memento mori. For when things get personal.",
    build: buildSkull, rarity: "RARE", price: 1100,
  },
  feather_charm: {
    slug: "feather_charm", name: "Crimson Feather", desc: "A raven's gift. Whispers in the wind.",
    build: buildFeather, rarity: "RARE", price: 1100,
  },
  dogtag_charm: {
    slug: "dogtag_charm", name: "Dog Tags", desc: "Standard issue. Never forget the fallen.",
    build: buildDogtag, rarity: "COMMON", price: 500,
  },
  shark_charm: {
    slug: "shark_charm", name: "Shark", desc: "A cartoon great-white. Smells blood in the water.",
    build: buildShark, rarity: "LEGENDARY", price: 3200,
  },
  lightning_charm: {
    slug: "lightning_charm", name: "Lightning Bolt", desc: "Charged with storm-light. Crackles in the dark.",
    build: buildLightning, rarity: "EPIC", price: 1800,
  },
  flame_charm: {
    slug: "flame_charm", name: "Eternal Flame", desc: "Burns without fuel. Lights the way to victory.",
    build: buildFlame, rarity: "EPIC", price: 1800,
  },
};

// ─── Socket + attach ─────────────────────────────────────────

const SOCKET_NAME = "socket_charm";
/** Default socket offset — below the magazine well, left of center (typical
 *  real-weapon charm anchor point). Weapon model space (meters). */
const DEFAULT_SOCKET_POS = new THREE.Vector3(-0.035, -0.06, 0.18);

// B2-5000 #781 — canonical charm-instance pool. One built instance per slug,
// lazily created on first equip. Subsequent equips clone the hierarchy
// (shallow on geo+mat) so the per-equip alloc cost drops from O(geo+mat
// build) to O(mesh-count). The pool survives for the page lifetime.
const _charmPool = new Map<CharmSlug, THREE.Group>();

/** Find or create the charm socket on the weapon group. The socket is a
 *  named empty Object3D so charms can be parented/removed cleanly. */
export function getOrCreateCharmSocket(weaponGroup: THREE.Group): THREE.Object3D {
  let socket = weaponGroup.getObjectByName(SOCKET_NAME);
  if (!socket) {
    socket = new THREE.Object3D();
    socket.name = SOCKET_NAME;
    socket.position.copy(DEFAULT_SOCKET_POS);
    weaponGroup.add(socket);
  }
  return socket;
}

/** Attach a charm to the weapon's socket_charm node. Removes any existing
 *  charm first. Pass "none" to clear. Returns the charm group (or null
 *  if cleared).
 *
 *  B2-5000 #781 — POOLED: the previous code called `cfg.build()` on every
 *  equip, allocating fresh geometry + materials each time (then disposed
 *  them on unequip — churn). Now we build ONE canonical instance per slug
 *  (lazily, on first equip) + clone its hierarchy on subsequent equips.
 *  `THREE.Object3D.clone()` shares geometry + material references (the clone
 *  is shallow on those), so the second+ equip is a cheap Group+Mesh
 *  allocation, not a fresh geometry+material build. The originals stay
 *  alive in the pool for the lifetime of the page (single shared set per
 *  slug). The `dispose()` calls in the toRemove loop are now no-ops on the
 *  pooled references (the clones share the originals' geo+mat, so disposing
 *  them would break the pool — guarded by `userData.__pooled` below). */
export function attachCharm(
  weaponGroup: THREE.Group,
  charmSlug: CharmSlug,
): THREE.Group | null {
  const socket = getOrCreateCharmSocket(weaponGroup);
  // Remove existing charm children (any child whose userData.isCharm === true).
  const toRemove: THREE.Object3D[] = [];
  socket.children.forEach((c) => {
    if ((c.userData as any).isCharm === true) toRemove.push(c);
  });
  toRemove.forEach((c) => {
    socket.remove(c);
    // B2-5000 #781 — only dispose non-pooled clones (clones share pooled
    // geo+mat references; disposing them would corrupt the pool).
    if (!(c.userData as any).__pooled) {
      c.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m.dispose();
        }
      });
    }
  });
  if (charmSlug === "none") return null;
  const cfg = CHARMS[charmSlug];
  if (!cfg) return null;
  // B2-5000 #781 — pool the canonical instance per slug; clone on subsequent
  // equips. The clone shares the original's geometry + material references
  // (shallow clone), so the second+ equip is O(Mesh-count) alloc, not
  // O(geo+mat build).
  let canonical = _charmPool.get(charmSlug);
  if (!canonical) {
    canonical = cfg.build();
    _charmPool.set(charmSlug, canonical);
  }
  const charm = canonical.clone(true);
  (charm.userData as any).isCharm = true;
  (charm.userData as any).charmSlug = charmSlug;
  (charm.userData as any).__pooled = true; // mark so dispose() skips geo+mat
  // Enable shadows on all charm meshes.
  charm.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
    }
  });
  socket.add(charm);
  return charm;
}

// ─── Dangle physics (Prompt 233 — "charms render + dangle physically") ───────

/**
 * Charm dangle physics state. The charm swings as a pendulum from its socket
 * in response to weapon motion (acceleration + recoil kick). Damped spring
 * back to rest so it settles after motion stops.
 */
export interface CharmDangleState {
  /** Current swing angle (radians) — X axis = forward/back, Y axis = left/right. */
  angleX: number;
  angleY: number;
  /** Angular velocity (rad/s) for each axis. */
  velX: number;
  velY: number;
}

export function createCharmDangleState(): CharmDangleState {
  return { angleX: 0, angleY: 0, velX: 0, velY: 0 };
}

/**
 * Section B #233 — update the charm's dangle physics. The charm is modeled as
 * a damped pendulum driven by the weapon's linear acceleration. Recoil adds
 * an impulse to the swing (the charm whips back when the gun fires).
 *
 * @param state The dangle state (mutated in place).
 * @param dt Delta time (seconds).
 * @param weaponAccel Weapon linear acceleration in viewmodel-local space
 *   [right, up, forward] (m/s²). Gravity is folded in internally.
 * @param recoilKick Optional recoil impulse (radians) — the charm whips back
 *   on each shot. Default 0.
 * @param stiffness Spring stiffness (default 25 — snappy but not stiff).
 * @param damping Damping coefficient (default 4 — settles in ~0.5s).
 */
export function updateCharmDangle(
  state: CharmDangleState,
  dt: number,
  weaponAccel: [number, number, number],
  recoilKick: number = 0,
  stiffness: number = 25,
  damping: number = 4,
): void {
  if (dt <= 0) return;
  // Drive the swing from the weapon's lateral + forward acceleration (the
  // charm hangs down; lateral accel swings it sideways, forward accel swings
  // it back, gravity returns it to rest).
  const driveX = -(weaponAccel[2] ?? 0) * 0.05; // forward accel → swing back
  const driveY =  (weaponAccel[0] ?? 0) * 0.05; // right accel → swing right
  // Spring force toward rest + damping + drive.
  const fx = -stiffness * state.angleX - damping * state.velX + driveX;
  const fy = -stiffness * state.angleY - damping * state.velY + driveY;
  state.velX += fx * dt;
  state.velY += fy * dt;
  // Recoil impulse — directly adds to backward velocity.
  if (recoilKick !== 0) state.velX += recoilKick;
  state.angleX += state.velX * dt;
  state.angleY += state.velY * dt;
  // Clamp the swing so the charm doesn't wrap around (±60°).
  const maxAngle = Math.PI / 3;
  if (state.angleX >  maxAngle) { state.angleX =  maxAngle; state.velX = 0; }
  if (state.angleX < -maxAngle) { state.angleX = -maxAngle; state.velX = 0; }
  if (state.angleY >  maxAngle) { state.angleY =  maxAngle; state.velY = 0; }
  if (state.angleY < -maxAngle) { state.angleY = -maxAngle; state.velY = 0; }
}

/**
 * Section B #233 — apply the dangle state to the charm group's rotation.
 * Call this after `updateCharmDangle` to render the swing.
 */
export function applyCharmDangle(charmGroup: THREE.Object3D, state: CharmDangleState): void {
  charmGroup.rotation.x = state.angleX;
  charmGroup.rotation.y = state.angleY;
}

/** True if the player owns the charm. */
export function isCharmOwned(ownedCharms: CharmSlug[], slug: CharmSlug): boolean {
  return slug === "none" || ownedCharms.includes(slug);
}

// ─── I-5000 prompt mapping ─────────────────────────────────────────────
// 3873 (per-equip allocation / pooled) — NEW: `CharmAllocationPool` + `allocateCharmToWeapon` below.
// 3874 (charm physics / swing)        — DONE: `CharmDangleState` + `updateCharmDangle` + `applyCharmDangle` above (Section B #233).
// 3871 (ownedCharms persisted)        — DEFERRED: schema change (PlayerInventory.ownedCharms not in schema — see A-55).
// 3872 (PlayerLoadout.charmSlug not in schema) — DEFERRED: schema change (A-56).

/**
 * I-5000 #3873 / A-57 — Per-equip allocation (pooled).
 *
 * The prior model was "one charm per weapon, owned outright". The pooled
 * model: the player owns a SET of charms (the inventory), and can equip
 * a charm to multiple weapons simultaneously — but each charm instance
 * is a "slot" in a pool. The pool size grows with the player's level
 * (so high-level players can equip more charms across their arsenal).
 *
 * `CharmAllocationPool` tracks which (weaponSlug, charmSlug) pairs are
 * currently equipped. `allocateCharmToWeapon` checks the pool capacity
 * + the player's ownership, then records the allocation. The /api/loadout
 * route uses this to validate equip requests.
 */
export interface CharmAllocationPool {
  playerId: string;
  /** Map of weaponSlug → charmSlug (the currently-equipped charm per weapon). */
  allocations: Map<string, CharmSlug>;
  /** Pool capacity — the max number of weapons that can have a charm equipped. */
  capacity: number;
}

/** Compute the pool capacity for a player level. Pure. */
export function computeCharmPoolCapacity(playerLevel: number): number {
  // Base 3 + 1 per 10 levels (so a level-50 player has 8 charm slots).
  return 3 + Math.floor(playerLevel / 10);
}

/**
 * Allocate a charm to a weapon. Returns the updated pool + a result code:
 *   - "ok" — allocation succeeded.
 *   - "pool_full" — the pool is at capacity for a NEW weapon (existing
 *     weapon allocations are always replaceable).
 *   - "not_owned" — the player doesn't own the charm.
 *   - "unknown_charm" — the charm slug isn't in the catalog.
 *
 * Pure — the caller persists the allocation to the PlayerLoadout table.
 */
export function allocateCharmToWeapon(
  pool: CharmAllocationPool,
  weaponSlug: string,
  charmSlug: CharmSlug,
  ownedCharms: CharmSlug[],
): { result: "ok" | "pool_full" | "not_owned" | "unknown_charm"; pool: CharmAllocationPool } {
  // Validate the charm slug is known.
  if (charmSlug !== "none" && !(charmSlug in CHARMS)) {
    return { result: "unknown_charm", pool };
  }
  // Validate ownership (unless it's the "none" charm — always allowed).
  if (charmSlug !== "none" && !isCharmOwned(ownedCharms, charmSlug)) {
    return { result: "not_owned", pool };
  }
  // Check pool capacity — only counts if this is a NEW weapon allocation.
  const isNewWeapon = !pool.allocations.has(weaponSlug);
  const activeAllocations = Array.from(pool.allocations.values()).filter((c) => c !== "none").length;
  if (isNewWeapon && charmSlug !== "none" && activeAllocations >= pool.capacity) {
    return { result: "pool_full", pool };
  }
  // Record the allocation.
  const newAllocations = new Map(pool.allocations);
  newAllocations.set(weaponSlug, charmSlug);
  return {
    result: "ok",
    pool: { ...pool, allocations: newAllocations },
  };
}

/** Create an empty allocation pool for a player. */
export function createCharmAllocationPool(playerId: string, playerLevel: number): CharmAllocationPool {
  return {
    playerId,
    allocations: new Map(),
    capacity: computeCharmPoolCapacity(playerLevel),
  };
}
