import * as THREE from "three";
import type { LoadoutConfig } from "../store";
import type { WeaponMaterials } from "./_shared";
import {
  part,
  addWearScratches,
  buildTaperedReceiver,
  buildRail,
  buildTakedownPins,
  buildRivets,
  buildMarkingDecal,
  buildBarrel,
  buildFlashHider,
  buildCompensator,
  buildSuppressor,
  buildIronSights,
  buildM4Stock,
  buildAkStock,
  buildSniperStock,
  buildPistolGrip,
  buildAkMag,
  buildStanagMag,
  buildP90Mag,
  buildTriggerGroup,
  buildTHandle,
  buildSideHandle,
  buildEjectionPort,
  buildSelector,
  buildBoltHandle,
  buildScopeRings,
  buildScopeReticle,
  buildScope,
  buildRedDot,
  buildHolo,
  buildAcog,
  buildSlide,
  buildBeveledReceiver,
  buildPicatinnyRailExtruded,
  buildRibbedGrip,
  buildCurvedMagazine,
  pickReceiverMaterial,
} from "./_shared";
import { applyMuzzleAttachment, applyOpticAttachment, applyForegrip } from "./attachments";

// ─── M249 SAW (LMG) ───

/** Folding bipod — two angled legs under a pivot block. */
export function buildBipod(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Pivot mount — clamps onto the barrel.
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.025, 0.04), mats.parkerized);
  mount.position.set(0, -0.018, 0); mount.castShadow = true; g.add(mount);
  // Pivot axle — cylinder horizontal through the mount.
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.045, 10), mats.parkerized);
  axle.rotation.z = Math.PI / 2; axle.position.set(0, -0.03, 0); g.add(axle);
  // Two legs — angled outward + downward (deployed position).
  const legGeo = new THREE.CylinderGeometry(0.005, 0.004, 0.13, 8);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, mats.parkerized);
    leg.castShadow = true;
    // Rotate so the leg points down + outward.
    leg.rotation.z = side * 0.55;
    leg.position.set(side * 0.025, -0.09, 0);
    g.add(leg);
    // Foot — small rubber pad on the bottom.
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), mats.rubber);
    foot.position.set(side * 0.075, -0.14, 0); g.add(foot);
  }
  return g;
}

/** Side-mounted belt-fed box magazine (M249 signature). */
export function buildBoxMag(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Main box — rectangular, slightly tapered toward the bottom.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.11), mats.darkPolymer);
  body.position.set(0, -0.065, 0); body.castShadow = true; g.add(body);
  // Top feed tray — narrow neck that mates with the feed cover.
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.07), mats.parkerized);
  neck.position.set(0, 0.005, 0); g.add(neck);
  // Latch tab — small lever on the front.
  const latch = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.018, 0.025), mats.parkerized);
  latch.position.set(0, -0.02, 0.06); g.add(latch);
  // Visible belt — a few rounds poking out the feed tray (brass + disintegrating link).
  const beltMat = mats.brass;
  for (let i = 0; i < 3; i++) {
    const round = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.022, 8), beltMat);
    round.rotation.x = Math.PI / 2;
    round.position.set(-0.018 + i * 0.018, 0.018, 0.03);
    g.add(round);
  }
  // Side ribs — structural detail on the box.
  for (const side of [-1, 1]) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.11, 0.005), mats.parkerized);
    rib.position.set(side * 0.036, -0.065, 0.052); g.add(rib);
  }
  return g;
}

/** Heavy barrel with perforated heat shield (M249 signature). */
export function buildHeatShieldedBarrel(mats: WeaponMaterials, length: number): THREE.Group {
  const g = new THREE.Group();
  // Chamber reinforcement — thicker section at the receiver end.
  const chamber = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.09, 18), mats.gunmetal);
  chamber.rotation.x = Math.PI / 2; chamber.position.z = -0.045; chamber.castShadow = true; g.add(chamber);
  // Main barrel — heavy profile (thicker than rifle).
  const mainLen = length - 0.09;
  const main = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, mainLen, 18), mats.gunmetal);
  main.rotation.x = Math.PI / 2; main.position.z = -0.09 - mainLen / 2; main.castShadow = true; g.add(main);
  // Gas block — front sight base (M249 has a fixed front sight on the gas block).
  const gb = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.05), mats.parkerized);
  gb.position.set(0, 0.01, -length + 0.18); gb.castShadow = true; g.add(gb);
  // Gas tube — thin cylinder back to the receiver.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.16, 10), mats.parkerized);
  tube.rotation.x = Math.PI / 2; tube.position.set(0, 0.035, -length + 0.26); g.add(tube);
  // Front sight post on the gas block.
  const sightPost = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.025, 0.008), mats.parkerized);
  sightPost.position.set(0, 0.045, -length + 0.17); g.add(sightPost);
  // Heat shield — perforated cylindrical shroud around the barrel.
  // Built as a half-cylinder (thetaLength = π) with the open side facing
  // upward so the vent holes are visible from above.
  const shieldLen = mainLen * 0.7;
  const shield = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, shieldLen, 16, 1, false, 0, Math.PI),
    mats.parkerized,
  );
  // CylinderGeometry axis is +Y by default; rotate to lie along the barrel
  // (-Z). After rotation.x = π/2 the open half (originally -Y) faces +Y
  // (upward) — exposing the barrel + vent holes from above.
  shield.rotation.x = Math.PI / 2;
  shield.position.set(0, 0.015, -0.09 - shieldLen / 2); shield.castShadow = true; g.add(shield);
  // Heat-shield vent holes — dark oval recesses on top.
  const ventMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 });
  const ventCount = 6;
  for (let i = 0; i < ventCount; i++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.005, 0.014), ventMat);
    vent.position.set(0, 0.032, -0.13 - i * (shieldLen / ventCount));
    g.add(vent);
  }
  // Muzzle thread ring.
  const thread = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.022, 0.022, 14), mats.parkerized);
  thread.rotation.x = Math.PI / 2; thread.position.z = -length + 0.011; thread.castShadow = true; g.add(thread);
  return g;
}

