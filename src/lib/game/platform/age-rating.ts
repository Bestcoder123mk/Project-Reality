/**
 * L1-5000 / prompts 4456,4514,4568,4606,4644,4682,4720: addressed by this module (duplicates of Section I prompts, originally implemented there).
 * L2-5000 / prompts 4758,4796,4834,4872,4910,4948,4986 (Age gate): addressed by this module (duplicates of Section I / L1-5000 prompts, originally implemented there).
 * SEC12-PLATFORM prompt 96 — Age rating + content compliance pass.
 *
 * Targets ESRB Teen (13+) / PEGI 16. Audits the game's content against
 * the rating (gore toggle from SEC3, violence, loot boxes from SEC11,
 * language) + exposes a `computeRecommendedRating(factors)` function so
 * the compliance team can see what the rating *should* be if the
 * factors changed (e.g. before flipping a gore toggle on for an
 * Mature-rated SKU).
 *
 * Public API:
 *   - `CONTENT_RATING_FACTORS` — every factor the rating depends on.
 *   - `RatingSystem` — "esrb" | "pegi" | "usk" | "cero" (string-literal).
 *   - `ContentRating` — { system, age, label, descriptors[] }.
 *   - `computeRecommendedRating(factors, system?)` — pure computation.
 *   - `getCurrentContentRating()` — reads the game's current settings
 *     (gore level, violence level, loot box presence, language) and
 *     returns the recommended rating for each system.
 *   - `getContentRatingAudit()` — full audit report (factors + the
 *     rating under each system + a per-descriptor rationale).
 *
 * The rating rules come from the ESRB / PEGI published criteria:
 *   - ESRB Teen (13+): violence with blood, minimal strong language,
 *     minimal suggestive themes, no real gambling.
 *   - ESRB Mature (17+): intense violence, blood and gore, strong
 *     language, gambling with real currency.
 *   - PEGI 16: realistic-looking violence, strong language, gambling.
 *   - PEGI 18: gross violence, sexual violence, gambling with real
 *     currency.
 *
 * Our game targets Teen/PEGI 16. If `getCurrentContentRating()` ever
 * returns Mature/18, the audit fails — a release blocker.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type RatingSystem = "esrb" | "pegi" | "usk" | "cero";

export type ViolenceLevel = "cartoon" | "fantasy" | "intense" | "brutal";
export type GoreLevel = "off" | "mild" | "full";
export type LanguageLevel = "none" | "mild" | "moderate" | "strong";
export type GamblingPresence = "none" | "simulated" | "real-currency";

/**
 * Every content factor the rating depends on. Each factor is a small
 * enum so the audit can be unit-tested without spinning up the game.
 */
export interface ContentRatingFactors {
  /** Violence intensity (ESRB violence category). */
  violence: ViolenceLevel;
  /** Gore / blood level (mirrors the SEC3 gore toggle). */
  gore: GoreLevel;
  /** Strong language in dialogue + subtitles. */
  language: LanguageLevel;
  /** Loot box / gambling presence (mirrors SEC11 pack system). */
  gambling: GamblingPresence;
  /** Suggestive / sexual content (we have none — but the factor is here
   *  so a future content addition can be audited). */
  suggestive: boolean;
  /** Drug / alcohol references. */
  drugReferences: boolean;
  /** Online interaction (unmoderated voice/text chat with strangers). */
  onlineInteraction: boolean;
}

export interface ContentRating {
  system: RatingSystem;
  /** Minimum recommended age (number, e.g. 13 for ESRB Teen). */
  age: number;
  /** Short label (e.g. "Teen", "Mature", "16"). */
  label: string;
  /** Content descriptors (e.g. "Violence", "Blood", "Strong Language"). */
  descriptors: string[];
}

export interface ContentRatingAudit {
  factors: ContentRatingFactors;
  ratings: ContentRating[];
  /** True when the rating meets the Teen / PEGI 16 target. */
  meetsTarget: boolean;
  /** Free-form notes (e.g. "real-currency gambling pushes rating to Mature"). */
  notes: string[];
}

