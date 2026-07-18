import * as THREE from "three";
import type { LoadoutConfig, SkinSlug } from "../store";
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
  // B2-5000 #850 — shared muzzle-offset helper (replaces magic arithmetic).
  muzzleOffset,
} from "./_shared";
import { applyMuzzleAttachment, applyOpticAttachment, applyForegrip } from "./attachments";

// ─── AK-74 ───

export function buildAk74(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Receiver — stamped steel, slightly tapered. V2-c uses the beveled
  // ExtrudeGeometry receiver (chamfered top edges catch a highlight) and
  // the skin-aware receiver material (gold → glossy, carbon → weave, etc).
  const receiverMat = pickReceiverMaterial(loadout.skin as SkinSlug, mats);
  const receiver = buildBeveledReceiver(receiverMat, 0.058, 0.09, 0.42, 0.9);
  receiver.position.set(0, 0, 0); group.add(receiver);
  // Wear + scratch details on the receiver top (so the metal doesn't look
  // uniform — subtle dark scratches + brighter rubbed-edge highlights).
  addWearScratches(group, mats, 0.045, -0.20, 0.18, 0.058, 0x9e3779b1);
  // Stamped-receiver rivets — the AK's signature pattern of domed rivets
  // along the side (trigger guard + trunnion + rear trunnion).
  group.add(buildRivets(mats, [-0.18, -0.12, -0.06, 0.06, 0.12, 0.18], 1, -0.025));
  group.add(buildRivets(mats, [-0.18, -0.12, -0.06, 0.06, 0.12, 0.18], -1, -0.025));
  // Dust cover — removable top cover with ribbing.
  const cover = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.025, 0.35), mats.parkerized);
  cover.position.set(0, 0.055, 0); group.add(cover);
  // Dust cover ribs — 2 grooves for stiffness (signature AK look).
  for (const rz of [-0.05, 0.05]) {
    const rib = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.003, 0.005), mats.parkerized);
    rib.position.set(0, 0.067, rz); group.add(rib);
  }
  // Side-rail mount for optics (AK side-rail — the standard AK optics mount).
  const sideRail = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.018, 0.14), mats.parkerized);
  sideRail.position.set(0.031, 0.025, 0.04); group.add(sideRail);
  // Side-rail clamp lever — small pivot detail.
  const railLever = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.012, 10), mats.blued);
  railLever.rotation.z = Math.PI / 2; railLever.position.set(0.034, 0.025, 0.11); group.add(railLever);
  // Manufacturer marking decal on the dust cover.
  group.add(buildMarkingDecal(mats, 0.027, 0.058, 0.12, 0.022, 0.006));
  // Barrel + gas block.
  const barrel = buildBarrel(mats, 0.42, 0.02, 0.016, true, -0.28);
  barrel.position.set(0, 0.005, -0.21); group.add(barrel);
  // Handguard — wood lower + upper.
  const hgLower = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.04, 0.18), mats.wood);
  hgLower.position.set(0, -0.015, -0.25); group.add(hgLower);
  const hgUpper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.025, 0.16), mats.wood);
  hgUpper.position.set(0, 0.035, -0.25); group.add(hgUpper);
  // Wood grain — 2 darker streaks on the lower handguard (suggested grain).
  for (const gy of [-0.022, -0.008]) {
    const grain = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.0015, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x3a2010, roughness: 0.9 }));
    grain.position.set(0, gy, -0.25); group.add(grain);
  }
  // Gas tube cover — wood.
  const gasCover = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.14, 10), mats.wood);
  gasCover.rotation.x = Math.PI / 2; gasCover.position.set(0, 0.035, -0.22); group.add(gasCover);
  // Magazine — curved banana. V2-c uses the new smooth-curve buildCurvedMagazine
  // (CatmullRomCurve3 sweep) for a continuous banana silhouette, vs the original
  // buildAkMag which approximated the curve with 5 stacked offset boxes (visible
  // "stairsteps" between segments). The curve amount of 0.035 matches the
  // classic AK-74 5.45×39 banana mag curvature.
  const mag = buildCurvedMagazine(mats, 0.22, 0.05, 0.035, 14);
  mag.position.set(0, -0.05, -0.02); group.add(mag);
  group.userData.magRef = mag as unknown as THREE.Mesh;
  // Reposition the named magazine socket to the actual mag position so any
  // attachment (extended mag, drum mag) parents correctly.
  const akSocketMag = group.userData.socketMagazine as THREE.Object3D | undefined;
  if (akSocketMag) akSocketMag.position.set(0, -0.05, -0.02);
  // Pistol grip.
  const grip = buildPistolGrip(mats, 0.12, -0.35);
  grip.position.set(0, -0.04, 0.1); group.add(grip);
  group.userData.handleRef = grip;
  // Stock — fixed wood.
  const stock = buildAkStock(mats);
  group.add(stock);
  // Trigger group.
  group.add(buildTriggerGroup(mats, 0.08));
  // Side charging handle.
  group.add(buildSideHandle(mats, 0.0));
  // Ejection port.
  group.add(buildEjectionPort(mats, -0.05));
  // Selector.
  group.add(buildSelector(mats, 0.05));
  // Iron sights.
  group.add(buildIronSights(mats, -0.34, 0.12));
  // Top rail for optics (AK side-rail simplified to top).
  const rail = buildRail(mats.parkerized, 0.12);
  rail.position.set(0, 0.072, 0); group.add(rail);

  // B2-5000 #850 — was `let muzzleZ = -0.21 - 0.42 + 0.02; // barrel end`
  // (receiver-rear-z=-0.21, barrel-len=0.42, tip-offset=0.02). Now sourced
  // from the shared `muzzleOffset()` helper so the calculation is documented
  // + tweakable in one place.
  let muzzleZ = muzzleOffset(-0.21, 0.42);
  // AK-specific slant brake (default muzzle device for the AK-74) — replaces
  // the generic birdcage when no other muzzle attachment is equipped.
  if (loadout.muzzle === "none") {
    const slant = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.045, 14), mats.parkerized);
    slant.rotation.x = Math.PI / 2; slant.position.set(0, 0.005, muzzleZ - 0.022); group.add(slant);
    // Slant cut — angled face on one side (the signature AK-74 brake shape).
    const slantCut = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 1 }));
    slantCut.position.set(0.012, 0.005, muzzleZ - 0.04); slantCut.rotation.z = 0.4; group.add(slantCut);
    muzzleZ -= 0.045;
  } else {
    muzzleZ = applyMuzzleAttachment(group, mats, loadout, muzzleZ);
  }
  // Optic attachment.
  applyOpticAttachment(group, mats, loadout, 0.072);
  // Foregrip.
  applyForegrip(group, mats, loadout, -0.28, -0.02);
  return muzzleZ;
}

