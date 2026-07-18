/**
 * Section B — tests for the combat/sectionB module.
 * Covers prompts 207, 213–215, 216, 221–227, 245–247, 249–250, 251–252,
 * 258–266, 267–276, 277–285, 287–292, 294–300.
 */
import { describe, it, expect } from "vitest";
import {
  BIPOD_WEAPONS,
  autoDeployBipod,
  bipodRecoilMult,
  M203_GRENADE,
  FOREGRIP_STATS,
  MUZZLE_STATS,
  OPTIC_STATS,
  scopeGlintIntensity,
  zeroingPoiOffsetM,
  adsFovFor,
  adsSightAlignment,
  adsSensitivityMult,
  crosshairBloomGapMult,
  hitmarkerVariant,
  ammoHudColor,
  isLastRoundInMag,
  WEAR_TIER_VISUALS,
  killEtchingTier,
  masteryCamoForKills,
  masteryCamoForHeadshots,
  weaponRadarStats,
  compareWeapons,
  ATTACHMENT_BALANCE,
  ATTACHMENT_UNLOCK_LEVELS,
  prestigeWeapon,
  weaponLevelForXp,
  MAX_WEAPON_LEVEL,
  MAGAZINE_STATS,
  FIRE_MODE_STATS,
  defaultFireModeFor,
  BURST_WEAPONS,
  shouldFireSingleShot,
  weaponSwapTimeMs,
  quickScopeSpreadMult,
  noScopeSpreadMult,
  stanceSwayMult,
  leanSwayMult,
  weaponRetractionAmount,
  SPRINT_TO_FIRE_DELAY_MS,
  shellEjectionVelocity,
  MAX_ACTIVE_CASINGS,
  MAX_ACTIVE_DROPPED_MAGS,
  chargingHandleAnimMs,
  BOLT_HOLD_OPEN_WEAPONS,
  BOLT_RELEASE_ANIM_MS,
  hasVisibleHammer,
  SAFETY_SWITCH_ANIM_MS,
  BRASS_TO_FACE_PROBABILITY,
  weaponMoveSpeedMult,
  weaponJumpHeightMult,
  weaponSlideDistMult,
  CARRY_SLOTS,
  ammoResupplyAmount,
  ammoTypeMatches,
  sharedAmmoGroup,
  isTracerOnlyLoadout,
  dragonsBreathFireDurationSec,
  SHOTGUN_AMMO_STATS,
  FIXED_PELLET_PATTERN_8,
  shotgunPelletCount,
  chokeSpreadMult,
  shouldCookOff,
  lmgBeltLengthMult,
  sniperBoltCycleMs,
  pistolSlideLockOnLastRound,
  akimboFireRateMult,
  revolverSpeedLoaderReloadMs,
  revolverSingleRoundReloadMs,
  revolverCylinderSpinMs,
  weaponConditionTier,
  recordKill,
  recordHeadshot,
  recordShot,
  weaponAccuracy,
  isDailyChallengeComplete,
  computeFeelCard,
  rankWeaponsByFeel,
  weaponWeightAdsTauMult,
  hasSeeThroughMag,
  fireRateGateKey,
  reloadTimeMs,
  shouldReloadFumble,
  CHECK_AMMO_HOLD_MS,
  viewmodelFovDeg,
  DEFAULT_VIEWMODEL_FOV,
  AMMO_TYPE_STATS,
  ammoTypeStats,
  canEquipInSlot,
  dropWeaponOnDeath,
  pickupDroppedWeapon,
  spawnWeaponCase,
  openWeaponCase,
  bdcReticleMarks,
  scopedAimPunchDeg,
  scopedAimPunchSample,
  mergeCrosshairConfig,
  validateCrosshairConfig,
  CROSSHAIR_PRESETS,
  DEFAULT_CROSSHAIR,
  type WeaponTracker,
  type WeaponDailyChallenge,
} from "../sectionB";
import { WEAPONS } from "../../store";
import { Vector3 } from "three";

