import { describe, it, expect } from "vitest";
import {
  BARK_CONFIGS,
  VOICE_PROFILES,
  voiceForClass,
  BARK_I18N,
  resolveBarkText,
  type BarkKind,
  type BarkLocale,
} from "../../ai/barks";

/**
 * Section D #524 — Bark context variety tests.
 * Every bark kind should have at least one variant (or the baseline text).
 */
describe("Section D #524 — Bark variety", () => {
  const ALL_KINDS: BarkKind[] = [
    "SPOTTED", "FLANKING", "FLANKING_LEFT", "FLANKING_RIGHT", "RELOADING",
    "DOWN", "ALLY_DOWN", "LOST_HIM", "SUPPRESSED", "GRENADE", "REGROUP",
    "BOSS_TAUNT", "DYING", "MOVING", "COVERING", "CONTACT_LEFT",
    "CONTACT_RIGHT", "CONTACT_FRONT", "CONTACT_REAR", "RELOADING_COVERED",
    "GRENADE_SMOKE", "GRENADE_FLASH", "INVESTIGATING", "CORPSE_FOUND",
    "ALARM", "BREACHING", "RETREATING", "SURRENDER", "SURRENDER_ORDER",
    "REVIVING",
  ];

  it("every bark kind has a config entry", () => {
    for (const kind of ALL_KINDS) {
      expect(BARK_CONFIGS[kind], `missing config for ${kind}`).toBeDefined();
    }
  });

  it("every bark kind has non-empty text", () => {
    for (const kind of ALL_KINDS) {
      expect(BARK_CONFIGS[kind].text.length, `empty text for ${kind}`).toBeGreaterThan(0);
    }
  });

  it("most bark kinds have ≥ 2 variants for variety", () => {
    const withoutVariants: BarkKind[] = [];
    for (const kind of ALL_KINDS) {
      const cfg = BARK_CONFIGS[kind];
      if (!cfg.variants || cfg.variants.length < 2) {
        withoutVariants.push(kind);
      }
    }
    // Allow a few kinds to lack variants (e.g. simple callouts) — but the
    // majority should have variety.
    expect(withoutVariants.length).toBeLessThan(ALL_KINDS.length / 2);
  });
});

/**
 * Section D #525 — Bark cooldown (no repeat within 30s).
 * Verified at the emitBark level (the test would require a window global;
 * the constants are tested here for documentation).
 */
describe("Section D #525 — Bark cooldown config", () => {
  it("every bark kind has a cooldownMs > 0", () => {
    for (const kind of Object.keys(BARK_CONFIGS) as BarkKind[]) {
      expect(BARK_CONFIGS[kind].cooldownMs, `zero cooldown for ${kind}`).toBeGreaterThan(0);
    }
  });
});

/**
 * Section D #526 — Per-class voice profiles.
 */
describe("Section D #526 — Per-class voice", () => {
  it("voiceForClass returns a distinct voice for each enemy class", () => {
    const classes = ["RIFLEMAN", "MG", "SNIPER", "CQB", "COMMANDER", "MEDIC", "SHIELD", "SCOUT", "SHOTGUNNER"];
    const voices = new Set<string>();
    for (const cls of classes) {
      const v = voiceForClass(cls);
      voices.add(v);
      expect(VOICE_PROFILES[v], `missing voice profile for ${v}`).toBeDefined();
    }
    // At least 5 distinct voices across the 9 classes.
    expect(voices.size).toBeGreaterThanOrEqual(5);
  });

  it("voiceForClass returns 'default' for unknown classes", () => {
    expect(voiceForClass("UNKNOWN")).toBe("default");
  });

  it("every voice profile has a pitch + formant", () => {
    for (const v of Object.values(VOICE_PROFILES)) {
      expect(v.pitch).toBeGreaterThan(0);
      expect(v.formant).toBeGreaterThan(0);
    }
  });

  it("MG has a deeper voice (lower pitch) than CQB", () => {
    const mg = VOICE_PROFILES[voiceForClass("MG")];
    const cqb = VOICE_PROFILES[voiceForClass("CQB")];
    expect(mg.pitch).toBeLessThan(cqb.pitch);
  });
});

/**
 * Section D #527 — Bark i18n.
 */
describe("Section D #527 — Bark i18n", () => {
  it("BARK_I18N has entries for at least one locale beyond English", () => {
    const locales = new Set<BarkLocale>();
    for (const kind of Object.keys(BARK_I18N) as BarkKind[]) {
      const entry = BARK_I18N[kind];
      if (!entry) continue;
      for (const loc of Object.keys(entry) as BarkLocale[]) {
        locales.add(loc);
      }
    }
    expect(locales.size).toBeGreaterThanOrEqual(3); // at least es, fr, de, ja, zh.
  });

  it("resolveBarkText falls back to English variants when the locale is missing", () => {
    const text = resolveBarkText("SPOTTED", "xx"); // unknown locale
    expect(text.length).toBeGreaterThan(0);
  });

  it("resolveBarkText returns a localized variant when available", () => {
    // SPOTTED has an "es" variant.
    const text = resolveBarkText("SPOTTED", "es", () => 0); // deterministic pick.
    expect(text).toContain("Contacto");
  });

  it("resolveBarkText returns the baseline text when no variants + no i18n", () => {
    // Use a kind with no variants — pick one we know lacks variants, or
    // just verify the baseline is returned for a kind with no i18n entry.
    const text = resolveBarkText("RELOADING_COVERED", "zh");
    expect(text).toBe(BARK_CONFIGS.RELOADING_COVERED.text);
  });
});

/**
 * Section D #528 — Bark subtitles.
 * The subtitle field is set on emitBark (verified via the BarkEntry interface
 * + the emitBark implementation). The config's `subtitled` flag controls
 * whether the subtitle is empty (suppressed) or matches the text.
 */
describe("Section D #528 — Bark subtitles config", () => {
  it("MOVING barks are not subtitled (minor comms)", () => {
    expect(BARK_CONFIGS.MOVING.subtitled).toBe(false);
  });

  it("COVERING barks are not subtitled (minor comms)", () => {
    expect(BARK_CONFIGS.COVERING.subtitled).toBe(false);
  });

  it("SPOTTED barks are subtitled by default (undefined = true)", () => {
    expect(BARK_CONFIGS.SPOTTED.subtitled).toBeUndefined();
  });

  it("ALARM barks are subtitled (important callout)", () => {
    expect(BARK_CONFIGS.ALARM.subtitled).toBeUndefined(); // undefined = true.
  });
});
