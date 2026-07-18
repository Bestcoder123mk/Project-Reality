import type { WeaponType } from "../store";

/**
 * RecoilSystem — per-weapon recoil patterns + recovery.
 *
 * Each weapon has a 30-shot recoil pattern authored as normalized (x,y)
 * offsets. Applied with smoothing + randomness. Pattern visible in
 * gunsmith as a dot-plot.
 *
 * Mathematical formulation:
 *   recoil_offset(t) = pattern[shot_index % 30] * weapon_recoil * randomization
 *   recovery: camera returns to original aim over `recoveryMs` ms with easeOutCubic
 *
 * After firing stops, the camera returns to the original aim point over
 * `recoveryMs` ms with [0.16, 1, 0.3, 1] ease (Apple's signature curve).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REALISM-1 (task A) — per-weapon recoil pattern overhaul.
 *
 * The previous patterns were "cloned from closest sibling + tuned" — many
 * weapons felt samey. This rewrite gives every weapon a distinct personality
 * grounded in the real gun's operating mechanism:
 *
 *   - AK-74: strong vertical climb + RIGHTWARD bias (gas block sits left of
 *     bore-axis → muzzle kicks up + right). Horizontal jitter ±0.08.
 *   - M4: tight, mostly vertical, low horizontal jitter ±0.03 (the "laser").
 *   - HK416: M4-like but with a slight LEFTWARD bias (mirrors the real gun's
 *     piston-system recoil impulse, which is slightly asymmetric opposite
 *     to the AK family).
 *   - FAMAS: high fire rate, low per-shot recoil but accumulates fast
 *     (bullpup weight behind the shooter's shoulder — high ROF, small kicks).
 *   - AUG: heavy first shot (bullpup weight shifts the center of mass), then
 *     settles into a tight, controllable climb.
 *   - SCAR-H: hard-hitting 7.62mm battle rifle — big vertical kick, slow
 *     recovery (heavy bolt, slow return-to-battery).
 *   - MK17: similar to SCAR-H but more controllable (heavier chassis dampens
 *     the impulse — SCAR-H is the sharper of the two, MK17 the steadier).
 *   - MK14: DMR — semi-auto, big single-shot kick with long recovery (heavy
 *     7.62mm round + wood-and-rail chassis — kicks like a hunting rifle).
 *   - Galil: AK-clone with worse horizontal jitter (Israeli copy of the AK
 *     pattern — same piston geometry, looser tolerances).
 *   - MP7: SMG, very low recoil, fast recovery (4.6mm cartridge is weaker
 *     than 9mm — minimal impulse per shot).
 *   - P90: 50-round mag, low recoil but bullpup muzzle climb (the bullpup
 *     layout puts the action behind the trigger — the muzzle is lighter,
 *     so it climbs more for the same impulse).
 *   - MP5: the iconic SMG "laser" — tightest pattern of all SMGs (roller-
 *     delayed blowback spreads the impulse over time — the softest shooting
 *     9mm SMG ever made).
 *   - UMP45: heavier .45 ACP, more per-shot kick than MP5 (slower cyclic,
 *     heavier bolt — bigger impulse per shot).
 *   - Vector: absurd fire rate, minimal per-shot recoil but high accumulative
 *     (Super V recoil-mitigation system redirects the bolt downward — the
 *     only SMG that pulls the muzzle DOWN, not up).
 *   - PP90M1: quirky Russian SMG, asymmetric recoil (helical magazine is
 *     offset from bore-axis → muzzle climbs up + to one side).
 *   - USP: precise pistol, low recoil (.45 ACP but the USP's recoil-
 *     reduction buffer spring absorbs ~30% of the impulse).
 *   - Deagle: brutal per-shot kick, long recovery (.50 AE — biggest pistol
 *     cartridge in production. Heavy slide, long return-to-battery).
 *   - Glock18: burst-fire feel, low per-shot but rapid (9mm + the Glock's
 *     polymer frame is light → snappy per-shot but fast cyclic).
 *   - M1911: classic .45, sharp single kick (1911's grip angle + heavy
 *     steel frame → sharp upward snap, then settles).
 *   - Revolver: heaviest pistol recoil, longest recovery (.50 cal revolver
 *     — the cylinder rotates with each shot, adding rotational mass to
 *     the recoil impulse).
 *   - AWP: massive sniper kick, long re-chamber (.338 Lapua Magnum — big
 *     cartridge, heavy bolt, long pull).
 *   - Scout: lighter sniper, faster re-chamber (lighter 7.62mm round +
 *     lightweight chassis — faster bolt throw).
 *   - Kar98k: WWII feel, sharp bolt-action kick (7.92mm Mauser — heavy
 *     round, turn-bolt action, sharp upward snap on firing).
 *   - L115A3: long-range sniper, very low recoil (heavy 7.5kg rifle — the
 *     mass absorbs the .338 Lapua impulse; the recoil reads as a slow push,
 *     not a snap. Long bolt cycle but low felt recoil).
 *   - Nova: pump shotgun, hard kick (12-gauge + pump action — full impulse
 *     delivered in one shot, no gas system to absorb it).
 *   - M1014: semi-auto shotgun, lower per-shot but rapid (gas system cycles
 *     the bolt — absorbs ~30% of the impulse per shot, faster follow-ups).
 *   - SPAS-12: heavier shotgun, more punch (heavier than the M1014 + the
 *     folding stock flexes → more felt recoil per shot).
 *   - M249: LMG, low per-shot recoil (heavy 7kg mass + 5.56mm cartridge —
 *     the mass stabilizes side-to-side; recoil accumulates slowly).
 *   - RPK: heavier LMG, more punch per shot (5.45mm + heavier barrel than
 *     the M249 → more felt recoil per shot, slower recovery).
 *   - MK48: hardest-hitting LMG, biggest kick (7.62mm GPMG — heaviest
 *     cartridge in the LMG class, biggest impulse per shot).
 *
 * All patterns remain playable — no pathological kicks (e.g. the Deagle
 * doesn't flip the camera 90°; it just kicks hard for one shot, then
 * recovers). The personalities are felt in the dance of the dot-plot, not
 * in impossible-to-control screen flipping.
 * ────────────────────────────────────────────────────────────────────────────
 */

