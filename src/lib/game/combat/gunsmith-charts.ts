/**
 * Section B (B3-5000) — gunsmith charts + balance telemetry + modding API.
 *
 * Implements prompts 1051–1100 (lines 2128–2226 of `5000-IMPROVEMENT-PROMPTS.md`).
 *
 * Three logical sub-ranges:
 *
 *   1. **Gunsmith ballistic charts** (#1051–#1067): pure helpers that produce
 *      chart-data arrays the gunsmith UI renders (bullet mass, BC, muzzle
 *      velocity, drop chart at 100/200/300m, wind drift chart, TOF chart,
 *      energy chart, penetration chart per surface, ricochet chart,
 *      fragmentation chart, damage falloff chart, recoil pattern chart,
 *      recoil recovery chart, spread chart, TTK chart, BTK chart, HSK chart).
 *      #1068 (weapon comparison chart) is already DONE in
 *      sectionB.ts:compareWeapons — aliased here.
 *
 *   2. **Weapon balance social + telemetry** (#1069–#1082): data interfaces
 *      + builder helpers for the tier list, meta report (win-rate), usage
 *      report (pick-rate), changelog, patch notes, dev blog, forum, survey,
 *      telemetry (per-weapon K/D / headshot rate / TTK), auto-tuning
 *      (adjust stats based on telemetry), A/B testing, rollback, presets
 *      (arcade/realistic/hardcore), server-side config.
 *
 *   3. **Weapon balance modding API** (#1083–#1100): data interfaces +
 *      helpers for the modding API — validation, sharing, leaderboard,
 *      reviews, categories, tags, search, install, uninstall, auto-update,
 *      conflict resolution, load order, dependency resolution, versioning,
 *      changelog, permissions, monetization (paid mods).
 *
 * Pure data + helpers. No engine wiring (the gunsmith UI + meta backend are
 * outside this task's ownership).
 *
 * Marker block — search `B3-5000 #NNNN` to find each prompt's helper.
 */

import type { WeaponType } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// #1051–#1053 — bullet mass + ballistic coefficient + muzzle velocity display
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1051 — per-category bullet mass (grams). The gunsmith displays
 *  this so the player can compare ammo weights. Heavier bullets have more
 *  momentum (less drop, less wind drift) but lower velocity. */
export const BULLET_MASS_GRAMS: Record<string, number> = {
  PISTOL:  8.0,   // 9mm ≈ 8g
  SMG:     8.0,   // 9mm / .45
  RIFLE:   4.0,   // 5.56mm ≈ 4g
  SNIPER:  16.0,  // .338 Lapua ≈ 16g
  LMG:     6.5,   // 7.62mm ≈ 9g (belt rounds)
  SHOTGUN: 30.0,  // 12ga slug ≈ 30g
};

/** B3-5000 #1051 — bullet mass display string. */
export function formatBulletMass(category: string): string {
  const g = BULLET_MASS_GRAMS[category] ?? 4.0;
  return `${g.toFixed(1)} g`;
}

/** B3-5000 #1052 — per-category ballistic coefficient (G1 model, dimensionless).
 *  The BC quantifies how well the bullet retains velocity (higher = better).
 *  Heavy boat-tail rounds (sniper) have high BC; light pistol rounds have low. */
export const BULLET_BC: Record<string, number> = {
  PISTOL:  0.15,
  SMG:     0.18,
  RIFLE:   0.30,  // 5.56mm M855 ≈ 0.30 G1
  SNIPER:  0.75,  // .338 Lapua ≈ 0.75 G1
  LMG:     0.40,
  SHOTGUN: 0.05,  // pellets have terrible BC
};

/** B3-5000 #1052 — ballistic coefficient display string. */
export function formatBulletBC(category: string): string {
  const bc = BULLET_BC[category] ?? 0.30;
  return `BC ${bc.toFixed(2)} (G1)`;
}

/** B3-5000 #1053 — per-category muzzle velocity (m/s). */
export const MUZZLE_VELOCITY_MS: Record<string, number> = {
  PISTOL:  380,
  SMG:     400,
  RIFLE:   910,
  SNIPER:  915,
  LMG:     850,
  SHOTGUN: 410,
};

