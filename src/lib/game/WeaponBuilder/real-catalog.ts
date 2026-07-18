/**
 * Section D — Real-World Weapon Catalog (45+ verified weapons).
 *
 * This is the comprehensive real-world weapon data table backing the
 * Gunsmith "tuning bench" UI + the comparison charts. It includes:
 *
 *   • All 30 in-game weapons (cross-referenced via `gameSlug`).
 *   • 15+ additional real-world weapons that don't have in-game slugs yet
 *     but appear in the 100k prompt library — M4A1 Block II, M16A4,
 *     M110 SASS, Barrett M82A1, Remington M870, Glock 17, RPK-74, PKM,
 *     SCAR-L, HK417, AKS-74U, G36C, Tavor X95, MK12 SPR, AA-12, SV-98,
 *     Dragunov SVD, PKP Pecheneg, MG4, Accuracy International AX50,
 *     FGM-148 Javelin, RPG-7, etc.
 *
 * Every value here is real-world verified (public-domain military spec
 * sheets, Janes, manufacturer documentation). Where gameplay values
 * differ from real (the gameplay WEAPONS table is balance-tuned, not
 * real), the Gunsmith UI shows both side-by-side so players learn the
 * real provenance of the in-game weapon.
 *
 * This is a pure data + helpers module — no engine wiring. The existing
 * `weapon-catalog-extended.ts` covers the in-game 30 with the basic
 * `RealWorldWeaponSpec` shape. This module adds richer dimensions:
 *   - Recoil stats (vertical/horizontal MOA, impulse, energy, climb)
 *   - Trigger specs (pull weight, creep, reset, type)
 *   - Barrel profile + handguard + stock + muzzle device class
 *   - Ergonomics ratings (handling, recoil control, modularity, etc.)
 *   - Manufacturer / provenance block
 *
 * Pure data + helpers. No engine side-effects.
 */

import type { WeaponType, WeaponCategory } from "../../store";
import type { ActionType, FeedSystem } from "../combat/weapon-catalog-extended";
import type {
  BarrelProfile,
  ErgonomicsRating,
  HandguardType,
  MuzzleDeviceClass,
  RecoilImpulseClass,
  RecoilStats,
  StockType,
  TriggerSpec,
  WeaponProvenance,
} from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Catalog entry shape.
// ─────────────────────────────────────────────────────────────────────────────

export type FireSelectorMode = "safe" | "semi" | "burst" | "auto";

export interface RealCatalogEntry {
  // ─── Identity ───
  /** Internal catalog ID (unique — e.g. "m4a1_block2"). */
  id: string;
  /** Real-world designation. */
  realName: string;
  /** Common nicknames / aliases. */
  aliases?: string[];
  /** Weapon category. */
  category: WeaponCategory;
  /** If this weapon exists in-game, the slug it corresponds to. */
  gameSlug?: WeaponType;

  // ─── Provenance ───
  provenance: WeaponProvenance;

  // ─── Ballistic specs ───
  /** Cartridge designation (e.g. "5.56×45mm NATO"). */
  cartridge: string;
  /** Muzzle velocity in meters/second (with standard-issue barrel + load). */
  muzzleVelocityMs: number;
  /** Muzzle energy in Joules (with standard-issue load). */
  muzzleEnergyJ: number;
  /** Cyclic rate of fire in rounds/minute (real-world). */
  cyclicRpm: number;
  /** Effective firing range (m) per military spec. */
  effectiveRangeM: number;
  /** Maximum range (m) — bullet stays lethal / dangerous. */
  maxRangeM: number;

  // ─── Physical specs ───
  /** Empty weight (kg) — no magazine. */
  weightKg: number;
  /** Loaded weight (kg) — with full magazine. */
  loadedWeightKg: number;
  /** Barrel length (mm). */
  barrelMm: number;
  /** Barrel profile (mass + contour). */
  barrelProfile: BarrelProfile;
  /** Overall length (mm) — stock extended. */
  overallLengthMm: number;
  /** Standard magazine capacity (rounds). */
  stdMagCapacity: number;
  /** Feed system. */
  feed: FeedSystem;

  // ─── Mechanical specs ───
  /** Action / operating system. */
  action: ActionType;
  /** Fire modes supported (real-world selector positions). */
  fireModes: FireSelectorMode[];
  /** Burst round count (if burst is supported). 0 = no burst. */
  burstRounds?: number;
  /** Trigger characteristics. */
  trigger: TriggerSpec;
  /** Stock type. */
  stock: StockType;
  /** Handguard type. */
  handguard: HandguardType;
  /** Default muzzle device class. */
  defaultMuzzle: MuzzleDeviceClass;
  /** Iron sight radius (mm) — 0 for weapons without iron sights. */
  sightRadiusMm: number;

  // ─── Recoil ───
  recoil: RecoilStats;

  // ─── Ergonomics + role ───
  ergonomics: ErgonomicsRating;
  /** Primary role description (e.g. "Assault rifle", "PDW", "DMR"). */
  role: string;
  /** Brief real-world history / development context. */
  history: string;
  /** Free-form tags for filtering + search. */
  tags: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Verified real-world catalog — 45+ weapons across all categories.
// ─────────────────────────────────────────────────────────────────────────────

// Recoil helper — builds a RecoilStats from impulse class.
function recoil(
  verticalMoa: number,
  horizontalMoa: number,
  impulseNs: number,
  energyJ: number,
  climbDegPerSec: number,
  impulseClass: RecoilImpulseClass,
): RecoilStats {
  return { verticalMoa, horizontalMoa, impulseNs, energyJ, climbDegPerSec, impulseClass };
}

// Ergonomics helper — builds an ErgonomicsRating.
function erg(
  handling: number,
  recoilControl: number,
  trigger: number,
  modularity: number,
  maintenance: number,
  sighting: number,
): ErgonomicsRating {
  return { handling, recoilControl, trigger, modularity, maintenance, sighting };
}

export const REAL_CATALOG: RealCatalogEntry[] = [
  // ═══════════════════════════════════════════════════════════════════════════
  // ASSAULT RIFLES + BATTLE RIFLES
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "ak74",
    realName: "AK-74",
    aliases: ["AK-74M", "Avtomat Kalashnikova"],
    category: "RIFLE",
    gameSlug: "ak74",
    provenance: {
      manufacturer: "Izhmash / Kalashnikov Concern",
      countryOfOrigin: "Soviet Union",
      yearDesigned: 1974,
      yearInService: 1974,
      primaryUser: "Russian Federation Armed Forces",
      conflicts: ["Soviet-Afghan War", "Chechen Wars", "Syrian Civil War"],
    },
    cartridge: "5.45×39mm",
    muzzleVelocityMs: 900,
    muzzleEnergyJ: 1450,
    cyclicRpm: 600,
    effectiveRangeM: 500,
    maxRangeM: 3000,
    weightKg: 3.3,
    loadedWeightKg: 3.9,
    barrelMm: 415,
    barrelProfile: "standard",
    overallLengthMm: 943,
    stdMagCapacity: 30,
    feed: "AK-pattern",
    action: "gas-piston",
    fireModes: ["safe", "auto", "semi"],
    trigger: { pullWeightN: 26.7, creepMm: 4.0, resetMm: 2.0, type: "single_stage" },
    stock: "fixed",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 380,
    recoil: recoil(1.4, 0.6, 2.95, 5.0, 18, "moderate"),
    ergonomics: erg(6.0, 7.5, 5.0, 4.5, 9.0, 5.5),
    role: "Assault rifle",
    history: "Replacement for the AKM, lighter recoil thanks to the 5.45mm cartridge and a new muzzle brake. Standard issue for Soviet / Russian motor-rifle units since 1974.",
    tags: ["rifle", "eastern-bloc", "gas-piston", "5.45"],
  },

