/**
 * SEC5-COMBAT — Prompt 41: Per-weapon sound layering profile.
 *
 * SEC8-AUDIO already built `AudioEngine.playLayeredGunshot(preset)` with 4 layers:
 *   (a) mechanical action — short click (hammer/striker)
 *   (b) report/crack — bandpass noise burst with fast decay
 *   (c) tail/reverb — lowpass noise with longer decay, sent to reverb
 *   (d) body thump — low-frequency triangle for physical weight
 *
 * The current audio system derives the preset from a 6-caliber table
 * (`GUNSHOT_PRESETS` in audio.ts, keyed by `slugToCaliber(slug)`). That's fine
 * for synth fallback but it loses per-weapon character: the AK-74 and the M4
 * both map to "rifle" and therefore sound identical.
 *
 * This module is the per-weapon layer the audio system will read when a real
 * sample (`gunshot_<slug>.wav`) isn't cached. Each profile carries:
 *
 *   - `caliber` — the SEC8 6-caliber slug (rifle/smg/pistol/sniper/shotgun/lmg).
 *     Used as the base synth preset; the per-weapon fields below layer on top.
 *   - `cartridge` — the actual cartridge (5.45mm, 5.56mm, 9mm, .45 ACP, .50 AE,
 *     7.62mm, .338 Lapua, 12-ga, 7.92mm). Drives the body-thump frequency.
 *   - `actionCharacter` — mechanical action flavour:
 *       "gas_piston" (AK/HK416), "direct_impingement" (M4), "blowback" (most
 *       pistols + SMGs), "rotating_bolt" (snipers/LMGs), "roller_delayed"
 *       (MP5), "short_recoil" (Deagle/revolver). Drives the click layer shape.
 *   - `tailLengthMs` — how long the reverb tail holds. Indoor weapons (SMG)
 *     have shorter tails; sniper rounds carry long tails (crack + boom).
 *   - `bodyThumpHz` — centre frequency of the body-thump layer. Heavier
 *     cartridges (12-ga, .50 AE) sit at 80 Hz; 9mm sits at 150 Hz.
 *   - `mechanicalClickHz` — centre frequency of the mechanical click layer.
 *     Pistols have a sharper click (2000-2400 Hz); bolt-actions have a deeper
 *     chunk (1500-1800 Hz).
 *
 * The audio system reads this via `getWeaponSoundProfile(slug)` and uses it to
 * tweak the base `GUNSHOT_PRESETS[caliber]` preset before calling
 * `playLayeredGunshot()`. If the audio system isn't ready to consume this yet,
 * the profile is still useful for gunsmith UI (per-weapon sound preview) + the
 * future VO/bark system (spatialiser can use `tailLengthMs` for reverb send).
 *
 * ── Wiring (one-liner for the orchestrator — WeaponSystem.ts is shared) ──
 * In WeaponSystem.tryShoot, after the existing `ctx.audio.playGunshot(slug)`
 * call (which already routes through `slugToCaliber` + layered synth), swap to:
 *
 *   ctx.audio.playGunshot(slug);  // existing — leave alone
 *
 * Or, when the audio engine exposes a per-weapon layered entrypoint:
 *
 *   const profile = getWeaponSoundProfile(this.ctx.weapon.loadout.weapon);
 *   ctx.audio.playLayeredGunshot(profileToPreset(profile));
 *
 * For now the profile is consumed by `weapon-sound-preview.ts` (gunsmith UI)
 * via a thin adapter. The audio engine integration is the orchestrator's call.
 */

import type { WeaponType, WeaponCategory } from "../store";
import { WEAPONS } from "../store";
import type { Caliber } from "../audio";

/** Mechanical action character — drives the click layer shape. */
export type ActionCharacter =
  | "gas_piston"        // AK-74, HK416, Galil — piston rod + bolt carrier
  | "direct_impingement"// M4 family — direct gas tube onto bolt carrier
  | "blowback"          // most pistols + SMGs — straight blowback
  | "rotating_bolt"     // snipers, LMGs, AUG — multi-lug rotating bolt
  | "roller_delayed"    // MP5 — roller-delayed blowback
  | "short_recoil"      // Deagle, revolver — short-recoil operation
  | "long_stroke_piston"// M249 family — long-stroke gas piston
  | "bolt_action";      // Kar98k, L115A3 — manual bolt operation

