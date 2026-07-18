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

// ─── MP-7 ───

/** Compact MP-7 personal defense weapon — polymer shell with full-length top
 *  rail, side-folding stock, vertical foregrip, integrated iron sights, and
 *  a horizontal magazine that sits in the pistol grip. The MP-7's signature
 *  is its bulky polymer shell housing all the working parts — modeled here
 *  as upper + lower shell halves with a clear seam, plus M-LOK slots on the
 *  front handguard and a fully folding skeleton stock. */
export function buildMp7(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Upper receiver shell — rounded polymer block (the MP-7's signature
  // rounded full-polymer upper that houses the reciprocating bolt).
  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.26), mats.polymer);
  upper.position.set(0, 0.02, 0); group.add(upper);
  // Upper shell bevel — slight top chamfer (modeled as a thinner top box).
  const upperTop = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.008, 0.24), mats.darkPolymer);
  upperTop.position.set(0, 0.05, 0); group.add(upperTop);
  // Lower receiver shell — wider where the mag + grip attach.
  const lower = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.18), mats.darkPolymer);
  lower.position.set(0, -0.025, 0.04); group.add(lower);
  // Shell seam — a thin dark recessed line between upper + lower (visible at
  // close range as the molded-shell parting line).
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.001, 0.26),
    new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  seam.position.set(0, 0.005, 0); group.add(seam);
  // Top rail — full-length Picatinny (the MP-7's signature continuous top rail).
  const rail = buildRail(mats.parkerized, 0.30, 0.028, 0.012, 8);
  rail.position.set(0, 0.048, -0.02); group.add(rail);
  // Side rail segments — short Picatinny on each side for accessories.
  for (const sx of [-1, 1]) {
    const sRail = buildRail(mats.parkerized, 0.08, 0.018, 0.008, 3);
    sRail.position.set(sx * 0.025, 0.025, -0.04);
    sRail.rotation.y = sx * Math.PI / 2;
    group.add(sRail);
  }
  // Barrel — short, mostly enclosed by the handguard.
  const barrel = buildBarrel(mats, 0.18, 0.013, 0.010, false);
  barrel.position.set(0, -0.005, -0.18); group.add(barrel);
  // Handguard — compact polymer with M-LOK slots on 3 sides.
  const hg = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.12, 16), mats.polymer);
  hg.rotation.x = Math.PI / 2; hg.position.set(0, -0.005, -0.18); hg.castShadow = true; group.add(hg);
  // M-LOK slots — longitudinal cutouts on top + sides.
  const mlokMat = new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 1 });
  for (const side of [-1, 0, 1]) {
    for (let i = 0; i < 2; i++) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.004, 0.022), mlokMat);
      const sa = side * Math.PI / 2;
      slot.position.set(Math.sin(sa) * 0.024, -0.005 + Math.cos(sa) * 0.024, -0.16 - i * 0.04);
      if (side !== 0) slot.rotation.y = sa;
      group.add(slot);
    }
  }
  // Handguard vents — 4 small circular vents on top (heat dissipation).
  for (let i = 0; i < 4; i++) {
    const vent = new THREE.Mesh(new THREE.CircleGeometry(0.003, 10), mlokMat);
    vent.position.set(0, 0.020, -0.16 - i * 0.025);
    vent.rotation.x = -Math.PI / 2;
    group.add(vent);
  }
  // Magazine — horizontal compact pistol-style (the MP-7 mag is a 40-round
  // 4.6mm box that fits in the pistol grip — short + slightly curved).
  const magBody = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.14, 0.028), mats.darkPolymer);
  magBody.position.set(0, -0.10, 0.04); magBody.rotation.x = 0.08; magBody.castShadow = true; group.add(magBody);
  // Mag witness window — small translucent window showing rounds.
  const winMat = new THREE.MeshStandardMaterial({
    color: 0x14181a, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.55,
  });
  const win = new THREE.Mesh(new THREE.PlaneGeometry(0.014, 0.08), winMat);
  win.position.set(0.018, -0.10, 0.04); win.rotation.y = Math.PI / 2; group.add(win);
  // Visible rounds in the window — small brass cylinders.
  for (let i = 0; i < 4; i++) {
    const round = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.014, 8), mats.brass);
    round.rotation.z = Math.PI / 2;
    round.position.set(0.018, -0.07 - i * 0.02, 0.04);
    group.add(round);
  }
  // Mag baseplate — slightly wider.
  const magBase = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.010, 0.032), mats.parkerized);
  magBase.position.set(0, -0.175, 0.05); magBase.rotation.x = 0.08; group.add(magBase);
  group.userData.magRef = magBody;
  // Folding skeleton stock — extended position (the MP-7 stock is a thin
  // skeleton frame that folds to the side).
  const stockUpper = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.16), mats.polymer);
  stockUpper.position.set(0, 0.025, 0.22); group.add(stockUpper);
  const stockLower = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.16), mats.polymer);
  stockLower.position.set(0, -0.012, 0.22); group.add(stockLower);
  // Stock vertical struts — 2 thin rods connecting upper + lower (skeleton).
  for (const sz of [-0.02, 0.04]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.035, 0.005), mats.polymer);
    strut.position.set(0, 0.006, 0.22 + sz); group.add(strut);
  }
  // Stock hinge — small pivot block at the receiver end (folds to the side).
  const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.030, 12), mats.parkerized);
  hinge.rotation.z = Math.PI / 2; hinge.position.set(0, 0.006, 0.14); group.add(hinge);
  // Buttpad — thin rubber on the stock end.
  const butt = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.040, 0.008), mats.rubber);
  butt.position.set(0, 0.006, 0.305); group.add(butt);
  group.userData.handleRef = stockUpper;
  // Pistol grip — integrated, slightly angled.
  const grip = buildPistolGrip(mats, 0.10, -0.20);
  grip.position.set(0, -0.045, 0.08); group.add(grip);
  // Foregrip — folding vertical (the MP-7's signature folding vertical foregrip).
  const fgrip = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.014, 0.07, 12), mats.polymer);
  fgrip.position.set(0, -0.065, -0.14); fgrip.castShadow = true; group.add(fgrip);
  // Foregrip hinge — small pivot block at the top (so it can fold).
  const fgHinge = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.028, 12), mats.parkerized);
  fgHinge.rotation.z = Math.PI / 2; fgHinge.position.set(0, -0.030, -0.14); group.add(fgHinge);
  // Trigger group.
  group.add(buildTriggerGroup(mats, 0.06));
  // Charging handle — MP-7 has a side charging handle on the right.
  const chg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 10), mats.parkerized);
  chg.rotation.z = Math.PI / 2; chg.position.set(0.028, 0.025, -0.04); group.add(chg);
  const chgKnob = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), mats.parkerized);
  chgKnob.position.set(0.045, 0.025, -0.04); group.add(chgKnob);
  // Ejection port — small, on the right side.
  group.add(buildEjectionPort(mats, -0.08));
  // Iron sights — flip-up front post + rear aperture.
  group.add(buildIronSights(mats, -0.24, 0.08));

  let muzzleZ = -0.18 - 0.18 + 0.015;
  muzzleZ = applyMuzzleAttachment(group, mats, loadout, muzzleZ);
  applyOpticAttachment(group, mats, loadout, 0.058);
  return muzzleZ;
}

