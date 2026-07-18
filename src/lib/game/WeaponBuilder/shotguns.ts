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

// ─── Nova (shotgun) ───

export function buildNova(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Receiver — boxy.
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.08, 0.3), mats.gunmetal);
  receiver.position.set(0, 0, 0); group.add(receiver);
  // Receiver top — corrugated surface (Benelli Nova signature: ribbed top).
  const recessMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 });
  for (let i = 0; i < 6; i++) {
    const corrug = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.003, 0.004), recessMat);
    corrug.position.set(0, 0.041, -0.10 + i * 0.04); group.add(corrug);
  }
  // Dual barrel — over-under.
  const barrelTop = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.55, 16), mats.gunmetal);
  barrelTop.rotation.x = Math.PI / 2; barrelTop.position.set(0, 0.022, -0.4); group.add(barrelTop);
  const barrelBot = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.55, 16), mats.gunmetal);
  barrelBot.rotation.x = Math.PI / 2; barrelBot.position.set(0, -0.005, -0.4); group.add(barrelBot);
  // Barrel rib — connecting top.
  const rib = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.012, 0.5), mats.gunmetal);
  rib.position.set(0, 0.034, -0.4); group.add(rib);
  // Vent rib — 5 heat dissipation holes.
  for (let i = 0; i < 5; i++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.004, 0.015), recessMat);
    vent.position.set(0, 0.04, -0.25 - i * 0.08); group.add(vent);
  }
  // Tubular magazine — under the barrel.
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 14), mats.gunmetal);
  tube.rotation.x = Math.PI / 2; tube.position.set(0, -0.03, -0.4); group.add(tube);
  // Magazine cap.
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.02, 14), mats.parkerized);
  cap.rotation.x = Math.PI / 2; cap.position.set(0, -0.03, -0.66); group.add(cap);
  // Pump — polymer with vertical grip ribs around the circumference (Benelli
  // Nova's signature ribbed forend for positive grip when racking).
  const pump = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.18, 14), mats.polymer);
  pump.rotation.x = Math.PI / 2; pump.position.set(0, -0.015, -0.35); group.add(pump);
  group.userData.handleRef = pump;
  // B2-5000 #851 — Nova magRef was the tube itself (the magazine IS the tube
  // on a pump shotgun, but the reload animation needs the loading port — the
  // right-side receiver opening where shells are pushed in). Setting
  // magRef=tube made the reload animation rotate/scale the tube (which is
  // integral to the barrel); now we anchor a dedicated loading-port Object3D
  // at the right side of the receiver so the reload anim shells dip toward it.
  const loadingPort = new THREE.Object3D();
  loadingPort.name = "loading_port";
  // Right side of the receiver, just behind the ejection port (z=-0.08, y=0.02).
  loadingPort.position.set(0.035, 0.02, -0.06);
  group.add(loadingPort);
  group.userData.magRef = loadingPort;
  // Pump ribs — 14 raised vertical ribs around the pump circumference (grip
  // texture). Each rib is a thin box at the pump's surface, oriented along Z.
  const pumpRibCount = 14;
  const pumpRibMat = mats.darkPolymer;
  for (let i = 0; i < pumpRibCount; i++) {
    const a = (i / pumpRibCount) * Math.PI * 2;
    const rr = 0.029; // slightly outside pump radius for raised-rib look
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.0025, 0.0025, 0.16), pumpRibMat);
    rib.position.set(Math.cos(a) * rr, -0.015 + Math.sin(a) * rr, -0.35);
    rib.rotation.y = -a;
    group.add(rib);
  }
  // Pump end caps — two steel collars at the front + rear of the pump.
  for (const dz of [-0.08, 0.08]) {
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.029, 0.004, 6, 16), mats.parkerized);
    collar.rotation.x = Math.PI / 2; collar.position.set(0, -0.015, -0.35 + dz);
    group.add(collar);
  }
  // Wood stock.
  const stock = buildAkStock(mats);
  stock.scale.set(1.1, 1.1, 1.1);
  group.add(stock);
  // Pistol grip.
  const grip = buildPistolGrip(mats, 0.13, -0.25);
  grip.position.set(0, -0.04, 0.1); group.add(grip);
  // Trigger group.
  group.add(buildTriggerGroup(mats, 0.08));
  // Ejection port — large for shotgun shells.
  const port = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.025, 0.08), recessMat);
  port.position.set(0.03, 0.02, -0.08); group.add(port);
  // Loaded shell indicator — visible brass shell at the ejection port.
  const loadedShell = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.025, 10), mats.brass);
  loadedShell.rotation.z = Math.PI / 2;
  loadedShell.position.set(0.034, 0.02, -0.08); group.add(loadedShell);
  // Front bead sight.
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), mats.brass);
  bead.position.set(0, 0.04, -0.66); group.add(bead);
  // Front bead tritium dot — small white-green emissive dot on the bead for low light.
  const beadTritMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xc8ffd0, emissiveIntensity: 0.9, roughness: 0.4,
  });
  const beadTrit = new THREE.Mesh(new THREE.SphereGeometry(0.002, 6, 4), beadTritMat);
  beadTrit.position.set(0, 0.043, -0.662); group.add(beadTrit);
  // Ghost ring rear sight — large aperture close to the eye for fast targeting
  // (Benelli Nova signature). A thin ring on a short post, mounted on the
  // receiver just behind the ejection port.
  const ghostPost = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.035, 0.006), mats.parkerized);
  ghostPost.position.set(0, 0.055, 0.04); group.add(ghostPost);
  const ghostRing = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0025, 6, 18), mats.parkerized);
  ghostRing.position.set(0, 0.075, 0.04); group.add(ghostRing);
  // Ghost ring tritium dot — small dot at the bottom of the ring for low-light alignment.
  const ghostTrit = new THREE.Mesh(new THREE.SphereGeometry(0.0014, 6, 4), beadTritMat);
  ghostTrit.position.set(0, 0.066, 0.039); group.add(ghostTrit);

  let muzzleZ = -0.68;
  if (loadout.muzzle === "suppressor") {
    // Shotgun suppressor is unusual but the attachment slot supports it.
    const supp = buildSuppressor(mats, 0.2);
    supp.position.set(0, 0.022, muzzleZ - 0.1); group.add(supp);
    muzzleZ -= 0.2;
  }
  return muzzleZ;
}