/** Per-weapon sound profile. Read by the audio system + gunsmith preview. */
export interface WeaponSoundProfile {
  /** Weapon slug. */
  slug: WeaponType;
  /** SEC8 6-caliber slug (rifle/smg/pistol/sniper/shotgun/lmg). Base preset. */
  caliber: Caliber;
  /** Cartridge label (for gunsmith display). */
  cartridge: string;
  /** Mechanical action flavour — drives the click layer. */
  actionCharacter: ActionCharacter;
  /** Reverb tail length in ms. Indoor weapons short, sniper rounds long. */
  tailLengthMs: number;
  /** Body-thump centre frequency (Hz). Heavier cartridges lower. */
  bodyThumpHz: number;
  /** Mechanical click centre frequency (Hz). Pistols sharper, bolts deeper. */
  mechanicalClickHz: number;
  /** Relative loudness (0..1). Snipers loudest, pistols quietest. */
  loudness: number;
  /** One-line designer note for the gunsmith UI. */
  note: string;
}

/**
 * Per-weapon sound profiles. One entry per WeaponType (30 weapons).
 *
 * Values are calibrated against the SEC8 GUNSHOT_PRESETS table — the per-weapon
 * fields nudge the base preset rather than replacing it. E.g. the AK-74 uses
 * the "rifle" preset as a base, then layers a 110 Hz body thump (heavier than
 * the M4's 120 Hz — the 7.62×39 round is heavier than 5.56) and a 2400 Hz
 * click (gas-piston sharp).
 */
