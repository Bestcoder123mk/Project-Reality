/**
 * Prompt J-4021 / J-4087 / J-4187 — loading tips.
 *
 * A rotating pool of tactical tips shown on loading screens (map load,
 * match countdown, pack-opening spinner). The tips are short, single-
 * sentence, action-oriented — designed to teach a mechanic in the
 * ~3-5s the player spends on a loading screen.
 *
 * Public API:
 *   - `LOADING_TIPS` — the canonical tip pool (English source of truth).
 *   - `getRandomTip(seed?)` — pick a random tip (seeded for deterministic
 *     tests; falls back to Math.random).
 *   - `getTipForContext(context)` — pick a tip relevant to the loading
 *     context (e.g. "map" → map-specific tips, "pack" → economy tips).
 *
 * The TutorialScreen + OnboardingOverlay already cover the long-form
 * teaching; this module is the micro-tip layer for the loading beats.
 */

export type LoadingTipCategory =
  | "movement"
  | "weapons"
  | "tactics"
  | "medical"
  | "economy"
  | "hud"
  | "accessibility"
  | "map"
  | "pack";

export interface LoadingTip {
  /** Stable slug for telemetry / dedupe. */
  slug: string;
  /** Short single-sentence tip body. */
  body: string;
  /** Category for context-aware selection. */
  category: LoadingTipCategory;
}

export const LOADING_TIPS: LoadingTip[] = [
  // Movement
  { slug: "move.sprint", body: "Hold Shift to sprint — but you can't fire while sprinting. Plan your route.", category: "movement" },
  { slug: "move.slide", body: "Crouch while sprinting to slide into cover. Momentum preserves into the slide.", category: "movement" },
  { slug: "move.lean", body: "Press Q/E to lean around corners without exposing your body. Use it to peek angles.", category: "movement" },
  // Weapons
  { slug: "wpn.recoil", body: "Recoil climbs vertically — pull down slightly to keep rounds on target.", category: "weapons" },
  { slug: "wpn.tap", body: "At long range, tap-fire instead of full-auto. Each shot resets the recoil pattern.", category: "weapons" },
  { slug: "wpn.switch", body: "Mouse wheel or Q/E switches weapons instantly. Have a sidearm ready for close quarters.", category: "weapons" },
  // Tactics
  { slug: "tac.flank", body: "Suppression narrows the enemy's audible range. Use covering fire to flank unheard.", category: "tactics" },
  { slug: "tac.cover", body: "Wooden cover stops bullets for ~2 rounds. Concrete is hard cover — use it.", category: "tactics" },
  { slug: "tac.smoke", body: "Smoke grenades block line-of-sight for 20s. Pop one before reviving a teammate.", category: "tactics" },
  // Medical
  { slug: "med.bleed", body: "Bleeding drains HP until bandaged. Press H to apply — stay still during the channel.", category: "medical" },
  { slug: "med.fracture", body: "Fractures slow movement. Press J for a splint — it's faster than a medkit.", category: "medical" },
  { slug: "med.revive", body: "Epinephrine (L) revives a downed teammate from a distance. Save one for emergencies.", category: "medical" },
  // Economy
  { slug: "eco.credits", body: "Credits are earned from kills, wave clears, and match completion. Save for a primary first.", category: "economy" },
  { slug: "eco.packs", body: "Packs are random — the Legendary crate guarantees an Epic+, but Elite has better value/credit.", category: "economy" },
  { slug: "eco.refund", body: "Duplicate pack items refund 30% of their credit value. Don't hoard duplicates.", category: "economy" },
  // HUD
  { slug: "hud.minimap", body: "The minimap rotates with you — North on the map is your forward direction.", category: "hud" },
  { slug: "hud.compass", body: "The compass strip shows cardinal bearings — call out contacts by bearing, not by feel.", category: "hud" },
  { slug: "hud.killfeed", body: "Click 'History' on the kill feed to review past kills — useful after a multi-kill chain.", category: "hud" },
  // Accessibility
  { slug: "acc.colorblind", body: "Colorblind modes re-test every HUD color for ΔE ≥ 15. Find your mode in Settings → Accessibility.", category: "accessibility" },
  { slug: "acc.subtitles", body: "Subtitles cover all audio cues, not just VO. Toggle in Settings → Accessibility.", category: "accessibility" },
  { slug: "acc.aimassist", body: "Gamepad aim-assist only kicks in when the controller is active — set it down to use mouse cleanly.", category: "accessibility" },
  // Map
  { slug: "map.sightlines", body: "Long sightlines favor snipers; tight corridors favor SMGs. Pick your primary to match the map.", category: "map" },
  { slug: "map.weather", body: "Rain muffles audio + adds fog. Adapt by leaning on visual cues + the minimap.", category: "map" },
  { slug: "map.night", body: "Night matches shift to moonlight. Equip a sight with night-vision capability when available.", category: "map" },
  // Pack
  { slug: "pack.odds", body: "Every pack's drop odds are visible before you buy — click 'Show odds' to see the weighted table.", category: "pack" },
  { slug: "pack.shark", body: "The shark charm + finisher are only in the Legendary crate at ~12% odds. No real-money purchase required.", category: "pack" },
];

/** Pick a random tip. Pass a `seed` for deterministic selection (tests). */
export function getRandomTip(seed?: number): LoadingTip {
  const idx = seed != null
    ? Math.abs(Math.floor(seed)) % LOADING_TIPS.length
    : Math.floor(Math.random() * LOADING_TIPS.length);
  return LOADING_TIPS[idx];
}

/** Pick a tip relevant to the loading context. Falls back to any tip. */
export function getTipForContext(context: LoadingTipCategory): LoadingTip {
  const matching = LOADING_TIPS.filter((t) => t.category === context);
  if (matching.length === 0) return getRandomTip();
  return matching[Math.floor(Math.random() * matching.length)];
}

/** All categories — useful for the SettingsPanel "tip rotation" picker
 *  (lets the player disable categories they don't want to see). */
export const LOADING_TIP_CATEGORIES: LoadingTipCategory[] = [
  "movement", "weapons", "tactics", "medical", "economy",
  "hud", "accessibility", "map", "pack",
];
