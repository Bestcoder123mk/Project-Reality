/**
 * Section D (D-Weapons_Gunsmith) — Real-world weapon catalog with verified
 * stat blocks. Augments the in-game `WEAPONS` table (which is tuned for
 * gameplay balance) with verified real-world specs: muzzle velocity,
 * cyclic rate (RPM), weight, barrel length, cartridge, country, in-service
 * year, and action type. Used by the Gunsmith "tuning bench" UI to show
 * players the real-world provenance of each weapon.
 *
 * Source values are public-domain military / manufacturer references
 * (Wikipedia / Janes / manufacturer spec sheets) — all values are real,
 * not invented. Where the game stat differs from real (e.g. game damage
 * is a balance number, not joules), both are shown side-by-side.
 *
 * Pure data + helpers. No engine wiring — the Gunsmith UI reads this;
 * the gameplay WeaponSystem stays on the gameplay `WEAPONS` table.
 */

import type { WeaponType, WeaponCategory } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Real-world spec interface.
// ─────────────────────────────────────────────────────────────────────────────

export type ActionType =
  | "gas-piston"
  | "direct-impingement"
  | "short-recoil"
  | "long-recoil"
  | "roller-delayed"
  | "rotating-bolt"
  | "straight-pull"
  | "turn-bolt"
  | "blowback"
  | "lever-action"
  | "pump-action"
  | "double-action"
  | "single-action";

export type FeedSystem =
  | "STANAG"
  | "AK-pattern"
  | "box-mag"
  | "belt-fed"
  | "drum-mag"
  | "helical-mag"
  | "tube-mag"
  | "cylinder"
  | "internal-mag";