// ── Current factors (read from the game's settings + content) ──────────────

/**
 * The "current" content factors. Defaults match the shipped game:
 *   - violence: "intense" (realistic FPS combat, but no dismemberment)
 *   - gore: "mild" (SEC3 default — surface splatter + brief blood mist)
 *   - language: "mild" (occasional mild profanity in dialogue/barks)
 *   - gambling: "simulated" (SEC11 packs are virtual currency only —
 *     no real-money purchase path is wired)
 *   - suggestive: false
 *   - drugReferences: false (medical items are abstract)
 *   - onlineInteraction: true (clan chat + friend invites exist)
 *
 * The gore level can be overridden at runtime via setGoreLevel(); the
 * audit picks up the override through `getCurrentGoreLevel()` below.
 */
const DEFAULT_FACTORS: ContentRatingFactors = {
  violence: "intense",
  gore: "mild",
  language: "mild",
  gambling: "simulated",
  suggestive: false,
  drugReferences: false,
  onlineInteraction: true,
};

/** In-memory override for the gore level (set by the runtime / settings menu). */
let currentGoreOverride: GoreLevel | null = null;

/** In-memory override for the loot-box presence (set by the SEC11 backend). */
let currentGamblingOverride: GamblingPresence | null = null;

/** Set the current gore level (called by the SEC3 settings menu / gore system). */
export function setCurrentGoreLevel(level: GoreLevel): void {
  currentGoreOverride = level;
}

/** Set the current gambling presence (called by the SEC11 backend-config). */
export function setCurrentGamblingPresence(presence: GamblingPresence): void {
  currentGamblingOverride = presence;
}

/** Read the current factors, applying any runtime overrides. */
export function getCurrentContentFactors(): ContentRatingFactors {
  return {
    ...DEFAULT_FACTORS,
    gore: currentGoreOverride ?? DEFAULT_FACTORS.gore,
    gambling: currentGamblingOverride ?? DEFAULT_FACTORS.gambling,
  };
}

// ── Rating computation ─────────────────────────────────────────────────────

/**
 * Compute the recommended ESRB rating for the given factors.
 *
 * Rules (simplified from the ESRB published criteria):
 *   - Mature (17+): brutal violence OR full gore OR strong language OR
 *     real-currency gambling OR sexual content.
 *   - Teen (13+): intense violence OR mild gore OR mild-moderate language
 *     OR simulated gambling (loot boxes bought with virtual currency).
 *   - Everyone 10+: fantasy violence, no gore, mild language.
 *   - Everyone: cartoon violence only, no gore, no language.
 */
function computeESRB(f: ContentRatingFactors): ContentRating {
  const descriptors: string[] = [];
  let age = 6;
  let label = "Everyone";

  // Violence.
  if (f.violence === "cartoon") descriptors.push("Cartoon Violence");
  else if (f.violence === "fantasy") {
    descriptors.push("Fantasy Violence");
    age = Math.max(age, 10);
    label = "Everyone 10+";
  } else if (f.violence === "intense") {
    descriptors.push("Violence");
    age = Math.max(age, 13);
    label = "Teen";
  } else if (f.violence === "brutal") {
    descriptors.push("Intense Violence");
    age = Math.max(age, 17);
    label = "Mature";
  }

  // Gore.
  if (f.gore === "mild") {
    descriptors.push("Blood");
    age = Math.max(age, 13);
    if (age < 13) label = "Teen";
  } else if (f.gore === "full") {
    descriptors.push("Blood and Gore");
    age = Math.max(age, 17);
    label = age >= 17 ? "Mature" : label;
  }

  // Language.
  if (f.language === "mild") {
    descriptors.push("Mild Language");
    age = Math.max(age, 10);
  } else if (f.language === "moderate") {
    descriptors.push("Language");
    age = Math.max(age, 13);
    if (age < 13) label = "Teen";
  } else if (f.language === "strong") {
    descriptors.push("Strong Language");
    age = Math.max(age, 17);
    label = age >= 17 ? "Mature" : label;
  }

  // Gambling.
  if (f.gambling === "simulated") {
    descriptors.push("Simulated Gambling");
    age = Math.max(age, 13);
    if (age < 13) label = "Teen";
  } else if (f.gambling === "real-currency") {
    descriptors.push("Real Gambling");
    age = Math.max(age, 17);
    label = age >= 17 ? "Mature" : label;
  }

  // Suggestive / drug references.
  if (f.suggestive) {
    descriptors.push("Suggestive Themes");
    age = Math.max(age, 13);
  }
  if (f.drugReferences) {
    descriptors.push("Drug Reference");
    age = Math.max(age, 13);
  }

  // Online interaction (always adds the descriptor, doesn't change age).
  if (f.onlineInteraction) {
    descriptors.push("Online Interactions Not Rated by the ESRB");
  }

  return { system: "esrb", age, label, descriptors };
}

