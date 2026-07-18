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

// ─── USP-S ───

/** HK USP-S — polymer-frame compact pistol with a threaded barrel for the
 *  factory suppressor. The slide has front + rear cocking serrations, an
 *  ejection port, a loaded chamber indicator, front post + rear notch sights
 *  with tritium dots, and a beveled top. The frame has an extended extended
 *  trigger guard (for gloved fingers), an ambidextrous safety, and an
 *  ergonomic grip with stippled side panels. */
export function buildUsp(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Polymer frame — beveled by chamfering top + bottom edges.
  const frameGeo = new THREE.BoxGeometry(0.040, 0.050, 0.16, 2, 2, 1);
  const fpos = frameGeo.attributes.position;
  for (let i = 0; i < fpos.count; i++) {
    const x = fpos.getX(i);
    const y = fpos.getY(i);
    if (Math.abs(y) > 0.025 * 0.35 && Math.abs(x) > 0.020 * 0.2) {
      fpos.setX(i, x * 0.90);
    }
  }
  fpos.needsUpdate = true;
  frameGeo.computeVertexNormals();
  const frame = new THREE.Mesh(frameGeo, mats.polymer);
  frame.position.set(0, -0.02, 0); frame.castShadow = true; group.add(frame);
  // Slide with serrations + ejection port + tritium sights.
  const slide = buildSlide(mats, 0.18, 0.040, 0.035, true);
  slide.position.set(0, 0.020, 0); group.add(slide);
  // Barrel — protruding slightly through the slide (the USP-S has a slightly
  // protruding threaded barrel for the factory suppressor).
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 16), mats.gunmetal);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.020, -0.08); barrel.castShadow = true; group.add(barrel);
  // Threaded muzzle section — slightly raised ring with thread grooves.
  const threadSec = new THREE.Mesh(new THREE.CylinderGeometry(0.0135, 0.013, 0.020, 14), mats.parkerized);
  threadSec.rotation.x = Math.PI / 2; threadSec.position.set(0, 0.020, -0.17); group.add(threadSec);
  // Grip — ergonomic polymer with texture.
  const grip = buildPistolGrip(mats, 0.13, -0.15);
  grip.position.set(0, -0.07, 0.04); group.add(grip);
  group.userData.handleRef = grip;
  // Magazine — inside the grip. Protrudes slightly at the bottom.
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.045, 0.030), mats.darkPolymer);
  mag.position.set(0, -0.135, 0.04); mag.castShadow = true; group.add(mag);
  group.userData.magRef = mag;
  // Mag baseplate — slightly wider.
  const magBase = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.008, 0.033), mats.parkerized);
  magBase.position.set(0, -0.160, 0.04); group.add(magBase);
  // Trigger guard — squared + extended (for gloved fingers).
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.020, 0.0045, 6, 12, Math.PI), mats.polymer);
  guard.position.set(0, -0.04, -0.005); guard.rotation.x = Math.PI; group.add(guard);
  // Trigger guard undercut — small vertical piece giving the guard its square shape.
  const guardFront = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.022, 0.005), mats.polymer);
  guardFront.position.set(0, -0.04, -0.025); group.add(guardFront);
  // Trigger — curved blade.
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.022, 0.005), mats.parkerized);
  trigger.position.set(0, -0.045, -0.005); group.add(trigger);
  // Hammer — exposed at the back of the slide.
  const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.014, 0.006), mats.parkerized);
  hammer.position.set(0, 0.015, 0.080); group.add(hammer);
  // Hammer strut — small detail below the hammer.
  const strut = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.008, 0.002), mats.parkerized);
  strut.position.set(0, 0.008, 0.080); group.add(strut);
  // Ambidextrous safety/decocker lever — on the side of the slide.
  const safety = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.014, 10), mats.parkerized);
  safety.rotation.z = Math.PI / 2; safety.position.set(0.024, 0.020, 0.045); group.add(safety);
  // Slide release — small lever on the left side.
  const slideRel = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.005, 0.005), mats.parkerized);
  slideRel.position.set(-0.025, 0.000, 0.005); group.add(slideRel);
  // Mag release button — small button behind the trigger guard.
  const magRel = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.005, 10), mats.parkerized);
  magRel.rotation.z = Math.PI / 2; magRel.position.set(-0.024, -0.040, 0.020); group.add(magRel);
  // Picatinny rail under the frame (USP has a small accessory rail for lights).
  const sRail = buildRail(mats.parkerized, 0.05, 0.022, 0.007, 2);
  sRail.position.set(0, -0.045, -0.018); group.add(sRail);

  let muzzleZ = -0.18;
  muzzleZ = applyMuzzleAttachment(group, mats, loadout, muzzleZ);
  return muzzleZ;
}