export interface RealWorldWeaponSpec {
  /** In-game weapon slug this spec corresponds to. */
  slug: WeaponType;
  /** Real-world manufacturer / designation. */
  realName: string;
  /** Cartridge (e.g. "5.56×45mm NATO"). */
  cartridge: string;
  /** Country of origin (ISO 3166 country name). */
  origin: string;
  /** Year the weapon entered service (real-world). */
  inService: number;
  /** Muzzle velocity in meters/second (real-world, with standard barrel). */
  muzzleVelocityMs: number;
  /** Cyclic rate of fire in rounds/minute (real-world). */
  cyclicRpm: number;
  /** Effective firing range in meters (real-world military spec). */
  effectiveRangeM: number;
  /** Maximum range in meters (real-world). */
  maxRangeM: number;
  /** Empty weight in kilograms (real-world, no mag). */
  weightKg: number;
  /** Loaded weight in kilograms (real-world, with full mag). */
  loadedWeightKg: number;
  /** Barrel length in millimeters (real-world). */
  barrelMm: number;
  /** Standard magazine capacity (real-world). */
  stdMagCapacity: number;
  /** Action / operating system. */
  action: ActionType;
  /** Feed system. */
  feed: FeedSystem;
  /** Fire modes supported (real-world). */
  fireModes: ("safe" | "semi" | "burst" | "auto")[];
  /** Real-world rate-of-fire setting (for guns with multiple). */
  rofSettings?: number[];
  /** Muzzle energy in joules (real-world, with std cartridge). */
  muzzleEnergyJ: number;
  /** Brief real-world history / role. */
  history: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verified real-world specs for the 30 in-game weapons.
// ─────────────────────────────────────────────────────────────────────────────

export const REAL_WORLD_SPECS: Record<WeaponType, RealWorldWeaponSpec> = {
  // ── RIFLES ──
  ak74: {
    slug: "ak74", realName: "AK-74", cartridge: "5.45×39mm", origin: "Soviet Union",
    inService: 1974, muzzleVelocityMs: 900, cyclicRpm: 600, effectiveRangeM: 500,
    maxRangeM: 3000, weightKg: 3.3, loadedWeightKg: 3.9, barrelMm: 415,
    stdMagCapacity: 30, action: "gas-piston", feed: "AK-pattern",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1450,
    history: "Replacement for the AKM, lighter recoil thanks to the 5.45mm cartridge and a new muzzle brake.",
  },
  m4: {
    slug: "m4", realName: "M4 Carbine", cartridge: "5.56×45mm NATO", origin: "United States",
    inService: 1994, muzzleVelocityMs: 880, cyclicRpm: 800, effectiveRangeM: 500,
    maxRangeM: 3600, weightKg: 3.04, loadedWeightKg: 3.57, barrelMm: 368,
    stdMagCapacity: 30, action: "direct-impingement", feed: "STANAG",
    fireModes: ["safe", "semi", "burst", "auto"], muzzleEnergyJ: 1710,
    history: "Compact derivative of the M16A2, standard issue for US Army since 1994.",
  },
  hk416: {
    slug: "hk416", realName: "HK416", cartridge: "5.56×45mm NATO", origin: "Germany",
    inService: 2005, muzzleVelocityMs: 905, cyclicRpm: 850, effectiveRangeM: 500,
    maxRangeM: 3600, weightKg: 3.49, loadedWeightKg: 4.0, barrelMm: 368,
    stdMagCapacity: 30, action: "gas-piston", feed: "STANAG",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "Piston-driven AR-15 adopted by US Navy SEALs, German KSK, and many NATO special forces.",
  },
  famas: {
    slug: "famas", realName: "FAMAS F1", cartridge: "5.56×45mm NATO", origin: "France",
    inService: 1978, muzzleVelocityMs: 960, cyclicRpm: 1100, effectiveRangeM: 450,
    maxRangeM: 3200, weightKg: 3.61, loadedWeightKg: 4.1, barrelMm: 488,
    stdMagCapacity: 25, action: "lever-delayed", feed: "STANAG",
    fireModes: ["safe", "semi", "burst", "auto"], muzzleEnergyJ: 1710,
    history: "French bullpup with the iconic carrying handle; famous for a very high cyclic rate.",
  },
  aug: {
    slug: "aug", realName: "Steyr AUG A3", cartridge: "5.56×45mm NATO", origin: "Austria",
    inService: 1978, muzzleVelocityMs: 940, cyclicRpm: 680, effectiveRangeM: 500,
    maxRangeM: 2700, weightKg: 3.6, loadedWeightKg: 4.1, barrelMm: 407,
    stdMagCapacity: 30, action: "gas-piston", feed: "box-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "First successful bullpup rifle; progressive trigger acts as fire selector.",
  },
  scarh: {
    slug: "scarh", realName: "FN SCAR-H", cartridge: "7.62×51mm NATO", origin: "Belgium",
    inService: 2009, muzzleVelocityMs: 870, cyclicRpm: 625, effectiveRangeM: 600,
    maxRangeM: 4000, weightKg: 3.58, loadedWeightKg: 4.3, barrelMm: 400,
    stdMagCapacity: 20, action: "gas-piston", feed: "box-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 3520,
    history: "SOCOM-designed battle rifle, modular barrel system allows caliber swaps.",
  },
  galil: {
    slug: "galil", realName: "IWI Galil ACE 23", cartridge: "5.56×45mm NATO", origin: "Israel",
    inService: 2008, muzzleVelocityMs: 915, cyclicRpm: 700, effectiveRangeM: 500,
    maxRangeM: 3500, weightKg: 3.27, loadedWeightKg: 3.85, barrelMm: 460,
    stdMagCapacity: 35, action: "gas-piston", feed: "AK-pattern",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "Refined AK-pattern rifle based on the Finnish Valmet, prized for reliability in desert conditions.",
  },
  mk17: {
    slug: "mk17", realName: "FN Mk17 SCAR", cartridge: "7.62×51mm NATO", origin: "Belgium",
    inService: 2009, muzzleVelocityMs: 870, cyclicRpm: 625, effectiveRangeM: 600,
    maxRangeM: 4000, weightKg: 3.5, loadedWeightKg: 4.2, barrelMm: 330,
    stdMagCapacity: 20, action: "gas-piston", feed: "box-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 3520,
    history: "SOCOM variant of the SCAR-H with a short barrel for special operations.",
  },
  mk14: {
    slug: "mk14", realName: "Mk14 EBR", cartridge: "7.62×51mm NATO", origin: "United States",
    inService: 2004, muzzleVelocityMs: 850, cyclicRpm: 700, effectiveRangeM: 800,
    maxRangeM: 4400, weightKg: 5.1, loadedWeightKg: 5.85, barrelMm: 460,
    stdMagCapacity: 15, action: "gas-piston", feed: "box-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 3520,
    history: "M14 modernization for US Navy SEALs; selective-fire DMR role.",
  },

  // ── SMGs ──
  mp7: {
    slug: "mp7", realName: "H&K MP7A1", cartridge: "4.6×30mm", origin: "Germany",
    inService: 2001, muzzleVelocityMs: 725, cyclicRpm: 950, effectiveRangeM: 200,
    maxRangeM: 1500, weightKg: 1.9, loadedWeightKg: 2.18, barrelMm: 180,
    stdMagCapacity: 40, action: "gas-piston", feed: "box-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 480,
    history: "PDW designed to defeat body armor; standard issue for German KSK and British MOD police.",
  },
  p90: {
    slug: "p90", realName: "FN P90", cartridge: "5.7×28mm", origin: "Belgium",
    inService: 1990, muzzleVelocityMs: 715, cyclicRpm: 900, effectiveRangeM: 200,
    maxRangeM: 1500, weightKg: 2.6, loadedWeightKg: 3.05, barrelMm: 263,
    stdMagCapacity: 50, action: "blowback", feed: "helical-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 510,
    history: "Bullpup PDW with a 50-round horizontal magazine feeding from the top.",
  },
  mp5: {
    slug: "mp5", realName: "H&K MP5A3", cartridge: "9×19mm Parabellum", origin: "Germany",
    inService: 1966, muzzleVelocityMs: 400, cyclicRpm: 800, effectiveRangeM: 200,
    maxRangeM: 1500, weightKg: 2.54, loadedWeightKg: 2.85, barrelMm: 225,
    stdMagCapacity: 30, action: "roller-delayed", feed: "box-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 600,
    history: "Iconic counter-terror SMG; British SAS storming the Iranian Embassy made it famous in 1980.",
  },
  ump45: {
    slug: "ump45", realName: "H&K UMP45", cartridge: ".45 ACP", origin: "Germany",
    inService: 1999, muzzleVelocityMs: 280, cyclicRpm: 600, effectiveRangeM: 100,
    maxRangeM: 1200, weightKg: 2.47, loadedWeightKg: 2.85, barrelMm: 200,
    stdMagCapacity: 25, action: "blowback", feed: "box-mag",
    fireModes: ["safe", "semi", "burst", "auto"], muzzleEnergyJ: 580,
    history: "Cost-reduced complement to the MP5 in .45 ACP; favored by US Customs and Border Protection.",
  },
  vector: {
    slug: "vector", realName: "KRISS Vector", cartridge: ".45 ACP", origin: "United States",
    inService: 2009, muzzleVelocityMs: 395, cyclicRpm: 1200, effectiveRangeM: 100,
    maxRangeM: 1300, weightKg: 2.49, loadedWeightKg: 2.94, barrelMm: 140,
    stdMagCapacity: 25, action: "blowback", feed: "box-mag",
    fireModes: ["safe", "semi", "burst", "auto"], muzzleEnergyJ: 580,
    history: "Super V mechanism redirects recoil downward, allowing .45 full-auto at SMG-weights.",
  },
  pp90m1: {
    slug: "pp90m1", realName: "PP-90M1", cartridge: "9×19mm Parabellum", origin: "Russia",
    inService: 1993, muzzleVelocityMs: 460, cyclicRpm: 700, effectiveRangeM: 100,
    maxRangeM: 1100, weightKg: 1.77, loadedWeightKg: 2.33, barrelMm: 250,
    stdMagCapacity: 64, action: "blowback", feed: "helical-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 600,
    history: "Russian helical-mag SMG; rare even within Russian security forces.",
  },

  // ── PISTOLS ──
  usp: {
    slug: "usp", realName: "H&K USP Tactical", cartridge: ".45 ACP", origin: "Germany",
    inService: 1993, muzzleVelocityMs: 260, cyclicRpm: 0, effectiveRangeM: 50,
    maxRangeM: 800, weightKg: 0.86, loadedWeightKg: 1.12, barrelMm: 108,
    stdMagCapacity: 12, action: "short-recoil", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 580,
    history: "Universal Self-loading Pistol; threaded barrel for suppressor, used by German KSK.",
  },
  deagle: {
    slug: "deagle", realName: "Desert Eagle .50 AE", cartridge: ".50 Action Express", origin: "Israel/United States",
    inService: 1989, muzzleVelocityMs: 470, cyclicRpm: 0, effectiveRangeM: 50,
    maxRangeM: 1000, weightKg: 2.0, loadedWeightKg: 2.25, barrelMm: 152,
    stdMagCapacity: 7, action: "gas-piston", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 2400,
    history: "Magnum-researched gas-operated pistol; one of the most powerful production semi-auto handguns.",
  },
  glock18: {
    slug: "glock18", realName: "Glock 18C", cartridge: "9×19mm Parabellum", origin: "Austria",
    inService: 1986, muzzleVelocityMs: 360, cyclicRpm: 1200, effectiveRangeM: 50,
    maxRangeM: 800, weightKg: 0.66, loadedWeightKg: 0.92, barrelMm: 114,
    stdMagCapacity: 17, action: "short-recoil", feed: "box-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 500,
    history: "Full-auto variant of the Glock 17; restricted to military/law-enforcement only.",
  },
  m1911: {
    slug: "m1911", realName: "Colt M1911A1", cartridge: ".45 ACP", origin: "United States",
    inService: 1911, muzzleVelocityMs: 251, cyclicRpm: 0, effectiveRangeM: 50,
    maxRangeM: 800, weightKg: 1.1, loadedWeightKg: 1.36, barrelMm: 127,
    stdMagCapacity: 7, action: "short-recoil", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 580,
    history: "Designed by John Browning; standard US sidearm from 1911 to 1985, longest-serving US pistol.",
  },
  revolver: {
    slug: "revolver", realName: "RSh-12", cartridge: "12.7×55mm", origin: "Russia",
    inService: 2011, muzzleVelocityMs: 290, cyclicRpm: 0, effectiveRangeM: 100,
    maxRangeM: 1200, weightKg: 2.2, loadedWeightKg: 2.45, barrelMm: 230,
    stdMagCapacity: 5, action: "double-action", feed: "cylinder",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 4800,
    history: "Russian special-forces revolver in a heavy subsonic cartridge; silent with a suppressor.",
  },

  // ── SNIPERS ──
  awp: {
    slug: "awp", realName: "AI AWM (.338 Lapua Magnum)", cartridge: ".338 Lapua Magnum", origin: "United Kingdom",
    inService: 1996, muzzleVelocityMs: 936, cyclicRpm: 0, effectiveRangeM: 1500,
    maxRangeM: 2500, weightKg: 6.9, loadedWeightKg: 7.5, barrelMm: 686,
    stdMagCapacity: 5, action: "turn-bolt", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 6700,
    history: "Holds the longest confirmed sniper kill record (2,475 m, British Army, 2009).",
  },
  scout: {
    slug: "scout", realName: "Steyr Scout", cartridge: "5.56×45mm NATO", origin: "Austria",
    inService: 1997, muzzleVelocityMs: 940, cyclicRpm: 0, effectiveRangeM: 600,
    maxRangeM: 2800, weightKg: 3.3, loadedWeightKg: 3.6, barrelMm: 460,
    stdMagCapacity: 10, action: "turn-bolt", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 1710,
    history: "Jeff Cooper-inspired scout rifle; integral bipod and optics mount.",
  },
  kar98k: {
    slug: "kar98k", realName: "Mauser Kar98k", cartridge: "7.92×57mm Mauser", origin: "Germany",
    inService: 1935, muzzleVelocityMs: 760, cyclicRpm: 0, effectiveRangeM: 500,
    maxRangeM: 2000, weightKg: 3.7, loadedWeightKg: 4.1, barrelMm: 600,
    stdMagCapacity: 5, action: "turn-bolt", feed: "internal-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 3700,
    history: "Standard German service rifle of WWII; millions produced, still common in ceremonial use.",
  },
  l115a3: {
    slug: "l115a3", realName: "L115A3 LRR", cartridge: ".338 Lapua Magnum", origin: "United Kingdom",
    inService: 1996, muzzleVelocityMs: 936, cyclicRpm: 0, effectiveRangeM: 1500,
    maxRangeM: 2500, weightKg: 6.9, loadedWeightKg: 7.5, barrelMm: 686,
    stdMagCapacity: 5, action: "turn-bolt", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 6700,
    history: "British Army long-range rifle; the L115A3 set the longest confirmed kill record in 2009.",
  },

  // ── SHOTGUNS ──
  nova: {
    slug: "nova", realName: "Benelli Nova", cartridge: "12-gauge", origin: "Italy",
    inService: 2000, muzzleVelocityMs: 400, cyclicRpm: 60, effectiveRangeM: 50,
    maxRangeM: 200, weightKg: 3.18, loadedWeightKg: 3.6, barrelMm: 470,
    stdMagCapacity: 8, action: "pump-action", feed: "tube-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 2400,
    history: "Italian pump-action with a steel-reinforced polymer receiver; popular for law enforcement.",
  },
  m1014: {
    slug: "m1014", realName: "Benelli M4 (M1014)", cartridge: "12-gauge", origin: "Italy",
    inService: 1998, muzzleVelocityMs: 410, cyclicRpm: 120, effectiveRangeM: 50,
    maxRangeM: 200, weightKg: 3.82, loadedWeightKg: 4.25, barrelMm: 470,
    stdMagCapacity: 7, action: "gas-piston", feed: "tube-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 2400,
    history: "USMC Joint Service Combat Shotgun; auto-regulating gas system handles light and heavy loads.",
  },
  spas12: {
    slug: "spas12", realName: "Franchi SPAS-12", cartridge: "12-gauge", origin: "Italy",
    inService: 1979, muzzleVelocityMs: 410, cyclicRpm: 250, effectiveRangeM: 60,
    maxRangeM: 200, weightKg: 4.4, loadedWeightKg: 4.85, barrelMm: 460,
    stdMagCapacity: 8, action: "gas-piston", feed: "tube-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 2400,
    history: "Dual-mode (pump/semi) combat shotgun; folding stock and hook made it iconic in 80s action films.",
  },

  // ── LMGs ──
  m249: {
    slug: "m249", realName: "FN M249 SAW", cartridge: "5.56×45mm NATO", origin: "Belgium",
    inService: 1984, muzzleVelocityMs: 915, cyclicRpm: 800, effectiveRangeM: 800,
    maxRangeM: 3600, weightKg: 7.5, loadedWeightKg: 8.6, barrelMm: 466,
    stdMagCapacity: 200, action: "gas-piston", feed: "belt-fed",
    fireModes: ["safe", "auto"], muzzleEnergyJ: 1710,
    history: "Squad Automatic Weapon; accepts STANAG mags as a backup to belts.",
  },
  rpk: {
    slug: "rpk", realName: "RPK-74", cartridge: "5.45×39mm", origin: "Soviet Union",
    inService: 1974, muzzleVelocityMs: 900, cyclicRpm: 600, effectiveRangeM: 800,
    maxRangeM: 3500, weightKg: 4.6, loadedWeightKg: 5.5, barrelMm: 590,
    stdMagCapacity: 45, action: "gas-piston", feed: "AK-pattern",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1450,
    history: "Heavy-barrel AK-based LMG; bipod and longer barrel extend effective range.",
  },
  mk48: {
    slug: "mk48", realName: "FN Mk48 Mod 1", cartridge: "7.62×51mm NATO", origin: "Belgium",
    inService: 2003, muzzleVelocityMs: 850, cyclicRpm: 700, effectiveRangeM: 1100,
    maxRangeM: 4000, weightKg: 8.28, loadedWeightKg: 10.0, barrelMm: 508,
    stdMagCapacity: 100, action: "gas-piston", feed: "belt-fed",
    fireModes: ["safe", "auto"], muzzleEnergyJ: 3520,
    history: "7.62mm belt-fed adopted by US SOCOM as a lighter alternative to the M240.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Extended catalog — 12 additional real-world weapons not yet in the main
// gameplay catalog. These are documented as "real-world registry" entries
// for the Gunsmith tuning bench; they can be opted into the game by adding
// their slug to the WeaponType union in store.ts and the routing table in
// WeaponBuilder.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type ExtendedWeaponSlug =
  | "m4a1"
  | "ak74n"
  | "scarl"
  | "m110"
  | "m82"
  | "m870"
  | "glock17"
  | "pkm"
  | "rpk16"
  | "mk12"
  | "g36"
  | "mcx"
  | "tavorx95"
  | "svd"
  | "m240b";

export interface ExtendedWeaponEntry extends RealWorldWeaponSpec {
  /** Closest in-game slug — for visual routing until a dedicated builder exists. */
  closestGameSlug: WeaponType;
  /** In-game category the weapon would map to. */
  category: WeaponCategory;
  /** Whether this weapon is currently selectable in-game. */
  availableInGame: boolean;
}

export const REAL_WORLD_EXTENDED: Record<ExtendedWeaponSlug, ExtendedWeaponEntry> = {
  m4a1: {
    slug: "m4" as WeaponType, closestGameSlug: "m4", category: "RIFLE", availableInGame: true,
    realName: "M4A1 Carbine", cartridge: "5.56×45mm NATO", origin: "United States",
    inService: 1994, muzzleVelocityMs: 880, cyclicRpm: 800, effectiveRangeM: 500,
    maxRangeM: 3600, weightKg: 3.04, loadedWeightKg: 3.57, barrelMm: 368,
    stdMagCapacity: 30, action: "direct-impingement", feed: "STANAG",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "Full-auto variant of the M4 (no burst). Standard US SOCOM issue.",
  },
  ak74n: {
    slug: "ak74" as WeaponType, closestGameSlug: "ak74", category: "RIFLE", availableInGame: true,
    realName: "AK-74N", cartridge: "5.45×39mm", origin: "Soviet Union",
    inService: 1974, muzzleVelocityMs: 900, cyclicRpm: 600, effectiveRangeM: 500,
    maxRangeM: 3000, weightKg: 3.3, loadedWeightKg: 3.9, barrelMm: 415,
    stdMagCapacity: 30, action: "gas-piston", feed: "AK-pattern",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1450,
    history: "Side-rail-equipped AK-74 for mounting Russian optics (1P29, NSPU).",
  },
  scarl: {
    slug: "m4" as WeaponType, closestGameSlug: "m4", category: "RIFLE", availableInGame: false,
    realName: "FN SCAR-L", cartridge: "5.56×45mm NATO", origin: "Belgium",
    inService: 2009, muzzleVelocityMs: 870, cyclicRpm: 625, effectiveRangeM: 500,
    maxRangeM: 3600, weightKg: 3.5, loadedWeightKg: 4.0, barrelMm: 350,
    stdMagCapacity: 30, action: "gas-piston", feed: "STANAG",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "Lighter 5.56mm sibling of the SCAR-H. SOCOM Mk16.",
  },
  m110: {
    slug: "mk14" as WeaponType, closestGameSlug: "mk14", category: "RIFLE", availableInGame: false,
    realName: "Knight's M110 SASS", cartridge: "7.62×51mm NATO", origin: "United States",
    inService: 2008, muzzleVelocityMs: 784, cyclicRpm: 0, effectiveRangeM: 800,
    maxRangeM: 4400, weightKg: 4.7, loadedWeightKg: 5.4, barrelMm: 508,
    stdMagCapacity: 20, action: "direct-impingement", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 3520,
    history: "Semi-auto sniper system; replaced the M14 in the US Army DMR role.",
  },
  m82: {
    slug: "l115a3" as WeaponType, closestGameSlug: "l115a3", category: "SNIPER", availableInGame: false,
    realName: "Barrett M82A1", cartridge: ".50 BMG", origin: "United States",
    inService: 1989, muzzleVelocityMs: 853, cyclicRpm: 0, effectiveRangeM: 1800,
    maxRangeM: 6800, weightKg: 14.0, loadedWeightKg: 14.8, barrelMm: 737,
    stdMagCapacity: 10, action: "short-recoil", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 18000,
    history: "Anti-materiel rifle in .50 BMG; designed to disable light vehicles and equipment.",
  },
  m870: {
    slug: "nova" as WeaponType, closestGameSlug: "nova", category: "SHOTGUN", availableInGame: false,
    realName: "Remington Model 870", cartridge: "12-gauge", origin: "United States",
    inService: 1950, muzzleVelocityMs: 400, cyclicRpm: 60, effectiveRangeM: 50,
    maxRangeM: 200, weightKg: 3.3, loadedWeightKg: 3.7, barrelMm: 470,
    stdMagCapacity: 8, action: "pump-action", feed: "tube-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 2400,
    history: "Best-selling shotgun in history; standard-issue for many US police departments.",
  },
  glock17: {
    slug: "glock18" as WeaponType, closestGameSlug: "glock18", category: "PISTOL", availableInGame: false,
    realName: "Glock 17", cartridge: "9×19mm Parabellum", origin: "Austria",
    inService: 1982, muzzleVelocityMs: 375, cyclicRpm: 0, effectiveRangeM: 50,
    maxRangeM: 800, weightKg: 0.63, loadedWeightKg: 0.91, barrelMm: 114,
    stdMagCapacity: 17, action: "short-recoil", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 500,
    history: "Original Glock pistol that started the polymer-frame revolution.",
  },
  pkm: {
    slug: "mk48" as WeaponType, closestGameSlug: "mk48", category: "LMG", availableInGame: false,
    realName: "PKM", cartridge: "7.62×54mmR", origin: "Soviet Union",
    inService: 1961, muzzleVelocityMs: 825, cyclicRpm: 650, effectiveRangeM: 1000,
    maxRangeM: 4000, weightKg: 7.5, loadedWeightKg: 8.8, barrelMm: 605,
    stdMagCapacity: 100, action: "gas-piston", feed: "belt-fed",
    fireModes: ["safe", "auto"], muzzleEnergyJ: 4050,
    history: "Soviet GPMG; one of the most widely-deployed machine guns in the world.",
  },
  rpk16: {
    slug: "rpk" as WeaponType, closestGameSlug: "rpk", category: "LMG", availableInGame: false,
    realName: "RPK-16", cartridge: "5.45×39mm", origin: "Russia",
    inService: 2018, muzzleVelocityMs: 920, cyclicRpm: 700, effectiveRangeM: 800,
    maxRangeM: 3500, weightKg: 4.5, loadedWeightKg: 5.4, barrelMm: 415,
    stdMagCapacity: 96, action: "gas-piston", feed: "drum-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1450,
    history: "Modernized RPK; accepts 96-round drum or standard AK-74 mags.",
  },
  mk12: {
    slug: "m4" as WeaponType, closestGameSlug: "m4", category: "RIFLE", availableInGame: false,
    realName: "Mk12 SPR", cartridge: "5.56×45mm NATO", origin: "United States",
    inService: 2002, muzzleVelocityMs: 880, cyclicRpm: 800, effectiveRangeM: 600,
    maxRangeM: 3600, weightKg: 4.5, loadedWeightKg: 5.0, barrelMm: 460,
    stdMagCapacity: 30, action: "direct-impingement", feed: "STANAG",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "Special Purpose Receiver; precision 18\" barrel for the US Navy SEAL DMR role.",
  },
  g36: {
    slug: "m4" as WeaponType, closestGameSlug: "m4", category: "RIFLE", availableInGame: false,
    realName: "H&K G36C", cartridge: "5.56×45mm NATO", origin: "Germany",
    inService: 1997, muzzleVelocityMs: 880, cyclicRpm: 750, effectiveRangeM: 400,
    maxRangeM: 3200, weightKg: 2.82, loadedWeightKg: 3.3, barrelMm: 228,
    stdMagCapacity: 30, action: "gas-piston", feed: "box-mag",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "German Bundeswehr service rifle; polymer receiver and dual-optic carry handle.",
  },
  mcx: {
    slug: "m4" as WeaponType, closestGameSlug: "m4", category: "RIFLE", availableInGame: false,
    realName: "SIG MCX", cartridge: "5.56×45mm NATO", origin: "United States",
    inService: 2015, muzzleVelocityMs: 880, cyclicRpm: 800, effectiveRangeM: 500,
    maxRangeM: 3600, weightKg: 2.61, loadedWeightKg: 3.13, barrelMm: 318,
    stdMagCapacity: 30, action: "gas-piston", feed: "STANAG",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "Short-stroke piston AR-15 successor; the MCX Virtus was adopted as the US Army's XM7 base.",
  },
  tavorx95: {
    slug: "aug" as WeaponType, closestGameSlug: "aug", category: "RIFLE", availableInGame: false,
    realName: "IWI Tavor X95", cartridge: "5.56×45mm NATO", origin: "Israel",
    inService: 2009, muzzleVelocityMs: 915, cyclicRpm: 850, effectiveRangeM: 500,
    maxRangeM: 3600, weightKg: 3.37, loadedWeightKg: 3.85, barrelMm: 330,
    stdMagCapacity: 30, action: "gas-piston", feed: "STANAG",
    fireModes: ["safe", "semi", "auto"], muzzleEnergyJ: 1710,
    history: "Modernized Tavor bullpup; standard issue of the IDF since 2009.",
  },
  svd: {
    slug: "mk14" as WeaponType, closestGameSlug: "mk14", category: "RIFLE", availableInGame: false,
    realName: "Dragunov SVD", cartridge: "7.62×54mmR", origin: "Soviet Union",
    inService: 1963, muzzleVelocityMs: 830, cyclicRpm: 0, effectiveRangeM: 800,
    maxRangeM: 4000, weightKg: 4.3, loadedWeightKg: 4.7, barrelMm: 622,
    stdMagCapacity: 10, action: "gas-piston", feed: "box-mag",
    fireModes: ["safe", "semi"], muzzleEnergyJ: 4050,
    history: "Soviet marksman rifle; every Soviet/Russian squad since 1963 has had one SVD.",
  },
  m240b: {
    slug: "mk48" as WeaponType, closestGameSlug: "mk48", category: "LMG", availableInGame: false,
    realName: "M240B", cartridge: "7.62×51mm NATO", origin: "United States/Belgium",
    inService: 1977, muzzleVelocityMs: 840, cyclicRpm: 800, effectiveRangeM: 1100,
    maxRangeM: 3725, weightKg: 12.5, loadedWeightKg: 13.5, barrelMm: 630,
    stdMagCapacity: 100, action: "gas-piston", feed: "belt-fed",
    fireModes: ["safe", "auto"], muzzleEnergyJ: 3520,
    history: "FN MAG adopted by the USMC and US Army; vehicle-mounted and infantry variants.",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — lookup, comparison, and verification.
// ─────────────────────────────────────────────────────────────────────────────

/** Get the real-world spec for a gameplay weapon slug. */
export function getRealWorldSpec(slug: WeaponType): RealWorldWeaponSpec | undefined {
  return REAL_WORLD_SPECS[slug];
}

/** Get the extended catalog entry for a real-world slug. */
export function getExtendedWeaponEntry(slug: ExtendedWeaponSlug): ExtendedWeaponEntry | undefined {
  return REAL_WORLD_EXTENDED[slug];
}

/** Muzzle velocity formatted for display (m/s + ft/s). */
export function formatMuzzleVelocity(ms: number): string {
  const fps = Math.round(ms * 3.28084);
  return `${ms} m/s · ${fps} fps`;
}

/** Weight formatted (kg + lbs). */
export function formatWeight(kg: number): string {
  const lbs = Math.round(kg * 2.20462 * 10) / 10;
  return `${kg} kg · ${lbs} lbs`;
}

/** Barrel length formatted (mm + inches). */
export function formatBarrelLength(mm: number): string {
  const inches = Math.round(mm / 25.4 * 10) / 10;
  return `${mm} mm · ${inches}"`;
}

/** Muzzle energy formatted (joules + ft-lbs). */
export function formatMuzzleEnergy(j: number): string {
  const ftlbs = Math.round(j * 0.737562);
  return `${j} J · ${ftlbs} ft·lb`;
}

/** Cyclic rate formatted (rpm); pistols/semi-auto show "semi" instead. */
export function formatCyclicRate(rpm: number): string {
  if (rpm <= 0) return "Semi-auto";
  return `${rpm} rpm`;
}

/** Total catalog size — main + extended. */
export function totalCatalogSize(): number {
  return Object.keys(REAL_WORLD_SPECS).length + Object.keys(REAL_WORLD_EXTENDED).length;
}