/** Carrying handle — fixed steel loop above the barrel. */
export function buildCarryingHandle(mats: WeaponMaterials, z: number): THREE.Group {
  const g = new THREE.Group();
  // Two vertical stands.
  for (const dz of [-0.04, 0.04]) {
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.04, 0.008), mats.parkerized);
    stand.position.set(0, 0.02, z + dz); g.add(stand);
  }
  // Top horizontal bar — slightly arched.
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.11, 10), mats.parkerized);
  bar.rotation.z = Math.PI / 2; bar.position.set(0, 0.045, z); g.add(bar);
  // Grip wrap — textured section in the middle.
  const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.05, 10), mats.rubber);
  wrap.rotation.z = Math.PI / 2; wrap.position.set(0, 0.045, z); g.add(wrap);
  return g;
}

/** Fixed skeleton stock — M249 polymer stock with buttplate. */
export function buildM249Stock(mats: WeaponMaterials): THREE.Group {
  const g = new THREE.Group();
  // Main stock body — angled block.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.085, 0.22), mats.polymer);
  body.position.set(0, -0.025, 0.16); body.rotation.x = -0.04; body.castShadow = true; g.add(body);
  // Comb — raised cheek rest.
  const comb = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.018, 0.16), mats.polymer);
  comb.position.set(0, 0.018, 0.16); g.add(comb);
  // Lower strut — open skeleton design.
  const strut = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.18), mats.polymer);
  strut.position.set(0, -0.06, 0.17); g.add(strut);
  // Buttplate — thick rubber recoil pad.
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.09, 0.018), mats.rubber);
  pad.position.set(0, -0.025, 0.28); g.add(pad);
  // Sling swivel.
  const swivel = new THREE.Mesh(new THREE.TorusGeometry(0.008, 0.003, 6, 10), mats.parkerized);
  swivel.position.set(0, -0.07, 0.1); swivel.rotation.x = Math.PI / 2; g.add(swivel);
  return g;
}

/** Build the M249 SAW — 30+ part belt-fed LMG. */
export function buildM249(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Receiver — beefy stamped steel, slightly tapered.
  const receiver = buildTaperedReceiver(mats.gunmetal, 0.06, 0.09, 0.38, 0.9);
  receiver.position.set(0, 0, 0); group.add(receiver);
  // Top cover — removable feed cover with Picatinny rail.
  const cover = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.025, 0.18), mats.parkerized);
  cover.position.set(0, 0.058, -0.02); group.add(cover);
  // Top rail — for optics.
  const rail = buildRail(mats.parkerized, 0.16, 0.03, 0.012, 6);
  rail.position.set(0, 0.073, -0.02); group.add(rail);
  // Heavy barrel with heat shield + gas block + front sight.
  const barrelLen = 0.52;
  const barrel = buildHeatShieldedBarrel(mats, barrelLen);
  barrel.position.set(0, 0.005, -0.19); group.add(barrel);
  // Bipod — mounted near the gas block.
  const bipod = buildBipod(mats);
  bipod.position.set(0, -0.02, -0.19 - barrelLen + 0.18); group.add(bipod);
  // Carrying handle — above the chamber.
  group.add(buildCarryingHandle(mats, -0.05));
  // Side-mounted belt-fed box magazine (left side, M249 signature).
  const mag = buildBoxMag(mats);
  mag.position.set(-0.06, -0.04, -0.04); group.add(mag);
  group.userData.magRef = mag as unknown as THREE.Mesh;
  // Pistol grip — vertical polymer.
  const grip = buildPistolGrip(mats, 0.13, -0.28);
  grip.position.set(0, -0.045, 0.12); group.add(grip);
  group.userData.handleRef = grip;
  // Fixed stock.
  group.add(buildM249Stock(mats));
  // Trigger group.
  group.add(buildTriggerGroup(mats, 0.08));
  // Side charging handle — left-side, behind the box mag.
  group.add(buildSideHandle(mats, -0.02));
  // Ejection port — right side (brass deflects away from the box mag).
  group.add(buildEjectionPort(mats, -0.06));
  // Selector — safe / auto (M249 is open-bolt full-auto only, but show a lever).
  group.add(buildSelector(mats, 0.05));
  // Iron sights — rear aperture on the top cover, front post on the gas block.
  group.add(buildIronSights(mats, -0.19 - barrelLen + 0.17, 0.05));

  let muzzleZ = -0.19 - barrelLen + 0.011; // thread ring end
  // Muzzle device + attachments.
  muzzleZ = applyMuzzleAttachment(group, mats, loadout, muzzleZ);
  // Optic attachment — on the top cover rail.
  applyOpticAttachment(group, mats, loadout, 0.073);
  // No foregrip slot — bipod occupies the front. (applyForegrip would clip
  // into the heat shield; skip it for the M249.)
  return muzzleZ;
}