export interface RecoilPattern {
  /** 30-shot pattern of normalized (x,y) offsets. x = horizontal (rightward +), y = vertical (upward +). */
  points: [number, number][];
  /** Recovery time in ms after firing stops. */
  recoveryMs: number;
  /** Randomness factor (0 = deterministic, 1 = fully random). */
  randomness: number;
}

/** Per-weapon recoil patterns. Each is 30 shots, then loops. */
export const RECOIL_PATTERNS: Record<WeaponType, RecoilPattern> = {
  // ════════════════════════════════════════════════════════════════════════
  // RIFLE / battle rifle / marksman
  // ════════════════════════════════════════════════════════════════════════

  ak74: {
    // Personality: classic AK — strong vertical climb + rightward bias
    // (gas block left of bore-axis → muzzle kicks up + right). Horizontal
    // jitter ±0.08 — the AK dances. First 5 shots are tight (the "AK pull-
    // down" window), then it climbs hard.
    points: [
      [0.00, 1.00], [0.04, 1.00], [0.08, 0.95], [0.10, 0.90], [0.12, 0.86],
      [0.16, 0.82], [0.20, 0.78], [0.24, 0.74], [0.26, 0.70], [0.28, 0.66],
      [0.30, 0.62], [0.31, 0.58], [0.32, 0.54], [0.33, 0.50], [0.33, 0.46],
      [0.34, 0.42], [0.34, 0.38], [0.33, 0.34], [0.32, 0.30], [0.31, 0.26],
      [0.29, 0.22], [0.27, 0.18], [0.24, 0.14], [0.21, 0.10], [0.18, 0.06],
      [0.14, 0.02], [0.10, -0.02], [0.06, -0.05], [0.02, -0.07], [-0.02, -0.08],
    ],
    recoveryMs: 400,
    randomness: 0.30,
  },

  m4: {
    // Personality: the "laser" — tight, mostly vertical, low horizontal
    // jitter ±0.03. Direct-impingement system runs flat (gas taps straight
    // onto the bolt carrier — minimal side-to-side impulse). Easiest rifle
    // to control at range.
    points: [
      [0.00, 0.82], [0.01, 0.82], [0.02, 0.80], [0.00, 0.78], [-0.01, 0.76],
      [0.01, 0.74], [0.02, 0.72], [0.00, 0.70], [-0.02, 0.68], [0.00, 0.66],
      [0.01, 0.64], [0.02, 0.62], [0.00, 0.60], [-0.01, 0.58], [-0.02, 0.56],
      [0.00, 0.54], [0.01, 0.52], [0.02, 0.50], [0.00, 0.48], [-0.01, 0.46],
      [-0.02, 0.44], [0.00, 0.42], [0.01, 0.40], [0.00, 0.38], [-0.01, 0.36],
      [0.00, 0.34], [0.01, 0.32], [0.00, 0.30], [-0.01, 0.28], [0.00, 0.26],
    ],
    recoveryMs: 380,
    randomness: 0.18,
  },

  hk416: {
    // Personality: M4-like but with a slight LEFTWARD bias (the piston rod
    // sits above the barrel, applying a slight downward-leftward impulse —
    // mirrors the AK's rightward bias but in the opposite direction due to
    // the opposite-side gas block). Slightly chunkier feel than the M4.
    points: [
      [0.00, 0.78], [-0.02, 0.78], [-0.04, 0.76], [-0.05, 0.74], [-0.06, 0.72],
      [-0.07, 0.70], [-0.08, 0.68], [-0.08, 0.66], [-0.08, 0.64], [-0.07, 0.62],
      [-0.06, 0.60], [-0.05, 0.58], [-0.04, 0.56], [-0.03, 0.54], [-0.02, 0.52],
      [-0.01, 0.50], [0.00, 0.48], [0.00, 0.46], [0.00, 0.44], [-0.01, 0.42],
      [-0.02, 0.40], [-0.02, 0.38], [-0.02, 0.36], [-0.01, 0.34], [0.00, 0.32],
      [0.00, 0.30], [0.00, 0.28], [-0.01, 0.26], [-0.01, 0.24], [0.00, 0.22],
    ],
    recoveryMs: 340,
    randomness: 0.18,
  },

  famas: {
    // Personality: high ROF (950 RPM), low per-shot recoil but accumulates
    // fast. Bullpup layout puts the action behind the trigger — the muzzle
    // is lighter, so the same impulse produces more muzzle climb. The
    // pattern reads as a fast, tight vertical dance — small kicks but they
    // stack up over the 25-round mag.
    points: [
      [0.00, 0.62], [0.02, 0.62], [-0.02, 0.62], [0.03, 0.62], [-0.03, 0.62],
      [0.04, 0.62], [-0.04, 0.62], [0.04, 0.62], [-0.04, 0.62], [0.05, 0.62],
      [-0.05, 0.62], [0.05, 0.62], [-0.05, 0.62], [0.05, 0.62], [-0.05, 0.62],
      [0.06, 0.60], [-0.06, 0.58], [0.06, 0.56], [-0.06, 0.54], [0.06, 0.52],
      [-0.06, 0.50], [0.06, 0.48], [-0.06, 0.46], [0.05, 0.44], [-0.05, 0.42],
      [0.04, 0.40], [-0.04, 0.38], [0.03, 0.36], [-0.02, 0.34], [0.00, 0.32],
    ],
    recoveryMs: 380,
    randomness: 0.28,
  },

  aug: {
    // Personality: bullpup with a heavy first shot (the AUG's mass is
    // concentrated behind the shooter's shoulder — the first shot's impulse
    // has to overcome the chassis's inertia, then the chassis is already
    // moving so subsequent shots feel softer). Heavy shot 0, then settles
    // into a tight climb.
    points: [
      [0.00, 1.30], [0.04, 0.60], [-0.02, 0.58], [0.04, 0.56], [-0.02, 0.54],
      [0.04, 0.52], [-0.02, 0.50], [0.03, 0.48], [-0.02, 0.46], [0.03, 0.44],
      [-0.01, 0.42], [0.03, 0.40], [-0.01, 0.38], [0.02, 0.36], [0.00, 0.34],
      [0.02, 0.32], [0.00, 0.30], [0.01, 0.28], [0.00, 0.26], [0.01, 0.24],
      [0.00, 0.22], [0.00, 0.20], [0.00, 0.18], [-0.01, 0.16], [0.00, 0.14],
      [0.00, 0.12], [0.00, 0.10], [0.00, 0.08], [0.00, 0.06], [0.00, 0.04],
    ],
    recoveryMs: 350,
    randomness: 0.22,
  },

  scarh: {
    // Personality: 7.62mm battle rifle — big vertical kick, slow recovery.
    // The SCAR-H's lightweight polymer lower + heavy barrel = top-heavy —
    // the muzzle really jumps. 20-round mag means every shot counts.
    points: [
      [0.00, 1.55], [0.06, 1.45], [-0.04, 1.35], [0.08, 1.25], [-0.06, 1.15],
      [0.10, 1.05], [-0.08, 0.95], [0.10, 0.85], [-0.08, 0.78], [0.10, 0.72],
      [-0.08, 0.66], [0.10, 0.60], [-0.08, 0.54], [0.08, 0.48], [-0.06, 0.42],
      [0.06, 0.36], [-0.04, 0.30], [0.04, 0.24], [-0.02, 0.18], [0.02, 0.12],
      [0.00, 0.06], [0.00, 0.00], [0.00, -0.04], [0.00, -0.06], [0.00, -0.08],
      [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08],
    ],
    recoveryMs: 500,
    randomness: 0.32,
  },

  galil: {
    // Personality: AK-clone with worse horizontal jitter (Israeli copy of
    // the AK pattern — same piston geometry, looser tolerances on the
    // production line). Same rightward bias as the AK but the dance is
    // wider + less predictable.
    points: [
      [0.00, 0.98], [0.08, 0.95], [-0.06, 0.92], [0.12, 0.88], [-0.10, 0.84],
      [0.14, 0.80], [-0.12, 0.76], [0.16, 0.72], [-0.14, 0.68], [0.16, 0.64],
      [-0.14, 0.60], [0.16, 0.56], [-0.14, 0.52], [0.14, 0.48], [-0.12, 0.44],
      [0.12, 0.40], [-0.10, 0.36], [0.10, 0.32], [-0.08, 0.28], [0.08, 0.24],
      [-0.06, 0.20], [0.06, 0.16], [-0.04, 0.12], [0.04, 0.08], [-0.02, 0.04],
      [0.02, 0.00], [0.00, -0.04], [-0.02, -0.06], [0.00, -0.08], [0.00, -0.08],
    ],
    recoveryMs: 420,
    randomness: 0.38,
  },

  mk17: {
    // Personality: similar to SCAR-H but more controllable. The MK17 is the
    // 7.62mm SCAR variant with a heavier chassis — same cartridge, more mass
    // absorbing the impulse. Reads as a slower, steadier climb (vs the
    // SCAR-H's sharper dance).
    points: [
      [0.00, 1.35], [0.04, 1.28], [-0.04, 1.22], [0.06, 1.16], [-0.06, 1.10],
      [0.08, 1.04], [-0.08, 0.98], [0.08, 0.92], [-0.08, 0.86], [0.08, 0.80],
      [-0.06, 0.74], [0.06, 0.68], [-0.04, 0.62], [0.04, 0.56], [-0.02, 0.50],
      [0.02, 0.44], [0.00, 0.38], [0.00, 0.32], [0.00, 0.26], [0.00, 0.20],
      [0.00, 0.14], [0.00, 0.08], [0.00, 0.02], [0.00, -0.02], [0.00, -0.04],
      [0.00, -0.04], [0.00, -0.04], [0.00, -0.04], [0.00, -0.04], [0.00, -0.04],
    ],
    recoveryMs: 460,
    randomness: 0.28,
  },

  mk14: {
    // Personality: DMR — semi-auto, big single-shot kick with long recovery.
    // The Mk14's wood-and-rail chassis is heavier than a baseline AR — each
    // 7.62mm shot delivers a sharp, hunting-rifle-style snap, then the gun
    // settles slowly. Most shots after the first are gentle (the chassis is
    // already moving).
    points: [
      [0.00, 1.85], [0.05, 0.70], [-0.05, 0.65], [0.06, 0.60], [-0.06, 0.55],
      [0.07, 0.50], [-0.07, 0.46], [0.07, 0.42], [-0.07, 0.38], [0.06, 0.34],
      [-0.06, 0.30], [0.05, 0.26], [-0.04, 0.22], [0.04, 0.18], [-0.02, 0.14],
      [0.02, 0.10], [0.00, 0.06], [0.00, 0.02], [0.00, -0.02], [0.00, -0.04],
      [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06],
      [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06],
    ],
    recoveryMs: 540,
    randomness: 0.28,
  },

  // ════════════════════════════════════════════════════════════════════════
  // SMG
  // ════════════════════════════════════════════════════════════════════════

  mp7: {
    // Personality: very low recoil, fast recovery. 4.6mm cartridge is weaker
    // than 9mm — minimal impulse per shot. The MP7 is the softest-shooting
    // PDW in production. Reads as a flat, fast climb with minimal horizontal.
    points: [
      [0.00, 0.45], [0.02, 0.45], [-0.02, 0.44], [0.02, 0.43], [-0.02, 0.42],
      [0.03, 0.41], [-0.03, 0.40], [0.03, 0.38], [-0.03, 0.37], [0.03, 0.35],
      [-0.02, 0.34], [0.02, 0.32], [-0.02, 0.30], [0.02, 0.28], [-0.01, 0.26],
      [0.01, 0.24], [0.00, 0.22], [0.00, 0.20], [0.00, 0.18], [0.00, 0.16],
      [0.00, 0.14], [0.00, 0.12], [0.00, 0.10], [0.00, 0.08], [0.00, 0.06],
      [0.00, 0.04], [0.00, 0.02], [0.00, 0.00], [0.00, -0.02], [0.00, -0.03],
    ],
    recoveryMs: 240,
    randomness: 0.35,
  },

  p90: {
    // Personality: 50-round mag, low recoil but bullpup muzzle climb. The
    // P90's bullpup layout puts the action behind the trigger — the muzzle
    // is lighter than a conventional SMG, so the same impulse produces more
    // climb. Reads as a steady upward drift over the 50-round mag.
    points: [
      [0.00, 0.42], [0.02, 0.43], [-0.02, 0.44], [0.02, 0.45], [-0.02, 0.45],
      [0.03, 0.46], [-0.03, 0.46], [0.03, 0.46], [-0.03, 0.46], [0.03, 0.46],
      [-0.03, 0.46], [0.03, 0.46], [-0.03, 0.45], [0.03, 0.45], [-0.03, 0.44],
      [0.03, 0.43], [-0.03, 0.42], [0.03, 0.40], [-0.02, 0.38], [0.02, 0.36],
      [-0.02, 0.34], [0.02, 0.32], [-0.02, 0.30], [0.02, 0.28], [-0.01, 0.26],
      [0.01, 0.24], [0.00, 0.22], [0.00, 0.20], [0.00, 0.18], [0.00, 0.16],
    ],
    recoveryMs: 220,
    randomness: 0.32,
  },

  mp5: {
    // Personality: the iconic SMG "laser" — tightest pattern of all SMGs.
    // Roller-delayed blowback spreads the impulse over time — the softest-
    // shooting 9mm SMG ever made. Reads as a near-flat line with minimal
    // climb + minimal horizontal jitter.
    points: [
      [0.00, 0.38], [0.01, 0.38], [-0.01, 0.38], [0.01, 0.37], [-0.01, 0.37],
      [0.01, 0.36], [-0.01, 0.36], [0.01, 0.35], [-0.01, 0.34], [0.01, 0.33],
      [-0.01, 0.32], [0.01, 0.31], [-0.01, 0.30], [0.00, 0.29], [0.00, 0.28],
      [0.00, 0.27], [0.00, 0.26], [0.00, 0.25], [0.00, 0.24], [0.00, 0.23],
      [0.00, 0.22], [0.00, 0.21], [0.00, 0.20], [0.00, 0.19], [0.00, 0.18],
      [0.00, 0.17], [0.00, 0.16], [0.00, 0.15], [0.00, 0.14], [0.00, 0.13],
    ],
    recoveryMs: 230,
    randomness: 0.28,
  },

  ump45: {
    // Personality: heavier .45 ACP, more per-shot kick than MP5. Slower
    // cyclic, heavier bolt — bigger impulse per shot. Reads as a chunkier,
    // slower climb than the MP5.
    points: [
      [0.00, 0.68], [0.03, 0.66], [-0.03, 0.64], [0.04, 0.62], [-0.04, 0.60],
      [0.04, 0.58], [-0.04, 0.56], [0.05, 0.54], [-0.05, 0.52], [0.05, 0.50],
      [-0.04, 0.48], [0.04, 0.46], [-0.04, 0.44], [0.04, 0.42], [-0.03, 0.40],
      [0.03, 0.38], [-0.03, 0.36], [0.02, 0.34], [-0.02, 0.32], [0.02, 0.30],
      [-0.02, 0.28], [0.01, 0.26], [-0.01, 0.24], [0.01, 0.22], [0.00, 0.20],
      [0.00, 0.18], [0.00, 0.16], [0.00, 0.14], [0.00, 0.12], [0.00, 0.10],
    ],
    recoveryMs: 300,
    randomness: 0.32,
  },

  vector: {
    // Personality: absurd fire rate (1200 RPM), minimal per-shot recoil but
    // high accumulative. The Super V recoil-mitigation system redirects the
    // bolt downward — the only SMG that pulls the muzzle DOWN, not up. Reads
    // as a very flat pattern with a slight downward drift (the player feels
    // the gun "settling" rather than climbing).
    points: [
      [0.00, 0.28], [0.01, 0.26], [-0.01, 0.24], [0.01, 0.22], [-0.01, 0.20],
      [0.01, 0.18], [-0.01, 0.16], [0.01, 0.14], [-0.01, 0.12], [0.01, 0.10],
      [-0.01, 0.08], [0.01, 0.06], [-0.01, 0.04], [0.01, 0.02], [-0.01, 0.00],
      [0.01, -0.02], [-0.01, -0.04], [0.01, -0.06], [-0.01, -0.08], [0.01, -0.10],
      [-0.01, -0.12], [0.01, -0.14], [-0.01, -0.16], [0.01, -0.18], [-0.01, -0.20],
      [0.00, -0.22], [0.00, -0.24], [0.00, -0.26], [0.00, -0.28], [0.00, -0.30],
    ],
    recoveryMs: 200,
    randomness: 0.40,
  },

  pp90m1: {
    // Personality: quirky Russian SMG, asymmetric recoil. Helical magazine
    // sits offset from bore-axis → muzzle climbs up + to one side (always
    // rightward, never leftward — the mag is on the left side of the gun).
    // Reads as a steady up-right diagonal drift.
    points: [
      [0.00, 0.55], [0.04, 0.55], [0.06, 0.55], [0.08, 0.54], [0.10, 0.54],
      [0.12, 0.53], [0.14, 0.52], [0.14, 0.51], [0.14, 0.50], [0.14, 0.49],
      [0.14, 0.48], [0.14, 0.47], [0.13, 0.46], [0.12, 0.45], [0.11, 0.44],
      [0.10, 0.43], [0.09, 0.42], [0.08, 0.41], [0.07, 0.40], [0.06, 0.39],
      [0.05, 0.38], [0.04, 0.37], [0.03, 0.36], [0.02, 0.35], [0.02, 0.34],
      [0.01, 0.33], [0.01, 0.32], [0.00, 0.31], [0.00, 0.30], [0.00, 0.29],
    ],
    recoveryMs: 260,
    randomness: 0.32,
  },

  // ════════════════════════════════════════════════════════════════════════
  // PISTOL
  // ════════════════════════════════════════════════════════════════════════

  usp: {
    // Personality: precise pistol, low recoil. The USP's recoil-reduction
    // buffer spring absorbs ~30% of the .45 ACP impulse. Reads as a soft,
    // controllable snap — perfect for follow-up shots.
    points: [
      [0.00, 1.00], [0.04, 0.85], [-0.04, 0.75], [0.06, 0.65], [-0.06, 0.55],
      [0.06, 0.45], [-0.06, 0.35], [0.05, 0.25], [-0.05, 0.15], [0.04, 0.05],
      [-0.04, -0.02], [0.03, -0.08], [-0.03, -0.12], [0.02, -0.14], [-0.02, -0.16],
      [0.01, -0.16], [-0.01, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16],
      [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16],
      [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16],
    ],
    recoveryMs: 320,
    randomness: 0.45,
  },

  deagle: {
    // Personality: brutal per-shot kick, long recovery. .50 AE — biggest
    // pistol cartridge in production. Heavy slide, long return-to-battery.
    // Each shot is a hammer blow; the camera kicks hard, then takes a long
    // moment to settle. Reads as a single big spike then near-zero.
    // Section B #300 — feel-pass tuning: recovery 500→450, randomness 0.55→0.45
    // (less random kick = more controllable for follow-up shots).
    points: [
      [0.00, 2.20], [0.10, 0.60], [-0.10, 0.45], [0.08, 0.30], [-0.08, 0.20],
      [0.06, 0.12], [-0.06, 0.06], [0.04, 0.00], [-0.04, -0.04], [0.02, -0.06],
      [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08],
      [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08],
      [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08],
      [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08], [0.00, -0.08],
    ],
    recoveryMs: 450,
    randomness: 0.45,
  },

  glock18: {
    // Personality: burst-fire feel, low per-shot but rapid. The Glock 18C is
    // full-auto — the polymer frame is light, so the impulse is snappy per
    // shot but the cyclic is fast. Reads as a quick, repetitive snap pattern.
    points: [
      [0.00, 0.78], [0.06, 0.74], [-0.06, 0.70], [0.06, 0.66], [-0.06, 0.62],
      [0.06, 0.58], [-0.06, 0.54], [0.06, 0.50], [-0.06, 0.46], [0.05, 0.42],
      [-0.05, 0.38], [0.05, 0.34], [-0.05, 0.30], [0.04, 0.26], [-0.04, 0.22],
      [0.03, 0.18], [-0.03, 0.14], [0.02, 0.10], [-0.02, 0.06], [0.01, 0.02],
      [0.00, -0.02], [0.00, -0.04], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06],
      [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06],
    ],
    recoveryMs: 280,
    randomness: 0.50,
  },

  m1911: {
    // Personality: classic .45, sharp single kick. The 1911's grip angle +
    // heavy steel frame → sharp upward snap on firing, then the gun settles
    // back into the shooter's grip. Reads as one big spike then a quick
    // recovery — a true duelist's pistol.
    points: [
      [0.00, 1.50], [0.08, 0.70], [-0.08, 0.55], [0.08, 0.40], [-0.06, 0.28],
      [0.06, 0.18], [-0.04, 0.10], [0.03, 0.02], [-0.02, -0.04], [0.00, -0.08],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
    ],
    recoveryMs: 360,
    randomness: 0.42,
  },

  revolver: {
    // Personality: heaviest pistol recoil, longest recovery. .50 cal revolver
    // — the cylinder rotates with each shot, adding rotational mass to the
    // recoil impulse. Reads as a brutal snap, then a long, slow settle.
    points: [
      [0.00, 2.50], [0.14, 0.70], [-0.14, 0.50], [0.12, 0.35], [-0.12, 0.22],
      [0.10, 0.12], [-0.08, 0.05], [0.06, -0.02], [-0.04, -0.06], [0.02, -0.10],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
    ],
    recoveryMs: 540,
    randomness: 0.60,
  },

  // ════════════════════════════════════════════════════════════════════════
  // SNIPER
  // ════════════════════════════════════════════════════════════════════════

  awp: {
    // Personality: massive sniper kick, long re-chamber. .338 Lapua Magnum —
    // big cartridge, heavy bolt, long pull. Each shot is a single huge kick;
    // the pattern then stays near-zero (you can't really rapid-fire an AWP).
    points: [
      [0.00, 3.00], [0.18, 1.00], [-0.18, 0.70], [0.15, 0.45], [-0.15, 0.25],
      [0.10, 0.10], [-0.08, -0.02], [0.04, -0.10], [-0.02, -0.14], [0.00, -0.16],
      [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16],
      [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16],
      [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16],
      [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16], [0.00, -0.16],
    ],
    recoveryMs: 650,
    randomness: 0.22,
  },

  scout: {
    // Personality: lighter sniper, faster re-chamber. The Scout is the
    // lightweight 7.62mm — fast bolt throw, lower per-shot kick than the
    // AWP. Reads as a snappy kick then a quick settle — rewards aggressive
    // repositioning between shots.
    points: [
      [0.00, 2.00], [0.10, 0.85], [-0.10, 0.65], [0.08, 0.45], [-0.08, 0.30],
      [0.06, 0.18], [-0.04, 0.08], [0.02, 0.00], [0.00, -0.06], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
    ],
    recoveryMs: 460,
    randomness: 0.30,
  },

  kar98k: {
    // Personality: WWII feel, sharp bolt-action kick. 7.92mm Mauser — heavy
    // round, turn-bolt action, sharp upward snap on firing. Reads as a sharp
    // single spike, slightly bigger than the Scout's, with a slightly longer
    // bolt cycle.
    points: [
      [0.00, 2.50], [0.12, 0.95], [-0.12, 0.70], [0.10, 0.50], [-0.10, 0.32],
      [0.08, 0.20], [-0.06, 0.10], [0.04, 0.02], [-0.02, -0.04], [0.00, -0.08],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
    ],
    recoveryMs: 570,
    randomness: 0.26,
  },

  l115a3: {
    // Personality: long-range sniper, very low recoil (heavy rifle). The
    // L115A3 is a 7.5kg .338 Lapua sniper — the mass absorbs the impulse;
    // the recoil reads as a slow push, not a snap. Long bolt cycle but low
    // felt recoil. Counter-intuitive vs the AWP (same cartridge, but the
    // AWP is lighter + reads as a sharper kick).
    points: [
      [0.00, 1.50], [0.06, 0.50], [-0.06, 0.40], [0.04, 0.30], [-0.04, 0.22],
      [0.03, 0.15], [-0.03, 0.10], [0.02, 0.05], [-0.02, 0.00], [0.00, -0.04],
      [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06],
      [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06],
      [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06],
      [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06], [0.00, -0.06],
    ],
    recoveryMs: 700,
    randomness: 0.15,
  },

  // ════════════════════════════════════════════════════════════════════════
  // SHOTGUN
  // ════════════════════════════════════════════════════════════════════════

  nova: {
    // Personality: pump shotgun, hard kick. 12-gauge + pump action — full
    // impulse delivered in one shot, no gas system to absorb it. Reads as a
    // single big push, then the pump cycle. Slowest cyclic of the shotguns.
    points: [
      [0.00, 2.60], [0.12, 1.10], [-0.12, 0.85], [0.10, 0.60], [-0.10, 0.40],
      [0.08, 0.25], [-0.06, 0.12], [0.04, 0.02], [-0.02, -0.06], [0.00, -0.10],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
    ],
    recoveryMs: 580,
    randomness: 0.70,
  },

  m1014: {
    // Personality: semi-auto shotgun, lower per-shot but rapid. The M1014's
    // gas system cycles the bolt — absorbs ~30% of the impulse per shot,
    // faster follow-ups. Reads as a chunkier, faster pattern than the Nova.
    points: [
      [0.00, 2.00], [0.08, 1.10], [-0.08, 0.95], [0.08, 0.80], [-0.08, 0.65],
      [0.08, 0.55], [-0.08, 0.45], [0.08, 0.35], [-0.08, 0.25], [0.06, 0.18],
      [-0.06, 0.12], [0.05, 0.06], [-0.04, 0.00], [0.03, -0.04], [-0.02, -0.08],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
      [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10], [0.00, -0.10],
    ],
    recoveryMs: 460,
    randomness: 0.65,
  },

  spas12: {
    // Personality: heavier shotgun, more punch. The SPAS-12 is heavier than
    // the M1014 + the folding stock flexes → more felt recoil per shot. Reads
    // as a slower, harder-hitting pattern than the M1014.
    // Section B #300 — feel-pass tuning: randomness 0.68→0.55, recovery 600→560
    // (tighter pellet spread + faster settle = more predictable + responsive).
    points: [
      [0.00, 2.80], [0.10, 1.20], [-0.10, 1.00], [0.10, 0.80], [-0.10, 0.65],
      [0.10, 0.50], [-0.10, 0.38], [0.08, 0.28], [-0.08, 0.18], [0.06, 0.10],
      [-0.06, 0.02], [0.04, -0.04], [-0.04, -0.08], [0.02, -0.10], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
      [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12], [0.00, -0.12],
    ],
    recoveryMs: 560,
    randomness: 0.55,
  },

  // ════════════════════════════════════════════════════════════════════════
  // LMG
  // ════════════════════════════════════════════════════════════════════════

  m249: {
    // Personality: LMG, low per-shot recoil (heavy) but accumulates slowly.
    // 5.56mm cartridge + 7kg mass — the mass stabilizes side-to-side; recoil
    // accumulates slowly over the 100-round belt. Reads as a steady, gentle
    // climb — the easiest LMG to keep on target.
    points: [
      [0.00, 0.55], [0.04, 0.55], [-0.04, 0.55], [0.04, 0.55], [-0.04, 0.55],
      [0.04, 0.56], [-0.04, 0.56], [0.04, 0.56], [-0.04, 0.56], [0.04, 0.56],
      [-0.04, 0.56], [0.04, 0.56], [-0.04, 0.56], [0.04, 0.56], [-0.04, 0.56],
      [0.05, 0.57], [-0.05, 0.58], [0.05, 0.59], [-0.05, 0.60], [0.05, 0.61],
      [-0.05, 0.62], [0.05, 0.63], [-0.05, 0.64], [0.05, 0.65], [-0.05, 0.66],
      [0.05, 0.67], [-0.05, 0.68], [0.04, 0.69], [-0.04, 0.70], [0.00, 0.70],
    ],
    recoveryMs: 500,
    randomness: 0.22,
  },

  rpk: {
    // Personality: heavier LMG, more punch per shot. 5.45mm + heavier barrel
    // than the M249 → more felt recoil per shot, slower recovery. Reads as a
    // chunkier, faster-climbing pattern than the M249.
    points: [
      [0.00, 0.85], [0.05, 0.83], [-0.05, 0.81], [0.06, 0.79], [-0.06, 0.77],
      [0.07, 0.75], [-0.07, 0.73], [0.07, 0.71], [-0.07, 0.69], [0.08, 0.67],
      [-0.08, 0.65], [0.08, 0.63], [-0.08, 0.61], [0.08, 0.59], [-0.08, 0.57],
      [0.08, 0.55], [-0.08, 0.53], [0.07, 0.51], [-0.07, 0.49], [0.07, 0.47],
      [-0.07, 0.45], [0.06, 0.43], [-0.06, 0.41], [0.05, 0.39], [-0.05, 0.37],
      [0.04, 0.35], [-0.04, 0.33], [0.03, 0.31], [-0.02, 0.29], [0.00, 0.27],
    ],
    recoveryMs: 550,
    randomness: 0.28,
  },

  mk48: {
    // Personality: hardest-hitting LMG, biggest kick. 7.62mm GPMG — heaviest
    // cartridge in the LMG class, biggest impulse per shot. Reads as a heavy,
    // slow climb — the heaviest LMG to keep on target.
    // Section B #300 — feel-pass tuning: recovery 600→550 (faster settle =
    // more controllable for burst-fire discipline).
    points: [
      [0.00, 1.25], [0.07, 1.20], [-0.07, 1.15], [0.08, 1.10], [-0.08, 1.05],
      [0.09, 1.00], [-0.09, 0.95], [0.09, 0.90], [-0.09, 0.85], [0.10, 0.80],
      [-0.10, 0.75], [0.10, 0.70], [-0.10, 0.65], [0.10, 0.60], [-0.10, 0.55],
      [0.09, 0.50], [-0.09, 0.45], [0.08, 0.40], [-0.08, 0.35], [0.07, 0.30],
      [-0.07, 0.25], [0.06, 0.20], [-0.06, 0.15], [0.05, 0.10], [-0.04, 0.05],
      [0.03, 0.00], [-0.02, -0.04], [0.01, -0.08], [0.00, -0.10], [0.00, -0.10],
    ],
    recoveryMs: 550,
    randomness: 0.26,
  },
};

