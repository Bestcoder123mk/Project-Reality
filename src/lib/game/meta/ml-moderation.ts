/**
 * SEC11-META — ML Kit content moderation for user-generated content.
 *
 * Wraps the ML Kit Language / Toxicity classifier (server-side via the
 * `@google-cloud/contentwarehouse` family, or client-side via the on-device
 * ML Kit JS bindings when running on a hybrid native shell). Provides a
 * single `moderate()` entry point that returns a verdict + per-category
 * scores so the caller can either block, shadow-ban, or surface a warning.
 *
 * Categories align with Perspective API labels so models are swappable
 * without changing downstream code. The classifier is invoked through a
 * `/api/moderation/classify` route so the model secret never ships to the
 * client.
 *
 * Public API:
 *   - `MLModerator.moderate(text, opts)` → ModerationResult
 *   - `MLModerator.moderateBatch(items)` → array of results
 *   - `MLModerator.shouldBlock(result, threshold)` → boolean
 */

export type ModerationCategory =
  | "toxicity"
  | "severe_toxicity"
  | "identity_attack"
  | "insult"
  | "profanity"
  | "threat"
  | "sexual_explicit";

export type ModerationVerdict = "allow" | "review" | "block";

export interface ModerationResult {
  text: string;
  scores: Partial<Record<ModerationCategory, number>>;
  verdict: ModerationVerdict;
  language: string;
  modelVersion: string;
  evaluatedAt: string;
}

export interface ModerationOptions {
  /** Override default block threshold (0..1). */
  blockThreshold?: number;
  /** Override default review threshold (0..1). */
  reviewThreshold?: number;
  /** Hint language (ISO 639-1). Auto-detect when omitted. */
  language?: string;
}

export interface ModerationItem {
  id: string;
  text: string;
  kind: "clan_name" | "clan_tag" | "chat_message" | "loadout_name" | "display_name";
}

const DEFAULT_BLOCK = 0.85;
const DEFAULT_REVIEW = 0.65;

export class MLModerator {
  private static endpoint = "/api/moderation/classify";
  private static modelVersion = "mlkit-toxicity-v3";

  /** Classify a single string. */
  static async moderate(text: string, opts: ModerationOptions = {}): Promise<ModerationResult> {
    const scores = await this.classify([text], opts.language);
    const verdict = this.verdictFor(scores[0], opts);
    return {
      text,
      scores: scores[0],
      verdict,
      language: opts.language ?? "auto",
      modelVersion: this.modelVersion,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /** Classify multiple items in one round-trip. */
  static async moderateBatch(items: ModerationItem[], opts: ModerationOptions = {}): Promise<Array<ModerationItem & { result: ModerationResult }>> {
    const texts = items.map((i) => i.text);
    const scores = await this.classify(texts, opts.language);
    return items.map((item, i) => ({
      ...item,
      result: {
        text: item.text,
        scores: scores[i],
        verdict: this.verdictFor(scores[i], opts),
        language: opts.language ?? "auto",
        modelVersion: this.modelVersion,
        evaluatedAt: new Date().toISOString(),
      },
    }));
  }

  /** Pure helper — no network. Useful for client-side pre-checks. */
  static shouldBlock(result: ModerationResult, threshold = DEFAULT_BLOCK): boolean {
    const max = Math.max(...Object.values(result.scores).map(Number));
    return max >= threshold;
  }

  private static verdictFor(scores: Partial<Record<ModerationCategory, number>>, opts: ModerationOptions): ModerationVerdict {
    const values = Object.values(scores).map(Number);
    const max = values.length ? Math.max(...values) : 0;
    const block = opts.blockThreshold ?? DEFAULT_BLOCK;
    const review = opts.reviewThreshold ?? DEFAULT_REVIEW;
    if (max >= block) return "block";
    if (max >= review) return "review";
    return "allow";
  }

  private static async classify(texts: string[], language?: string): Promise<Partial<Record<ModerationCategory, number>>[]> {
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts, language }),
      });
      if (!res.ok) return texts.map(() => ({}));
      const data = (await res.json()) as { scores: Partial<Record<ModerationCategory, number>>[] };
      return data.scores;
    } catch {
      return texts.map(() => ({}));
    }
  }
}

export const moderator = MLModerator;
