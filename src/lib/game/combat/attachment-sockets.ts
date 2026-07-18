/**
 * Section D — Attachment Socket System (Picatinny / M-LOK / KeyMod).
 *
 * Real-world weapons use standardized rail systems to mount attachments:
 *   • Picatinny 1913 — the classic 21-slot rail on every modern rifle.
 *   • M-LOK        — Magpul's modular slot system (lighter, lower profile).
 *   • KeyMod       — VLTOR's modular system (similar to M-LOK, different slot).
 *   • ARCA Swiss   — bipod/foregrip standard for precision rifles.
 *
 * This module defines:
 *   1. Socket types + their physical specs (slot pitch, slot count, position).
 *   2. Per-weapon socket layout — what rail system each weapon has, where.
 *   3. Attachment compatibility — which attachments fit which socket.
 *   4. Position resolution — compute the world-space position of a socket.
 *
 * The existing `WeaponBuilder.ts` already creates named Object3D sockets
 * (`socket_muzzle`, `socket_sight`, `socket_grip`, `socket_magazine`,
 * `socket_charm`). This module adds the rail-system metadata so the
 * Gunsmith can show "Picatinny 1913 — 12 slots" on the spec card and
 * restrict attachment choices to compatible rails.
 */

import type { WeaponType, WeaponCategory } from "../store";
import type { AttachmentSlug, AttachmentType } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Rail system types.
// ─────────────────────────────────────────────────────────────────────────────

export type RailSystem = "picatinny" | "mlok" | "keymod" | "arca" | "fixed" | "dovetail" | "none";

export interface RailSpec {
  system: RailSystem;
  /** Slot pitch (mm). Picatinny = 5.46 mm, M-LOK = variable. */
  slotPitchMm: number;
  /** Number of usable slots. */
  slotCount: number;
  /** Rail length (mm). */
  lengthMm: number;
  /** Maximum attachment weight the rail can support (kg). */
  maxLoadKg: number;
  /** Whether the rail supports quick-detach (QD) sling mounts. */
  hasQdSockets: boolean;
}