export const WEAPON_SOUND_PROFILES: Record<WeaponType, WeaponSoundProfile> = {
  // ── RIFLE ──
  ak74:    { slug: "ak74",    caliber: "rifle",  cartridge: "5.45×39mm",   actionCharacter: "gas_piston",         tailLengthMs: 220, bodyThumpHz: 110, mechanicalClickHz: 2400, loudness: 0.85, note: "Sharp gas-piston crack + mid-low body. Distant AK signature." },
  m4:      { slug: "m4",      caliber: "rifle",  cartridge: "5.56×45mm",   actionCharacter: "direct_impingement", tailLengthMs: 200, bodyThumpHz: 120, mechanicalClickHz: 2400, loudness: 0.80, note: "Higher-pitched DI crack. Cleaner than the AK." },
  hk416:   { slug: "hk416",   caliber: "rifle",  cartridge: "5.56×45mm",   actionCharacter: "gas_piston",         tailLengthMs: 200, bodyThumpHz: 120, mechanicalClickHz: 2350, loudness: 0.82, note: "Piston system — slightly chunkier click than the M4." },
  famas:   { slug: "famas",   caliber: "rifle",  cartridge: "5.56×45mm",   actionCharacter: "direct_impingement", tailLengthMs: 210, bodyThumpHz: 125, mechanicalClickHz: 2500, loudness: 0.85, note: "Bullpup report — sharper crack, shorter barrel." },
  aug:     { slug: "aug",     caliber: "rifle",  cartridge: "5.56×45mm",   actionCharacter: "rotating_bolt",      tailLengthMs: 215, bodyThumpHz: 122, mechanicalClickHz: 2300, loudness: 0.82, note: "Bullpup smooth. Mid-pitched crack + soft piston." },
  scarh:   { slug: "scarh",   caliber: "rifle",  cartridge: "7.62×51mm",   actionCharacter: "gas_piston",         tailLengthMs: 260, bodyThumpHz: 95,  mechanicalClickHz: 2200, loudness: 0.92, note: "Heavy 7.62 crack. Deeper body thump than 5.56mm rifles." },
  galil:   { slug: "galil",   caliber: "rifle",  cartridge: "5.56×45mm",   actionCharacter: "gas_piston",         tailLengthMs: 220, bodyThumpHz: 115, mechanicalClickHz: 2350, loudness: 0.83, note: "AK-derived piston. Slightly chunkier than the M4." },
  mk17:    { slug: "mk17",    caliber: "rifle",  cartridge: "7.62×51mm",   actionCharacter: "gas_piston",         tailLengthMs: 270, bodyThumpHz: 90,  mechanicalClickHz: 2200, loudness: 0.93, note: "Battle rifle 7.62. Deepest body thump in the rifle class." },
  mk14:    { slug: "mk14",    caliber: "rifle",  cartridge: "7.62×51mm",   actionCharacter: "gas_piston",         tailLengthMs: 270, bodyThumpHz: 92,  mechanicalClickHz: 2250, loudness: 0.93, note: "Marksman 7.62. Long tail, deep body — audible at range." },

  // ── SMG ──
  mp7:     { slug: "mp7",     caliber: "smg",    cartridge: "4.6×30mm",    actionCharacter: "blowback",           tailLengthMs: 140, bodyThumpHz: 155, mechanicalClickHz: 2200, loudness: 0.65, note: "High-pitched PDW crack. Soft body — small cartridge." },
  p90:     { slug: "p90",     caliber: "smg",    cartridge: "5.7×28mm",    actionCharacter: "blowback",           tailLengthMs: 150, bodyThumpHz: 150, mechanicalClickHz: 2250, loudness: 0.68, note: "Bullpup PDW. Slightly longer tail than the MP7." },
  mp5:     { slug: "mp5",     caliber: "smg",    cartridge: "9×19mm",      actionCharacter: "roller_delayed",     tailLengthMs: 160, bodyThumpHz: 145, mechanicalClickHz: 2000, loudness: 0.70, note: "Roller-delayed signature — distinctive mid-pitched chunk." },
  ump45:   { slug: "ump45",   caliber: "smg",    cartridge: ".45 ACP",     actionCharacter: "blowback",           tailLengthMs: 170, bodyThumpHz: 130, mechanicalClickHz: 1900, loudness: 0.75, note: "Heavier .45 ACP body. Slower cyclic report." },
  vector:  { slug: "vector",  caliber: "smg",    cartridge: ".45 ACP",     actionCharacter: "blowback",           tailLengthMs: 150, bodyThumpHz: 135, mechanicalClickHz: 2100, loudness: 0.78, note: "Super V 1200 RPM — fast cyclic, deep .45 body." },
  pp90m1:  { slug: "pp90m1",  caliber: "smg",    cartridge: "9×19mm",      actionCharacter: "blowback",           tailLengthMs: 160, bodyThumpHz: 148, mechanicalClickHz: 2150, loudness: 0.72, note: "Russian helical-mag 9mm. Similar to MP7 but warmer." },

  // ── PISTOL ──
  usp:     { slug: "usp",     caliber: "pistol", cartridge: ".45 ACP",     actionCharacter: "blowback",           tailLengthMs: 180, bodyThumpHz: 140, mechanicalClickHz: 2000, loudness: 0.65, note: "Suppressed .45 — soft report + sharp mechanical click." },
  deagle:  { slug: "deagle",  caliber: "pistol", cartridge: ".50 AE",      actionCharacter: "short_recoil",       tailLengthMs: 250, bodyThumpHz: 80,  mechanicalClickHz: 1900, loudness: 0.95, note: ".50 AE hand-cannon — deep body thump + long tail." },
  glock18: { slug: "glock18", caliber: "pistol", cartridge: "9×19mm",      actionCharacter: "blowback",           tailLengthMs: 140, bodyThumpHz: 150, mechanicalClickHz: 2100, loudness: 0.62, note: "Full-auto 9mm machine pistol — fast cyclic crack." },
  m1911:   { slug: "m1911",   caliber: "pistol", cartridge: ".45 ACP",     actionCharacter: "blowback",           tailLengthMs: 200, bodyThumpHz: 135, mechanicalClickHz: 1950, loudness: 0.72, note: "Classic 1911 .45 — warm body, distinctive 7-round cadence." },
  revolver:{ slug: "revolver",caliber: "pistol", cartridge: ".50 cal",     actionCharacter: "short_recoil",       tailLengthMs: 270, bodyThumpHz: 75,  mechanicalClickHz: 1800, loudness: 0.97, note: ".50 cal revolver — cylinder rotation + deep boom." },

  // ── SNIPER ──
  awp:     { slug: "awp",     caliber: "sniper", cartridge: ".338 Lapua",  actionCharacter: "rotating_bolt",      tailLengthMs: 400, bodyThumpHz: 90,  mechanicalClickHz: 2600, loudness: 1.0,  note: "Long-range .338 Lapua — sharp crack + long tail + deep boom." },
  scout:   { slug: "scout",   caliber: "sniper", cartridge: "7.62×51mm",   actionCharacter: "rotating_bolt",      tailLengthMs: 340, bodyThumpHz: 100, mechanicalClickHz: 2500, loudness: 0.90, note: "Lightweight 7.62 marksman — shorter tail than the AWP." },
  kar98k:  { slug: "kar98k",  caliber: "sniper", cartridge: "7.92×57mm",   actionCharacter: "bolt_action",        tailLengthMs: 360, bodyThumpHz: 95,  mechanicalClickHz: 1700, loudness: 0.93, note: "Mauser bolt-action — distinctive chunky bolt cycle." },
  l115a3:  { slug: "l115a3",  caliber: "sniper", cartridge: ".338 Lapua",  actionCharacter: "bolt_action",        tailLengthMs: 420, bodyThumpHz: 88,  mechanicalClickHz: 1700, loudness: 1.0,  note: "British .338 — heaviest sniper report. Long-range signature." },

  // ── SHOTGUN ──
  nova:    { slug: "nova",    caliber: "shotgun",cartridge: "12-gauge",    actionCharacter: "blowback",           tailLengthMs: 320, bodyThumpHz: 80,  mechanicalClickHz: 1800, loudness: 0.95, note: "Pump 12-ga — deep body thump + rack audible at close range." },
  m1014:   { slug: "m1014",   caliber: "shotgun",cartridge: "12-gauge",    actionCharacter: "gas_piston",         tailLengthMs: 300, bodyThumpHz: 85,  mechanicalClickHz: 1900, loudness: 0.92, note: "Semi-auto 12-ga — gas system softens the body thump." },
  spas12:  { slug: "spas12",  caliber: "shotgun",cartridge: "12-gauge",    actionCharacter: "gas_piston",         tailLengthMs: 310, bodyThumpHz: 82,  mechanicalClickHz: 1850, loudness: 0.94, note: "Dual-mode 12-ga — heavier than the M1014, longer tail." },

  // ── LMG ──
  m249:    { slug: "m249",    caliber: "lmg",    cartridge: "5.56×45mm",   actionCharacter: "long_stroke_piston", tailLengthMs: 220, bodyThumpHz: 110, mechanicalClickHz: 2300, loudness: 0.88, note: "Belt-fed SAW — sustained cyclic report, distinct belt rattle." },
  rpk:     { slug: "rpk",     caliber: "lmg",    cartridge: "5.45×39mm",   actionCharacter: "gas_piston",         tailLengthMs: 230, bodyThumpHz: 105, mechanicalClickHz: 2350, loudness: 0.86, note: "Drum-fed RPK — slightly chunkier than the M249." },
  mk48:    { slug: "mk48",    caliber: "lmg",    cartridge: "7.62×51mm",   actionCharacter: "long_stroke_piston", tailLengthMs: 260, bodyThumpHz: 92,  mechanicalClickHz: 2200, loudness: 0.93, note: "7.62 GPMG — heaviest LMG body thump + longest tail." },
};

