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

// ─── Attachment helpers ───

export function applyMuzzleAttachment(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, muzzleZ: number): number {
  if (loadout.muzzle === "suppressor") {
    const supp = buildSuppressor(mats, 0.2);
    supp.position.set(0, 0.02, muzzleZ - 0.1); group.add(supp);
    return muzzleZ - 0.2;
  } else if (loadout.muzzle === "compensator") {
    const comp = buildCompensator(mats, 0.05);
    comp.position.set(0, 0.02, muzzleZ - 0.025); group.add(comp);
    return muzzleZ - 0.05;
  }
  // Default: birdcage flash hider.
  const fh = buildFlashHider(mats, 0.06);
  fh.position.set(0, 0.02, muzzleZ - 0.03); group.add(fh);
  return muzzleZ - 0.06;
}

export function applyOpticAttachment(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, railY: number): void {
  const sight = loadout.sight;
  if (sight === "none") return;
  if (sight === "scope8x") {
    const scope = buildScope(mats, 0.26, 0.028);
    scope.position.set(0, railY + 0.045, -0.02); group.add(scope);
    group.add(buildScopeRings(mats, -0.06, 0.04));
  } else if (sight === "acog") {
    const acog = buildAcog(mats);
    acog.position.set(0, railY + 0.02, -0.04); group.add(acog);
  } else if (sight === "holo") {
    const holo = buildHolo(mats);
    holo.position.set(0, railY + 0.015, -0.06); group.add(holo);
  } else if (sight === "red_dot") {
    const rd = buildRedDot(mats);
    rd.position.set(0, railY + 0.015, -0.06); group.add(rd);
  }
}

export function applyForegrip(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, z: number, y: number): void {
  if (loadout.grip === "none") return;
  // Vertical foregrip.
  const fg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.08, 12), mats.polymer);
  fg.position.set(0, y - 0.05, z); group.add(fg);
  // Mount block.
  const mount = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.015, 0.025), mats.parkerized);
  mount.position.set(0, y - 0.015, z); group.add(mount);
}