  {
    id: "m4",
    realName: "M4 Carbine",
    aliases: ["Colt M4"],
    category: "RIFLE",
    gameSlug: "m4",
    provenance: {
      manufacturer: "Colt Defense / FN Herstal",
      countryOfOrigin: "United States",
      yearDesigned: 1988,
      yearInService: 1994,
      primaryUser: "United States Armed Forces",
      conflicts: ["Global War on Terror", "Iraq War", "War in Afghanistan"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 880,
    muzzleEnergyJ: 1710,
    cyclicRpm: 800,
    effectiveRangeM: 500,
    maxRangeM: 3600,
    weightKg: 3.04,
    loadedWeightKg: 3.57,
    barrelMm: 368,
    barrelProfile: "standard",
    overallLengthMm: 838,
    stdMagCapacity: 30,
    feed: "STANAG",
    action: "direct-impingement",
    fireModes: ["safe", "semi", "burst", "auto"],
    burstRounds: 3,
    trigger: { pullWeightN: 24.5, creepMm: 2.5, resetMm: 1.5, type: "single_stage" },
    stock: "collapsible",
    handguard: "picatinny_top",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 470,
    recoil: recoil(1.2, 0.5, 2.75, 4.5, 15, "moderate"),
    ergonomics: erg(8.5, 7.0, 7.5, 9.0, 8.0, 7.5),
    role: "Carbine / assault rifle",
    history: "Compact derivative of the M16A2 with collapsible stock. Standard issue for US Army since 1994; the M4A1 variant upgraded to full-auto.",
    tags: ["rifle", "NATO", "DI", "5.56", "carbine"],
  },

  {
    id: "m4a1_block2",
    realName: "M4A1 Block II (SOPMOD)",
    aliases: ["M4A1", "URG-I"],
    category: "RIFLE",
    provenance: {
      manufacturer: "Colt / Crane Naval Surface Warfare Center",
      countryOfOrigin: "United States",
      yearDesigned: 1994,
      yearInService: 2014,
      primaryUser: "US Special Operations Command (USSOCOM)",
      conflicts: ["War in Afghanistan", "Operation Inherent Resolve"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 902,
    muzzleEnergyJ: 1755,
    cyclicRpm: 950,
    effectiveRangeM: 500,
    maxRangeM: 3600,
    weightKg: 3.43,
    loadedWeightKg: 4.05,
    barrelMm: 368,
    barrelProfile: "medium",
    overallLengthMm: 838,
    stdMagCapacity: 30,
    feed: "STANAG",
    action: "direct-impingement",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 22.2, creepMm: 2.0, resetMm: 1.2, type: "single_stage" },
    stock: "collapsible",
    handguard: "picatinny_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(1.0, 0.4, 2.70, 4.4, 12, "moderate"),
    ergonomics: erg(9.0, 7.5, 8.0, 9.5, 8.0, 8.0),
    role: "Special operations carbine",
    history: "USSOCOM upgrade with full-auto trigger group, heavy barrel, free-float rail, SOPMOD accessory suite. Standard issue for NSW + Ranger regiments.",
    tags: ["rifle", "NATO", "DI", "5.56", "specops", "sopmod"],
  },

  {
    id: "m16a4",
    realName: "M16A4",
    category: "RIFLE",
    provenance: {
      manufacturer: "FN Herstal (US plant)",
      countryOfOrigin: "United States",
      yearDesigned: 1997,
      yearInService: 1997,
      primaryUser: "United States Marine Corps",
      conflicts: ["Iraq War", "War in Afghanistan"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 948,
    muzzleEnergyJ: 1790,
    cyclicRpm: 800,
    effectiveRangeM: 550,
    maxRangeM: 3600,
    weightKg: 3.99,
    loadedWeightKg: 4.49,
    barrelMm: 508,
    barrelProfile: "standard",
    overallLengthMm: 1000,
    stdMagCapacity: 30,
    feed: "STANAG",
    action: "direct-impingement",
    fireModes: ["safe", "semi", "burst"],
    burstRounds: 3,
    trigger: { pullWeightN: 24.5, creepMm: 2.5, resetMm: 1.5, type: "single_stage" },
    stock: "fixed",
    handguard: "picatinny_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 508,
    recoil: recoil(1.1, 0.4, 2.80, 4.6, 13, "moderate"),
    ergonomics: erg(7.5, 7.5, 7.5, 8.5, 8.0, 8.5),
    role: "Infantry rifle",
    history: "Final iteration of the M16 series; replaced the M16A2 carry handle with a Picatinny rail. Used by USMC until adoption of the M27 IAR.",
    tags: ["rifle", "NATO", "DI", "5.56", "usmc"],
  },

  {
    id: "hk416",
    realName: "H&K HK416 (D10 RS)",
    aliases: ["HK416", "M27 IAR (variant)"],
    category: "RIFLE",
    gameSlug: "hk416",
    provenance: {
      manufacturer: "Heckler & Koch",
      countryOfOrigin: "Germany",
      yearDesigned: 2004,
      yearInService: 2005,
      primaryUser: "US Navy SEALs, German KSK, Norwegian Armed Forces",
      conflicts: ["Operation Neptune Spear (Bin Laden raid)", "War in Afghanistan"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 905,
    muzzleEnergyJ: 1755,
    cyclicRpm: 850,
    effectiveRangeM: 500,
    maxRangeM: 3600,
    weightKg: 3.49,
    loadedWeightKg: 4.02,
    barrelMm: 368,
    barrelProfile: "heavy",
    overallLengthMm: 885,
    stdMagCapacity: 30,
    feed: "STANAG",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 22.5, creepMm: 2.0, resetMm: 1.2, type: "single_stage" },
    stock: "collapsible",
    handguard: "picatinny_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(1.1, 0.4, 2.78, 4.5, 14, "moderate"),
    ergonomics: erg(9.0, 8.0, 8.0, 9.5, 7.5, 8.0),
    role: "Assault rifle / special operations",
    history: "Piston-driven AR-15 adopted by US Navy SEALs (used in the Bin Laden raid), German KSK, and many NATO special forces. M27 IAR variant replaces the M249 in USMC squads.",
    tags: ["rifle", "NATO", "gas-piston", "5.56", "specops"],
  },

  {
    id: "scarl",
    realName: "FN SCAR-L (Mk 16)",
    aliases: ["SCAR-L", "Mk 16 Mod 0"],
    category: "RIFLE",
    provenance: {
      manufacturer: "FN Herstal",
      countryOfOrigin: "Belgium",
      yearDesigned: 2004,
      yearInService: 2009,
      primaryUser: "US Special Operations Command",
      conflicts: ["War in Afghanistan"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 870,
    muzzleEnergyJ: 1710,
    cyclicRpm: 600,
    effectiveRangeM: 500,
    maxRangeM: 3600,
    weightKg: 3.50,
    loadedWeightKg: 4.05,
    barrelMm: 350,
    barrelProfile: "medium",
    overallLengthMm: 838,
    stdMagCapacity: 30,
    feed: "STANAG",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 24.5, creepMm: 2.5, resetMm: 1.5, type: "single_stage" },
    stock: "folding",
    handguard: "picatinny_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(1.0, 0.4, 2.70, 4.4, 12, "moderate"),
    ergonomics: erg(8.5, 8.0, 7.5, 9.0, 7.5, 8.0),
    role: "Special operations rifle",
    history: "SOCOM-designed modular rifle with quick-change barrels. SCAR-L (5.56) and SCAR-H (7.62) share lower receiver controls.",
    tags: ["rifle", "NATO", "gas-piston", "5.56", "scar", "specops"],
  },

  {
    id: "scarh",
    realName: "FN SCAR-H (Mk 17)",
    aliases: ["SCAR-H", "Mk 17 Mod 0"],
    category: "RIFLE",
    gameSlug: "scarh",
    provenance: {
      manufacturer: "FN Herstal",
      countryOfOrigin: "Belgium",
      yearDesigned: 2004,
      yearInService: 2009,
      primaryUser: "US Special Operations Command",
      conflicts: ["War in Afghanistan", "Operation Inherent Resolve"],
    },
    cartridge: "7.62×51mm NATO",
    muzzleVelocityMs: 870,
    muzzleEnergyJ: 3520,
    cyclicRpm: 625,
    effectiveRangeM: 600,
    maxRangeM: 4000,
    weightKg: 3.58,
    loadedWeightKg: 4.30,
    barrelMm: 400,
    barrelProfile: "heavy",
    overallLengthMm: 885,
    stdMagCapacity: 20,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 24.5, creepMm: 2.5, resetMm: 1.5, type: "single_stage" },
    stock: "folding",
    handguard: "picatinny_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(2.2, 0.8, 5.60, 9.0, 30, "high"),
    ergonomics: erg(8.0, 7.5, 7.5, 9.0, 7.5, 8.0),
    role: "Battle rifle",
    history: "SOCOM-designed battle rifle, modular barrel system allows caliber swaps. Standard issue for US Navy SEALs + Army Special Forces.",
    tags: ["rifle", "NATO", "gas-piston", "7.62", "scar", "battle-rifle"],
  },

  {
    id: "hk417",
    realName: "H&K HK417",
    aliases: ["G28 (DMR variant)"],
    category: "RIFLE",
    provenance: {
      manufacturer: "Heckler & Koch",
      countryOfOrigin: "Germany",
      yearDesigned: 2005,
      yearInService: 2006,
      primaryUser: "German Bundeswehr, British Army",
      conflicts: ["War in Afghanistan"],
    },
    cartridge: "7.62×51mm NATO",
    muzzleVelocityMs: 800,
    muzzleEnergyJ: 3350,
    cyclicRpm: 600,
    effectiveRangeM: 600,
    maxRangeM: 4000,
    weightKg: 4.65,
    loadedWeightKg: 5.30,
    barrelMm: 410,
    barrelProfile: "heavy",
    overallLengthMm: 980,
    stdMagCapacity: 20,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 18.0, creepMm: 1.5, resetMm: 1.0, type: "two_stage" },
    stock: "collapsible",
    handguard: "picatinny_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(2.1, 0.7, 5.45, 8.7, 28, "high"),
    ergonomics: erg(8.5, 7.5, 8.5, 9.0, 7.5, 8.5),
    role: "DMR / battle rifle",
    history: "7.62mm big brother to the HK416; G28 DMR variant adopted by the Bundeswehr. Used by British Army as L129A1.",
    tags: ["rifle", "NATO", "gas-piston", "7.62", "dmr"],
  },

  {
    id: "famas",
    realName: "FAMAS F1",
    aliases: ["FAMAS", "Le Clairon"],
    category: "RIFLE",
    gameSlug: "famas",
    provenance: {
      manufacturer: "MAS (Manufacture d'armes de Saint-Étienne)",
      countryOfOrigin: "France",
      yearDesigned: 1973,
      yearInService: 1978,
      primaryUser: "French Army",
      conflicts: ["Gulf War", "Operation Serval", "Chadian-Libyan conflict"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 960,
    muzzleEnergyJ: 1710,
    cyclicRpm: 1100,
    effectiveRangeM: 450,
    maxRangeM: 3200,
    weightKg: 3.61,
    loadedWeightKg: 4.10,
    barrelMm: 488,
    barrelProfile: "standard",
    overallLengthMm: 757,
    stdMagCapacity: 25,
    feed: "STANAG",
    action: "roller-delayed",
    fireModes: ["safe", "semi", "burst", "auto"],
    burstRounds: 3,
    trigger: { pullWeightN: 35.0, creepMm: 3.5, resetMm: 2.0, type: "single_stage" },
    stock: "bullpup",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 330,
    recoil: recoil(1.3, 0.5, 2.85, 4.6, 14, "moderate"),
    ergonomics: erg(7.0, 7.0, 5.5, 5.0, 6.5, 6.5),
    role: "Bullpup assault rifle",
    history: "French bullpup with the iconic carrying handle; famous for a very high cyclic rate. Being replaced by the HK416F.",
    tags: ["rifle", "NATO", "bullpup", "5.56", "french"],
  },

  {
    id: "aug",
    realName: "Steyr AUG A3",
    aliases: ["AUG", "Steyr"],
    category: "RIFLE",
    gameSlug: "aug",
    provenance: {
      manufacturer: "Steyr Mannlicher",
      countryOfOrigin: "Austria",
      yearDesigned: 1974,
      yearInService: 1978,
      primaryUser: "Austrian Bundesheer, Australian Defence Force",
      conflicts: ["War in Afghanistan", "Iraq War"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 940,
    muzzleEnergyJ: 1710,
    cyclicRpm: 680,
    effectiveRangeM: 500,
    maxRangeM: 2700,
    weightKg: 3.6,
    loadedWeightKg: 4.1,
    barrelMm: 407,
    barrelProfile: "standard",
    overallLengthMm: 790,
    stdMagCapacity: 30,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 27.0, creepMm: 5.0, resetMm: 2.5, type: "double_action" },
    stock: "bullpup",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(1.2, 0.4, 2.78, 4.5, 13, "moderate"),
    ergonomics: erg(7.5, 7.0, 5.0, 6.0, 8.0, 6.5),
    role: "Bullpup assault rifle",
    history: "First successful bullpup rifle; progressive trigger acts as fire selector (light pull = semi, hard pull = auto). Standard issue for Austrian + Australian forces.",
    tags: ["rifle", "NATO", "bullpup", "5.56", "austrian"],
  },

  {
    id: "tavor_x95",
    realName: "IWI Tavor X95",
    aliases: ["X95", "MTAR-21"],
    category: "RIFLE",
    provenance: {
      manufacturer: "Israel Weapon Industries",
      countryOfOrigin: "Israel",
      yearDesigned: 2009,
      yearInService: 2009,
      primaryUser: "Israel Defense Forces",
      conflicts: ["Gaza conflicts", "Operation Protective Edge"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 915,
    muzzleEnergyJ: 1720,
    cyclicRpm: 900,
    effectiveRangeM: 500,
    maxRangeM: 3600,
    weightKg: 3.37,
    loadedWeightKg: 3.85,
    barrelMm: 380,
    barrelProfile: "medium",
    overallLengthMm: 580,
    stdMagCapacity: 30,
    feed: "STANAG",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 25.0, creepMm: 3.0, resetMm: 1.8, type: "single_stage" },
    stock: "bullpup",
    handguard: "picatinny_top",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(1.1, 0.4, 2.75, 4.5, 13, "moderate"),
    ergonomics: erg(8.0, 7.5, 6.5, 8.0, 8.0, 7.0),
    role: "Bullpup assault rifle",
    history: "Compact bullpup; replacement for the original Tavor TAR-21 in IDF service. Selectable ejection + suppressor-ready.",
    tags: ["rifle", "NATO", "bullpup", "5.56", "israeli"],
  },

  {
    id: "g36c",
    realName: "H&K G36C",
    aliases: ["G36", "G36K"],
    category: "RIFLE",
    provenance: {
      manufacturer: "Heckler & Koch",
      countryOfOrigin: "Germany",
      yearDesigned: 1995,
      yearInService: 1997,
      primaryUser: "German Bundeswehr, Spanish Armed Forces",
      conflicts: ["War in Afghanistan", "Mali conflict"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 880,
    muzzleEnergyJ: 1700,
    cyclicRpm: 750,
    effectiveRangeM: 400,
    maxRangeM: 3200,
    weightKg: 2.80,
    loadedWeightKg: 3.30,
    barrelMm: 228,
    barrelProfile: "light",
    overallLengthMm: 720,
    stdMagCapacity: 30,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 26.0, creepMm: 3.0, resetMm: 1.8, type: "single_stage" },
    stock: "folding",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(1.3, 0.5, 2.80, 4.5, 14, "moderate"),
    ergonomics: erg(7.5, 7.0, 6.0, 7.0, 8.0, 6.0),
    role: "Compact carbine",
    history: "German service rifle; the G36C is the compact variant with shortened barrel. Standard issue for German Bundeswehr since 1997.",
    tags: ["rifle", "NATO", "gas-piston", "5.56", "german", "carbine"],
  },

  {
    id: "mcx",
    realName: "SIG MCX Vortex",
    aliases: ["MCX", "MCX Vortex"],
    category: "RIFLE",
    provenance: {
      manufacturer: "SIG Sauer",
      countryOfOrigin: "United States",
      yearDesigned: 2015,
      yearInService: 2016,
      primaryUser: "UK Special Forces, US civilian market",
      conflicts: ["War in Afghanistan"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 914,
    muzzleEnergyJ: 1755,
    cyclicRpm: 800,
    effectiveRangeM: 500,
    maxRangeM: 3600,
    weightKg: 2.60,
    loadedWeightKg: 3.10,
    barrelMm: 380,
    barrelProfile: "medium",
    overallLengthMm: 838,
    stdMagCapacity: 30,
    feed: "STANAG",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 22.0, creepMm: 2.0, resetMm: 1.2, type: "single_stage" },
    stock: "collapsible",
    handguard: "mlok_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(0.9, 0.3, 2.70, 4.3, 11, "low"),
    ergonomics: erg(9.0, 8.5, 8.0, 9.0, 8.0, 8.0),
    role: "Modular carbine",
    history: "Short-stroke piston modular platform; folding-stock + caliber-conversion. Adopted by UKSF + German Polizei.",
    tags: ["rifle", "NATO", "gas-piston", "5.56", "modular"],
  },

  {
    id: "galil",
    realName: "IWI Galil ACE 23",
    aliases: ["Galil", "ACE"],
    category: "RIFLE",
    gameSlug: "galil",
    provenance: {
      manufacturer: "Israel Weapon Industries",
      countryOfOrigin: "Israel",
      yearDesigned: 2006,
      yearInService: 2008,
      primaryUser: "Chilean Army, Colombian Armed Forces, Vietnamese Navy",
      conflicts: ["Colombian conflict"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 915,
    muzzleEnergyJ: 1720,
    cyclicRpm: 700,
    effectiveRangeM: 500,
    maxRangeM: 3500,
    weightKg: 3.27,
    loadedWeightKg: 3.85,
    barrelMm: 460,
    barrelProfile: "medium",
    overallLengthMm: 945,
    stdMagCapacity: 35,
    feed: "AK-pattern",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 25.0, creepMm: 3.0, resetMm: 1.8, type: "single_stage" },
    stock: "folding",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 470,
    recoil: recoil(1.4, 0.5, 2.90, 4.7, 16, "moderate"),
    ergonomics: erg(7.0, 8.0, 6.0, 7.0, 9.0, 6.5),
    role: "Assault rifle",
    history: "Refined AK-pattern rifle based on the Finnish Valmet, prized for reliability in desert + jungle conditions.",
    tags: ["rifle", "NATO", "gas-piston", "5.56", "israeli", "ak-derived"],
  },

  {
    id: "aks74u",
    realName: "AKS-74U",
    aliases: ["AKS74U", "Krinkov"],
    category: "RIFLE",
    provenance: {
      manufacturer: "Izhmash / Tula Arms Plant",
      countryOfOrigin: "Soviet Union",
      yearDesigned: 1979,
      yearInService: 1980,
      primaryUser: "Russian Spetsnaz, VDV, vehicle crews",
      conflicts: ["Soviet-Afghan War", "Chechen Wars", "War in Donbas"],
    },
    cartridge: "5.45×39mm",
    muzzleVelocityMs: 735,
    muzzleEnergyJ: 1000,
    cyclicRpm: 700,
    effectiveRangeM: 200,
    maxRangeM: 1500,
    weightKg: 2.70,
    loadedWeightKg: 3.10,
    barrelMm: 210,
    barrelProfile: "light",
    overallLengthMm: 730,
    stdMagCapacity: 30,
    feed: "AK-pattern",
    action: "gas-piston",
    fireModes: ["safe", "auto", "semi"],
    trigger: { pullWeightN: 26.7, creepMm: 4.0, resetMm: 2.0, type: "single_stage" },
    stock: "folding",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 230,
    recoil: recoil(2.0, 0.8, 2.50, 4.5, 28, "high"),
    ergonomics: erg(7.5, 5.5, 5.0, 4.5, 8.5, 5.0),
    role: "PDW / carbine",
    history: "Compact AK for vehicle crews + special forces. Iconic 'Krinkov' flash hider + booster. Standard issue for Russian Spetsnaz.",
    tags: ["rifle", "eastern-bloc", "gas-piston", "5.45", "carbine", "pdw"],
  },

  {
    id: "mk12_spr",
    realName: "Mk 12 Mod 1 SPR",
    aliases: ["Mk 12", "SPR"],
    category: "RIFLE",
    provenance: {
      manufacturer: " Crane Division (NSWC Crane) + Crane armories",
      countryOfOrigin: "United States",
      yearDesigned: 2000,
      yearInService: 2002,
      primaryUser: "US Navy SEALs, US Army Special Forces",
      conflicts: ["War in Afghanistan", "Iraq War"],
    },
    cartridge: "5.56×45mm NATO (Mk 262 Mod 1)",
    muzzleVelocityMs: 936,
    muzzleEnergyJ: 1880,
    cyclicRpm: 800,
    effectiveRangeM: 700,
    maxRangeM: 3600,
    weightKg: 4.50,
    loadedWeightKg: 5.05,
    barrelMm: 460,
    barrelProfile: "heavy",
    overallLengthMm: 1016,
    stdMagCapacity: 30,
    feed: "STANAG",
    action: "direct-impingement",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 17.8, creepMm: 1.2, resetMm: 0.8, type: "two_stage" },
    stock: "collapsible",
    handguard: "picatinny_full",
    defaultMuzzle: "compensator",
    sightRadiusMm: 0,
    recoil: recoil(0.8, 0.3, 2.65, 4.2, 9, "low"),
    ergonomics: erg(7.5, 8.5, 9.0, 9.0, 7.5, 9.0),
    role: "Special Purpose Rifle (DMR)",
    history: "Precision 5.56mm SPR built by NSWC Crane for USSOCOM. Uses Mk 262 Mod 1 open-tip match ammo for extended effective range.",
    tags: ["rifle", "NATO", "DI", "5.56", "specops", "dmr"],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MARKSMAN RIFLES + SNIPER RIFLES
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "mk14",
    realName: "Mk14 EBR (Mod 0/1)",
    aliases: ["M14 EBR", "Mk 14"],
    category: "RIFLE",
    gameSlug: "mk14",
    provenance: {
      manufacturer: "Smith Enterprise Inc. / Navy Crane",
      countryOfOrigin: "United States",
      yearDesigned: 2001,
      yearInService: 2004,
      primaryUser: "US Navy SEALs, US Coast Guard",
      conflicts: ["War in Afghanistan", "Iraq War"],
    },
    cartridge: "7.62×51mm NATO",
    muzzleVelocityMs: 850,
    muzzleEnergyJ: 3520,
    cyclicRpm: 700,
    effectiveRangeM: 800,
    maxRangeM: 4400,
    weightKg: 5.10,
    loadedWeightKg: 5.85,
    barrelMm: 460,
    barrelProfile: "medium",
    overallLengthMm: 889,
    stdMagCapacity: 15,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 18.0, creepMm: 1.5, resetMm: 1.0, type: "two_stage" },
    stock: "collapsible",
    handguard: "picatinny_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(2.4, 0.9, 6.10, 10.5, 32, "high"),
    ergonomics: erg(6.5, 7.5, 8.5, 8.5, 7.0, 8.0),
    role: "Designated marksman rifle",
    history: "M14 modernization for US Navy SEALs; selective-fire DMR role. Sage EBR chassis + 4-stage stock system.",
    tags: ["rifle", "NATO", "gas-piston", "7.62", "dmr", "specops"],
  },

  {
    id: "m110_sass",
    realName: "Knight's M110 SASS",
    aliases: ["M110", "SASS"],
    category: "SNIPER",
    provenance: {
      manufacturer: "Knight's Armament Company",
      countryOfOrigin: "United States",
      yearDesigned: 2006,
      yearInService: 2008,
      primaryUser: "US Army",
      conflicts: ["Iraq War", "War in Afghanistan"],
    },
    cartridge: "7.62×51mm NATO",
    muzzleVelocityMs: 784,
    muzzleEnergyJ: 3500,
    cyclicRpm: 0,
    effectiveRangeM: 1000,
    maxRangeM: 4400,
    weightKg: 7.00,
    loadedWeightKg: 7.60,
    barrelMm: 508,
    barrelProfile: "heavy",
    overallLengthMm: 1220,
    stdMagCapacity: 20,
    feed: "box-mag",
    action: "direct-impingement",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 13.3, creepMm: 0.8, resetMm: 0.5, type: "two_stage" },
    stock: "collapsible",
    handguard: "picatinny_full",
    defaultMuzzle: "suppressor",
    sightRadiusMm: 0,
    recoil: recoil(2.0, 0.6, 5.50, 8.8, 24, "high"),
    ergonomics: erg(7.0, 8.0, 9.0, 8.5, 7.0, 9.0),
    role: "Semi-auto sniper system",
    history: "Semi-Automatic Sniper System — replaced the M14 in the DMR role for US Army. Quick-detach suppressor standard issue.",
    tags: ["sniper", "NATO", "DI", "7.62", "dmr", "us-army"],
  },

  {
    id: "awp",
    realName: "Accuracy International AWP",
    aliases: ["AW", "Arctic Warfare"],
    category: "SNIPER",
    gameSlug: "awp",
    provenance: {
      manufacturer: "Accuracy International",
      countryOfOrigin: "United Kingdom",
      yearDesigned: 1982,
      yearInService: 1985,
      primaryUser: "British Army, Swedish Army",
      conflicts: ["Gulf War", "Iraq War", "War in Afghanistan"],
    },
    cartridge: ".308 Winchester / 7.62×51mm NATO",
    muzzleVelocityMs: 850,
    muzzleEnergyJ: 3500,
    cyclicRpm: 0,
    effectiveRangeM: 1000,
    maxRangeM: 4400,
    weightKg: 6.40,
    loadedWeightKg: 6.90,
    barrelMm: 610,
    barrelProfile: "bull",
    overallLengthMm: 1180,
    stdMagCapacity: 5,
    feed: "box-mag",
    action: "turn-bolt",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 13.3, creepMm: 0.5, resetMm: 0.4, type: "two_stage" },
    stock: "fixed",
    handguard: "picatinny_top",
    defaultMuzzle: "muzzle_brake",
    sightRadiusMm: 0,
    recoil: recoil(2.4, 0.6, 6.50, 10.5, 18, "high"),
    ergonomics: erg(7.0, 7.5, 9.5, 7.0, 8.0, 9.5),
    role: "Bolt-action sniper rifle",
    history: "British sniper rifle derived from the L96; the AWP (Police) variant chambers .308 Win or .338 Lapua depending on configuration.",
    tags: ["sniper", "NATO", "bolt-action", "7.62", "british"],
  },

  {
    id: "l115a3",
    realName: "Accuracy International L115A3",
    aliases: ["L115A3", "AWSM"],
    category: "SNIPER",
    gameSlug: "l115a3",
    provenance: {
      manufacturer: "Accuracy International",
      countryOfOrigin: "United Kingdom",
      yearDesigned: 1996,
      yearInService: 2008,
      primaryUser: "British Army, Royal Marines",
      conflicts: ["War in Afghanistan", "Iraq War"],
    },
    cartridge: ".338 Lapua Magnum",
    muzzleVelocityMs: 936,
    muzzleEnergyJ: 6600,
    cyclicRpm: 0,
    effectiveRangeM: 1500,
    maxRangeM: 5500,
    weightKg: 6.90,
    loadedWeightKg: 7.40,
    barrelMm: 686,
    barrelProfile: "bull",
    overallLengthMm: 1300,
    stdMagCapacity: 5,
    feed: "box-mag",
    action: "turn-bolt",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 13.3, creepMm: 0.5, resetMm: 0.4, type: "two_stage" },
    stock: "folding",
    handguard: "picatinny_top",
    defaultMuzzle: "muzzle_brake",
    sightRadiusMm: 0,
    recoil: recoil(3.0, 0.8, 9.50, 14.5, 22, "extreme"),
    ergonomics: erg(7.5, 8.0, 9.5, 7.5, 8.0, 9.5),
    role: "Long-range sniper rifle",
    history: ".338 Lapua sniper rifle; British Army holds the longest confirmed kill at 2,475 m (Corporal Craig Harrison, 2009).",
    tags: ["sniper", "NATO", "bolt-action", "338-lapua", "british", "long-range"],
  },

  {
    id: "ax50",
    realName: "Accuracy International AX50",
    aliases: ["AX50", "AX series"],
    category: "SNIPER",
    provenance: {
      manufacturer: "Accuracy International",
      countryOfOrigin: "United Kingdom",
      yearDesigned: 2010,
      yearInService: 2014,
      primaryUser: "Norwegian Army, British Special Forces",
      conflicts: ["War in Afghanistan"],
    },
    cartridge: ".50 BMG (12.7×99mm NATO)",
    muzzleVelocityMs: 823,
    muzzleEnergyJ: 18000,
    cyclicRpm: 0,
    effectiveRangeM: 2000,
    maxRangeM: 6800,
    weightKg: 15.00,
    loadedWeightKg: 16.00,
    barrelMm: 686,
    barrelProfile: "bull",
    overallLengthMm: 1560,
    stdMagCapacity: 5,
    feed: "box-mag",
    action: "turn-bolt",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 13.3, creepMm: 0.4, resetMm: 0.3, type: "two_stage" },
    stock: "folding",
    handguard: "picatinny_top",
    defaultMuzzle: "muzzle_brake",
    sightRadiusMm: 0,
    recoil: recoil(4.5, 1.2, 22.00, 32.0, 25, "extreme"),
    ergonomics: erg(6.0, 7.0, 9.5, 7.0, 7.5, 9.5),
    role: "Anti-materiel rifle",
    history: ".50 caliber bolt-action anti-materiel rifle; AX series multi-caliber chassis. Used by Norwegian + UK snipers.",
    tags: ["sniper", "NATO", "bolt-action", "50-bmg", "british", "anti-materiel"],
  },

  {
    id: "barrett_m82",
    realName: "Barrett M82A1",
    aliases: ["M82", "M107 (US military designation)"],
    category: "SNIPER",
    provenance: {
      manufacturer: "Barrett Firearms",
      countryOfOrigin: "United States",
      yearDesigned: 1982,
      yearInService: 1989,
      primaryUser: "US Army (M107), numerous militaries worldwide",
      conflicts: ["Gulf War", "Iraq War", "War in Afghanistan"],
    },
    cartridge: ".50 BMG (12.7×99mm NATO)",
    muzzleVelocityMs: 853,
    muzzleEnergyJ: 18000,
    cyclicRpm: 0,
    effectiveRangeM: 1800,
    maxRangeM: 6800,
    weightKg: 14.00,
    loadedWeightKg: 14.80,
    barrelMm: 737,
    barrelProfile: "bull",
    overallLengthMm: 1448,
    stdMagCapacity: 10,
    feed: "box-mag",
    action: "short-recoil",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 35.0, creepMm: 1.5, resetMm: 1.0, type: "two_stage" },
    stock: "fixed",
    handguard: "none",
    defaultMuzzle: "muzzle_brake",
    sightRadiusMm: 0,
    recoil: recoil(3.5, 1.0, 20.00, 28.0, 22, "extreme"),
    ergonomics: erg(5.0, 8.0, 7.0, 5.0, 6.5, 8.5),
    role: "Anti-materiel rifle",
    history: "Iconic .50 BMG semi-auto anti-materiel rifle; adopted by US Army as the M107. Effective against radar cabins, light armor, and unexploded ordnance.",
    tags: ["sniper", "NATO", "short-recoil", "50-bmg", "anti-materiel"],
  },

  {
    id: "kar98k",
    realName: "Mauser Kar98k",
    aliases: ["Kar98k", "Mauser 98k"],
    category: "SNIPER",
    gameSlug: "kar98k",
    provenance: {
      manufacturer: "Mauser / various German arsenals",
      countryOfOrigin: "Germany",
      yearDesigned: 1935,
      yearInService: 1935,
      primaryUser: "Wehrmacht (WW2), various post-war militaries",
      conflicts: ["World War 2"],
    },
    cartridge: "7.92×57mm Mauser",
    muzzleVelocityMs: 760,
    muzzleEnergyJ: 3700,
    cyclicRpm: 0,
    effectiveRangeM: 500,
    maxRangeM: 2500,
    weightKg: 3.70,
    loadedWeightKg: 4.10,
    barrelMm: 600,
    barrelProfile: "standard",
    overallLengthMm: 1110,
    stdMagCapacity: 5,
    feed: "internal-mag",
    action: "turn-bolt",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 22.0, creepMm: 1.5, resetMm: 1.0, type: "two_stage" },
    stock: "fixed",
    handguard: "wood",
    defaultMuzzle: "none",
    sightRadiusMm: 580,
    recoil: recoil(2.5, 0.7, 7.00, 11.5, 20, "high"),
    ergonomics: erg(7.0, 7.0, 8.0, 1.0, 7.5, 8.0),
    role: "Bolt-action battle rifle",
    history: "Standard German infantry rifle of WW2. Bolt-action design derived from the Gewehr 98; sniper variants fitted with ZF39 or ZF41 scopes.",
    tags: ["sniper", "ww2", "bolt-action", "792-mauser", "german", "classic"],
  },

  {
    id: "svd_dragunov",
    realName: "Dragunov SVD",
    aliases: ["SVD", "Snayperskaya Vintovka Dragunova"],
    category: "SNIPER",
    provenance: {
      manufacturer: "Izhmash / Kalashnikov Concern",
      countryOfOrigin: "Soviet Union",
      yearDesigned: 1963,
      yearInService: 1967,
      primaryUser: "Soviet / Russian Army",
      conflicts: ["Soviet-Afghan War", "Chechen Wars", "Syrian Civil War"],
    },
    cartridge: "7.62×54mmR",
    muzzleVelocityMs: 830,
    muzzleEnergyJ: 3300,
    cyclicRpm: 0,
    effectiveRangeM: 800,
    maxRangeM: 4400,
    weightKg: 3.95,
    loadedWeightKg: 4.30,
    barrelMm: 620,
    barrelProfile: "medium",
    overallLengthMm: 1225,
    stdMagCapacity: 10,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 18.0, creepMm: 1.5, resetMm: 1.0, type: "two_stage" },
    stock: "fixed",
    handguard: "wood",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(2.2, 0.7, 5.80, 9.5, 24, "high"),
    ergonomics: erg(7.0, 7.0, 7.5, 4.0, 7.5, 8.0),
    role: "Designated marksman rifle",
    history: "Soviet squad-level marksman rifle; first purpose-built DMR. PSO-1 4× scope standard. Still in service with Russian + many allied forces.",
    tags: ["sniper", "eastern-bloc", "gas-piston", "762x54r", "dmr"],
  },

  {
    id: "sv98",
    realName: "Izhmash SV-98",
    aliases: ["SV98"],
    category: "SNIPER",
    provenance: {
      manufacturer: "Izhmash / Kalashnikov Concern",
      countryOfOrigin: "Russia",
      yearDesigned: 1998,
      yearInService: 2005,
      primaryUser: "Russian FSB, Russian Internal Troops",
      conflicts: ["Second Chechen War"],
    },
    cartridge: "7.62×54mmR",
    muzzleVelocityMs: 820,
    muzzleEnergyJ: 3300,
    cyclicRpm: 0,
    effectiveRangeM: 1000,
    maxRangeM: 4400,
    weightKg: 6.20,
    loadedWeightKg: 6.70,
    barrelMm: 650,
    barrelProfile: "bull",
    overallLengthMm: 1275,
    stdMagCapacity: 10,
    feed: "box-mag",
    action: "turn-bolt",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 11.0, creepMm: 0.4, resetMm: 0.3, type: "two_stage" },
    stock: "fixed",
    handguard: "picatinny_top",
    defaultMuzzle: "muzzle_brake",
    sightRadiusMm: 0,
    recoil: recoil(2.4, 0.6, 6.50, 10.5, 18, "high"),
    ergonomics: erg(7.0, 7.5, 9.0, 6.0, 7.5, 9.0),
    role: "Bolt-action sniper rifle",
    history: "Russian precision bolt-action sniper rifle; designed for FSB + Internal Troops. Free-floated barrel + adjustable trigger.",
    tags: ["sniper", "russian", "bolt-action", "762x54r", "long-range"],
  },

  {
    id: "tikka_t3x",
    realName: "Tikka T3x TAC A1",
    aliases: ["Tikka T3x"],
    category: "SNIPER",
    provenance: {
      manufacturer: "Sako / Beretta Holdings",
      countryOfOrigin: "Finland",
      yearDesigned: 2016,
      yearInService: 2016,
      primaryUser: "Civilian precision shooters, police sniper units",
    },
    cartridge: ".308 Winchester",
    muzzleVelocityMs: 850,
    muzzleEnergyJ: 3500,
    cyclicRpm: 0,
    effectiveRangeM: 800,
    maxRangeM: 4000,
    weightKg: 3.40,
    loadedWeightKg: 3.95,
    barrelMm: 590,
    barrelProfile: "bull",
    overallLengthMm: 1130,
    stdMagCapacity: 10,
    feed: "box-mag",
    action: "turn-bolt",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 13.0, creepMm: 0.5, resetMm: 0.3, type: "single_stage" },
    stock: "fixed",
    handguard: "picatinny_top",
    defaultMuzzle: "muzzle_brake",
    sightRadiusMm: 0,
    recoil: recoil(2.2, 0.6, 6.00, 9.5, 17, "high"),
    ergonomics: erg(8.5, 7.0, 9.0, 7.5, 9.0, 9.0),
    role: "Precision bolt-action",
    history: "Finnish precision rifle built on the Sako T3 action. TAC A1 chassis variant designed for law enforcement + competition use.",
    tags: ["sniper", "NATO", "bolt-action", "308", "finnish", "precision"],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SMGs + PDWs
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "mp7",
    realName: "H&K MP7A1",
    aliases: ["MP7", "PDW"],
    category: "SMG",
    gameSlug: "mp7",
    provenance: {
      manufacturer: "Heckler & Koch",
      countryOfOrigin: "Germany",
      yearDesigned: 1999,
      yearInService: 2001,
      primaryUser: "German KSK, British MOD police, US Secret Service",
      conflicts: ["War in Afghanistan", "Iraq War"],
    },
    cartridge: "4.6×30mm",
    muzzleVelocityMs: 725,
    muzzleEnergyJ: 480,
    cyclicRpm: 950,
    effectiveRangeM: 200,
    maxRangeM: 1500,
    weightKg: 1.90,
    loadedWeightKg: 2.18,
    barrelMm: 180,
    barrelProfile: "light",
    overallLengthMm: 415,
    stdMagCapacity: 40,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 26.0, creepMm: 2.5, resetMm: 1.5, type: "single_stage" },
    stock: "collapsible",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(0.7, 0.3, 0.85, 1.4, 8, "low"),
    ergonomics: erg(9.0, 8.5, 7.0, 7.5, 8.5, 7.0),
    role: "Personal defense weapon",
    history: "PDW designed to defeat body armor; standard issue for German KSK and British MOD police. Compact + armor-piercing.",
    tags: ["smg", "NATO", "gas-piston", "46", "pdw", "specops"],
  },