/**
 * Get the sound profile for a weapon. Falls back to a generic profile derived
 * from the SEC8 caliber table if the slug isn't in WEAPON_SOUND_PROFILES (which
 * shouldn't happen for the 30 catalogued weapons, but is defensive for new
 * weapons added later).
 */
export function getWeaponSoundProfile(slug: WeaponType): WeaponSoundProfile {
  const direct = WEAPON_SOUND_PROFILES[slug];
  if (direct) return direct;

  // Fallback: derive a generic profile from the caliber. This path is only
  // reached if a new WeaponType was added to the union without a corresponding
  // entry above. The audio system + gunsmith UI degrade gracefully.
  const caliberMap: Record<WeaponCategory, Caliber> = {
    RIFLE: "rifle", SMG: "smg", PISTOL: "pistol",
    SNIPER: "sniper", SHOTGUN: "shotgun", LMG: "lmg",
  };
  const cat = WEAPONS[slug]?.category ?? "RIFLE";
  const caliber = caliberMap[cat];
  return {
    slug, caliber, cartridge: "—",
    actionCharacter: "blowback",
    tailLengthMs: 200, bodyThumpHz: 120, mechanicalClickHz: 2200,
    loudness: 0.75, note: "Generic profile — no per-weapon data.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B1-5000 — Prompts 649, 662–667: per-weapon dry-fire + reload + mag-insert +
// bolt-rack + inspect sounds. The base WeaponSoundProfile covers fire sound
// (#663 — already wired via WeaponSystem.tryShoot → ctx.audio.playGunshot).
// These auxiliary profiles cover the other 4 weapon-action sounds the spec
// calls for. Per-category dry-fire (#649) is the fallback when a per-weapon
// entry isn't present.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-weapon auxiliary sound profile: dry-fire, reload, mag-insert, bolt-rack,
 *  inspect. Each field is an audio slug the AudioEngine resolves (real sample
 *  first, layered synth fallback). Falls back to a per-category default. */
export interface WeaponAuxiliarySoundProfile {
  /** Weapon slug. */
  slug: WeaponType;
  /** Dry-fire audio slug (click when out of ammo). Per-category fallback. */
  dryFireSlug: string;
  /** Reload audio slug (full reload sequence). */
  reloadSlug: string;
  /** Mag-insertion audio slug (the "click" of the mag seating). */
  magInsertSlug: string;
  /** Bolt-rack / charging-handle audio slug. */
  boltRackSlug: string;
  /** Inspect audio slug (Y-key inspect animation). */
  inspectSlug: string;
}

/** Per-category dry-fire audio slug (Prompt 649 — distinct per category). */
export const CATEGORY_DRY_FIRE_SLUG: Record<WeaponCategory, string> = {
  RIFLE: "dry_fire_rifle",
  SMG: "dry_fire_smg",
  PISTOL: "dry_fire_pistol",
  SNIPER: "dry_fire_sniper",
  SHOTGUN: "dry_fire_shotgun",
  LMG: "dry_fire_lmg",
};

/** Per-weapon auxiliary sound profiles. Covers the 30 catalogued weapons.
 *  Falls back to the per-category default when a slug isn't found. */
export const WEAPON_AUXILIARY_SOUNDS: Partial<Record<WeaponType, WeaponAuxiliarySoundProfile>> = {
  // ── RIFLE ──
  ak74:    { slug: "ak74",    dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_ak74",    magInsertSlug: "mag_insert_ak",    boltRackSlug: "bolt_rak_ak",    inspectSlug: "inspect_ak74" },
  m4:      { slug: "m4",      dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_m4",      magInsertSlug: "mag_insert_ar",    boltRackSlug: "bolt_rak_ar",    inspectSlug: "inspect_m4" },
  hk416:   { slug: "hk416",   dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_hk416",   magInsertSlug: "mag_insert_ar",    boltRackSlug: "bolt_rak_ar",    inspectSlug: "inspect_hk416" },
  famas:   { slug: "famas",   dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_famas",   magInsertSlug: "mag_insert_famas", boltRackSlug: "bolt_rak_bullpup", inspectSlug: "inspect_famas" },
  aug:     { slug: "aug",     dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_aug",     magInsertSlug: "mag_insert_aug",   boltRackSlug: "bolt_rak_bullpup", inspectSlug: "inspect_aug" },
  scarh:   { slug: "scarh",   dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_scarh",   magInsertSlug: "mag_insert_scar",  boltRackSlug: "bolt_rak_ar",    inspectSlug: "inspect_scarh" },
  galil:   { slug: "galil",   dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_galil",   magInsertSlug: "mag_insert_ak",    boltRackSlug: "bolt_rak_ak",    inspectSlug: "inspect_galil" },
  mk17:    { slug: "mk17",    dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_mk17",    magInsertSlug: "mag_insert_scar",  boltRackSlug: "bolt_rak_ar",    inspectSlug: "inspect_mk17" },
  mk14:    { slug: "mk14",    dryFireSlug: "dry_fire_rifle",    reloadSlug: "reload_mk14",    magInsertSlug: "mag_insert_m14",   boltRackSlug: "bolt_rak_ar",    inspectSlug: "inspect_mk14" },
  // ── SMG ──
  mp7:     { slug: "mp7",     dryFireSlug: "dry_fire_smg",      reloadSlug: "reload_mp7",     magInsertSlug: "mag_insert_mp7",   boltRackSlug: "bolt_rak_smg",   inspectSlug: "inspect_mp7" },
  p90:     { slug: "p90",     dryFireSlug: "dry_fire_smg",      reloadSlug: "reload_p90",     magInsertSlug: "mag_insert_p90",   boltRackSlug: "bolt_rak_bullpup", inspectSlug: "inspect_p90" },
  mp5:     { slug: "mp5",     dryFireSlug: "dry_fire_smg",      reloadSlug: "reload_mp5",     magInsertSlug: "mag_insert_mp5",   boltRackSlug: "bolt_rak_mp5",   inspectSlug: "inspect_mp5" },
  ump45:   { slug: "ump45",   dryFireSlug: "dry_fire_smg",      reloadSlug: "reload_ump45",   magInsertSlug: "mag_insert_ump",   boltRackSlug: "bolt_rak_smg",   inspectSlug: "inspect_ump45" },
  vector:  { slug: "vector",  dryFireSlug: "dry_fire_smg",      reloadSlug: "reload_vector",  magInsertSlug: "mag_insert_vector",boltRackSlug: "bolt_rak_smg",   inspectSlug: "inspect_vector" },
  pp90m1:  { slug: "pp90m1",  dryFireSlug: "dry_fire_smg",      reloadSlug: "reload_pp90m1",  magInsertSlug: "mag_insert_pp90",  boltRackSlug: "bolt_rak_smg",   inspectSlug: "inspect_pp90m1" },
  // ── PISTOL ──
  usp:     { slug: "usp",     dryFireSlug: "dry_fire_pistol",   reloadSlug: "reload_usp",     magInsertSlug: "mag_insert_pistol",boltRackSlug: "slide_rack_pistol", inspectSlug: "inspect_usp" },
  deagle:  { slug: "deagle",  dryFireSlug: "dry_fire_pistol",   reloadSlug: "reload_deagle",  magInsertSlug: "mag_insert_deagle",boltRackSlug: "slide_rack_pistol", inspectSlug: "inspect_deagle" },
  glock18: { slug: "glock18", dryFireSlug: "dry_fire_pistol",   reloadSlug: "reload_glock18", magInsertSlug: "mag_insert_glock", boltRackSlug: "slide_rack_pistol", inspectSlug: "inspect_glock18" },
  m1911:   { slug: "m1911",   dryFireSlug: "dry_fire_pistol",   reloadSlug: "reload_m1911",   magInsertSlug: "mag_insert_1911",  boltRackSlug: "slide_rack_pistol", inspectSlug: "inspect_m1911" },
  revolver:{ slug: "revolver",dryFireSlug: "dry_fire_pistol",   reloadSlug: "reload_revolver",magInsertSlug: "speed_loader",     boltRackSlug: "cylinder_close",  inspectSlug: "inspect_revolver" },
  // ── SNIPER ──
  awp:     { slug: "awp",     dryFireSlug: "dry_fire_sniper",   reloadSlug: "reload_awp",     magInsertSlug: "mag_insert_awp",   boltRackSlug: "bolt_lift_awp",  inspectSlug: "inspect_awp" },
  scout:   { slug: "scout",   dryFireSlug: "dry_fire_sniper",   reloadSlug: "reload_scout",   magInsertSlug: "mag_insert_scout", boltRackSlug: "bolt_lift_scout",inspectSlug: "inspect_scout" },
  kar98k:  { slug: "kar98k",  dryFireSlug: "dry_fire_sniper",   reloadSlug: "reload_kar98k",  magInsertSlug: "stripper_kar98",   boltRackSlug: "bolt_lift_kar98",inspectSlug: "inspect_kar98k" },
  l115a3:  { slug: "l115a3",  dryFireSlug: "dry_fire_sniper",   reloadSlug: "reload_l115a3",  magInsertSlug: "mag_insert_l115",  boltRackSlug: "bolt_lift_l115", inspectSlug: "inspect_l115a3" },
  // ── SHOTGUN ──
  nova:    { slug: "nova",    dryFireSlug: "dry_fire_shotgun",  reloadSlug: "reload_nova",    magInsertSlug: "shell_insert_nova",boltRackSlug: "pump_rack_nova", inspectSlug: "inspect_nova" },
  m1014:   { slug: "m1014",   dryFireSlug: "dry_fire_shotgun",  reloadSlug: "reload_m1014",   magInsertSlug: "shell_insert_m1014",boltRackSlug:"bolt_rak_m1014", inspectSlug: "inspect_m1014" },
  spas12:  { slug: "spas12",  dryFireSlug: "dry_fire_shotgun",  reloadSlug: "reload_spas12",  magInsertSlug: "shell_insert_spas",boltRackSlug: "pump_rak_spas",  inspectSlug: "inspect_spas12" },
  // ── LMG ──
  m249:    { slug: "m249",    dryFireSlug: "dry_fire_lmg",      reloadSlug: "reload_m249",    magInsertSlug: "belt_feed_m249",   boltRackSlug: "bolt_rak_lmg",   inspectSlug: "inspect_m249" },
  rpk:     { slug: "rpk",     dryFireSlug: "dry_fire_lmg",      reloadSlug: "reload_rpk",     magInsertSlug: "mag_insert_rpk",   boltRackSlug: "bolt_rak_ak",    inspectSlug: "inspect_rpk" },
  mk48:    { slug: "mk48",    dryFireSlug: "dry_fire_lmg",      reloadSlug: "reload_mk48",    magInsertSlug: "belt_feed_mk48",   boltRackSlug: "bolt_rak_lmg",   inspectSlug: "inspect_mk48" },
};

/** Get the auxiliary sound profile for a weapon. Falls back to per-category
 *  defaults for each field when a per-weapon entry isn't present. */
export function getWeaponAuxiliarySounds(slug: WeaponType): WeaponAuxiliarySoundProfile {
  const direct = WEAPON_AUXILIARY_SOUNDS[slug];
  if (direct) return direct;
  const cat = WEAPONS[slug]?.category ?? "RIFLE";
  const dryFire = CATEGORY_DRY_FIRE_SLUG[cat] ?? "dry_fire_rifle";
  return {
    slug,
    dryFireSlug: dryFire,
    reloadSlug: `reload_${slug}`,
    magInsertSlug: "mag_insert_default",
    boltRackSlug: "bolt_rak_default",
    inspectSlug: `inspect_${slug}`,
  };
}

/** Prompt 649 — get the per-category dry-fire audio slug. */
export function getDryFireSlug(category: WeaponCategory): string {
  return CATEGORY_DRY_FIRE_SLUG[category] ?? "dry_fire_rifle";
}

/** Prompt 662 — get the per-weapon reload audio slug. */
export function getReloadSlug(slug: WeaponType): string {
  return getWeaponAuxiliarySounds(slug).reloadSlug;
}

/** Prompt 664 — get the per-weapon dry-fire audio slug. */
export function getWeaponDryFireSlug(slug: WeaponType): string {
  return getWeaponAuxiliarySounds(slug).dryFireSlug;
}

/** Prompt 665 — get the per-weapon mag-insertion audio slug. */
export function getMagInsertSlug(slug: WeaponType): string {
  return getWeaponAuxiliarySounds(slug).magInsertSlug;
}

/** Prompt 666 — get the per-weapon bolt-rack audio slug. */
export function getBoltRackSlug(slug: WeaponType): string {
  return getWeaponAuxiliarySounds(slug).boltRackSlug;
}

/** Prompt 667 — get the per-weapon inspect audio slug. */
export function getInspectSlug(slug: WeaponType): string {
  return getWeaponAuxiliarySounds(slug).inspectSlug;
}