// ─── Desert Eagle ───

/** Desert Eagle — large steel-frame gas-operated pistol. Signature features:
 *  slab-sided heavy slide with deep cocking serrations, polygon rifled
 *  barrel with a ventilated rib on top, large wood grip panels with the
 *  eagle medallion, big trigger guard, exposed hammer, and a muzzle brake
 *  integral to the barrel. */
export function buildDeagle(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Large steel frame — beveled.
  const frameGeo = new THREE.BoxGeometry(0.050, 0.060, 0.20, 2, 2, 1);
  const fpos = frameGeo.attributes.position;
  for (let i = 0; i < fpos.count; i++) {
    const x = fpos.getX(i);
    const y = fpos.getY(i);
    if (y > 0.030 * 0.35 && Math.abs(x) > 0.025 * 0.2) {
      fpos.setX(i, x * 0.86);
    }
  }
  fpos.needsUpdate = true;
  frameGeo.computeVertexNormals();
  const frame = new THREE.Mesh(frameGeo, mats.gunmetal);
  frame.position.set(0, -0.02, 0); frame.castShadow = true; group.add(frame);
  // Heavy slab slide with serrations + sights.
  const slide = buildSlide(mats, 0.22, 0.050, 0.045, true);
  slide.position.set(0, 0.025, 0); group.add(slide);
  // Polygon barrel — ribbed top (signature Deagle barrel with ventilated rib).
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.20, 18), mats.gunmetal);
  barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.025, -0.08); barrel.castShadow = true; group.add(barrel);
  // Ventilated rib — top flat rib on the barrel (the Deagle signature).
  const rib = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.005, 0.18), mats.gunmetal);
  rib.position.set(0, 0.042, -0.07); group.add(rib);
  // Rib vents — 4 small dark recesses along the rib (heat dissipation + the
  // signature Deagle "ventilated rib" look).
  for (let i = 0; i < 4; i++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.003, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
    vent.position.set(0, 0.045, -0.14 + i * 0.04); group.add(vent);
  }
  // Front sight base — on the rib (the Deagle has a tall front sight on the
  // barrel rib, not the slide).
  const fsBase = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.014, 0.010), mats.parkerized);
  fsBase.position.set(0, 0.050, -0.16); group.add(fsBase);
  // Front sight post.
  const fsPost = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.016, 0.004), mats.parkerized);
  fsPost.position.set(0, 0.062, -0.16); group.add(fsPost);
  // Front sight tritium dot.
  const fsTrit = new THREE.Mesh(new THREE.SphereGeometry(0.0016, 6, 4),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xc8ffd0, emissiveIntensity: 0.9 }));
  fsTrit.position.set(0, 0.068, -0.16); group.add(fsTrit);
  // Wood grip panels — slab sides with the signature eagle medallion.
  // Beveled grip with a palm-swell shape (curves outward toward the middle).
  // B2-5000 #853 — was `let leftGrip: THREE.Mesh | null = null;` captured
  // conditionally inside a `for (const sx of [-1, 1])` loop (fragile — silent
  // breakage if the array is reordered or filtered). Now the left grip is
  // created explicitly before the loop; the loop only handles the right side
  // + the shared palm-swell / grain / medallion details for both sides.
  const leftGrip = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.12, 0.08), mats.wood);
  leftGrip.position.set(-0.030, -0.05, 0.03); leftGrip.castShadow = true; group.add(leftGrip);
  for (const sx of [-1, 1]) {
    if (sx === -1) {
      // Left grip already created above — skip re-creating.
    } else {
      const lgrip = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.12, 0.08), mats.wood);
      lgrip.position.set(sx * 0.030, -0.05, 0.03); lgrip.castShadow = true; group.add(lgrip);
    }
    // Grip palm swell — a wider middle section.
    const swell = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.06, 0.07), mats.wood);
    swell.position.set(sx * 0.034, -0.05, 0.03); group.add(swell);
    // Grip wood grain — 2 darker streaks (the same pattern as AK furniture).
    for (const gy of [-0.07, -0.04, -0.01]) {
      const grain = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.0014, 0.07),
        new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 0.9 }));
      grain.position.set(sx * 0.032, gy, 0.03); group.add(grain);
    }
    // Eagle medallion — small accent-color circle in the grip center.
    const medallion = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.001, 12),
      mats.accent);
    medallion.rotation.z = Math.PI / 2; medallion.position.set(sx * 0.035, -0.05, 0.03);
    group.add(medallion);
  }
  // Grip screw — small pin at the top + bottom of each grip panel.
  for (const sx of [-1, 1]) {
    for (const sy of [-0.10, 0.00]) {
      const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.012, 8), mats.blued);
      screw.rotation.z = Math.PI / 2; screw.position.set(sx * 0.030, sy, 0.03); group.add(screw);
    }
  }
  // B2-5000 #853 — leftGrip is now always defined (no `?? frame` fallback
  // needed; the explicit construction above guarantees it).
  group.userData.handleRef = leftGrip;
  // Magazine — inside the grip (the Deagle mag is single-stack 7-round .50AE).
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.045, 0.045), mats.darkPolymer);
  mag.position.set(0, -0.10, 0.03); mag.castShadow = true; group.add(mag);
  group.userData.magRef = mag;
  // Mag baseplate — slightly wider with a finger groove.
  const magBase = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.010, 0.050), mats.parkerized);
  magBase.position.set(0, -0.125, 0.03); group.add(magBase);
  // Trigger guard — large (the Deagle trigger guard is oversized for gloved use).
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.0055, 6, 12, Math.PI), mats.gunmetal);
  guard.position.set(0, -0.05, -0.005); guard.rotation.x = Math.PI; group.add(guard);
  // Trigger guard front strut — vertical piece giving the guard its shape.
  const guardFront = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.025, 0.005), mats.gunmetal);
  guardFront.position.set(0, -0.05, -0.030); group.add(guardFront);
  // Trigger — wide blade (the Deagle trigger is wider than other pistols).
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.024, 0.006), mats.parkerized);
  trigger.position.set(0, -0.055, -0.005); group.add(trigger);
  // Hammer — large exposed spur hammer.
  const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.018, 0.008), mats.parkerized);
  hammer.position.set(0, 0.025, 0.085); group.add(hammer);
  // Hammer spur — small knurled extension at the top for cocking.
  const hammerSpur = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.005, 0.012, 8), mats.parkerized);
  hammerSpur.rotation.x = Math.PI / 2; hammerSpur.position.set(0, 0.030, 0.092); group.add(hammerSpur);
  // Slide release — large lever on the left side.
  const slideRel = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.006, 0.006), mats.parkerized);
  slideRel.position.set(-0.030, 0.005, 0.005); group.add(slideRel);
  // Safety — frame-mounted toggle on the left side.
  const safety = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.016, 10), mats.parkerized);
  safety.rotation.z = Math.PI / 2; safety.position.set(-0.030, -0.020, 0.045); group.add(safety);
  // Mag release — large button behind the trigger guard.
  const magRel = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.006, 10), mats.parkerized);
  magRel.rotation.z = Math.PI / 2; magRel.position.set(-0.028, -0.040, 0.025); group.add(magRel);
  // Muzzle brake (Deagle signature — integral to the barrel).
  const brake = buildCompensator(mats, 0.04);
  brake.position.set(0, 0.025, -0.18); group.add(brake);

  let muzzleZ = -0.22;
  if (loadout.muzzle === "suppressor") {
    const supp = buildSuppressor(mats, 0.16);
    supp.position.set(0, 0.025, muzzleZ - 0.08); group.add(supp);
    muzzleZ -= 0.16;
  } else if (loadout.muzzle !== "none") {
    const dev = buildFlashHider(mats, 0.05);
    dev.position.set(0, 0.025, muzzleZ - 0.03); group.add(dev);
    muzzleZ -= 0.05;
  }
  return muzzleZ;
}