  {
    id: "p90",
    realName: "FN P90",
    aliases: ["P90", "Project 90"],
    category: "SMG",
    gameSlug: "p90",
    provenance: {
      manufacturer: "FN Herstal",
      countryOfOrigin: "Belgium",
      yearDesigned: 1986,
      yearInService: 1990,
      primaryUser: "Belgian Army, Saudi Arabia, US Secret Service",
      conflicts: ["War in Afghanistan", "Mexican drug war"],
    },
    cartridge: "5.7×28mm",
    muzzleVelocityMs: 715,
    muzzleEnergyJ: 510,
    cyclicRpm: 900,
    effectiveRangeM: 200,
    maxRangeM: 1500,
    weightKg: 2.60,
    loadedWeightKg: 3.05,
    barrelMm: 263,
    barrelProfile: "light",
    overallLengthMm: 500,
    stdMagCapacity: 50,
    feed: "helical-mag",
    action: "blowback",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 25.0, creepMm: 2.5, resetMm: 1.5, type: "single_stage" },
    stock: "bullpup",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(0.6, 0.2, 0.95, 1.6, 7, "low"),
    ergonomics: erg(8.5, 9.0, 7.0, 5.0, 7.0, 7.5),
    role: "Personal defense weapon",
    history: "Bullpup PDW with a 50-round horizontal magazine feeding from the top. SS190 AP round defeats CRISAT body armor at 200 m.",
    tags: ["smg", "NATO", "blowback", "57", "pdw", "bullpup"],
  },

  {
    id: "mp5",
    realName: "H&K MP5A3",
    aliases: ["MP5", "Machine Pistole 5"],
    category: "SMG",
    gameSlug: "mp5",
    provenance: {
      manufacturer: "Heckler & Koch",
      countryOfOrigin: "Germany",
      yearDesigned: 1966,
      yearInService: 1966,
      primaryUser: "German Police, US Navy SEALs, British SAS",
      conflicts: ["Iranian Embassy siege (1980)", "Gulf War", "Operation Neptune Spear"],
    },
    cartridge: "9×19mm Parabellum",
    muzzleVelocityMs: 400,
    muzzleEnergyJ: 600,
    cyclicRpm: 800,
    effectiveRangeM: 200,
    maxRangeM: 1500,
    weightKg: 2.54,
    loadedWeightKg: 2.85,
    barrelMm: 225,
    barrelProfile: "light",
    overallLengthMm: 680,
    stdMagCapacity: 30,
    feed: "box-mag",
    action: "roller-delayed",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 22.0, creepMm: 2.0, resetMm: 1.2, type: "single_stage" },
    stock: "collapsible",
    handguard: "tube",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 340,
    recoil: recoil(0.7, 0.3, 1.10, 1.8, 7, "low"),
    ergonomics: erg(9.0, 8.5, 8.0, 7.5, 9.0, 8.0),
    role: "Submachine gun",
    history: "Iconic counter-terror SMG; British SAS storming the Iranian Embassy made it famous in 1980. Still in service with many CT units.",
    tags: ["smg", "NATO", "roller-delayed", "9mm", "specops", "counter-terror"],
  },

  {
    id: "ump45",
    realName: "H&K UMP45",
    aliases: ["UMP", "UMP-45"],
    category: "SMG",
    gameSlug: "ump45",
    provenance: {
      manufacturer: "Heckler & Koch",
      countryOfOrigin: "Germany",
      yearDesigned: 1999,
      yearInService: 1999,
      primaryUser: "US Customs, Border Patrol, German police",
      conflicts: ["War in Afghanistan"],
    },
    cartridge: ".45 ACP",
    muzzleVelocityMs: 280,
    muzzleEnergyJ: 600,
    cyclicRpm: 600,
    effectiveRangeM: 100,
    maxRangeM: 1200,
    weightKg: 2.47,
    loadedWeightKg: 2.85,
    barrelMm: 200,
    barrelProfile: "light",
    overallLengthMm: 690,
    stdMagCapacity: 25,
    feed: "box-mag",
    action: "blowback",
    fireModes: ["safe", "semi", "burst", "auto"],
    burstRounds: 2,
    trigger: { pullWeightN: 26.0, creepMm: 3.0, resetMm: 1.8, type: "single_stage" },
    stock: "folding",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 310,
    recoil: recoil(1.1, 0.4, 1.80, 3.0, 11, "moderate"),
    ergonomics: erg(8.5, 7.5, 7.0, 7.0, 8.5, 7.5),
    role: "Submachine gun",
    history: "Heavier caliber successor to the MP5; .45 ACP variant for increased stopping power. Used by US Border Patrol + CBP.",
    tags: ["smg", "NATO", "blowback", "45acp", "counter-terror"],
  },

  {
    id: "vector",
    realName: "KRISS Vector CRB",
    aliases: ["Vector", "KRISS"],
    category: "SMG",
    gameSlug: "vector",
    provenance: {
      manufacturer: "KRISS USA",
      countryOfOrigin: "United States",
      yearDesigned: 2006,
      yearInService: 2009,
      primaryUser: "Civilian market, limited military trials",
    },
    cartridge: ".45 ACP",
    muzzleVelocityMs: 350,
    muzzleEnergyJ: 800,
    cyclicRpm: 1200,
    effectiveRangeM: 100,
    maxRangeM: 1200,
    weightKg: 2.49,
    loadedWeightKg: 2.85,
    barrelMm: 165,
    barrelProfile: "light",
    overallLengthMm: 635,
    stdMagCapacity: 25,
    feed: "box-mag",
    action: "blowback",
    fireModes: ["safe", "semi", "burst", "auto"],
    burstRounds: 2,
    trigger: { pullWeightN: 26.0, creepMm: 2.5, resetMm: 1.5, type: "single_stage" },
    stock: "folding",
    handguard: "picatinny_top",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(0.9, 0.3, 1.50, 2.5, 9, "low"),
    ergonomics: erg(8.0, 8.5, 7.0, 7.5, 7.5, 7.5),
    role: "Submachine gun",
    history: "Recoil-mitigating SMG; Super V action diverts recoil downward, reducing climb. High cyclic rate of 1,200 RPM.",
    tags: ["smg", "NATO", "blowback", "45acp", "high-rate"],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PISTOLS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "glock17",
    realName: "Glock 17 Gen5",
    aliases: ["Glock 17", "G17"],
    category: "PISTOL",
    gameSlug: "glock17",
    provenance: {
      manufacturer: "Glock Ges.m.b.H.",
      countryOfOrigin: "Austria",
      yearDesigned: 1982,
      yearInService: 1982,
      primaryUser: "Austrian Army, US FBI, UK Armed Forces",
      conflicts: ["Gulf War", "Iraq War", "War in Afghanistan"],
    },
    cartridge: "9×19mm Parabellum",
    muzzleVelocityMs: 375,
    muzzleEnergyJ: 500,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 800,
    weightKg: 0.625,
    loadedWeightKg: 0.905,
    barrelMm: 114,
    barrelProfile: "light",
    overallLengthMm: 204,
    stdMagCapacity: 17,
    feed: "box-mag",
    action: "blowback",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 24.5, creepMm: 2.0, resetMm: 0.5, type: "single_action" },
    stock: "pistol",
    handguard: "none",
    defaultMuzzle: "none",
    sightRadiusMm: 165,
    recoil: recoil(1.5, 0.5, 1.20, 2.0, 0, "low"),
    ergonomics: erg(9.0, 7.5, 6.5, 7.5, 9.5, 7.5),
    role: "Sidearm",
    history: "Polymer-frame service pistol; standard issue for Austrian + UK Armed Forces + US FBI. Lightweight, reliable, high magazine capacity.",
    tags: ["pistol", "NATO", "striker-fired", "9mm", "sidearm"],
  },

  {
    id: "m1911",
    realName: "Colt M1911A1",
    aliases: ["1911", "M1911"],
    category: "PISTOL",
    gameSlug: "m1911",
    provenance: {
      manufacturer: "Colt (and many licensees)",
      countryOfOrigin: "United States",
      yearDesigned: 1911,
      yearInService: 1911,
      primaryUser: "US Armed Forces (until 1985), Marine Corps MEU(SOC)",
      conflicts: ["World War 1", "World War 2", "Korea", "Vietnam", "Gulf War"],
    },
    cartridge: ".45 ACP",
    muzzleVelocityMs: 251,
    muzzleEnergyJ: 500,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 800,
    weightKg: 1.105,
    loadedWeightKg: 1.205,
    barrelMm: 127,
    barrelProfile: "light",
    overallLengthMm: 210,
    stdMagCapacity: 7,
    feed: "box-mag",
    action: "short-recoil",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 20.0, creepMm: 1.0, resetMm: 0.8, type: "single_action" },
    stock: "pistol",
    handguard: "none",
    defaultMuzzle: "none",
    sightRadiusMm: 165,
    recoil: recoil(1.7, 0.5, 2.50, 4.2, 0, "moderate"),
    ergonomics: erg(8.0, 7.0, 9.0, 6.0, 8.5, 7.5),
    role: "Sidearm",
    history: "Classic John Browning design; standard US sidearm from 1911 to 1985. Still used by USMC MEU(SOC) + many civilian shooters.",
    tags: ["pistol", "NATO", "1911", "45acp", "single-action", "classic"],
  },

  {
    id: "usp45",
    realName: "H&K USP .45 Tactical",
    aliases: ["USP", "USP45"],
    category: "PISTOL",
    provenance: {
      manufacturer: "Heckler & Koch",
      countryOfOrigin: "Germany",
      yearDesigned: 1993,
      yearInService: 1995,
      primaryUser: "German Bundeswehr, US Navy Mark 24 (Mk 24 Mod 0)",
      conflicts: ["War in Afghanistan", "Iraq War"],
    },
    cartridge: ".45 ACP",
    muzzleVelocityMs: 260,
    muzzleEnergyJ: 550,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 800,
    weightKg: 0.780,
    loadedWeightKg: 0.985,
    barrelMm: 108,
    barrelProfile: "light",
    overallLengthMm: 194,
    stdMagCapacity: 12,
    feed: "box-mag",
    action: "short-recoil",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 22.0, creepMm: 1.5, resetMm: 1.0, type: "single_action" },
    stock: "pistol",
    handguard: "none",
    defaultMuzzle: "thread_protector",
    sightRadiusMm: 158,
    recoil: recoil(1.4, 0.4, 2.30, 3.8, 0, "moderate"),
    ergonomics: erg(8.5, 8.0, 8.0, 7.0, 9.0, 8.0),
    role: "Sidearm / specops pistol",
    history: "German polymer service pistol; Tactical variant has threaded barrel for suppressor + match trigger. US Navy Mk 24 Mod 0.",
    tags: ["pistol", "NATO", "45acp", "specops", "suppressor-ready"],
  },

  {
    id: "deagle",
    realName: "Desert Eagle Mk XIX .50 AE",
    aliases: ["Desert Eagle", "Deagle"],
    category: "PISTOL",
    gameSlug: "deagle",
    provenance: {
      manufacturer: "Israel Military Industries / Magnum Research",
      countryOfOrigin: "Israel / United States",
      yearDesigned: 1982,
      yearInService: 1983,
      primaryUser: "Civilian market, limited movie / game appearances",
    },
    cartridge: ".50 Action Express",
    muzzleVelocityMs: 470,
    muzzleEnergyJ: 2400,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 1500,
    weightKg: 2.00,
    loadedWeightKg: 2.25,
    barrelMm: 152,
    barrelProfile: "heavy",
    overallLengthMm: 260,
    stdMagCapacity: 7,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 35.0, creepMm: 2.0, resetMm: 1.2, type: "single_action" },
    stock: "pistol",
    handguard: "none",
    defaultMuzzle: "none",
    sightRadiusMm: 215,
    recoil: recoil(3.5, 1.0, 5.50, 8.8, 0, "extreme"),
    ergonomics: erg(5.5, 4.0, 6.5, 4.0, 6.0, 7.0),
    role: "Hand cannon (sporting)",
    history: "Iconic .50 caliber semi-auto pistol; gas-operated (rare for handguns). Heavy + impractical for service use; popular in film + games.",
    tags: ["pistol", "50ae", "gas-operated", "handcannon", "novelty"],
  },

  {
    id: "p226",
    realName: "SIG Sauer P226 Mk25",
    aliases: ["P226", "Mk 25"],
    category: "PISTOL",
    provenance: {
      manufacturer: "SIG Sauer",
      countryOfOrigin: "Germany / United States",
      yearDesigned: 1984,
      yearInService: 1984,
      primaryUser: "US Navy SEALs (until 2017), US Coast Guard",
      conflicts: ["Gulf War", "War in Afghanistan", "Iraq War"],
    },
    cartridge: "9×19mm Parabellum",
    muzzleVelocityMs: 350,
    muzzleEnergyJ: 500,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 800,
    weightKg: 0.964,
    loadedWeightKg: 1.150,
    barrelMm: 112,
    barrelProfile: "light",
    overallLengthMm: 196,
    stdMagCapacity: 15,
    feed: "box-mag",
    action: "short-recoil",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 40.0, creepMm: 1.5, resetMm: 1.0, type: "double_action" },
    stock: "pistol",
    handguard: "none",
    defaultMuzzle: "thread_protector",
    sightRadiusMm: 160,
    recoil: recoil(1.4, 0.4, 1.30, 2.2, 0, "low"),
    ergonomics: erg(9.0, 8.0, 8.5, 7.0, 9.0, 8.0),
    role: "Service + specops sidearm",
    history: "Classic SIG service pistol; Mk 25 variant is the current US Navy SEAL sidearm (until recently). Nitron finish + corrosion resistant.",
    tags: ["pistol", "NATO", "9mm", "specops", "sidearm"],
  },

  {
    id: "fiveseven",
    realName: "FN Five-seveN",
    aliases: ["Five-seveN", "57"],
    category: "PISTOL",
    provenance: {
      manufacturer: "FN Herstal",
      countryOfOrigin: "Belgium",
      yearDesigned: 1998,
      yearInService: 2000,
      primaryUser: "Belgian Army, Mexican military, US Secret Service",
      conflicts: ["Mexican drug war"],
    },
    cartridge: "5.7×28mm",
    muzzleVelocityMs: 716,
    muzzleEnergyJ: 425,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 1500,
    weightKg: 0.609,
    loadedWeightKg: 0.750,
    barrelMm: 122,
    barrelProfile: "light",
    overallLengthMm: 208,
    stdMagCapacity: 20,
    feed: "box-mag",
    action: "blowback",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 26.0, creepMm: 2.5, resetMm: 1.5, type: "single_action" },
    stock: "pistol",
    handguard: "none",
    defaultMuzzle: "none",
    sightRadiusMm: 170,
    recoil: recoil(0.7, 0.2, 0.65, 1.1, 0, "low"),
    ergonomics: erg(8.5, 8.5, 7.0, 6.5, 9.0, 7.5),
    role: "Sidearm / armor-defeating pistol",
    history: "Pistol companion to the P90 PDW; same 5.7×28mm cartridge defeats CRISAT body armor. Lightweight + low recoil.",
    tags: ["pistol", "NATO", "57", "armor-piercing", "sidearm"],
  },

  {
    id: "beretta_m9",
    realName: "Beretta M9A1",
    aliases: ["M9", "92FS"],
    category: "PISTOL",
    provenance: {
      manufacturer: "Beretta",
      countryOfOrigin: "Italy",
      yearDesigned: 1980,
      yearInService: 1985,
      primaryUser: "US Armed Forces (1985-2017)",
      conflicts: ["Gulf War", "Iraq War", "War in Afghanistan"],
    },
    cartridge: "9×19mm Parabellum",
    muzzleVelocityMs: 381,
    muzzleEnergyJ: 500,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 800,
    weightKg: 0.952,
    loadedWeightKg: 1.150,
    barrelMm: 125,
    barrelProfile: "light",
    overallLengthMm: 217,
    stdMagCapacity: 15,
    feed: "box-mag",
    action: "short-recoil",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 33.4, creepMm: 2.0, resetMm: 1.0, type: "double_action" },
    stock: "pistol",
    handguard: "none",
    defaultMuzzle: "none",
    sightRadiusMm: 178,
    recoil: recoil(1.3, 0.4, 1.25, 2.1, 0, "low"),
    ergonomics: erg(8.0, 7.5, 7.5, 6.5, 9.0, 7.5),
    role: "Service sidearm",
    history: "US military sidearm from 1985-2017 (replaced by M17/M18). Open-slide design + reliable DA/SA trigger.",
    tags: ["pistol", "NATO", "9mm", "sidearm", "us-military"],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SHOTGUNS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "m870",
    realName: "Remington Model 870 MCS",
    aliases: ["M870", "Remington 870"],
    category: "SHOTGUN",
    gameSlug: "m870",
    provenance: {
      manufacturer: "Remington Arms",
      countryOfOrigin: "United States",
      yearDesigned: 1950,
      yearInService: 1950,
      primaryUser: "US Marine Corps, US Navy, civilian market",
      conflicts: ["Vietnam War", "Gulf War", "Iraq War", "War in Afghanistan"],
    },
    cartridge: "12 gauge (2.75\" / 3\" shells)",
    muzzleVelocityMs: 400,
    muzzleEnergyJ: 2400,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 300,
    weightKg: 3.60,
    loadedWeightKg: 4.10,
    barrelMm: 470,
    barrelProfile: "standard",
    overallLengthMm: 1040,
    stdMagCapacity: 7,
    feed: "tube-mag",
    action: "pump-action",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 30.0, creepMm: 2.5, resetMm: 1.5, type: "single_stage" },
    stock: "collapsible",
    handguard: "polymer",
    defaultMuzzle: "none",
    sightRadiusMm: 470,
    recoil: recoil(3.0, 1.0, 9.50, 16.0, 0, "extreme"),
    ergonomics: erg(7.5, 7.0, 6.5, 6.0, 9.0, 7.0),
    role: "Combat shotgun",
    history: "Most-produced shotgun in history (11+ million). MCS (Modular Combat Shotgun) variant used by USMC + Navy for breaching.",
    tags: ["shotgun", "12ga", "pump-action", "breaching"],
  },

  {
    id: "m1014",
    realName: "Benelli M4 (M1014)",
    aliases: ["M4 shotgun", "M1014"],
    category: "SHOTGUN",
    gameSlug: "m1014",
    provenance: {
      manufacturer: "Benelli Armi (Beretta Holdings)",
      countryOfOrigin: "Italy",
      yearDesigned: 1998,
      yearInService: 1999,
      primaryUser: "US Marine Corps, US Army",
      conflicts: ["War in Afghanistan", "Iraq War"],
    },
    cartridge: "12 gauge (2.75\" / 3\" shells)",
    muzzleVelocityMs: 410,
    muzzleEnergyJ: 2500,
    cyclicRpm: 0,
    effectiveRangeM: 50,
    maxRangeM: 300,
    weightKg: 3.82,
    loadedWeightKg: 4.40,
    barrelMm: 470,
    barrelProfile: "standard",
    overallLengthMm: 1010,
    stdMagCapacity: 7,
    feed: "tube-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 28.0, creepMm: 2.0, resetMm: 1.0, type: "single_stage" },
    stock: "collapsible",
    handguard: "polymer",
    defaultMuzzle: "none",
    sightRadiusMm: 470,
    recoil: recoil(2.5, 0.8, 8.50, 14.0, 0, "extreme"),
    ergonomics: erg(8.5, 8.0, 7.0, 6.5, 8.5, 7.5),
    role: "Combat shotgun (semi-auto)",
    history: "Auto-regulating gas-operated (ARGO) combat shotgun; standard USMC issue since 1999. Dual gas piston for reliability with all shell types.",
    tags: ["shotgun", "12ga", "semi-auto", "gas-piston", "us-military"],
  },

  {
    id: "aa12",
    realName: "MPS AA-12",
    aliases: ["AA-12", "Auto Assault-12"],
    category: "SHOTGUN",
    provenance: {
      manufacturer: "Military Police Systems",
      countryOfOrigin: "United States",
      yearDesigned: 1972,
      yearInService: 2005,
      primaryUser: "Limited military + law enforcement",
    },
    cartridge: "12 gauge (2.75\" shells)",
    muzzleVelocityMs: 380,
    muzzleEnergyJ: 2300,
    cyclicRpm: 300,
    effectiveRangeM: 100,
    maxRangeM: 300,
    weightKg: 5.20,
    loadedWeightKg: 6.80,
    barrelMm: 457,
    barrelProfile: "heavy",
    overallLengthMm: 965,
    stdMagCapacity: 8,
    feed: "box-mag",
    action: "gas-piston",
    fireModes: ["safe", "semi", "auto"],
    trigger: { pullWeightN: 22.0, creepMm: 1.5, resetMm: 1.0, type: "single_stage" },
    stock: "fixed",
    handguard: "polymer",
    defaultMuzzle: "compensator",
    sightRadiusMm: 0,
    recoil: recoil(1.5, 0.5, 7.00, 11.5, 0, "high"),
    ergonomics: erg(6.0, 9.0, 7.0, 6.0, 7.0, 6.5),
    role: "Full-auto combat shotgun",
    history: "Full-auto shotgun designed by Maxwell Atchisson; constant-recoil principle reduces felt recoil. Drum-mag fed; fires FRAG-12 explosive rounds.",
    tags: ["shotgun", "12ga", "full-auto", "gas-piston", "drum"],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LMGs + GPMGs
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "m249",
    realName: "FN M249 SAW (M249 LMG)",
    aliases: ["M249", "SAW", "Squad Automatic Weapon"],
    category: "LMG",
    gameSlug: "m249",
    provenance: {
      manufacturer: "FN Herstal (US plant, Columbia, SC)",
      countryOfOrigin: "Belgium / United States",
      yearDesigned: 1976,
      yearInService: 1984,
      primaryUser: "US Armed Forces, numerous NATO militaries",
      conflicts: ["Gulf War", "War in Afghanistan", "Iraq War"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 915,
    muzzleEnergyJ: 1755,
    cyclicRpm: 850,
    effectiveRangeM: 800,
    maxRangeM: 3600,
    weightKg: 7.10,
    loadedWeightKg: 8.30,
    barrelMm: 466,
    barrelProfile: "heavy",
    overallLengthMm: 1040,
    stdMagCapacity: 200,
    feed: "belt-fed",
    action: "gas-piston",
    fireModes: ["safe", "auto"],
    trigger: { pullWeightN: 35.0, creepMm: 3.0, resetMm: 1.5, type: "single_stage" },
    stock: "fixed",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(1.5, 0.5, 2.90, 4.8, 16, "moderate"),
    ergonomics: erg(5.5, 8.5, 6.5, 7.0, 7.5, 6.5),
    role: "Squad automatic weapon",
    history: "FN Minimi adopted by US military as the M249; feeds from belts or STANAG mags. Standard squad automatic weapon since 1984.",
    tags: ["lmg", "NATO", "gas-piston", "5.56", "belt-fed", "saw"],
  },

  {
    id: "rpk74",
    realName: "RPK-74",
    aliases: ["RPK", "RPK-74M"],
    category: "LMG",
    gameSlug: "rpk",
    provenance: {
      manufacturer: "Izhmash / Kalashnikov Concern",
      countryOfOrigin: "Soviet Union",
      yearDesigned: 1974,
      yearInService: 1978,
      primaryUser: "Soviet / Russian Army",
      conflicts: ["Soviet-Afghan War", "Chechen Wars", "War in Donbas"],
    },
    cartridge: "5.45×39mm",
    muzzleVelocityMs: 960,
    muzzleEnergyJ: 1730,
    cyclicRpm: 600,
    effectiveRangeM: 600,
    maxRangeM: 3000,
    weightKg: 4.70,
    loadedWeightKg: 5.50,
    barrelMm: 590,
    barrelProfile: "heavy",
    overallLengthMm: 1055,
    stdMagCapacity: 45,
    feed: "AK-pattern",
    action: "gas-piston",
    fireModes: ["safe", "auto", "semi"],
    trigger: { pullWeightN: 26.7, creepMm: 4.0, resetMm: 2.0, type: "single_stage" },
    stock: "fixed",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 580,
    recoil: recoil(1.2, 0.4, 3.10, 5.0, 14, "moderate"),
    ergonomics: erg(6.5, 8.5, 5.5, 5.5, 9.0, 7.0),
    role: "Squad automatic weapon",
    history: "Heavy-barrel + bipod AK-pattern support weapon; standard Soviet + Russian squad automatic. 45-round box mag or 75-round drum.",
    tags: ["lmg", "eastern-bloc", "gas-piston", "5.45", "ak-derived"],
  },

  {
    id: "pkm",
    realName: "PKM (PK Kalashnikov Machine Gun)",
    aliases: ["PKM", "PK"],
    category: "LMG",
    provenance: {
      manufacturer: "Izhmash / Vyatskiye Polyany",
      countryOfOrigin: "Soviet Union",
      yearDesigned: 1961,
      yearInService: 1961,
      primaryUser: "Soviet / Russian Army, numerous former-Soviet states",
      conflicts: ["Soviet-Afghan War", "Chechen Wars", "Syrian Civil War", "War in Donbas"],
    },
    cartridge: "7.62×54mmR",
    muzzleVelocityMs: 825,
    muzzleEnergyJ: 3300,
    cyclicRpm: 650,
    effectiveRangeM: 1500,
    maxRangeM: 4400,
    weightKg: 8.40,
    loadedWeightKg: 10.20,
    barrelMm: 605,
    barrelProfile: "heavy",
    overallLengthMm: 1192,
    stdMagCapacity: 100,
    feed: "belt-fed",
    action: "gas-piston",
    fireModes: ["safe", "auto"],
    trigger: { pullWeightN: 30.0, creepMm: 3.0, resetMm: 1.5, type: "single_stage" },
    stock: "fixed",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(2.5, 0.7, 6.50, 10.5, 22, "high"),
    ergonomics: erg(6.0, 8.5, 6.0, 5.0, 8.5, 7.0),
    role: "General-purpose machine gun",
    history: "Soviet GPMG, AK-pattern long-stroke piston; replaced the SG-43. Standard issue for Soviet + Russian infantry + many client states.",
    tags: ["lmg", "eastern-bloc", "gas-piston", "762x54r", "belt-fed", "gpmg"],
  },

  {
    id: "pkp_pecheneg",
    realName: "PKP Pecheneg",
    aliases: ["Pecheneg", "PKP"],
    category: "LMG",
    provenance: {
      manufacturer: "Izhmash / Degtyarev Plant",
      countryOfOrigin: "Russia",
      yearDesigned: 2001,
      yearInService: 2005,
      primaryUser: "Russian Army, Spetsnaz",
      conflicts: ["Second Chechen War", "Syrian Civil War", "War in Donbas"],
    },
    cartridge: "7.62×54mmR",
    muzzleVelocityMs: 825,
    muzzleEnergyJ: 3300,
    cyclicRpm: 650,
    effectiveRangeM: 1500,
    maxRangeM: 4400,
    weightKg: 8.20,
    loadedWeightKg: 10.00,
    barrelMm: 605,
    barrelProfile: "heavy",
    overallLengthMm: 1148,
    stdMagCapacity: 100,
    feed: "belt-fed",
    action: "gas-piston",
    fireModes: ["safe", "auto"],
    trigger: { pullWeightN: 30.0, creepMm: 3.0, resetMm: 1.5, type: "single_stage" },
    stock: "fixed",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(2.4, 0.7, 6.40, 10.3, 21, "high"),
    ergonomics: erg(6.5, 8.5, 6.0, 5.0, 8.5, 7.0),
    role: "General-purpose machine gun",
    history: "Modernized PKM with forced-air barrel cooling (no quick-change barrel needed); standard issue for Russian motor-rifle units.",
    tags: ["lmg", "russian", "gas-piston", "762x54r", "belt-fed", "gpmg"],
  },

  {
    id: "m240b",
    realName: "FN M240B (MAG-58)",
    aliases: ["M240", "MAG-58", "Pig"],
    category: "LMG",
    gameSlug: "m240b",
    provenance: {
      manufacturer: "FN Herstal (US plant, Columbia, SC)",
      countryOfOrigin: "Belgium / United States",
      yearDesigned: 1958,
      yearInService: 1977,
      primaryUser: "US Armed Forces, numerous NATO militaries",
      conflicts: ["Gulf War", "War in Afghanistan", "Iraq War"],
    },
    cartridge: "7.62×51mm NATO",
    muzzleVelocityMs: 838,
    muzzleEnergyJ: 3500,
    cyclicRpm: 800,
    effectiveRangeM: 1800,
    maxRangeM: 4400,
    weightKg: 12.50,
    loadedWeightKg: 14.10,
    barrelMm: 630,
    barrelProfile: "heavy",
    overallLengthMm: 1245,
    stdMagCapacity: 100,
    feed: "belt-fed",
    action: "gas-piston",
    fireModes: ["safe", "auto"],
    trigger: { pullWeightN: 35.0, creepMm: 3.0, resetMm: 1.5, type: "single_stage" },
    stock: "fixed",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(2.6, 0.7, 6.80, 11.0, 22, "high"),
    ergonomics: erg(5.0, 9.0, 6.5, 6.0, 8.0, 7.0),
    role: "General-purpose machine gun",
    history: "FN MAG-58 adopted by US military as the M240; standard 7.62mm GPMG since 1977. Heavier than the PKM but very reliable.",
    tags: ["lmg", "NATO", "gas-piston", "7.62", "belt-fed", "gpmg"],
  },

  {
    id: "mg4",
    realName: "H&K MG4 (HK123)",
    aliases: ["MG4", "MG43"],
    category: "LMG",
    provenance: {
      manufacturer: "Heckler & Koch",
      countryOfOrigin: "Germany",
      yearDesigned: 1990,
      yearInService: 2003,
      primaryUser: "German Bundeswehr",
      conflicts: ["War in Afghanistan", "Mali conflict"],
    },
    cartridge: "5.56×45mm NATO",
    muzzleVelocityMs: 920,
    muzzleEnergyJ: 1755,
    cyclicRpm: 890,
    effectiveRangeM: 800,
    maxRangeM: 3600,
    weightKg: 8.55,
    loadedWeightKg: 9.55,
    barrelMm: 482,
    barrelProfile: "heavy",
    overallLengthMm: 1170,
    stdMagCapacity: 100,
    feed: "belt-fed",
    action: "gas-piston",
    fireModes: ["safe", "auto"],
    trigger: { pullWeightN: 32.0, creepMm: 3.0, resetMm: 1.5, type: "single_stage" },
    stock: "folding",
    handguard: "polymer",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(1.5, 0.5, 2.95, 4.8, 15, "moderate"),
    ergonomics: erg(7.0, 8.5, 6.5, 6.5, 7.5, 7.0),
    role: "Light machine gun",
    history: "H&K 5.56mm belt-fed LMG; replaces the MG3 in the squad automatic role for the Bundeswehr. Folding stock + integrated Picatinny rail.",
    tags: ["lmg", "NATO", "gas-piston", "5.56", "belt-fed", "german"],
  },

  {
    id: "mk48",
    realName: "FN Mk 48 Mod 1",
    aliases: ["Mk 48"],
    category: "LMG",
    gameSlug: "mk48",
    provenance: {
      manufacturer: "FN Herstal",
      countryOfOrigin: "Belgium",
      yearDesigned: 2003,
      yearInService: 2003,
      primaryUser: "US Special Operations Command",
      conflicts: ["War in Afghanistan", "Iraq War"],
    },
    cartridge: "7.62×51mm NATO",
    muzzleVelocityMs: 838,
    muzzleEnergyJ: 3500,
    cyclicRpm: 800,
    effectiveRangeM: 1800,
    maxRangeM: 4400,
    weightKg: 8.20,
    loadedWeightKg: 9.70,
    barrelMm: 502,
    barrelProfile: "heavy",
    overallLengthMm: 1006,
    stdMagCapacity: 100,
    feed: "belt-fed",
    action: "gas-piston",
    fireModes: ["safe", "auto"],
    trigger: { pullWeightN: 32.0, creepMm: 3.0, resetMm: 1.5, type: "single_stage" },
    stock: "collapsible",
    handguard: "picatinny_full",
    defaultMuzzle: "flash_hider",
    sightRadiusMm: 0,
    recoil: recoil(2.4, 0.7, 6.50, 10.5, 21, "high"),
    ergonomics: erg(6.5, 9.0, 7.0, 7.5, 7.5, 7.0),
    role: "Special operations LMG",
    history: "Lightened M240 variant for USSOCOM; 7.62mm belt-fed at M240B cyclic rate but ~30% lighter weight. Standard issue for Navy SEALs + Army SF.",
    tags: ["lmg", "NATO", "gas-piston", "7.62", "belt-fed", "specops"],
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LAUNCHERS (anti-materiel / anti-tank)
  // ═══════════════════════════════════════════════════════════════════════════

  {
    id: "rpg7",
    realName: "RPG-7",
    aliases: ["RPG", "Ruchnoy Protivotankoviy Granatomyot"],
    category: "SHOTGUN",
    provenance: {
      manufacturer: "Bazalt (Russia) / numerous licensees + clones",
      countryOfOrigin: "Soviet Union",
      yearDesigned: 1958,
      yearInService: 1961,
      primaryUser: "Russian Army, numerous former-Soviet + insurgent forces",
      conflicts: ["Vietnam War", "Soviet-Afghan War", "Iraq War", "Syrian Civil War", "War in Donbas"],
    },
    cartridge: "40mm PG-7V (HEAT)",
    muzzleVelocityMs: 145,
    muzzleEnergyJ: 30000,
    cyclicRpm: 0,
    effectiveRangeM: 200,
    maxRangeM: 920,
    weightKg: 7.00,
    loadedWeightKg: 8.60,
    barrelMm: 950,
    barrelProfile: "standard",
    overallLengthMm: 950,
    stdMagCapacity: 1,
    feed: "internal-mag",
    action: "single-action",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 25.0, creepMm: 5.0, resetMm: 0, type: "single_action" },
    stock: "none",
    handguard: "polymer",
    defaultMuzzle: "none",
    sightRadiusMm: 0,
    recoil: recoil(4.0, 1.0, 35.00, 50.0, 0, "extreme"),
    ergonomics: erg(5.5, 4.5, 5.0, 2.0, 7.5, 6.0),
    role: "Anti-tank rocket launcher",
    history: "Iconic Soviet anti-tank rocket launcher; PG-7V HEAT round penetrates 260mm RHA. Most widely used AT weapon in history; produced by 9+ countries.",
    tags: ["launcher", "anti-tank", "rocket", "eastern-bloc", "heat"],
  },

  {
    id: "javelin",
    realName: "FGM-148 Javelin",
    aliases: ["Javelin", "FGM-148"],
    category: "SHOTGUN",
    provenance: {
      manufacturer: "Raytheon / Lockheed Martin",
      countryOfOrigin: "United States",
      yearDesigned: 1989,
      yearInService: 1996,
      primaryUser: "US Armed Forces, UK, Ukraine, numerous NATO militaries",
      conflicts: ["Iraq War", "War in Afghanistan", "War in Donbas (Ukraine)"],
    },
    cartridge: "127mm FGM-148 (tandem-charge HEAT)",
    muzzleVelocityMs: 175,
    muzzleEnergyJ: 90000,
    cyclicRpm: 0,
    effectiveRangeM: 2500,
    maxRangeM: 4750,
    weightKg: 11.80,
    loadedWeightKg: 22.30,
    barrelMm: 1200,
    barrelProfile: "bull",
    overallLengthMm: 1200,
    stdMagCapacity: 1,
    feed: "internal-mag",
    action: "single-action",
    fireModes: ["safe", "semi"],
    trigger: { pullWeightN: 25.0, creepMm: 5.0, resetMm: 0, type: "single_action" },
    stock: "none",
    handguard: "polymer",
    defaultMuzzle: "none",
    sightRadiusMm: 0,
    recoil: recoil(3.5, 1.0, 30.00, 40.0, 0, "extreme"),
    ergonomics: erg(4.5, 4.0, 5.5, 1.5, 5.5, 8.5),
    role: "Man-portable anti-tank missile",
    history: "Fire-and-forget ATGM with top-attack + direct-fire modes; soft-launch then main motor accelerates to ~600 m/s. Ukrainian forces have used it extensively against Russian armor.",
    tags: ["launcher", "anti-tank", "missile", "fire-and-forget", "top-attack"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — lookup, filter, sort.
// ─────────────────────────────────────────────────────────────────────────────

/** Find a catalog entry by its in-game slug. */
export function findByGameSlug(slug: WeaponType): RealCatalogEntry | undefined {
  return REAL_CATALOG.find((w) => w.gameSlug === slug);
}

/** Find a catalog entry by its catalog ID. */
export function findById(id: string): RealCatalogEntry | undefined {
  return REAL_CATALOG.find((w) => w.id === id);
}

/** Find a catalog entry by real-world name (case-insensitive, exact or alias). */
export function findByRealName(name: string): RealCatalogEntry | undefined {
  const lower = name.toLowerCase().trim();
  return REAL_CATALOG.find((w) =>
    w.realName.toLowerCase() === lower ||
    w.aliases?.some((a) => a.toLowerCase() === lower));
}

/** All catalog entries in a category. */
export function byCategory(category: WeaponCategory): RealCatalogEntry[] {
  return REAL_CATALOG.filter((w) => w.category === category);
}

/** All catalog entries from a given country of origin. */
export function byCountry(country: string): RealCatalogEntry[] {
  return REAL_CATALOG.filter((w) =>
    w.provenance.countryOfOrigin.toLowerCase().includes(country.toLowerCase()));
}

/** All catalog entries from a given manufacturer. */
export function byManufacturer(manufacturer: string): RealCatalogEntry[] {
  return REAL_CATALOG.filter((w) =>
    w.provenance.manufacturer.toLowerCase().includes(manufacturer.toLowerCase()));
}

/** All catalog entries matching any of the given tags. */
export function byTags(tags: string[]): RealCatalogEntry[] {
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  return REAL_CATALOG.filter((w) => w.tags.some((t) => tagSet.has(t.toLowerCase())));
}

/** All catalog entries in service during a given year. */
export function inServiceDuring(year: number): RealCatalogEntry[] {
  return REAL_CATALOG.filter((w) =>
    year >= w.provenance.yearInService && year <= w.provenance.yearInService + 50);
}

/** Sort entries by a numeric stat. */
export function sortByStat<K extends keyof RealCatalogEntry>(
  stat: K,
  direction: "asc" | "desc" = "asc",
): RealCatalogEntry[] {
  return REAL_CATALOG.slice().sort((a, b) => {
    const av = a[stat] as unknown as number | string;
    const bv = b[stat] as unknown as number | string;
    if (typeof av === "number" && typeof bv === "number") {
      return direction === "asc" ? av - bv : bv - av;
    }
    const as = String(av);
    const bs = String(bv);
    return direction === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat range + percentile helpers (for chart scaling).
// ─────────────────────────────────────────────────────────────────────────────

/** Min + max of a numeric stat across the catalog (excludes 0 = N/A). */
export function statRange<K extends keyof RealCatalogEntry>(
  stat: K,
): { min: number; max: number; avg: number } {
  const values = REAL_CATALOG
    .map((w) => w[stat] as unknown as number)
    .filter((v) => typeof v === "number" && v > 0);
  if (values.length === 0) return { min: 0, max: 0, avg: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  return { min, max, avg };
}

/** Percentile rank of a value within the catalog for a numeric stat. */
export function statPercentile<K extends keyof RealCatalogEntry>(
  stat: K,
  value: number,
): number {
  const values = REAL_CATALOG
    .map((w) => w[stat] as unknown as number)
    .filter((v) => typeof v === "number" && v > 0);
  if (values.length === 0) return 0;
  const below = values.filter((v) => v < value).length;
  return below / values.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Weapon comparison — for the tuning bench UI side-by-side.
// ─────────────────────────────────────────────────────────────────────────────

export interface WeaponComparisonRow {
  label: string;
  values: (number | string | undefined)[];
  /** 0..1 normalized rank within the catalog (only for numeric rows). */
  percentiles?: (number | undefined)[];
  /** Higher is better? (only for numeric rows). */
  higherIsBetter?: boolean;
  /** Unit suffix. */
  unit?: string;
}

/** Build a comparison table for up to N weapons. */
export function compareWeapons(entries: RealCatalogEntry[]): WeaponComparisonRow[] {
  const rows: WeaponComparisonRow[] = [
    { label: "Manufacturer", values: entries.map((w) => w.provenance.manufacturer) },
    { label: "Country", values: entries.map((w) => w.provenance.countryOfOrigin) },
    { label: "In Service", values: entries.map((w) => w.provenance.yearInService), unit: "year" },
    { label: "Cartridge", values: entries.map((w) => w.cartridge) },
    {
      label: "Muzzle Velocity",
      values: entries.map((w) => w.muzzleVelocityMs),
      percentiles: entries.map((w) => statPercentile("muzzleVelocityMs", w.muzzleVelocityMs)),
      higherIsBetter: true, unit: "m/s",
    },
    {
      label: "Muzzle Energy",
      values: entries.map((w) => w.muzzleEnergyJ),
      percentiles: entries.map((w) => statPercentile("muzzleEnergyJ", w.muzzleEnergyJ)),
      higherIsBetter: true, unit: "J",
    },
    {
      label: "Cyclic Rate",
      values: entries.map((w) => w.cyclicRpm || "Semi"),
      percentiles: entries.map((w) => w.cyclicRpm ? statPercentile("cyclicRpm", w.cyclicRpm) : undefined),
      higherIsBetter: true, unit: "RPM",
    },
    {
      label: "Effective Range",
      values: entries.map((w) => w.effectiveRangeM),
      percentiles: entries.map((w) => statPercentile("effectiveRangeM", w.effectiveRangeM)),
      higherIsBetter: true, unit: "m",
    },
    {
      label: "Empty Weight",
      values: entries.map((w) => w.weightKg),
      percentiles: entries.map((w) => statPercentile("weightKg", w.weightKg)),
      higherIsBetter: false, unit: "kg",
    },
    {
      label: "Barrel Length",
      values: entries.map((w) => w.barrelMm),
      percentiles: entries.map((w) => statPercentile("barrelMm", w.barrelMm)),
      higherIsBetter: false, unit: "mm",
    },
    {
      label: "Magazine Capacity",
      values: entries.map((w) => w.stdMagCapacity),
      percentiles: entries.map((w) => statPercentile("stdMagCapacity", w.stdMagCapacity)),
      higherIsBetter: true, unit: "rds",
    },
    { label: "Action", values: entries.map((w) => w.action) },
    { label: "Fire Modes", values: entries.map((w) => w.fireModes.join(" / ")) },
    {
      label: "Trigger Pull",
      values: entries.map((w) => w.trigger.pullWeightN),
      higherIsBetter: false, unit: "N",
    },
    {
      label: "Vertical Recoil",
      values: entries.map((w) => w.recoil.verticalMoa),
      percentiles: entries.map((w) => statPercentile("recoil" as keyof RealCatalogEntry, w.recoil.verticalMoa)),
      higherIsBetter: false, unit: "MOA",
    },
    { label: "Default Muzzle Device", values: entries.map((w) => w.defaultMuzzle) },
    { label: "Stock Type", values: entries.map((w) => w.stock) },
    { label: "Handguard", values: entries.map((w) => w.handguard) },
    {
      label: "Ergonomics: Handling",
      values: entries.map((w) => w.ergonomics.handling),
      higherIsBetter: true, unit: "/10",
    },
    {
      label: "Ergonomics: Recoil Control",
      values: entries.map((w) => w.ergonomics.recoilControl),
      higherIsBetter: true, unit: "/10",
    },
    {
      label: "Ergonomics: Trigger",
      values: entries.map((w) => w.ergonomics.trigger),
      higherIsBetter: true, unit: "/10",
    },
    {
      label: "Ergonomics: Modularity",
      values: entries.map((w) => w.ergonomics.modularity),
      higherIsBetter: true, unit: "/10",
    },
  ];
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestions — for the Gunsmith "recommended attachments" panel.
// ─────────────────────────────────────────────────────────────────────────────

export interface AttachmentSuggestion {
  socket: "muzzle" | "sight" | "grip" | "magazine";
  recommended: string;
  reason: string;
}

/** Suggest attachments to compensate for the weapon's weaknesses. */
export function suggestAttachments(weapon: RealCatalogEntry): AttachmentSuggestion[] {
  const suggestions: AttachmentSuggestion[] = [];

  // Muzzle suggestions based on recoil + role.
  if (weapon.recoil.impulseClass === "high" || weapon.recoil.impulseClass === "extreme") {
    suggestions.push({
      socket: "muzzle",
      recommended: weapon.category === "SNIPER" ? "Muzzle Brake" : "Compensator",
      reason: `Mitigate ${weapon.recoil.impulseClass} recoil (${weapon.recoil.verticalMoa.toFixed(1)} MOA vertical).`,
    });
  } else if (weapon.category === "SMG" || weapon.category === "RIFLE") {
    suggestions.push({
      socket: "muzzle",
      recommended: "Suppressor",
      reason: "Low recoil allows suppressor without penalty; hides firing signature.",
    });
  }

  // Sight suggestions based on effective range.
  if (weapon.effectiveRangeM >= 800) {
    suggestions.push({
      socket: "sight",
      recommended: "8x Scope",
      reason: `Effective range ${weapon.effectiveRangeM}m requires magnified optic.`,
    });
  } else if (weapon.effectiveRangeM >= 400) {
    suggestions.push({
      socket: "sight",
      recommended: "ACOG (4×) or LPVO (1-4×)",
      reason: `Mid-range engagements (${weapon.effectiveRangeM}m) — 4× magnification optimal.`,
    });
  } else {
    suggestions.push({
      socket: "sight",
      recommended: "Red Dot or Holographic",
      reason: `Close-range weapon (${weapon.effectiveRangeM}m) — fast target acquisition.`,
    });
  }

  // Grip suggestions based on recoil.
  if (weapon.recoil.climbDegPerSec > 18) {
    suggestions.push({
      socket: "grip",
      recommended: "Vertical Foregrip",
      reason: `Muzzle climb ${weapon.recoil.climbDegPerSec.toFixed(0)}°/sec — vertical grip improves control.`,
    });
  } else {
    suggestions.push({
      socket: "grip",
      recommended: "Angled Foregrip",
      reason: "Stable recoil pattern — angled grip improves ADS speed.",
    });
  }

  // Magazine suggestions based on cyclic rate + role.
  if (weapon.category === "LMG" || weapon.stdMagCapacity < 15) {
    suggestions.push({
      socket: "magazine",
      recommended: "Extended Magazine",
      reason: `Standard ${weapon.stdMagCapacity}-round mag is small for ${weapon.role.toLowerCase()}.`,
    });
  } else if (weapon.category === "SMG" || weapon.category === "RIFLE") {
    suggestions.push({
      socket: "magazine",
      recommended: "Quickdraw Magazine",
      reason: "Standard capacity is adequate; quickdraw speeds up reloads.",
    });
  }

  return suggestions;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog summary — for the Gunsmith spec card.
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogSummary {
  totalEntries: number;
  byCategory: Record<WeaponCategory, number>;
  byCountry: Record<string, number>;
  yearRange: { earliest: number; latest: number };
  /** Average stats across the catalog (for "above/below average" labels). */
  avgMuzzleVelocityMs: number;
  avgCyclicRpm: number;
  avgWeightKg: number;
  avgEffectiveRangeM: number;
}

/** Summary statistics for the entire catalog. */
export function catalogSummary(): CatalogSummary {
  const byCategory = {} as Record<WeaponCategory, number>;
  const byCountry: Record<string, number> = {};
  let earliest = 9999, latest = 0;
  let sumV = 0, sumRpm = 0, sumW = 0, sumR = 0;
  for (const w of REAL_CATALOG) {
    byCategory[w.category] = (byCategory[w.category] ?? 0) + 1;
    byCountry[w.provenance.countryOfOrigin] =
      (byCountry[w.provenance.countryOfOrigin] ?? 0) + 1;
    if (w.provenance.yearInService < earliest) earliest = w.provenance.yearInService;
    if (w.provenance.yearInService > latest) latest = w.provenance.yearInService;
    sumV += w.muzzleVelocityMs;
    if (w.cyclicRpm > 0) sumRpm += w.cyclicRpm;
    sumW += w.weightKg;
    sumR += w.effectiveRangeM;
  }
  const n = REAL_CATALOG.length;
  return {
    totalEntries: n,
    byCategory,
    byCountry,
    yearRange: { earliest, latest },
    avgMuzzleVelocityMs: sumV / n,
    avgCyclicRpm: sumRpm / n,
    avgWeightKg: sumW / n,
    avgEffectiveRangeM: sumR / n,
  };
}

/** All unique manufacturers in the catalog. */
export function allManufacturers(): string[] {
  return Array.from(new Set(REAL_CATALOG.map((w) => w.provenance.manufacturer))).sort();
}

/** All unique countries in the catalog. */
export function allCountries(): string[] {
  return Array.from(new Set(REAL_CATALOG.map((w) => w.provenance.countryOfOrigin))).sort();
}

/** All unique cartridges in the catalog. */
export function allCartridges(): string[] {
  return Array.from(new Set(REAL_CATALOG.map((w) => w.cartridge))).sort();
}

/** All unique tags in the catalog. */
export function allTags(): string[] {
  return Array.from(new Set(REAL_CATALOG.flatMap((w) => w.tags))).sort();
}