describe("Section B — bipod (#207)", () => {
  it("m249 supports bipod; m4 does not", () => {
    expect(BIPOD_WEAPONS.has("m249")).toBe(true);
    expect(BIPOD_WEAPONS.has("rpk")).toBe(true);
    expect(BIPOD_WEAPONS.has("mk48")).toBe(true);
    expect(BIPOD_WEAPONS.has("m4")).toBe(false);
  });
  it("auto-deploys when prone + stationary", () => {
    const s = autoDeployBipod("m249", true, true, false);
    expect(s.deployed).toBe(true);
    expect(s.mode).toBe("prone");
  });
  it("deploys on cover", () => {
    const s = autoDeployBipod("m249", false, false, true);
    expect(s.deployed).toBe(true);
    expect(s.mode).toBe("cover");
  });
  it("recoil reduced 60% when deployed", () => {
    expect(bipodRecoilMult({ deployed: true, mode: "prone" })).toBeCloseTo(0.4);
    expect(bipodRecoilMult({ deployed: false, mode: "none" })).toBe(1.0);
  });
});

describe("Section B — M203 (#208)", () => {
  it("has 6 max ammo + 14m arm distance", () => {
    expect(M203_GRENADE.maxAmmo).toBe(6);
    expect(M203_GRENADE.armDistanceM).toBe(14);
  });
});

describe("Section B — foregrip variants (#212)", () => {
  it("vertical reduces vertical recoil 25%", () => {
    expect(FOREGRIP_STATS.vertical.verticalRecoilMult).toBeCloseTo(0.75);
  });
  it("angled speeds ADS 20%", () => {
    expect(FOREGRIP_STATS.angled.adsSpeedMult).toBeCloseTo(1.2);
  });
  it("stubby tightens hipfire 30%", () => {
    expect(FOREGRIP_STATS.stubby.hipfireSpreadMult).toBeCloseTo(0.7);
  });
});

describe("Section B — muzzle variants (#213)", () => {
  it("suppressor reduces sound 60%", () => {
    expect(MUZZLE_STATS.suppressor.soundMult).toBeCloseTo(0.4);
  });
  it("compensator reduces horizontal recoil 30%", () => {
    expect(MUZZLE_STATS.compensator.horizontalRecoilMult).toBeCloseTo(0.7);
  });
  it("muzzle brake reduces vertical recoil 20%", () => {
    expect(MUZZLE_STATS.muzzle_brake.verticalRecoilMult).toBeCloseTo(0.8);
  });
});

describe("Section B — optic variants + scope glint (#214, #215)", () => {
  it("scope8x zoom is 8x", () => {
    expect(OPTIC_STATS.scope8x.zoom).toBe(8);
  });
  it("scope glint only on 8x+ optics", () => {
    expect(scopeGlintIntensity("scope8x", 1.0)).toBe(1.0);
    expect(scopeGlintIntensity("red_dot", 1.0)).toBe(0);
    expect(scopeGlintIntensity("scope8x", -0.5)).toBe(0); // pointing away from sun
  });
});

describe("Section B — zeroing (#216)", () => {
  it("zeroed at 100m, shooting at 200m = impact low", () => {
    const offset = zeroingPoiOffsetM(100, 200, 850);
    expect(offset).toBeLessThan(0); // impact is low at longer range
  });
  it("shooting at zero distance = no offset", () => {
    const offset = zeroingPoiOffsetM(200, 200, 850);
    expect(Math.abs(offset)).toBeLessThan(0.001);
  });
});

describe("Section B — ADS FOV + sight alignment (#221, #222)", () => {
  it("sniper ADS FOV is much smaller than pistol", () => {
    const sniperFov = adsFovFor("SNIPER", "scope8x");
    const pistolFov = adsFovFor("PISTOL", "red_dot");
    expect(sniperFov).toBeLessThan(pistolFov);
  });
  it("AWP has distinct sight alignment", () => {
    const awpAlign = adsSightAlignment("awp");
    const m4Align = adsSightAlignment("m4");
    expect(awpAlign[1]).not.toBe(m4Align[1]);
  });
  it("ADS sensitivity scales with zoom", () => {
    const mult = adsSensitivityMult(75, 25);
    expect(mult).toBeCloseTo(1 / 3);
  });
});