/**
 * Apply a recoil pattern sample to the weapon + camera.
 * Returns the (x,y) offset to apply to the camera pitch/yaw.
 */
export function applyRecoilPattern(
  weapon: WeaponType,
  shotIndex: number,
  recoilAmount: number,
): { x: number; y: number } {
  const pattern = RECOIL_PATTERNS[weapon];
  if (!pattern) return { x: 0, y: 0 };
  const idx = shotIndex % pattern.points.length;
  const [px, py] = pattern.points[idx];
  const rand = pattern.randomness;
  return {
    x: (px + (Math.random() - 0.5) * rand) * recoilAmount,
    y: (py + (Math.random() - 0.5) * rand) * recoilAmount,
  };
}

/** Get the recovery time for a weapon (ms). */
export function getRecoilRecoveryMs(weapon: WeaponType): number {
  return RECOIL_PATTERNS[weapon]?.recoveryMs ?? 400;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B — Prompts 152–155: recovery curve + stamina coupling + difficulty
// multiplier + damage-induced sight misalignment.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prompt 152 — easeOutCubic recovery curve.
 *
 * Maps a normalized recovery progress `t` ∈ [0,1] (0 = just stopped firing,
 * 1 = fully recovered) to the eased fraction of recovery. The sight settles
 * fast-then-slow: at t=0.25 it's already 58% recovered, at t=0.5 it's 88%,
 * at t=0.75 it's 98%. No overshoot, no abrupt stop — the classic easeOutCubic
 * deceleration.
 *
 * The RecoilSystem's per-frame recovery math should use this:
 *   offset = recoilOffset * (1 - easeOutCubicRecovery(t))
 * where `t` = (now - lastShotTime) / recoveryMs.
 */
export function easeOutCubicRecovery(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * Prompt 153 — stamina coupling on recoil recovery.
 *
 * A low-stamina player's weapon recovers slower. The recovery time is scaled
 * by `1 + (1 - staminaRatio) * 0.5` so at 0% stamina, recovery takes 1.5× as
 * long (matches the spec). At 100% stamina, recovery is unchanged.
 *
 * Pure function — the caller passes the current stamina ratio (0..1) + the
 * base recovery time (ms); returns the scaled recovery time.
 */
export function getStaminaScaledRecoveryMs(
  baseRecoveryMs: number,
  staminaRatio: number,
): number {
  const r = Math.max(0, Math.min(1, staminaRatio));
  const mult = 1 + (1 - r) * 0.5; // 1.0 at full stamina, 1.5 at empty
  return baseRecoveryMs * mult;
}

/**
 * Prompt 154 — difficulty recoil multiplier.
 *
 * Read by WeaponSystem.tryShoot to scale the per-shot recoil amount. The
 * values come from the Difficulty config's `recoilMult` field (added by
 * Section B). Default 1.0 for backwards compat (old saves without the field).
 */
export interface DifficultyRecoilConfig {
  recoilMult: number;
}

/** Per-difficulty recoil multiplier. Easy = 0.6, Normal = 1.0, Hard = 1.3, Insane = 1.6. */
export const DIFFICULTY_RECOIL_MULT: Record<string, number> = {
  easy: 0.6,
  normal: 1.0,
  hard: 1.3,
  insane: 1.6,
};

/**
 * Prompt 154 — resolve a difficulty key (or config object) to a recoil
 * multiplier. Falls back to 1.0 (normal) for unknown difficulty slugs.
 */
export function getDifficultyRecoilMult(
  diff: string | DifficultyRecoilConfig,
): number {
  if (typeof diff === "string") return DIFFICULTY_RECOIL_MULT[diff] ?? 1.0;
  return diff.recoilMult ?? 1.0;
}

/**
 * Prompt 155 — damage-induced sight misalignment.
 *
 * While `player.lastDamageTime` was less than `DAMAGE_SWAY_WINDOW_MS` ago,
 * the player's ADS sway is multiplied by `DAMAGE_SWAY_MULT` (1.3 = 30%
 * extra horizontal sway per the spec). The system reads `lastDamageTime`
 * (performance.now()) and the current time; the sway multiplier is applied
 * by the caller (ProceduralAnimSystem / WeaponSystem) to the sway amplitude.
 *
 * Returns 1.0 when not recently damaged; the multiplier when recently damaged.
 */
export const DAMAGE_SWAY_WINDOW_MS = 1000;
export const DAMAGE_SWAY_MULT = 1.3;

export function getDamageSwayMult(
  lastDamageTime: number,
  now: number = performance.now(),
): number {
  if (lastDamageTime <= 0) return 1.0;
  const since = now - lastDamageTime;
  if (since >= DAMAGE_SWAY_WINDOW_MS) return 1.0;
  // Linear ramp from 1.3 (just damaged) down to 1.0 (1s later). The decay
  // is linear so the player feels a steady recovery (not a hard cutoff).
  const t = since / DAMAGE_SWAY_WINDOW_MS; // 0..1
  return DAMAGE_SWAY_MULT - (DAMAGE_SWAY_MULT - 1.0) * t;
}

/**
 * Combined recovery progress with the new easeOutCubic curve + the stamina
 * scale. Callers that want the full Section B recovery math in one call:
 *
 *   const base = getRecoilRecoveryMs(weapon);
 *   const scaled = getStaminaScaledRecoveryMs(base, staminaRatio);
 *   const t = Math.min(1, (now - lastShotTime) / scaled);
 *   const easedT = easeOutCubicRecovery(t);
 *   const remainingOffset = recoilOffset * (1 - easedT);
 *
 * This helper packages the math so callers don't have to remember the order.
 */
export function computeRecoilRecoveryProgress(
  weapon: WeaponType,
  lastShotTime: number,
  staminaRatio: number,
  now: number = performance.now(),
): { progress: number; remainingOffset: number; recoveryMs: number } {
  const base = getRecoilRecoveryMs(weapon);
  const scaled = getStaminaScaledRecoveryMs(base, staminaRatio);
  const t = Math.min(1, Math.max(0, (now - lastShotTime) / scaled));
  const progress = easeOutCubicRecovery(t);
  return {
    progress,
    remainingOffset: 1 - progress,
    recoveryMs: scaled,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REALISM-1 (task A) — per-weapon recoil "kick strength" multiplier.
//
// The existing WeaponSystem applies `weapon.recoil` (from the WEAPONS table
// in store.ts) as the recoil amount. Each weapon's pattern is normalized to
// the [0..~3] range; the `weapon.recoil` value scales it. This table is an
// optional per-weapon override that callers can layer on top of `weapon.recoil`
// to nudge a weapon's felt recoil up or down without retuning the pattern.
//
// Kept at 1.0 for every weapon by default — the patterns + weapon.recoil
// already produce the right feel. Provided as a tuning knob for the future.
// ─────────────────────────────────────────────────────────────────────────────
export const RECOIL_KICK_MULT: Record<WeaponType, number> = {
  ak74: 1.00, m4: 1.00, mp7: 1.00, p90: 1.00, usp: 1.00, deagle: 1.00,
  awp: 1.00, scout: 1.00, nova: 1.00, m249: 1.00,
  hk416: 1.00, famas: 1.00, aug: 1.00, scarh: 1.00, galil: 1.00,
  mk17: 1.00, mk14: 1.00, mp5: 1.00, ump45: 1.00, vector: 1.00,
  pp90m1: 1.00, glock18: 1.00, m1911: 1.00, revolver: 1.00,
  kar98k: 1.00, l115a3: 1.00, m1014: 1.00, spas12: 1.00,
  rpk: 1.00, mk48: 1.00,
};

/**
 * Get the per-weapon recoil kick multiplier. Defaults to 1.0 (no change).
 * Provided as a tuning knob — the orchestrator can multiply the existing
 * `weapon.recoil` value by this in WeaponSystem.tryShoot to apply a per-
 * weapon nudge on top of the pattern.
 */
export function getRecoilKickMult(weapon: WeaponType): number {
  return RECOIL_KICK_MULT[weapon] ?? 1.0;
}