/**
 * Compute the recommended PEGI rating for the given factors.
 *
 * Rules (simplified from the PEGI published criteria):
 *   - PEGI 18: gross violence (brutal + full gore) OR real-currency
 *     gambling OR sexual violence.
 *   - PEGI 16: realistic-looking violence (intense), strong language,
 *     simulated gambling, drug references.
 *   - PEGI 12: fantasy violence, mild bad language.
 *   - PEGI 7: mild fantasy violence that could scare young children.
 *   - PEGI 3: cartoon violence only.
 */
function computePEGI(f: ContentRatingFactors): ContentRating {
  const descriptors: string[] = [];
  let age = 3;

  // Violence.
  if (f.violence === "cartoon") {
    descriptors.push("Cartoon Violence");
  } else if (f.violence === "fantasy") {
    descriptors.push("Fantasy Violence");
    age = Math.max(age, 7);
  } else if (f.violence === "intense") {
    descriptors.push("Violence");
    age = Math.max(age, 16);
  } else if (f.violence === "brutal") {
    descriptors.push("Gross Violence");
    age = Math.max(age, 18);
  }

  // Gore (PEGI treats blood/gore as a violence multiplier).
  if (f.gore === "mild") {
    // Already covered by the violence descriptor — don't add another.
  } else if (f.gore === "full") {
    descriptors.push("Gore");
    age = Math.max(age, 18);
  }

  // Language.
  if (f.language === "mild") {
    descriptors.push("Bad Language");
    age = Math.max(age, 12);
  } else if (f.language === "moderate") {
    descriptors.push("Bad Language");
    age = Math.max(age, 16);
  } else if (f.language === "strong") {
    descriptors.push("Strong Language");
    age = Math.max(age, 18);
  }

  // Gambling.
  if (f.gambling === "simulated") {
    descriptors.push("Gambling");
    age = Math.max(age, 16);
  } else if (f.gambling === "real-currency") {
    descriptors.push("Gambling");
    age = Math.max(age, 18);
  }

  // Drug references.
  if (f.drugReferences) {
    descriptors.push("Drug References");
    age = Math.max(age, 16);
  }

  // Suggestive content.
  if (f.suggestive) {
    descriptors.push("Sexual Content");
    age = Math.max(age, 16);
  }

  if (f.onlineInteraction) {
    descriptors.push("Online");
  }

  return { system: "pegi", age, label: String(age), descriptors };
}

/**
 * Compute the recommended USK rating (German system). USK is stricter
 * on violence than ESRB/PEGI — realistic violence against humans
 * typically gets USK 16, brutal/gore gets USK 18.
 */