describe("Section B — crosshair bloom + hitmarker (#224, #227)", () => {
  it("crosshair blooms when moving + firing", () => {
    const stillMult = crosshairBloomGapMult(false, false, 0.01);
    const movingMult = crosshairBloomGapMult(true, false, 0.01);
    const firingMult = crosshairBloomGapMult(false, true, 0.01);
    expect(movingMult).toBeGreaterThan(stillMult);
    expect(firingMult).toBeGreaterThan(stillMult);
  });
  it("hitmarker variants have distinct colors", () => {
    const hit = hitmarkerVariant("hit");
    const hs = hitmarkerVariant("headshot");
    const kill = hitmarkerVariant("kill");
    expect(hit.color).not.toBe(hs.color);
    expect(hs.color).not.toBe(kill.color);
    expect(kill.size).toBeGreaterThan(hit.size);
  });
});

describe("Section B — low ammo + last round (#228, #229)", () => {
  it("ammo HUD turns red below 25%", () => {
    expect(ammoHudColor(2, 30).toString(16)).toBe("ff3333");
  });
  it("last round detected when ammo=1", () => {
    expect(isLastRoundInMag(1)).toBe(true);
    expect(isLastRoundInMag(5)).toBe(false);
  });
});

describe("Section B — cosmetics (#232, #235, #236, #299)", () => {
  it("wear tier visuals are distinct", () => {
    expect(WEAR_TIER_VISUALS.factory_new.scratchDensity).toBe(0);
    expect(WEAR_TIER_VISUALS.battle_scarred.scratchDensity).toBeGreaterThan(0.5);
  });
  it("kill etching tiers", () => {
    expect(killEtchingTier(100)).toBe("none");
    expect(killEtchingTier(500)).toBe("bronze");
    expect(killEtchingTier(1000)).toBe("silver");
    expect(killEtchingTier(2500)).toBe("gold");
    expect(killEtchingTier(5000)).toBe("platinum");
  });
  it("mastery camo by kills", () => {
    expect(masteryCamoForKills(100)).toBe("none");
    expect(masteryCamoForKills(500)).toBe("gold");
    expect(masteryCamoForKills(5000)).toBe("diamond");
  });
  it("mastery camo by headshots (#299)", () => {
    expect(masteryCamoForHeadshots(100)).toBe("none");
    expect(masteryCamoForHeadshots(500)).toBe("gold");
    expect(masteryCamoForHeadshots(2500)).toBe("diamond");
  });
});

