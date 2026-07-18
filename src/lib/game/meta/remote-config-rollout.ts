/**
 * SEC11-META — Remote Config feature rollout system.
 *
 * Drives server-controlled feature flags with staged rollout (0-100%),
 * audience targeting (cohort/segment), and kill-switch override. Players
 * are deterministically bucketed so the same player always sees the same
 * value within a rollout window.
 *
 * Designed to be hydrated from Firestore (`remoteConfig/{env}`) on app boot
 * and re-evaluated client-side without a network round-trip. Changes to
 * the config are versioned so analytics can correlate behavior to a
 * specific rollout generation.
 *
 * Public API:
 *   - `RemoteConfigRollout.get(key, ctx)` → typed config value
 *   - `RemoteConfigRollout.setActive(config)` → swap in a new doc
 *   - `RemoteConfigRollout.snapshot()` → immutable view (for dashboards)
 */

import { track } from "@/lib/analytics";

export type RolloutAudience = "all" | "new" | "returning" | "whale" | "founder";

export interface RolloutRule {
  key: string;
  enabled: boolean;
  /** 0..100 — percent of qualifying audience that receives the variant. */
  rollout: number;
  audiences: RolloutAudience[];
  /** Default value when player is not bucketed in. */
  defaultValue: unknown;
  /** Variant value when player is bucketed in. */
  variantValue: unknown;
  /** Optional override for specific player ids (always wins). */
  allowList?: string[];
  /** Force-disable for these players (kill-switch per-player). */
  denyList?: string[];
  /** Monotonic generation counter — bumps on every edit. */
  generation: number;
}

export interface RemoteConfigDoc {
  env: string;
  version: string;
  rules: Record<string, RolloutRule>;
  updatedAt: string;
}

export interface EvalContext {
  playerId: string;
  audience: RolloutAudience;
  /** Optional explicit override (server-side A/B assignment). */
  forceVariant?: boolean;
}

export interface EvalResult {
  key: string;
  value: unknown;
  bucketed: boolean;
  generation: number;
  reason: "allow" | "deny" | "audience" | "rollout" | "force" | "disabled";
}

/** FNV-1a hash → 0..99 integer bucket. Deterministic per (key, playerId). */
function bucket(hashSeed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < hashSeed.length; i++) {
    h ^= hashSeed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 100;
}

export class RemoteConfigRollout {
  private active: RemoteConfigDoc | null = null;
  private readonly listeners = new Set<(doc: RemoteConfigDoc) => void>();

  /** Replace the active config (typically from a Firestore snapshot). */
  setActive(doc: RemoteConfigDoc): void {
    this.active = doc;
    for (const fn of this.listeners) fn(doc);
  }

  /** Subscribe to config swaps. Returns an unsubscribe fn. */
  subscribe(fn: (doc: RemoteConfigDoc) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Evaluate a single key for the given player context. */
  get<T = unknown>(key: string, ctx: EvalContext): T {
    const rule = this.active?.rules[key];
    if (!rule) return undefined as T;
    const result = this.evaluate(rule, ctx);
    if (result.bucketed) {
      void track("screen_view", { rc_key: key, rc_gen: rule.generation });
    }
    return result.value as T;
  }

  evaluate(rule: RolloutRule, ctx: EvalContext): EvalResult {
    if (!rule.enabled) {
      return { key: rule.key, value: rule.defaultValue, bucketed: false, generation: rule.generation, reason: "disabled" };
    }
    if (rule.denyList?.includes(ctx.playerId)) {
      return { key: rule.key, value: rule.defaultValue, bucketed: false, generation: rule.generation, reason: "deny" };
    }
    if (rule.allowList?.includes(ctx.playerId) || ctx.forceVariant) {
      return { key: rule.key, value: rule.variantValue, bucketed: true, generation: rule.generation, reason: "allow" };
    }
    if (!rule.audiences.includes("all") && !rule.audiences.includes(ctx.audience)) {
      return { key: rule.key, value: rule.defaultValue, bucketed: false, generation: rule.generation, reason: "audience" };
    }
    const b = bucket(`${rule.key}:${ctx.playerId}`);
    const bucketed = b < rule.rollout;
    return {
      key: rule.key,
      value: bucketed ? rule.variantValue : rule.defaultValue,
      bucketed,
      generation: rule.generation,
      reason: bucketed ? "rollout" : "force",
    };
  }

  snapshot(): Readonly<RemoteConfigDoc> | null {
    return this.active ? Object.freeze(JSON.parse(JSON.stringify(this.active))) : null;
  }
}

/** Singleton used by client + server entry points. */
export const remoteConfig = new RemoteConfigRollout();