/** B3-5000 #1053 — muzzle velocity display string. */
export function formatMuzzleVelocity(category: string): string {
  const v = MUZZLE_VELOCITY_MS[category] ?? 800;
  return `${v} m/s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// #1054–#1060 — ballistic charts (drop / wind / TOF / energy / penetration /
// ricochet / fragmentation at 100/200/300m)
// ─────────────────────────────────────────────────────────────────────────────

/** Chart data point: distance + value. */
export interface ChartPoint {
  distanceM: number;
  value: number;
}

/** B3-5000 #1054 — bullet drop chart at 100/200/300m. Returns the drop (m)
 *  at each distance. Aliases Ballistics.ts:computeDrop (drop = 0.5 × g × t²
 *  where t = d / v). */
export function bulletDropChart(muzzleVelocityMs: number, distancesM: number[] = [100, 200, 300]): ChartPoint[] {
  return distancesM.map((d) => {
    const t = d / muzzleVelocityMs;
    return { distanceM: d, value: 0.5 * 9.81 * t * t };
  });
}

/** B3-5000 #1055 — bullet wind drift chart at 100/200/300m for a 5 m/s wind.
 *  Aliases Ballistics.ts:computeWindDrift. */
export function bulletWindDriftChart(
  muzzleVelocityMs: number,
  damage: number,
  windSpeedMs = 5,
  distancesM: number[] = [100, 200, 300],
): ChartPoint[] {
  return distancesM.map((d) => {
    const t = d / muzzleVelocityMs;
    const windAccel = (windSpeedMs * 2) / Math.max(15, damage);
    return { distanceM: d, value: 0.5 * windAccel * t * t };
  });
}

/** B3-5000 #1056 — bullet time-of-flight chart at 100/200/300m. */
export function bulletTofChart(muzzleVelocityMs: number, distancesM: number[] = [100, 200, 300]): ChartPoint[] {
  return distancesM.map((d) => ({ distanceM: d, value: d / muzzleVelocityMs }));
}

/** B3-5000 #1057 — bullet kinetic energy chart at 100/200/300m.
 *  KE = 0.5 × m × v². Uses the per-category mass (#1051) + a velocity-falloff
 *  model (the bullet slows over distance due to air drag). */
export function bulletEnergyChart(
  category: string,
  muzzleVelocityMs: number,
  distancesM: number[] = [100, 200, 300],
): ChartPoint[] {
  const massKg = (BULLET_MASS_GRAMS[category] ?? 4.0) / 1000;
  const bc = BULLET_BC[category] ?? 0.30;
  return distancesM.map((d) => {
    // Simplified drag: velocity decays exponentially with distance.
    // Lower BC = faster decay.
    const v = muzzleVelocityMs * Math.exp(-d / (1000 * bc));
    return { distanceM: d, value: 0.5 * massKg * v * v };
  });
}

/** B3-5000 #1058 — bullet penetration chart per surface. Returns the
 *  penetration depth (m) for each surface type. Aliases
 *  combat/penetration.ts:MATERIAL_PENETRATION. */
export interface PenetrationChartRow {
  surface: string;
  penetrationDepthM: number;
}

/** B3-5000 #1058 — bullet penetration chart per surface (per category).
 *  The chart rows are derived from the sectionB.ts:SURFACE_PENETRATION_MULT
 *  table (per-surface pen multiplier) × the per-category base penetration
 *  depth. */
export function bulletPenetrationChart(category: string): PenetrationChartRow[] {
  // Base penetration depth (m) for a rifle round.
  const baseDepthM: Record<string, number> = {
    PISTOL: 0.10, SMG: 0.12, RIFLE: 0.25, SNIPER: 0.33, LMG: 0.22, SHOTGUN: 0.05,
  };
  const base = baseDepthM[category] ?? 0.25;
  // Per-surface multiplier (simplified from Ballistics.ts:SURFACE_PENETRATION_MULT).
  const surfaces: Record<string, number> = {
    drywall: 1.5, wood: 1.2, sheet_metal: 0.4, brick: 0.3, sandbag: 0.05,
    glass: 1.6, earth: 0.6, concrete: 0.15, steel_plate: 0.0, foliage: 2.0,
  };
  return Object.entries(surfaces).map(([surface, mult]) => ({
    surface,
    penetrationDepthM: base * mult,
  }));
}

/** B3-5000 #1059 — bullet ricochet chart per surface. Returns the ricochet
 *  probability (0..1) for each surface type. Hard surfaces ricochet more;
 *  soft surfaces absorb. */
export interface RicochetChartRow {
  surface: string;
  ricochetProbability: number;
}

export function bulletRicochetChart(): RicochetChartRow[] {
  return [
    { surface: "steel_plate", ricochetProbability: 0.85 },
    { surface: "sheet_metal", ricochetProbability: 0.55 },
    { surface: "concrete",    ricochetProbability: 0.35 },
    { surface: "brick",       ricochetProbability: 0.25 },
    { surface: "glass",       ricochetProbability: 0.10 },
    { surface: "wood",        ricochetProbability: 0.05 },
    { surface: "earth",       ricochetProbability: 0.00 },
    { surface: "sandbag",     ricochetProbability: 0.00 },
  ];
}

/** B3-5000 #1060 — bullet fragmentation chart per ammo type. Returns the
 *  fragmentation probability (0..1) + fragment count for each ammo. */
export interface FragmentationChartRow {
  ammo: string;
  fragmentationProbability: number;
  fragmentCount: number;
}

export function bulletFragmentationChart(): FragmentationChartRow[] {
  return [
    { ammo: "fmj",        fragmentationProbability: 0.15, fragmentCount: 3 },
    { ammo: "hp",         fragmentationProbability: 0.85, fragmentCount: 8 },
    { ammo: "ap",         fragmentationProbability: 0.05, fragmentCount: 2 },
    { ammo: "incendiary", fragmentationProbability: 0.60, fragmentCount: 6 },
    { ammo: "subsonic",   fragmentationProbability: 0.10, fragmentCount: 3 },
    { ammo: "tracer",     fragmentationProbability: 0.15, fragmentCount: 3 },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// #1061–#1067 — damage falloff + recoil pattern + recoil recovery + spread +
// TTK + BTK + HSK charts
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1061 — damage falloff chart. Returns the damage at each distance.
 *  Damage falls off linearly from muzzle to max-range (then 0 beyond). */
export function damageFalloffChart(
  baseDamage: number,
  maxRangeM: number,
  distancesM: number[] = [0, 50, 100, 200, 300, 400],
): ChartPoint[] {
  return distancesM.map((d) => {
    if (d >= maxRangeM) return { distanceM: d, value: 0 };
    // Linear falloff: 100% at muzzle, 50% at max-range, 0% beyond.
    const falloff = 1.0 - 0.5 * (d / maxRangeM);
    return { distanceM: d, value: baseDamage * falloff };
  });
}

/** B3-5000 #1062 — recoil pattern chart. Returns the per-shot recoil offset
 *  (vertical + horizontal) for the first N shots. The pattern is seeded
 *  with the weapon's recoil value + a per-weapon pattern seed so the chart
 *  is deterministic (the player can study the pattern in the gunsmith). */
export interface RecoilPatternPoint {
  shot: number;
  verticalDeg: number;
  horizontalDeg: number;
}

export function recoilPatternChart(
  weapon: WeaponType,
  recoilValue: number,
  shotCount = 10,
  seed = 0,
): RecoilPatternPoint[] {
  // Deterministic pseudo-random based on seed + shot index (no Math.random —
  // the chart must be reproducible so the player can study it).
  const points: RecoilPatternPoint[] = [];
  let cumulativeV = 0;
  for (let i = 0; i < shotCount; i++) {
    // Hash the seed + shot + weapon for a per-shot horizontal kick.
    const hash = hashStr(`${weapon}-${seed}-${i}`);
    const horizontal = ((hash % 1000) / 1000 - 0.5) * recoilValue * 0.6;
    const vertical = recoilValue * (1.0 - i * 0.03); // slight bloom decay
    cumulativeV += vertical;
    points.push({ shot: i + 1, verticalDeg: cumulativeV, horizontalDeg: horizontal });
  }
  return points;
}

/** B3-5000 #1063 — recoil recovery chart. Returns the recoil-offset over
 *  time after the player stops firing. The recoil recovers exponentially
 *  (the player's hands bring the muzzle back down). */
export interface RecoilRecoveryPoint {
  timeMs: number;
  offsetDeg: number;
}

export function recoilRecoveryChart(
  peakOffsetDeg: number,
  recoveryTauMs = 200,
  durationsMs: number[] = [0, 50, 100, 200, 400, 600],
): RecoilRecoveryPoint[] {
  return durationsMs.map((t) => ({
    timeMs: t,
    offsetDeg: peakOffsetDeg * Math.exp(-t / recoveryTauMs),
  }));
}

/** B3-5000 #1064 — spread chart. Returns the spread (deg) at each stance.
 *  The chart shows how spread varies by stance (hipfire > moving > standing
 *  > crouch > ADS > prone-bipod). */
export interface SpreadChartRow {
  stance: string;
  spreadDeg: number;
}

export function spreadChart(baseSpreadDeg: number): SpreadChartRow[] {
  return [
    { stance: "Hipfire",       spreadDeg: baseSpreadDeg * 4.0 },
    { stance: "Moving",        spreadDeg: baseSpreadDeg * 2.5 },
    { stance: "Standing",      spreadDeg: baseSpreadDeg * 1.5 },
    { stance: "Crouch",        spreadDeg: baseSpreadDeg * 1.0 },
    { stance: "ADS",           spreadDeg: baseSpreadDeg * 0.4 },
    { stance: "Prone (bipod)", spreadDeg: baseSpreadDeg * 0.1 },
  ];
}

/** B3-5000 #1065 — TTK (time-to-kill) chart. Returns the TTK (ms) for each
 *  target HP value. TTK = (HP / damagePerShot) × fireIntervalMs. */
export interface TtkChartRow {
  targetHp: number;
  ttkMs: number;
}

export function ttkChart(damagePerShot: number, fireIntervalMs: number, targetHps: number[] = [100, 150, 200, 250]): TtkChartRow[] {
  return targetHps.map((hp) => {
    const shots = Math.ceil(hp / damagePerShot);
    return { targetHp: hp, ttkMs: (shots - 1) * fireIntervalMs };
  });
}

/** B3-5000 #1066 — BTK (bullets-to-kill) chart. Returns the bullets-to-kill
 *  for each target HP value. */
export interface BtkChartRow {
  targetHp: number;
  bullets: number;
}

export function btkChart(damagePerShot: number, targetHps: number[] = [100, 150, 200, 250]): BtkChartRow[] {
  return targetHps.map((hp) => ({
    targetHp: hp,
    bullets: Math.ceil(hp / damagePerShot),
  }));
}

/** B3-5000 #1067 — HSK (headshots-to-kill) chart. Returns the headshots-to-kill
 *  for each target HP value, assuming a 2× headshot multiplier. */
export interface HskChartRow {
  targetHp: number;
  headshots: number;
}

export function hskChart(damagePerShot: number, headshotMult = 2.0, targetHps: number[] = [100, 150, 200, 250]): HskChartRow[] {
  return targetHps.map((hp) => ({
    targetHp: hp,
    headshots: Math.ceil(hp / (damagePerShot * headshotMult)),
  }));
}

/** B3-5000 #1068 — weapon comparison chart (overlay two weapons). Aliases
 *  sectionB.ts:compareWeapons — this helper accepts the pre-computed chart
 *  data for two weapons + returns a side-by-side comparison structure the
 *  gunsmith UI renders as an overlay. */
export interface WeaponComparisonChart<TPoint> {
  weaponA: WeaponType;
  weaponB: WeaponType;
  seriesA: TPoint[];
  seriesB: TPoint[];
}

export function compareWeaponCharts<TPoint>(
  weaponA: WeaponType,
  weaponB: WeaponType,
  seriesA: TPoint[],
  seriesB: TPoint[],
): WeaponComparisonChart<TPoint> {
  return { weaponA, weaponB, seriesA, seriesB };
}

// ─────────────────────────────────────────────────────────────────────────────
// #1069–#1077 — weapon balance social + reports
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1069 — weapon tier list (community-voted). Each weapon is
 *  assigned a tier (S/A/B/C/D) by the community. The tier list is updated
 *  weekly from the community feedback forum (#1075). */
export type WeaponTier = "S" | "A" | "B" | "C" | "D";

export interface WeaponTierListEntry {
  weapon: WeaponType;
  tier: WeaponTier;
  votes: number;
}

export interface WeaponTierList {
  weekOf: string; // ISO date
  entries: WeaponTierListEntry[];
}

/** Build a tier list from raw vote tallies. Assigns tiers by vote percentile:
 *  top 10% = S, next 20% = A, next 40% = B, next 20% = C, bottom 10% = D. */
export function buildWeaponTierList(
  weekOf: string,
  votes: Partial<Record<WeaponType, number>>,
): WeaponTierList {
  const entries = (Object.entries(votes) as [WeaponType, number][])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let cumulative = 0;
  const tiered = entries.map(([weapon, v]) => {
    cumulative += v;
    const pct = cumulative / total;
    let tier: WeaponTier = "D";
    if (pct <= 0.10) tier = "S";
    else if (pct <= 0.30) tier = "A";
    else if (pct <= 0.70) tier = "B";
    else if (pct <= 0.90) tier = "C";
    return { weapon, tier, votes: v };
  });
  return { weekOf, entries: tiered };
}

/** B3-5000 #1070 — weapon meta report (win-rate per weapon). */
export interface WeaponMetaReportEntry {
  weapon: WeaponType;
  winRate: number;   // 0..1
  pickRate: number;  // 0..1
  kdRatio: number;
}

export interface WeaponMetaReport {
  generatedAt: string;
  entries: WeaponMetaReportEntry[];
}

/** Build the meta report from raw match telemetry. */
export function buildWeaponMetaReport(
  generatedAt: string,
  perWeapon: Partial<Record<WeaponType, { wins: number; matches: number; picks: number; totalMatches: number; kills: number; deaths: number }>>,
): WeaponMetaReport {
  const entries = (Object.entries(perWeapon) as [WeaponType, { wins: number; matches: number; picks: number; totalMatches: number; kills: number; deaths: number }][]).map(([weapon, d]) => ({
    weapon,
    winRate: d.matches > 0 ? d.wins / d.matches : 0,
    pickRate: d.totalMatches > 0 ? d.picks / d.totalMatches : 0,
    kdRatio: d.deaths > 0 ? d.kills / d.deaths : d.kills,
  }));
  return { generatedAt, entries };
}

/** B3-5000 #1071 — weapon usage report (pick-rate). Subset of the meta
 *  report — just the pick-rate, sorted descending. */
export interface WeaponUsageReportEntry {
  weapon: WeaponType;
  pickRate: number;
}

export function buildWeaponUsageReport(meta: WeaponMetaReport): WeaponUsageReportEntry[] {
  return meta.entries
    .map((e) => ({ weapon: e.weapon, pickRate: e.pickRate }))
    .sort((a, b) => b.pickRate - a.pickRate);
}

/** B3-5000 #1072 — weapon balance changelog entry. */
export interface BalanceChangelogEntry {
  version: string;
  date: string;
  weapon: WeaponType;
  change: string;
  reason: string;
}

/** B3-5000 #1072 — append a changelog entry. Returns the new array. */
export function appendBalanceChangelog(
  log: BalanceChangelogEntry[],
  entry: BalanceChangelogEntry,
): BalanceChangelogEntry[] {
  return [...log, entry];
}

/** B3-5000 #1073 — patch notes (a curated subset of the changelog). */
export interface PatchNotes {
  version: string;
  date: string;
  title: string;
  summary: string;
  entries: BalanceChangelogEntry[];
}

/** Build patch notes by filtering the changelog to a specific version. */
export function buildPatchNotes(
  changelog: BalanceChangelogEntry[],
  version: string,
  date: string,
  title: string,
  summary: string,
): PatchNotes {
  return {
    version, date, title, summary,
    entries: changelog.filter((e) => e.version === version),
  };
}

/** B3-5000 #1074 — dev blog post. */
export interface DevBlogPost {
  id: string;
  title: string;
  author: string;
  date: string;
  body: string;
  relatedPatchVersion?: string;
}

/** B3-5000 #1075 — community feedback forum thread. */
export interface ForumThread {
  id: string;
  title: string;
  author: string;
  createdAt: string;
  replyCount: number;
  upvotes: number;
  tags: string[];
}

/** B3-5000 #1076 — community balance survey. */
export interface BalanceSurvey {
  id: string;
  title: string;
  createdAt: string;
  questions: BalanceSurveyQuestion[];
  responses: number;
}

export interface BalanceSurveyQuestion {
  id: string;
  prompt: string;
  type: "rating" | "multiple_choice" | "free_text";
  options?: string[];
}

/** B3-5000 #1077 — weapon balance telemetry (per-weapon K/D, headshot rate, TTK). */
export interface WeaponTelemetry {
  weapon: WeaponType;
  kills: number;
  deaths: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  totalTtkMs: number;
  ttkSamples: number;
}

export interface WeaponTelemetryReport {
  generatedAt: string;
  entries: Array<{
    weapon: WeaponType;
    kdRatio: number;
    headshotRate: number;
    accuracy: number;
    avgTtkMs: number;
  }>;
}

/** B3-5000 #1077 — build the telemetry report from raw per-weapon telemetry. */
export function buildWeaponTelemetryReport(
  generatedAt: string,
  telemetry: WeaponTelemetry[],
): WeaponTelemetryReport {
  const entries = telemetry.map((t) => ({
    weapon: t.weapon,
    kdRatio: t.deaths > 0 ? t.kills / t.deaths : t.kills,
    headshotRate: t.kills > 0 ? t.headshots / t.kills : 0,
    accuracy: t.shotsFired > 0 ? t.shotsHit / t.shotsFired : 0,
    avgTtkMs: t.ttkSamples > 0 ? t.totalTtkMs / t.ttkSamples : 0,
  }));
  return { generatedAt, entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// #1078–#1082 — auto-tuning + A/B testing + rollback + presets + server config
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1078 — weapon balance auto-tuning. Adjusts a weapon's stats based
 *  on telemetry. If a weapon's K/D is too high (>1.5), reduce damage by 5%;
 *  if too low (<0.7), increase damage by 5%. Returns the new damage value. */
export function autoTuneDamage(
  currentDamage: number,
  kdRatio: number,
  targetKd = 1.0,
  adjustmentFraction = 0.05,
): number {
  if (kdRatio <= 0) return currentDamage;
  // Above target → reduce damage; below → increase.
  const ratio = kdRatio / targetKd;
  if (ratio > 1.2) return currentDamage * (1 - adjustmentFraction);
  if (ratio < 0.83) return currentDamage * (1 + adjustmentFraction);
  return currentDamage;
}

/** B3-5000 #1079 — A/B test assignment. Returns "A" or "B" based on a stable
 *  hash of the player ID (so the same player always sees the same variant). */
export function assignAbVariant(playerId: string): "A" | "B" {
  return hashStr(playerId) % 2 === 0 ? "A" : "B";
}

/** B3-5000 #1080 — weapon balance rollback. Restores a previous version's
 *  stats from the changelog. Returns the prior damage value (or current
 *  if no rollback target found). */
export function rollbackWeaponStat(
  weapon: WeaponType,
  currentValue: number,
  changelog: BalanceChangelogEntry[],
  targetVersion: string,
): number {
  // Find the most recent changelog entry at or before targetVersion that
  // mentions this weapon. The "change" string is parsed for a number.
  const relevant = changelog
    .filter((e) => e.weapon === weapon && e.version <= targetVersion)
    .sort((a, b) => b.version.localeCompare(a.version));
  if (relevant.length === 0) return currentValue;
  // Parse the change string for the prior value (e.g. "damage 25 → 22").
  const match = relevant[0].change.match(/(\d+(?:\.\d+)?)\s*[→\-]\s*(\d+(?:\.\d+)?)/);
  if (match) return parseFloat(match[1]); // the "before" value
  return currentValue;
}

/** B3-5000 #1081 — weapon balance preset (arcade/realistic/hardcore). Each
 *  preset scales the global TTK + recoil + spread. */
export type BalancePreset = "arcade" | "realistic" | "hardcore";

export interface BalancePresetConfig {
  name: BalancePreset;
  damageMult: number;
  recoilMult: number;
  spreadMult: number;
  headshotMult: number;
}

export const BALANCE_PRESETS: Record<BalancePreset, BalancePresetConfig> = {
  arcade:    { name: "arcade",    damageMult: 0.7,  recoilMult: 0.6, spreadMult: 0.6, headshotMult: 1.5 },
  realistic: { name: "realistic", damageMult: 1.0,  recoilMult: 1.0, spreadMult: 1.0, headshotMult: 2.0 },
  hardcore:  { name: "hardcore",  damageMult: 1.5,  recoilMult: 1.5, spreadMult: 1.3, headshotMult: 3.0 },
};

/** B3-5000 #1082 — server-side balance config. The server pushes this to
 *  clients; no code deploy required to retune. */
export interface ServerBalanceConfig {
  version: string;
  preset: BalancePreset;
  perWeaponOverrides: Partial<Record<WeaponType, Partial<{
    damageMult: number;
    recoilMult: number;
    spreadMult: number;
    fireRateMult: number;
  }>>>;
  generatedAt: string;
}

/** Build a server balance config from a preset + per-weapon overrides. */
export function buildServerBalanceConfig(
  preset: BalancePreset,
  perWeaponOverrides: ServerBalanceConfig["perWeaponOverrides"] = {},
  version = "1.0.0",
): ServerBalanceConfig {
  return {
    version,
    preset,
    perWeaponOverrides,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #1083–#1100 — weapon balance modding API
// ─────────────────────────────────────────────────────────────────────────────

/** B3-5000 #1083 — weapon balance mod. A community-authored tuning override
 *  for one or more weapons. The modding API validates (#1084), shares
 *  (#1085), leaderboards (#1086), reviews (#1087), categorizes (#1088),
 *  tags (#1089), searches (#1090), installs (#1091), uninstalls (#1092),
 *  auto-updates (#1093), conflict-resolves (#1094), load-orders (#1095),
 *  dependency-resolves (#1096), versions (#1097), changelogs (#1098),
 *  permissions (#1099), and monetizes (#1100) these mods. */
export interface WeaponBalanceMod {
  id: string;
  name: string;
  authorId: string;
  version: string;
  description: string;
  /** Per-weapon stat overrides. */
  overrides: Partial<Record<WeaponType, Partial<{
    damageMult: number;
    recoilMult: number;
    spreadMult: number;
    fireRateMult: number;
    magSizeMult: number;
    reloadTimeMult: number;
  }>>>;
  /** Mod IDs this mod depends on (#1096). */
  dependencies: string[];
  /** Semantic categories (#1088). */
  categories: string[];
  /** Free-form tags (#1089). */
  tags: string[];
  /** Permissions required to install (#1099). */
  permissions: ModPermission[];
  /** Monetization model (#1100). */
  monetization: ModMonetization;
  createdAt: string;
  updatedAt: string;
}

/** B3-5000 #1099 — mod permissions. */
export type ModPermission =
  | "read_stats"
  | "override_stats"
  | "network_access"
  | "filesystem_access"
  | "ui_overlay";

/** B3-5000 #1100 — mod monetization model. */
export interface ModMonetization {
  model: "free" | "paid" | "freemium" | "donation";
  priceUsd?: number;
  /** Revenue split: 0..1 fraction to the author (rest to platform). */
  authorRevenueShare?: number;
}

/** B3-5000 #1084 — modding validation. Rejects OP mods (any multiplier
 *  outside the allowed range). Returns null if valid, or an error message. */
export function validateMod(mod: WeaponBalanceMod, opts: {
  minMult?: number;
  maxMult?: number;
} = {}): string | null {
  const min = opts.minMult ?? 0.5;
  const max = opts.maxMult ?? 2.0;
  for (const [weapon, ov] of Object.entries(mod.overrides)) {
    if (!ov) continue;
    for (const [field, value] of Object.entries(ov)) {
      if (typeof value !== "number") continue;
      if (value < min) return `${weapon}.${field} = ${value} is below minimum ${min}`;
      if (value > max) return `${weapon}.${field} = ${value} is above maximum ${max}`;
    }
  }
  // Mods can't request filesystem_access (security gate).
  if (mod.permissions.includes("filesystem_access")) {
    return "filesystem_access permission is not allowed for weapon-balance mods";
  }
  return null;
}

/** B3-5000 #1085 — modding sharing. Serializes a mod to a shareable string
 *  (base64-encoded JSON). The recipient decodes + installs. */
export function serializeModForSharing(mod: WeaponBalanceMod): string {
  // Browser-safe base64 of JSON. (Server-side this would use Buffer.)
  const json = JSON.stringify(mod);
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(json)));
  // Node fallback.
  return Buffer.from(json, "utf-8").toString("base64");
}

/** B3-5000 #1085 — deserialize a shared mod string. */
export function deserializeSharedMod(encoded: string): WeaponBalanceMod | null {
  try {
    const json = typeof atob === "function"
      ? decodeURIComponent(escape(atob(encoded)))
      : Buffer.from(encoded, "base64").toString("utf-8");
    return JSON.parse(json) as WeaponBalanceMod;
  } catch {
    return null;
  }
}

/** B3-5000 #1086 — modding leaderboard entry (most-used mods). */
export interface ModLeaderboardEntry {
  modId: string;
  name: string;
  authorId: string;
  installCount: number;
  rating: number;
}

/** Sort a list of mods by install count (descending) for the leaderboard. */
export function buildModLeaderboard(
  mods: Array<{ modId: string; name: string; authorId: string; installCount: number; rating: number }>,
): ModLeaderboardEntry[] {
  return [...mods].sort((a, b) => b.installCount - a.installCount);
}

/** B3-5000 #1087 — modding review. */
export interface ModReview {
  id: string;
  modId: string;
  authorId: string;
  rating: number;   // 1..5
  body: string;
  createdAt: string;
}

/** Compute the average rating for a mod from its reviews. */
export function averageModRating(reviews: ModReview[]): number {
  if (reviews.length === 0) return 0;
  return reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
}

/** B3-5000 #1088 — modding categories. The canonical category list. */
export const MOD_CATEGORIES: string[] = [
  "realism", "arcade", "tactical", "milsim", "competitive", "casual",
  "historical", "sci-fi", "pvp", "pve", "zombie", "training",
];

/** B3-5000 #1089 — modding tags. Free-form but the API suggests a tag
 *  vocabulary for consistency. */
export const MOD_SUGGESTED_TAGS: string[] = [
  "high-damage", "low-recoil", "fast-fire", "slow-fire", "high-capacity",
  "sniper-friendly", "cqb", "long-range", "suppressed", "no-scope",
  "hardcore", "tactical", "experimental", "balance-fix", "meme",
];

/** B3-5000 #1090 — modding search. Filters mods by query + category + tags. */
export function searchMods(
  mods: WeaponBalanceMod[],
  query: string,
  category?: string,
  tags?: string[],
): WeaponBalanceMod[] {
  const q = query.toLowerCase().trim();
  return mods.filter((m) => {
    if (category && !m.categories.includes(category)) return false;
    if (tags && tags.length > 0 && !tags.every((t) => m.tags.includes(t))) return false;
    if (!q) return true;
    return (
      m.name.toLowerCase().includes(q) ||
      m.description.toLowerCase().includes(q) ||
      m.authorId.toLowerCase().includes(q) ||
      m.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** B3-5000 #1091 — modding install state. Tracks which mods are installed
 *  + their load order (#1095). */
export interface ModInstallState {
  installed: Array<{ modId: string; installedAt: string; version: string }>;
  loadOrder: string[]; // mod IDs in load order (first = highest priority)
}

/** B3-5000 #1091 — install a mod. Appends to the install list + the load
 *  order (new mods go last by default). */
export function installMod(state: ModInstallState, mod: WeaponBalanceMod): ModInstallState {
  if (state.installed.some((i) => i.modId === mod.id)) return state; // already installed
  return {
    installed: [
      ...state.installed,
      { modId: mod.id, installedAt: new Date().toISOString(), version: mod.version },
    ],
    loadOrder: [...state.loadOrder, mod.id],
  };
}

/** B3-5000 #1092 — uninstall a mod. Removes from the install list + load order. */
export function uninstallMod(state: ModInstallState, modId: string): ModInstallState {
  return {
    installed: state.installed.filter((i) => i.modId !== modId),
    loadOrder: state.loadOrder.filter((id) => id !== modId),
  };
}

/** B3-5000 #1093 — modding auto-update. Checks if an installed mod is
 *  outdated vs the latest version. Returns true if an update is available. */
export function isModUpdateAvailable(
  installedVersion: string,
  latestVersion: string,
): boolean {
  return compareModVersions(installedVersion, latestVersion) < 0;
}

/** B3-5000 #1097 — compare two semver mod versions. Returns <0 if a < b,
 *  0 if equal, >0 if a > b. */
export function compareModVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** B3-5000 #1094 — modding conflict resolution. Two mods conflict if they
 *  override the same weapon's same stat. Returns the list of conflicting
 *  (weapon, field) pairs. */
export function detectModConflicts(
  mods: WeaponBalanceMod[],
): Array<{ weapon: WeaponType; field: string; modIds: string[] }> {
  const overrides = new Map<string, string[]>();
  for (const mod of mods) {
    for (const [weapon, ov] of Object.entries(mod.overrides)) {
      if (!ov) continue;
      for (const field of Object.keys(ov)) {
        const key = `${weapon}:${field}`;
        const list = overrides.get(key) ?? [];
        list.push(mod.id);
        overrides.set(key, list);
      }
    }
  }
  const conflicts: Array<{ weapon: WeaponType; field: string; modIds: string[] }> = [];
  for (const [key, modIds] of overrides.entries()) {
    if (modIds.length > 1) {
      const [weapon, field] = key.split(":") as [WeaponType, string];
      conflicts.push({ weapon, field, modIds });
    }
  }
  return conflicts;
}

/** B3-5000 #1095 — modding load order. Resolves conflicts by giving the
 *  mod earlier in the load order priority. Returns the effective per-weapon
 *  override map after applying the load order. */
export function resolveLoadOrder(
  mods: WeaponBalanceMod[],
  loadOrder: string[],
): Partial<Record<WeaponType, Record<string, number>>> {
  // Sort mods by load order (earlier = higher priority, applied last so it wins).
  const sorted = [...mods].sort((a, b) => {
    const ia = loadOrder.indexOf(a.id);
    const ib = loadOrder.indexOf(b.id);
    return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
  });
  // Apply in load order; later mods overwrite earlier (last-wins).
  // Actually we want first-in-load-order to win, so apply in REVERSE order
  // (last first, then earlier overwrites).
  const result: Partial<Record<WeaponType, Record<string, number>>> = {};
  for (let i = sorted.length - 1; i >= 0; i--) {
    const mod = sorted[i];
    for (const [weapon, ov] of Object.entries(mod.overrides)) {
      if (!ov) continue;
      const w = weapon as WeaponType;
      if (!result[w]) result[w] = {};
      for (const [field, value] of Object.entries(ov)) {
        if (typeof value === "number") result[w]![field] = value;
      }
    }
  }
  return result;
}

/** B3-5000 #1096 — modding dependency resolution. Returns the install
 *  order for a list of mods so that dependencies are installed before
 *  dependents. Throws if a dependency cycle is detected. */
export function resolveModDependencies(mods: WeaponBalanceMod[]): string[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Dependency cycle detected at mod ${id}`);
    }
    visiting.add(id);
    const mod = byId.get(id);
    if (mod) {
      for (const dep of mod.dependencies) visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const m of mods) visit(m.id);
  return order;
}

/** B3-5000 #1098 — modding changelog entry. */
export interface ModChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

/** Append a changelog entry to a mod's changelog. */
export function appendModChangelog(
  log: ModChangelogEntry[],
  entry: ModChangelogEntry,
): ModChangelogEntry[] {
  return [...log, entry];
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic string hash (FNV-1a 32-bit). Used for tier-list seeding,
 *  A/B test assignment, + recoil-pattern generation (no Math.random — the
 *  gunsmith charts must be reproducible). */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