describe("Section B — gunsmith stats + comparison (#237, #238)", () => {
  it("radar stats are 0..100", () => {
    const stats = weaponRadarStats(WEAPONS.ak74);
    for (const v of Object.values(stats)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
  it("comparison returns deltas", () => {
    const delta = compareWeapons(WEAPONS.ak74, WEAPONS.m4);
    expect(typeof delta.damage).toBe("number");
  });
});

describe("Section B — attachment balance (#240)", () => {
  it("each attachment has a pro + a con", () => {
    for (const [slug, entry] of Object.entries(ATTACHMENT_BALANCE)) {
      expect(entry.pro.length).toBeGreaterThan(0);
      expect(entry.con.length).toBeGreaterThan(0);
      expect(entry.slug).toBe(slug);
    }
  });
});

describe("Section B — weapon level + prestige (#241, #242)", () => {
  it("level scales with XP (1000 XP per level)", () => {
    expect(weaponLevelForXp(0)).toBe(0);
    expect(weaponLevelForXp(1000)).toBe(1);
    expect(weaponLevelForXp(50000)).toBe(MAX_WEAPON_LEVEL);
  });
  it("attachments unlock at level 5+", () => {
    expect(ATTACHMENT_UNLOCK_LEVELS.red_dot).toBe(5);
    expect(ATTACHMENT_UNLOCK_LEVELS.suppressor).toBeGreaterThanOrEqual(15);
  });
  it("prestige resets level + increments prestige", () => {
    const maxed = { level: MAX_WEAPON_LEVEL, xp: 50000, totalKills: 1000, totalHeadshots: 500, prestige: 0 };
    const prestiged = prestigeWeapon(maxed);
    expect(prestiged.level).toBe(0);
    expect(prestiged.prestige).toBe(1);
    expect(prestiged.totalKills).toBe(1000); // kills persist
  });
});

describe("Section B — magazine variants (#244)", () => {
  it("drum mag triples size + slows movement", () => {
    expect(MAGAZINE_STATS.drum.sizeMult).toBe(3);
    expect(MAGAZINE_STATS.drum.moveSpeedMult).toBeLessThan(1);
  });
});

describe("Section B — fire modes (#245, #246, #247)", () => {
  it("bolt-action snipers default to bolt", () => {
    expect(defaultFireModeFor("awp")).toBe("bolt");
    expect(defaultFireModeFor("kar98k")).toBe("bolt");
  });
  it("famas defaults to burst", () => {
    expect(defaultFireModeFor("famas")).toBe("burst");
  });
  it("pistols default to semi", () => {
    expect(defaultFireModeFor("usp")).toBe("semi");
  });
  it("burst fires 3 shots per pull", () => {
    expect(FIRE_MODE_STATS.burst.shotsPerPull).toBe(3);
  });
  it("trigger discipline: <100ms = single shot", () => {
    expect(shouldFireSingleShot(50)).toBe(true);
    expect(shouldFireSingleShot(200)).toBe(false);
  });
  it("famas is in BURST_WEAPONS", () => {
    expect(BURST_WEAPONS.has("famas")).toBe(true);
  });
});

describe("Section B — weapon swap speed (#248)", () => {
  it("pistol swaps faster than LMG", () => {
    expect(weaponSwapTimeMs("usp")).toBeLessThan(weaponSwapTimeMs("m249"));
  });
});

describe("Section B — quick-scope + no-scope (#249, #250)", () => {
  it("quick-scope bonus within 200ms", () => {
    expect(quickScopeSpreadMult(50)).toBeLessThan(1);
    expect(quickScopeSpreadMult(300)).toBe(1);
  });
  it("no-scope penalty for snipers", () => {
    expect(noScopeSpreadMult(true, false)).toBe(5); // 5× spread
    expect(noScopeSpreadMult(false, false)).toBe(1);
  });
});

describe("Section B — sway stances (#251, #252)", () => {
  it("prone reduces sway 60%", () => {
    expect(stanceSwayMult(false, true)).toBeCloseTo(0.4);
  });
  it("crouch reduces sway 30%", () => {
    expect(stanceSwayMult(true, false)).toBeCloseTo(0.7);
  });
  it("lean reduces sway 50%", () => {
    expect(leanSwayMult(true)).toBeCloseTo(0.5);
  });
});

describe("Section B — weapon collision (#254)", () => {
  it("retraction scales with distance to wall", () => {
    expect(weaponRetractionAmount(0.5)).toBe(0);
    expect(weaponRetractionAmount(0.0)).toBe(1);
  });
  it("sprint-to-fire delay is 250ms", () => {
    expect(SPRINT_TO_FIRE_DELAY_MS).toBe(250);
  });
});

describe("Section B — shell ejection (#258)", () => {
  it("shell ejection velocity varies by category", () => {
    const rifle = shellEjectionVelocity("m4");
    const pistol = shellEjectionVelocity("usp");
    expect(rifle[0]).not.toBe(pistol[0]); // different right velocity
  });
  it("max active casings is 64", () => {
    expect(MAX_ACTIVE_CASINGS).toBe(64);
  });
  it("max dropped mags is 8", () => {
    expect(MAX_ACTIVE_DROPPED_MAGS).toBe(8);
  });
});

describe("Section B — charging handle + bolt (#261, #262, #263, #264)", () => {
  it("bolt-action has longer charging handle cycle", () => {
    expect(chargingHandleAnimMs("awp")).toBeGreaterThan(chargingHandleAnimMs("m4"));
  });
  it("BOLT_HOLD_OPEN_WEAPONS includes m4 but not awp", () => {
    expect(BOLT_HOLD_OPEN_WEAPONS.has("m4")).toBe(true);
    expect(BOLT_HOLD_OPEN_WEAPONS.has("awp")).toBe(false);
  });
  it("bolt release anim is 200ms", () => {
    expect(BOLT_RELEASE_ANIM_MS).toBe(200);
  });
  it("1911 + revolver have visible hammer", () => {
    expect(hasVisibleHammer("m1911")).toBe(true);
    expect(hasVisibleHammer("revolver")).toBe(true);
    expect(hasVisibleHammer("m4")).toBe(false);
  });
  it("safety switch anim is 150ms", () => {
    expect(SAFETY_SWITCH_ANIM_MS).toBe(150);
  });
  it("brass-to-face probability is 2%", () => {
    expect(BRASS_TO_FACE_PROBABILITY).toBeCloseTo(0.02);
  });
});

describe("Section B — weapon weight (#267, #268, #269, #158, #175)", () => {
  it("LMG slows movement 12%", () => {
    expect(weaponMoveSpeedMult("m249")).toBeLessThan(1);
  });
  it("LMG reduces jump height", () => {
    expect(weaponJumpHeightMult("m249")).toBeLessThan(1);
  });
  it("LMG reduces slide distance", () => {
    expect(weaponSlideDistMult("m249")).toBeLessThan(1);
  });
  it("AWP has slow ADS tau (heavy)", () => {
    expect(weaponWeightAdsTauMult("awp")).toBeGreaterThan(1);
  });
  it("pistol has fast ADS tau", () => {
    expect(weaponWeightAdsTauMult("usp")).toBeLessThan(1);
  });
  it("see-through mag is default for all weapons", () => {
    expect(hasSeeThroughMag("ak74")).toBe(true);
    expect(hasSeeThroughMag("awp")).toBe(true);
    expect(hasSeeThroughMag("usp")).toBe(true);
  });
});

describe("Section B — carry limit + ammo resupply (#270, #274, #275, #276)", () => {
  it("carry slots include sidearm", () => {
    expect(CARRY_SLOTS).toContain("sidearm");
  });
  it("ammo resupply amount = 2× mag size", () => {
    expect(ammoResupplyAmount("m4")).toBe(WEAPONS.m4.magSize * 2);
  });
  it("ammo type matches within category", () => {
    expect(ammoTypeMatches("m4", "hk416")).toBe(true); // both RIFLE
    expect(ammoTypeMatches("m4", "usp")).toBe(false); // RIFLE vs PISTOL
  });
  it("shared ammo pool groups by cartridge", () => {
    expect(sharedAmmoGroup("ak74")).toBe(sharedAmmoGroup("rpk")); // both 5.45
    expect(sharedAmmoGroup("ak74")).not.toBe(sharedAmmoGroup("m4")); // 5.45 vs 5.56
  });
});

describe("Section B — shotgun ammo (#277, #278, #279, #280, #281, #282, #283)", () => {
  it("tracer-only loadout detected", () => {
    expect(isTracerOnlyLoadout("tracer")).toBe(true);
    expect(isTracerOnlyLoadout("fmj")).toBe(false);
  });
  it("dragon's breath burns for 3s", () => {
    expect(dragonsBreathFireDurationSec()).toBe(3);
  });
  it("slug is single high-damage projectile", () => {
    expect(SHOTGUN_AMMO_STATS.slug.pelletCount).toBe(1);
    expect(SHOTGUN_AMMO_STATS.slug.damageMult).toBeGreaterThan(1);
  });
  it("fixed pellet pattern has 8 pellets", () => {
    expect(FIXED_PELLET_PATTERN_8.length).toBe(8);
  });
  it("shotgun pellet count per weapon", () => {
    expect(shotgunPelletCount("nova")).toBe(8);
    expect(shotgunPelletCount("m1014")).toBe(8);
  });
  it("full choke has tightest spread", () => {
    expect(chokeSpreadMult("full")).toBeLessThan(chokeSpreadMult("improved_cylinder"));
  });
});

describe("Section B — LMG overheat + belt (#284, #285)", () => {
  it("cook-off at full heat while firing", () => {
    expect(shouldCookOff(1.0, true)).toBe(true);
    expect(shouldCookOff(0.5, true)).toBe(false);
  });
  it("belt length scales with ammo", () => {
    expect(lmgBeltLengthMult(50, 100)).toBeCloseTo(0.5);
    expect(lmgBeltLengthMult(0, 100)).toBe(0);
  });
});

describe("Section B — sniper + pistol + revolver details (#287, #288, #290, #291, #292)", () => {
  it("sniper bolt cycle: AWP slower than Scout", () => {
    expect(sniperBoltCycleMs("awp")).toBeGreaterThan(sniperBoltCycleMs("scout"));
  });
  it("pistol slide locks on last round (except revolver)", () => {
    expect(pistolSlideLockOnLastRound("usp")).toBe(true);
    expect(pistolSlideLockOnLastRound("revolver")).toBe(false);
  });
  it("akimbo doubles fire rate", () => {
    expect(akimboFireRateMult(true)).toBe(2);
    expect(akimboFireRateMult(false)).toBe(1);
  });
  it("speed-loader is faster than single-round", () => {
    expect(revolverSpeedLoaderReloadMs()).toBeLessThan(revolverSingleRoundReloadMs());
  });
  it("cylinder spin duration", () => {
    expect(revolverCylinderSpinMs()).toBeGreaterThan(0);
  });
});

describe("Section B — weapon condition + trackers (#294, #295, #296, #297, #298)", () => {
  it("condition tier based on rounds fired", () => {
    expect(weaponConditionTier(100)).toBe("factory_new");
    expect(weaponConditionTier(50000)).toBe("battle_scarred");
  });
  it("trackers record kills, headshots, shots", () => {
    const t: WeaponTracker = { kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0 };
    recordKill(t);
    recordHeadshot(t);
    recordShot(t, true);
    recordShot(t, false);
    expect(t.kills).toBe(1);
    expect(t.headshots).toBe(1);
    expect(t.shotsFired).toBe(2);
    expect(t.shotsHit).toBe(1);
    expect(weaponAccuracy(t)).toBe(50); // 1/2 = 50%
  });
  it("daily challenge completes at target", () => {
    const c: WeaponDailyChallenge = {
      weapon: "ak74", goal: "kills", target: 10, progress: 5,
      reward: { xp: 1000, credits: 500 },
    };
    expect(isDailyChallengeComplete(c)).toBe(false);
    c.progress = 10;
    expect(isDailyChallengeComplete(c)).toBe(true);
  });
});

describe("Section B — feel pass (#300)", () => {
  it("feel card computes for every weapon", () => {
    for (const slug of Object.keys(WEAPONS)) {
      const card = computeFeelCard(slug as any);
      expect(card.weapon).toBe(slug);
      expect(card.feelScore).toBeGreaterThanOrEqual(0);
      expect(card.feelScore).toBeLessThanOrEqual(1);
    }
  });
  it("rankWeaponsByFeel returns top 3 + bottom 3", () => {
    const r = rankWeaponsByFeel();
    expect(r.top3.length).toBe(3);
    expect(r.bottom3.length).toBe(3);
    // Top 3 feel scores should be >= bottom 3 feel scores.
    const topMin = Math.min(...r.top3.map((c) => c.feelScore));
    const bottomMax = Math.max(...r.bottom3.map((c) => c.feelScore));
    expect(topMin).toBeGreaterThanOrEqual(bottomMax);
  });
});

describe("Section B — WeaponSystem reload mechanics (#159, #177, #178, #179, #180, #181)", () => {
  it("fire-rate gate key is weapon+slot scoped", () => {
    expect(fireRateGateKey("m4", "primary")).not.toBe(fireRateGateKey("usp", "secondary"));
  });
  it("empty reload takes longer than partial", () => {
    const empty = reloadTimeMs("m4", true, 1, 1);
    const partial = reloadTimeMs("m4", false, 1, 1);
    expect(empty).toBeGreaterThan(partial);
  });
  it("low stamina slows reload", () => {
    const fullStam = reloadTimeMs("m4", false, 1, 1);
    const lowStam = reloadTimeMs("m4", false, 0, 1);
    expect(lowStam).toBeGreaterThan(fullStam);
  });
  it("low HP slows reload + can fumble", () => {
    const fullHp = reloadTimeMs("m4", false, 1, 1);
    const lowHp = reloadTimeMs("m4", false, 1, 0.2);
    expect(lowHp).toBeGreaterThan(fullHp);
  });
  it("fumble only below 40% HP", () => {
    expect(shouldReloadFumble(0.5)).toBe(false);
    // Below 40% the chance is 15% — we can't assert true (random), but we
    // can assert it returns a boolean.
    const result = shouldReloadFumble(0.2);
    expect(typeof result).toBe("boolean");
  });
  it("check-ammo hold is 300ms", () => {
    expect(CHECK_AMMO_HOLD_MS).toBe(300);
  });
});

describe("Section B — viewmodel FOV (#230)", () => {
  it("default viewmodel FOV is 65 deg", () => {
    expect(DEFAULT_VIEWMODEL_FOV).toBe(65);
  });
  it("viewmodel FOV is independent per weapon category", () => {
    // LMG should frame tighter (lower FOV) than pistol.
    const lmgFov = viewmodelFovDeg("m249");
    const pistolFov = viewmodelFovDeg("usp");
    expect(lmgFov).toBeLessThan(pistolFov);
  });
  it("player offset adjusts viewmodel FOV", () => {
    const base = viewmodelFovDeg("m4", { offset: 0 });
    const wide = viewmodelFovDeg("m4", { offset: 10 });
    expect(wide).toBeGreaterThan(base);
  });
  it("viewmodel FOV clamps to [40, 90]", () => {
    expect(viewmodelFovDeg("m4", { offset: -100 })).toBeGreaterThanOrEqual(40);
    expect(viewmodelFovDeg("m4", { offset: 100 })).toBeLessThanOrEqual(90);
  });
});

describe("Section B — ammo type stats (#243)", () => {
  it("every ammo slug has an entry", () => {
    for (const slug of ["fmj", "hp", "ap", "subsonic", "tracer", "incendiary"] as const) {
      expect(AMMO_TYPE_STATS[slug]).toBeDefined();
    }
  });
  it("HP does more damage but less armor pen than FMJ", () => {
    expect(AMMO_TYPE_STATS.hp.damageMult).toBeGreaterThan(AMMO_TYPE_STATS.fmj.damageMult);
    expect(AMMO_TYPE_STATS.hp.armorPenMult).toBeLessThan(AMMO_TYPE_STATS.fmj.armorPenMult);
  });
  it("AP has highest armor pen", () => {
    expect(AMMO_TYPE_STATS.ap.armorPenMult).toBeGreaterThan(AMMO_TYPE_STATS.fmj.armorPenMult);
  });
  it("subsonic is quietest + slowest", () => {
    expect(AMMO_TYPE_STATS.subsonic.soundMult).toBeLessThan(AMMO_TYPE_STATS.fmj.soundMult);
    expect(AMMO_TYPE_STATS.subsonic.velocityMult).toBeLessThan(AMMO_TYPE_STATS.fmj.velocityMult);
  });
  it("tracer-only loadout has tracerFrequency = 1", () => {
    expect(AMMO_TYPE_STATS.tracer.tracerFrequency).toBe(1);
  });
  it("ammoTypeStats falls back to FMJ for unknown slug", () => {
    // @ts-expect-error — testing runtime fallback for unknown slug
    const s = ammoTypeStats("unknown");
    expect(s).toBe(AMMO_TYPE_STATS.fmj);
  });
});

describe("Section B — carry limit + drop/pickup (#270, #271, #272, #273)", () => {
  it("pistol goes in sidearm slot, rifle does not", () => {
    expect(canEquipInSlot("usp", "sidearm")).toBe(true);
    expect(canEquipInSlot("m4", "sidearm")).toBe(false);
  });
  it("rifle goes in primary, pistol does not", () => {
    expect(canEquipInSlot("m4", "primary")).toBe(true);
    expect(canEquipInSlot("usp", "primary")).toBe(false);
  });
  it("secondary accepts any weapon", () => {
    expect(canEquipInSlot("m4", "secondary")).toBe(true);
    expect(canEquipInSlot("usp", "secondary")).toBe(true);
  });
  it("dropWeaponOnDeath preserves reserve ammo", () => {
    const v = new Vector3(1, 0, 2);
    const d = dropWeaponOnDeath("m4", v, 90, 30);
    expect(d.weapon).toBe("m4");
    expect(d.reserveAmmo).toBe(90);
    expect(d.despawnSec).toBe(30);
  });
  it("pickupDroppedWeapon inherits reserve when ammo matches", () => {
    const v = new Vector3(0, 0, 0);
    const d = dropWeaponOnDeath("m4", v, 90);
    const p = pickupDroppedWeapon(d, "hk416"); // both 5.56×45
    expect(p.weapon).toBe("m4");
    expect(p.reserveAmmo).toBe(90);
  });
  it("pickupDroppedWeapon zeroes reserve when ammo doesn't match", () => {
    const v = new Vector3(0, 0, 0);
    const d = dropWeaponOnDeath("ak74", v, 90); // 5.45×39
    const p = pickupDroppedWeapon(d, "m4"); // 5.56×45 — different caliber
    expect(p.weapon).toBe("ak74");
    expect(p.reserveAmmo).toBe(0);
  });
  it("spawnWeaponCase + openWeaponCase round-trip", () => {
    const v = new Vector3(5, 0, 5);
    const wc = spawnWeaponCase(v, ["m4", "usp", "awp"]);
    expect(wc.opened).toBe(false);
    expect(wc.weapons).toHaveLength(3);
    const inside = openWeaponCase(wc);
    expect(inside).toEqual(["m4", "usp", "awp"]);
    expect(wc.opened).toBe(true);
    // Re-opening returns nothing.
    expect(openWeaponCase(wc)).toEqual([]);
  });
});

describe("Section B — BDC reticle + scoped aim-punch (#219, #220)", () => {
  it("BDC marks are increasing offsets for longer ranges", () => {
    const marks = bdcReticleMarks(100, 850);
    expect(marks.length).toBe(4);
    // Drop (and thus mrad offset) increases with range.
    for (let i = 1; i < marks.length; i++) {
      expect(marks[i].dropMrad).toBeGreaterThan(marks[i - 1].dropMrad);
    }
  });
  it("BDC mark at the zero distance has ~0 offset", () => {
    const marks = bdcReticleMarks(200, 850, [200]);
    expect(Math.abs(marks[0].dropMrad)).toBeLessThan(0.01);
  });
  it("scoped aim-punch scales with damage fraction", () => {
    expect(scopedAimPunchDeg(0)).toBe(0);
    expect(scopedAimPunchDeg(0.5)).toBeCloseTo(10);
    expect(scopedAimPunchDeg(1.0)).toBeCloseTo(20);
  });
  it("scoped aim-punch envelope peaks then decays", () => {
    const peak = scopedAimPunchSample(10, 30); // at attack peak
    expect(peak).toBeCloseTo(10);
    const after = scopedAimPunchSample(10, 280); // past recovery
    expect(after).toBe(0);
  });
});

describe("Section B — crosshair editor (#225)", () => {
  it("merges partial overrides with defaults", () => {
    const merged = mergeCrosshairConfig({ color: 0xff0000 });
    expect(merged.color).toBe(0xff0000);
    expect(merged.thickness).toBe(DEFAULT_CROSSHAIR.thickness);
    expect(merged.gap).toBe(DEFAULT_CROSSHAIR.gap);
  });
  it("clamps thickness + gap", () => {
    const merged = mergeCrosshairConfig({ thickness: 99, gap: -50 });
    expect(merged.thickness).toBe(10);
    expect(merged.gap).toBe(0);
  });
  it("validates a correct config (no errors)", () => {
    const errors = validateCrosshairConfig(DEFAULT_CROSSHAIR);
    expect(errors).toEqual([]);
  });
  it("catches invalid fields", () => {
    const errors = validateCrosshairConfig({
      color: -1, thickness: 0, gap: 99, dot: "yes" as any, outline: true, outlineColor: 0x999999,
    });
    expect(errors.length).toBeGreaterThan(0);
  });
  it("provides presets", () => {
    expect(CROSSHAIR_PRESETS.dot.dot).toBe(true);
    expect(CROSSHAIR_PRESETS.cross.outline).toBe(false);
  });
});