// ─── M4 Carbine ───

export function buildM4(group: THREE.Group, mats: WeaponMaterials, loadout: LoadoutConfig, _ms: THREE.Object3D, _es: THREE.Object3D): number {
  // Upper receiver — flat-top with Picatinny rail. V2-c upgrades:
  //  • Beveled ExtrudeGeometry receiver (chamfered edges catch highlights,
  //    reads as CNC-milled vs a flat slab).
  //  • Skin-aware material — premium/camo/carbon skins get their respective
  //    specialized material on the receiver body.
  const receiverMat = pickReceiverMaterial(loadout.skin as SkinSlug, mats);
  const upper = buildBeveledReceiver(receiverMat, 0.052, 0.08, 0.4, 0.92);
  upper.position.set(0, 0, 0); group.add(upper);
  // Wear + scratch details on the receiver sides (subtle, so the anodized
  // finish doesn't look uniformly smooth).
  addWearScratches(group, mats, 0.040, -0.18, 0.16, 0.052, 0x85ebca77);
  // Takedown pins — front + rear pivot pins (AR-style forged receiver detail).
  group.add(buildTakedownPins(mats, -0.05, 0.12, 1));
  group.add(buildTakedownPins(mats, -0.05, 0.12, -1));
  // Manufacturer marking decal on the mag well.
  group.add(buildMarkingDecal(mats, 0.028, -0.02, -0.04, 0.032, 0.009));
  // Top rail — V2-c uses the extruded Picatinny rail (single mesh with proper
  // slot cross-sections cut in) instead of the assembled buildRail. Reads as a
  // solid machined rail vs a stack of slot recess meshes.
  const rail = buildPicatinnyRailExtruded(mats.parkerized, 0.38, 0.032, 0.012, 12);
  rail.position.set(0, 0.052, 0); group.add(rail);
  // Brass deflector — small bump behind the ejection port (AR signature).
  const brassDef = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.018, 0.018), mats.gunmetal);
  brassDef.position.set(0.031, 0.018, -0.09); group.add(brassDef);
  // Barrel + gas block (M4 has a shorter barrel + front sight base).
  const barrel = buildBarrel(mats, 0.36, 0.019, 0.015, true, -0.22);
  barrel.position.set(0, 0.0, -0.2); group.add(barrel);
  // Handguard — M-LOK style polymer with rail segments. Hex-shaped profile
  // (build from a cylinder with 6 segments — reads as a modern M-LOK rail).
  const hg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.032, 0.24, 6), mats.cerakote);
  hg.rotation.x = Math.PI / 2; hg.position.set(0, 0.005, -0.26); group.add(hg);
  // M-LOK slots — longitudinal slots on 3 sides (top, left, right).
  const mlokMat = new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 1 });
  for (const side of [-1, 0, 1]) {
    for (let i = 0; i < 4; i++) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.005, 0.03), mlokMat);
      const sa = side * Math.PI / 2;
      slot.position.set(Math.sin(sa) * 0.033, 0.005 + Math.cos(sa) * 0.033, -0.18 - i * 0.04);
      if (side !== 0) slot.rotation.y = sa;
      group.add(slot);
    }
  }
  // Vent holes on the handguard top.
  for (let i = 0; i < 5; i++) {
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.008, 0.012), mlokMat);
    vent.position.set(0, 0.032, -0.16 - i * 0.04); group.add(vent);
  }
  // Top rail on handguard — extruded picatinny with rubber cover for grip.
  const hgRail = buildPicatinnyRailExtruded(mats.parkerized, 0.22, 0.03, 0.01, 6, true);
  hgRail.position.set(0, 0.04, -0.26); group.add(hgRail);
  // Magazine — straight STANAG.
  const mag = buildStanagMag(mats, 0.17, 0.042);
  mag.position.set(0, -0.045, -0.02); group.add(mag);
  group.userData.magRef = mag as unknown as THREE.Mesh;
  // Reposition the named magazine socket to the actual mag well position.
  const m4SocketMag = group.userData.socketMagazine as THREE.Object3D | undefined;
  if (m4SocketMag) m4SocketMag.position.set(0, -0.045, -0.02);
  // Pistol grip — V2-c uses the new ribbed grip (cylinder-based ribs) for a
  // more organic Magpul-style texture vs the box-ridge approach.
  const grip = buildRibbedGrip(mats, 0.12, -0.28);
  grip.position.set(0, -0.04, 0.1); group.add(grip);
  group.userData.handleRef = grip;
  // Reposition the named grip + charm sockets to the actual grip position.
  const m4SocketGrip = group.userData.socketGrip as THREE.Object3D | undefined;
  if (m4SocketGrip) m4SocketGrip.position.set(0, -0.04, 0.1);
  const m4SocketCharm = group.userData.socketCharm as THREE.Object3D | undefined;
  if (m4SocketCharm) m4SocketCharm.position.set(0.025, -0.07, 0.10);
  // Collapsible stock.
  const stock = buildM4Stock(mats);
  group.add(stock);
  // Trigger group.
  group.add(buildTriggerGroup(mats, 0.08));
  // T-handle charging handle.
  group.add(buildTHandle(mats, 0.22));
  // Ejection port.
  group.add(buildEjectionPort(mats, -0.05));
  // Selector.
  group.add(buildSelector(mats, 0.05));
  // Iron sights (flip-up).
  group.add(buildIronSights(mats, -0.3, 0.1));
  // Reposition the named sight socket to the top rail height.
  const m4SocketSight = group.userData.socketSight as THREE.Object3D | undefined;
  if (m4SocketSight) m4SocketSight.position.set(0, 0.07, 0.0);

  // B2-5000 #850 — was `let muzzleZ = -0.2 - 0.36 + 0.02;` (M4 receiver-rear
  // z=-0.2, barrel-len=0.36, tip-offset=0.02). Now from shared helper.
  let muzzleZ = muzzleOffset(-0.2, 0.36);
  muzzleZ = applyMuzzleAttachment(group, mats, loadout, muzzleZ);
  applyOpticAttachment(group, mats, loadout, 0.052);
  applyForegrip(group, mats, loadout, -0.28, 0.005);
  return muzzleZ;
}