export const RAIL_SPECS: Record<RailSystem, Omit<RailSpec, "slotCount" | "lengthMm">> = {
  picatinny: {
    system: "picatinny", slotPitchMm: 5.46, maxLoadKg: 2.5, hasQdSockets: true,
  },
  mlok: {
    system: "mlok", slotPitchMm: 18, maxLoadKg: 1.8, hasQdSockets: true,
  },
  keymod: {
    system: "keymod", slotPitchMm: 18, maxLoadKg: 1.8, hasQdSockets: false,
  },
  arca: {
    system: "arca", slotPitchMm: 35, maxLoadKg: 3.5, hasQdSockets: false,
  },
  fixed: {
    system: "fixed", slotPitchMm: 0, maxLoadKg: 1.5, hasQdSockets: false,
  },
  dovetail: {
    system: "dovetail", slotPitchMm: 0, maxLoadKg: 1.2, hasQdSockets: false,
  },
  none: {
    system: "none", slotPitchMm: 0, maxLoadKg: 0, hasQdSockets: false,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Socket positions — the named mount points on a weapon.
// ─────────────────────────────────────────────────────────────────────────────

export type SocketPosition =
  | "muzzle_device"   // muzzle device (suppressor, comp, brake)
  | "top_rail"        // optics rail
  | "handguard_top"   // handguard top rail (Picatinny segment)
  | "handguard_side"  // handguard side rail (M-LOK / KeyMod slot)
  | "handguard_bottom" // foregrip / bipod / underbarrel
  | "receiver_side"   // receiver side rail (AK pattern)
  | "stock"           // stock-mounted (cheek riser, monopod)
  | "magazine"        // magazine well
  | "grip"            // pistol grip
  | "barrel"          // barrel-mounted (bayonet, bipod)

export interface SocketSpec {
  position: SocketPosition;
  rail: RailSystem;
  /** Slot count available at this position. */
  slots: number;
  /** Length of rail at this position (mm). */
  lengthMm: number;
  /** Position offset relative to weapon origin (meters). */
  offsetM: [number, number, number];
  /** Attachment types that this socket can accept. */
  acceptsTypes: AttachmentType[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-weapon socket layouts. Each weapon declares its rail system + socket
// positions. Defaults to a generic Picatinny-top + M-LOK-handguard layout.
// ─────────────────────────────────────────────────────────────────────────────

function picatinny(slots: number, lengthMm: number): Pick<RailSpec, "system" | "slotCount" | "lengthMm"> {
  return { system: "picatinny", slotCount: slots, lengthMm };
}

function mlok(slots: number, lengthMm: number): Pick<RailSpec, "system" | "slotCount" | "lengthMm"> {
  return { system: "mlok", slotCount: slots, lengthMm };
}

const DEFAULT_RIFLE_SOCKETS: SocketSpec[] = [
  { position: "muzzle_device", rail: "fixed", slots: 1, lengthMm: 30,
    offsetM: [0, 0.02, -0.7], acceptsTypes: ["MUZZLE"] },
  { position: "top_rail", rail: "picatinny", slots: 12, lengthMm: 180,
    offsetM: [0, 0.07, -0.1], acceptsTypes: ["SIGHT"] },
  { position: "handguard_top", rail: "picatinny", slots: 7, lengthMm: 150,
    offsetM: [0, 0.06, -0.35], acceptsTypes: ["SIGHT", "GRIP"] },
  { position: "handguard_side", rail: "mlok", slots: 5, lengthMm: 130,
    offsetM: [0.03, 0.02, -0.35], acceptsTypes: ["GRIP"] },
  { position: "handguard_side", rail: "mlok", slots: 5, lengthMm: 130,
    offsetM: [-0.03, 0.02, -0.35], acceptsTypes: ["GRIP"] },
  { position: "handguard_bottom", rail: "mlok", slots: 5, lengthMm: 130,
    offsetM: [0, -0.02, -0.35], acceptsTypes: ["GRIP"] },
  { position: "magazine", rail: "fixed", slots: 1, lengthMm: 50,
    offsetM: [0, -0.06, -0.02], acceptsTypes: ["MAGAZINE"] },
];

const AK_SOCKETS: SocketSpec[] = [
  { position: "muzzle_device", rail: "fixed", slots: 1, lengthMm: 30,
    offsetM: [0, 0.02, -0.7], acceptsTypes: ["MUZZLE"] },
  { position: "receiver_side", rail: "dovetail", slots: 1, lengthMm: 110,
    offsetM: [0.031, 0.025, 0.04], acceptsTypes: ["SIGHT"] },
  { position: "handguard_bottom", rail: "fixed", slots: 1, lengthMm: 90,
    offsetM: [0, -0.04, -0.25], acceptsTypes: ["GRIP"] },
  { position: "magazine", rail: "fixed", slots: 1, lengthMm: 50,
    offsetM: [0, -0.06, -0.02], acceptsTypes: ["MAGAZINE"] },
];

const PISTOL_SOCKETS: SocketSpec[] = [
  { position: "muzzle_device", rail: "fixed", slots: 1, lengthMm: 20,
    offsetM: [0, 0.01, -0.18], acceptsTypes: ["MUZZLE"] },
  { position: "top_rail", rail: "fixed", slots: 1, lengthMm: 30,
    offsetM: [0, 0.04, -0.05], acceptsTypes: ["SIGHT"] },
  { position: "magazine", rail: "fixed", slots: 1, lengthMm: 30,
    offsetM: [0, -0.06, 0.02], acceptsTypes: ["MAGAZINE"] },
];

const SNIPER_SOCKETS: SocketSpec[] = [
  { position: "muzzle_device", rail: "fixed", slots: 1, lengthMm: 25,
    offsetM: [0, 0.02, -0.9], acceptsTypes: ["MUZZLE"] },
  { position: "top_rail", rail: "picatinny", slots: 8, lengthMm: 160,
    offsetM: [0, 0.09, -0.1], acceptsTypes: ["SIGHT"] },
  { position: "handguard_bottom", rail: "arca", slots: 1, lengthMm: 100,
    offsetM: [0, -0.03, -0.3], acceptsTypes: ["GRIP"] },
  { position: "stock", rail: "fixed", slots: 1, lengthMm: 50,
    offsetM: [0, -0.05, 0.3], acceptsTypes: ["GRIP"] },
  { position: "magazine", rail: "fixed", slots: 1, lengthMm: 50,
    offsetM: [0, -0.05, -0.05], acceptsTypes: ["MAGAZINE"] },
];

const SHOTGUN_SOCKETS: SocketSpec[] = [
  { position: "muzzle_device", rail: "fixed", slots: 1, lengthMm: 30,
    offsetM: [0, 0.02, -0.85], acceptsTypes: ["MUZZLE"] },
  { position: "top_rail", rail: "picatinny", slots: 4, lengthMm: 70,
    offsetM: [0, 0.06, -0.2], acceptsTypes: ["SIGHT"] },
  { position: "handguard_bottom", rail: "fixed", slots: 1, lengthMm: 130,
    offsetM: [0, -0.04, -0.3], acceptsTypes: ["GRIP"] },
  { position: "magazine", rail: "fixed", slots: 1, lengthMm: 50,
    offsetM: [0, -0.05, -0.1], acceptsTypes: ["MAGAZINE"] },
];

const LMG_SOCKETS: SocketSpec[] = [
  { position: "muzzle_device", rail: "fixed", slots: 1, lengthMm: 30,
    offsetM: [0, 0.02, -0.85], acceptsTypes: ["MUZZLE"] },
  { position: "top_rail", rail: "picatinny", slots: 6, lengthMm: 120,
    offsetM: [0, 0.08, -0.1], acceptsTypes: ["SIGHT"] },
  { position: "handguard_bottom", rail: "fixed", slots: 1, lengthMm: 150,
    offsetM: [0, -0.05, -0.4], acceptsTypes: ["GRIP"] },
  { position: "barrel", rail: "fixed", slots: 1, lengthMm: 80,
    offsetM: [0, -0.02, -0.5], acceptsTypes: ["GRIP"] },
];

function socketsForWeapon(slug: WeaponType): SocketSpec[] {
  // AK-pattern weapons (AK-74, Galil, RPK) share the side-rail layout.
  if (slug === "ak74" || slug === "galil" || slug === "rpk") return AK_SOCKETS;
  // Pistols.
  if (slug === "usp" || slug === "deagle" || slug === "glock18" ||
      slug === "m1911" || slug === "revolver") return PISTOL_SOCKETS;
  // Snipers.
  if (slug === "awp" || slug === "scout" || slug === "kar98k" || slug === "l115a3") return SNIPER_SOCKETS;
  // Shotguns.
  if (slug === "nova" || slug === "m1014" || slug === "spas12") return SHOTGUN_SOCKETS;
  // LMGs.
  if (slug === "m249" || slug === "mk48") return LMG_SOCKETS;
  // Default: AR-pattern rifles + SMGs (Picatinny top + M-LOK handguard).
  return DEFAULT_RIFLE_SOCKETS;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compatibility — which attachments fit which socket.
// ─────────────────────────────────────────────────────────────────────────────

const MUZZLE_REQUIRES: RailSystem[] = ["fixed"];
const OPTIC_REQUIRES: RailSystem[] = ["picatinny", "dovetail", "fixed"];
const GRIP_REQUIRES: RailSystem[] = ["picatinny", "mlok", "keymod", "arca", "fixed"];
const MAG_REQUIRES: RailSystem[] = ["fixed"];

/** Returns true if the given attachment can mount on the given socket. */
export function attachmentFitsSocket(
  attachment: AttachmentSlug,
  socket: SocketSpec,
  attachmentType: AttachmentType,
): boolean {
  if (!socket.acceptsTypes.includes(attachmentType)) return false;
  switch (attachmentType) {
    case "MUZZLE":   return MUZZLE_REQUIRES.includes(socket.rail);
    case "SIGHT":    return OPTIC_REQUIRES.includes(socket.rail);
    case "GRIP":     return GRIP_REQUIRES.includes(socket.rail);
    case "MAGAZINE": return MAG_REQUIRES.includes(socket.rail);
    default:         return false;
  }
}

/** Find all sockets on a weapon that can accept the given attachment type. */
export function compatibleSockets(
  weapon: WeaponType,
  attachment: AttachmentSlug,
  attachmentType: AttachmentType,
): SocketSpec[] {
  return socketsForWeapon(weapon).filter((s) =>
    attachmentFitsSocket(attachment, s, attachmentType));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rail-system summary for the spec card.
// ─────────────────────────────────────────────────────────────────────────────

export interface WeaponRailSummary {
  /** Top rail system (for optics). */
  topRail: RailSpec;
  /** Handguard rail system (for grips). */
  handguardRail: RailSpec;
  /** Total usable attachment slots across the weapon. */
  totalSlots: number;
  /** Whether the weapon supports QD sling sockets. */
  hasQdSockets: boolean;
  /** All socket positions on this weapon. */
  sockets: SocketSpec[];
}

export function railSummaryFor(weapon: WeaponType): WeaponRailSummary {
  const sockets = socketsForWeapon(weapon);
  const top = sockets.find((s) => s.position === "top_rail" || s.position === "receiver_side");
  const hg = sockets.find((s) => s.position === "handguard_bottom" || s.position === "handguard_side");
  const topRail = top ? { ...RAIL_SPECS[top.rail], system: top.rail, slotCount: top.slots, lengthMm: top.lengthMm } : { ...RAIL_SPECS.none, slotCount: 0, lengthMm: 0 };
  const handguardRail = hg ? { ...RAIL_SPECS[hg.rail], system: hg.rail, slotCount: hg.slots, lengthMm: hg.lengthMm } : { ...RAIL_SPECS.none, slotCount: 0, lengthMm: 0 };
  return {
    topRail: topRail as RailSpec,
    handguardRail: handguardRail as RailSpec,
    totalSlots: sockets.reduce((sum, s) => sum + s.slots, 0),
    hasQdSockets: sockets.some((s) => RAIL_SPECS[s.rail].hasQdSockets),
    sockets,
  };
}

/** Human-readable label for a rail system. */
export function railLabel(rail: RailSystem): string {
  const labels: Record<RailSystem, string> = {
    picatinny: "Picatinny 1913",
    mlok: "M-LOK",
    keymod: "KeyMod",
    arca: "ARCA Swiss",
    fixed: "Fixed Mount",
    dovetail: "Dovetail Side Rail",
    none: "None",
  };
  return labels[rail];
}

/** All sockets on a weapon, with formatted labels. */
export function socketLabelList(weapon: WeaponType): { position: SocketPosition; rail: string; slots: number }[] {
  return socketsForWeapon(weapon).map((s) => ({
    position: s.position,
    rail: railLabel(s.rail),
    slots: s.slots,
  }));
}