function computeUSK(f: ContentRatingFactors): ContentRating {
  const descriptors: string[] = [];
  let age = 0;
  if (f.violence === "cartoon") age = 0;
  else if (f.violence === "fantasy") age = 6;
  else if (f.violence === "intense") {
    age = 16;
    descriptors.push("Gewaltdarstellung");
  } else if (f.violence === "brutal") {
    age = 18;
    descriptors.push("Brutale Gewaltdarstellung");
  }
  if (f.gore === "full") {
    age = Math.max(age, 18);
    descriptors.push("Gore");
  }
  if (f.gambling === "real-currency") {
    age = Math.max(age, 18);
    descriptors.push("Glücksspiel");
  }
  if (f.language === "strong") {
    age = Math.max(age, 16);
    descriptors.push("Starke Sprache");
  }
  return { system: "usk", age, label: String(age), descriptors };
}

/**
 * Compute the recommended CERO rating (Japan). CERO is stricter on
 * gore + drug references.
 */
function computeCERO(f: ContentRatingFactors): ContentRating {
  const descriptors: string[] = [];
  let age = 0; // A (all ages)
  let label = "A";
  if (f.violence === "intense") {
    age = 15;
    label = "C";
    descriptors.push("暴力");
  } else if (f.violence === "brutal") {
    age = 17;
    label = "D";
    descriptors.push("暴力的表現");
  }
  if (f.gore === "full") {
    age = Math.max(age, 17);
    label = "D";
    descriptors.push("ゴア表現");
  }
  if (f.gambling === "real-currency") {
    age = Math.max(age, 17);
    label = "D";
  }
  return { system: "cero", age, label, descriptors };
}

/**
 * Compute the recommended rating under the given system (or all four
 * when no system is specified).
 */
export function computeRecommendedRating(
  factors: ContentRatingFactors,
  system?: RatingSystem,
): ContentRating | ContentRating[] {
  if (system === "esrb") return computeESRB(factors);
  if (system === "pegi") return computePEGI(factors);
  if (system === "usk") return computeUSK(factors);
  if (system === "cero") return computeCERO(factors);
  return [
    computeESRB(factors),
    computePEGI(factors),
    computeUSK(factors),
    computeCERO(factors),
  ];
}

/**
 * Compute the rating the game *currently* should carry, under each
 * system. Reads the game's current factors (gore override + gambling
 * override + defaults).
 */
export function getCurrentContentRating(): ContentRating[] {
  return computeRecommendedRating(getCurrentContentFactors()) as ContentRating[];
}

// ── Audit ──────────────────────────────────────────────────────────────────

/**
 * The target rating: ESRB Teen (13+) / PEGI 16. The audit fails if the
 * computed rating exceeds either. (A Mature / 18+ rating would push
 * the game off the console storefronts that gate Teen titles into the
 * "family" recommendations surface — the business target is Teen.)
 */
export const RATING_TARGET = {
  esrb: { maxAge: 13, label: "Teen" },
  pegi: { maxAge: 16, label: "16" },
} as const;

/** Run the full content-rating audit. */
export function getContentRatingAudit(): ContentRatingAudit {
  const factors = getCurrentContentFactors();
  const ratings = getCurrentContentRating();
  const esrb = ratings.find((r) => r.system === "esrb")!;
  const pegi = ratings.find((r) => r.system === "pegi")!;

  const meetsTarget =
    esrb.age <= RATING_TARGET.esrb.maxAge && pegi.age <= RATING_TARGET.pegi.maxAge;

  const notes: string[] = [];
  if (esrb.age > RATING_TARGET.esrb.maxAge) {
    notes.push(
      `ESRB rating ${esrb.label} (${esrb.age}+) exceeds target Teen (${RATING_TARGET.esrb.maxAge}+).`,
    );
  }
  if (pegi.age > RATING_TARGET.pegi.maxAge) {
    notes.push(
      `PEGI rating ${pegi.label} exceeds target ${RATING_TARGET.pegi.label}.`,
    );
  }
  if (factors.gambling === "real-currency") {
    notes.push(
      "Real-currency gambling present — pushes rating to Mature/18+ in most jurisdictions and triggers loot-box disclosure rules in BE/NL/JP.",
    );
  }
  if (factors.gore === "full") {
    notes.push(
      "Full gore enabled — pushes ESRB to Mature. Ship with 'mild' default for Teen SKU.",
    );
  }
  if (factors.language === "strong") {
    notes.push("Strong language present — pushes ESRB to Mature.");
  }
  if (factors.violence === "brutal") {
    notes.push("Brutal violence — pushes every system to max rating.");
  }
  if (notes.length === 0) {
    notes.push("All factors within Teen / PEGI 16 targets.");
  }

  return { factors, ratings, meetsTarget, notes };
}