// ─── P90 ───

/** FN P90 — bullpup PDW with top-mounted horizontal magazine, full-polymer
 *  shell, and an integrated ring-sight (the P90's signature MC-10 ring sight
 *  built into the carry handle — a circular optic that projects a glowing
 *  reticle). The body has rounded curves (no flat sides) + finger grooves on
 *  the grip + the unmistakable swooping silhouette. */
export function buildP90(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Bullpup body — full polymer shell. The P90 has a distinctive rounded
  // triangular profile (taller at the rear, swooping down to the muzzle).
  // Upper body — the main shell.
  const upperBody = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.060, 0.40), mats.polymer);
  upperBody.position.set(0, 0.010, 0); upperBody.castShadow = true; group.add(upperBody);
  // Upper shell bevel — slight chamfer on top (the molded shell parting line).
  const upperBevel = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.006, 0.40), mats.darkPolymer);
  upperBevel.position.set(0, 0.041, 0); group.add(upperBevel);
  // Lower body — wider at the rear (where the rear grip is) + narrow at the
  // front (where the barrel exits).
  const lowerBody = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.058, 0.30), mats.darkPolymer);
  lowerBody.position.set(0, -0.030, -0.04); lowerBody.castShadow = true; group.add(lowerBody);
  // Front forend — tapered section toward the muzzle (the P90's rounded nose).
  const forend = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.040, 0.12, 16), mats.polymer);
  forend.rotation.x = Math.PI / 2; forend.position.set(0, -0.005, -0.24); forend.castShadow = true; group.add(forend);
  // Top rail — Picatinny rail segment behind the magazine (for mounting
  // optics on top of the P90, replacing the factory integrated ring sight).
  const rail = buildRail(mats.parkerized, 0.18, 0.030, 0.012, 5);
  rail.position.set(0, 0.060, 0.16); group.add(rail);
  // Integrated ring sight housing — the P90's signature MC-10 optic built
  // into the carry handle. A raised housing above the receiver with a
  // circular reticle window.
  const sightHousing = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.038, 0.12), mats.darkPolymer);
  sightHousing.position.set(0, 0.075, -0.02); group.add(sightHousing);
  // Sight housing top — slight raised ridge (carry-handle look).
  const sightTop = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.008, 0.13), mats.darkPolymer);
  sightTop.position.set(0, 0.098, -0.02); group.add(sightTop);
  // Ring sight front window — small angled glass face.
  const rsFront = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.024), mats.glass);
  rsFront.position.set(0, 0.078, -0.081); rsFront.rotation.x = -Math.PI / 2 - 0.4;
  group.add(rsFront);
  // Ring sight rear window — small angled glass face.
  const rsRear = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.024), mats.glass);
  rsRear.position.set(0, 0.078, 0.041); rsRear.rotation.x = -Math.PI / 2 + 0.4;
  group.add(rsRear);
  // Glowing reticle inside the ring sight — small additive red dot.
  const reticle = new THREE.Mesh(new THREE.TorusGeometry(0.005, 0.0006, 4, 16), mats.reticleRed);
  reticle.position.set(0, 0.078, -0.02); group.add(reticle);
  const reticleDot = new THREE.Mesh(new THREE.CircleGeometry(0.001, 12), mats.reticleRed);
  reticleDot.position.set(0, 0.078, -0.02); group.add(reticleDot);
  // Top-mounted horizontal magazine (P90 signature).
  const mag = buildP90Mag(mats);
  group.add(mag);
  group.userData.magRef = mag as unknown as THREE.Mesh;
  // Magazine release — small button on the side (just behind the mag).
  const magRel = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.014, 0.014), mats.parkerized);
  magRel.position.set(0.036, 0.040, 0.10); group.add(magRel);
  // Barrel — short, enclosed in the forend.
  const barrel = buildBarrel(mats, 0.18, 0.012, 0.010, false);
  barrel.position.set(0, -0.005, -0.24); group.add(barrel);
  // Front sight post — integrated (backup, under the ring sight).
  const fs = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.018, 0.006), mats.parkerized);
  fs.position.set(0, 0.030, -0.30); group.add(fs);
  // Front sight ears — small protective wings.
  for (const sx of [-0.009, 0.009]) {
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.014, 0.008), mats.parkerized);
    ear.position.set(sx, 0.028, -0.30); group.add(ear);
  }
  // Grip — integrated rear (bullpup). The P90's rear grip is a large hand-
  // shaped cavity; modeled as a tapered block with finger grooves.
  const rearGrip = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.12, 0.05), mats.polymer);
  rearGrip.position.set(0, -0.075, 0.12); rearGrip.castShadow = true; group.add(rearGrip);
  // Finger grooves — 3 horizontal ribs on the front face of the grip.
  for (let i = 0; i < 3; i++) {
    const groove = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.002, 0.04), mats.darkPolymer);
    groove.position.set(0, -0.05 - i * 0.030, 0.10); group.add(groove);
  }
  // Grip texture — stippled side panels (small dot grid).
  for (const sx of [-1, 1]) {
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        const dot = new THREE.Mesh(new THREE.BoxGeometry(0.001, 0.002, 0.002), mats.darkPolymer);
        dot.position.set(sx * 0.024, -0.04 - r * 0.025, 0.085 + c * 0.012);
        group.add(dot);
      }
    }
  }
  group.userData.handleRef = rearGrip;
  // Front grip — angled (the P90's forward grip is part of the trigger guard
  // housing — a small forward-angled grip the support hand holds).
  const frontGrip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.017, 0.07, 14), mats.polymer);
  frontGrip.position.set(0, -0.070, -0.18); frontGrip.rotation.x = 0.18; frontGrip.castShadow = true;
  group.add(frontGrip);
  // Trigger group — set further back (bullpup layout).
  group.add(buildTriggerGroup(mats, -0.06));
  // Ejection port — downward on P90 (the P90 ejects straight down).
  const ejection = buildEjectionPort(mats, -0.10);
  ejection.rotation.x = Math.PI; ejection.position.set(0, -0.04, -0.10);
  group.add(ejection);
  // Charging handle — on the side (P90 has a side charging handle).
  const chg = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.025, 10), mats.parkerized);
  chg.rotation.z = Math.PI / 2; chg.position.set(0.038, 0.005, -0.04); group.add(chg);
  const chgKnob = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), mats.parkerized);
  chgKnob.position.set(0.052, 0.005, -0.04); group.add(chgKnob);
  // Safety selector — small lever above the trigger guard.
  const sel = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.014, 10), mats.parkerized);
  sel.rotation.z = Math.PI / 2; sel.position.set(0.034, -0.025, 0.04); group.add(sel);

  let muzzleZ = -0.24 - 0.18 + 0.012;
  muzzleZ = applyMuzzleAttachment(group, mats, loadout, muzzleZ);
  // If the user attaches an optic, raise it to sit on the top rail (otherwise
  // the integrated ring sight is the default).
  applyOpticAttachment(group, mats, loadout, 0.060);
  return muzzleZ;
}

