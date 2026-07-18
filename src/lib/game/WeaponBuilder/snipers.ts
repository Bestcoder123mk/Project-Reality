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

// ─── AWP-X (sniper) ───

export function buildAwp(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Receiver — beefy steel.
  const receiver = buildTaperedReceiver(mats.gunmetal, 0.055, 0.085, 0.36, 0.9);
  receiver.position.set(0, 0, 0); group.add(receiver);
  // Heavy fluted barrel — long with built-in fluting (buildBarrel's fluted
  // option lays 6 longitudinal grooves along the main barrel section).
  const barrel = buildBarrel(mats, 0.6, 0.026, 0.022, false, 0, true);
  barrel.position.set(0, 0.005, -0.22); group.add(barrel);
  // Muzzle brake.
  const brake = buildCompensator(mats, 0.06);
  brake.position.set(0, 0.005, -0.82); group.add(brake);
  // Scope mount rings.
  group.add(buildScopeRings(mats, -0.05, 0.08));
  // Full telescopic scope — tightened proportion (was objR=0.034, length=0.28
  // which read as oversized). Now objR=0.026, length=0.24 (real 30mm tube).
  const scope = buildScope(mats, 0.24, 0.026);
  scope.position.set(0, 0.085, 0.01); group.add(scope);
  // Thumbhole stock.
  const stock = buildSniperStock(mats, false);
  group.add(stock);
  // B2-5000 #852 — was `stock.children[0] as THREE.Mesh` (blind children[0]
  // index — fragile if buildSniperStock ever reorders its children). Now
  // look up by name 'stock_body' (buildSniperStock names its primary mesh).
  group.userData.handleRef = stock.getObjectByName("stock_body") ?? stock.children[0] as THREE.Mesh;
  // Pistol grip — part of the thumbhole stock.
  // Magazine — detachable box.
  const mag = buildStanagMag(mats, 0.08, 0.045);
  mag.position.set(0, -0.05, -0.05); group.add(mag);
  group.userData.magRef = mag as unknown as THREE.Mesh;
  // Bolt handle.
  group.add(buildBoltHandle(mats, 0.05));
  // Trigger.
  group.add(buildTriggerGroup(mats, 0.08));
  // Ejection port.
  group.add(buildEjectionPort(mats, -0.08));

  let muzzleZ = -0.88;
  if (loadout.muzzle === "suppressor") {
    const supp = buildSuppressor(mats, 0.22);
    supp.position.set(0, 0.005, muzzleZ - 0.11); group.add(supp);
    muzzleZ -= 0.22;
  }
  return muzzleZ;
}

// ─── Scout (sniper) ───

export function buildScout(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Receiver — lighter than AWP.
  const receiver = buildTaperedReceiver(mats.gunmetal, 0.05, 0.075, 0.32, 0.9);
  receiver.position.set(0, 0, 0); group.add(receiver);
  // Barrel — medium profile, shorter, with built-in fluting (heat dissipation
  // + weight reduction; signature sniper barrel treatment).
  const barrel = buildBarrel(mats, 0.5, 0.022, 0.018, false, 0, true);
  barrel.position.set(0, 0.005, -0.2); group.add(barrel);
  // Muzzle brake (Scout signature — 3-port brake for recoil reduction).
  const brake = buildCompensator(mats, 0.05);
  brake.position.set(0, 0.005, -0.70); group.add(brake);
  // Scope rings.
  group.add(buildScopeRings(mats, -0.04, 0.07));
  // Medium scope.
  const scope = buildScope(mats, 0.24, 0.028);
  scope.position.set(0, 0.095, 0.01); group.add(scope);
  // Traditional wood stock.
  const stock = buildSniperStock(mats, true);
  group.add(stock);
  // B2-5000 #852 — named lookup instead of blind children[0].
  group.userData.handleRef = stock.getObjectByName("stock_body") ?? stock.children[0] as THREE.Mesh;
  // Magazine.
  const mag = buildStanagMag(mats, 0.07, 0.04);
  mag.position.set(0, -0.045, -0.04); group.add(mag);
  group.userData.magRef = mag as unknown as THREE.Mesh;
  // Bolt handle.
  group.add(buildBoltHandle(mats, 0.03));
  // Trigger.
  group.add(buildTriggerGroup(mats, 0.07));
  // Ejection port.
  group.add(buildEjectionPort(mats, -0.06));
  // Iron sights (scout has backup sights).
  group.add(buildIronSights(mats, -0.5, 0.1));

  let muzzleZ = -0.75;
  if (loadout.muzzle === "suppressor") {
    const supp = buildSuppressor(mats, 0.18);
    supp.position.set(0, 0.005, muzzleZ - 0.09); group.add(supp);
    muzzleZ -= 0.18;
  } else if (loadout.muzzle !== "none") {
    // Override the default muzzle brake if a different attachment is equipped.
    muzzleZ = applyMuzzleAttachment(group, mats, loadout, muzzleZ);
  }
  return muzzleZ;
}