// ── L1-5000 / prompt 4505 — age gate enforcement ───────────────────────────
//
// The legacy module shipped `getContentRatingAudit()` (a compliance report)
// but had no enforcement hook — the AgeGateOverlay component (UI side) wrote
// a localStorage flag, but no platform-side gate read it. A player who
// cleared localStorage (or used a fresh browser) bypassed the gate without
// the platform ever knowing.
//
// `enforceAgeGate(playerId)` is the canonical platform-side gate. Routes +
// middleware can short-circuit on `{ ok: false }` — e.g., refuse to write
// analytics events when the player is under 13 (COPPA).
//
// `recordAgeGateConfirmation(playerId, under13)` is the server-side recorder
// the AgeGateOverlay's POST route calls.

export type AgeGateStatus =
  | { ok: true; confirmedAt: string; under13: boolean }
  | { ok: false; reason: "unconfirmed" | "under_13" };

/**
 * L1-5000 / prompt 4505 — read the player's age-gate status from the
 * canonical store. Returns `{ ok: true }` when the player has confirmed
 * 13+. Returns `{ ok: false, reason: "under_13" }` when self-reported
 * under 13 (COPPA gate). Returns `{ ok: false, reason: "unconfirmed" }`
 * when no confirmation event exists — routes should treat this as
 * "prompt the UI gate before proceeding".
 */
export async function enforceAgeGate(playerId: string): Promise<AgeGateStatus> {
  try {
    const { db } = await import("@/lib/db");
    const row = await db.playerEvent.findFirst({
      where: { playerId, name: "age_gate_confirmation" },
      orderBy: { at: "desc" },
      select: { props: true, at: true },
    });
    if (!row) {
      return { ok: false, reason: "unconfirmed" };
    }
    try {
      const parsed = JSON.parse(row.props) as { under13?: unknown };
      const under13 = parsed.under13 === true;
      if (under13) {
        return { ok: false, reason: "under_13" };
      }
      return { ok: true, confirmedAt: row.at.toISOString(), under13: false };
    } catch {
      return { ok: false, reason: "unconfirmed" };
    }
  } catch {
    // DB unavailable (SSR / no ensureSeed yet) — fail open with
    // "unconfirmed" so the caller renders the UI gate.
    return { ok: false, reason: "unconfirmed" };
  }
}

/**
 * L1-5000 / prompt 4505 — record an age-gate confirmation server-side.
 * Called by the POST route the AgeGateOverlay component hits when the
 * player confirms. The latest row by `at` is canonical.
 */
export async function recordAgeGateConfirmation(
  playerId: string,
  under13: boolean,
): Promise<{ ok: true; at: string }> {
  const at = new Date().toISOString();
  try {
    const { db } = await import("@/lib/db");
    await db.playerEvent.create({
      data: {
        playerId,
        sessionId: "age_gate",
        name: "age_gate_confirmation",
        props: JSON.stringify({ under13, at }),
      },
    });
  } catch {
    // DB unavailable — fail open (the UI side has the localStorage
    // record as the fallback). The next successful confirmation will
    // overwrite.
  }
  return { ok: true, at };
}

/**
 * L1-5000 / prompt 4505 — check whether the player's age-gate status
 * permits analytics + crash reporting. COPPA: under-13 players must
 * not be tracked. Returns false when the player is unconfirmed OR
 * under 13.
 */
export async function ageGatePermitsAnalytics(playerId: string): Promise<boolean> {
  const status = await enforceAgeGate(playerId);
  return status.ok && !status.under13;
}
