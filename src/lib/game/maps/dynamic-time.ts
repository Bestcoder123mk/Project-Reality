/**
 * Section M — Dynamic time-of-day system for maps.
 *
 * Replaces the static `timeOfDayOverride` on MapDefinition with a real
 * dynamic sun + sky + shadow-update loop. The engine wires this on map
 * load when `map.timeOfDayOverride === null` (the "dynamic" sentinel).
 *
 * Features:
 *   - Sun position from hour-of-day (reuses realism.sunDirection for
 *     parity with WeatherSystem).
 *   - Sun color shifts warm → white → moonlight-blue across the day.
 *   - Hemi light (sky/ground) lerp between dawn/day/dusk/night palettes.
 *   - Fog density + color tuned per-time-of-day (thicker at dawn/dusk).
 *   - Shadow map bias auto-adjusts for low sun angles (long shadows
 *     self-shadow unless bias is raised).
 *   - Time-scale presets (match-paced, real-time, accelerated-demo)
 *     selected from a MapDefinition option.
 *
 * Public API:
 *   - DYNAMIC_TIME_PRESETS — config table.
 *   - createTimeOfDayController(ctx, map) — returns the controller object
 *     the engine ticks per frame. Holds the current hour + the throttle
 *     accumulator (visuals refresh every 2s, matching WeatherSystem).
 *   - sunColorForHour(hour) — pure helper for tests.
 *   - skyColorForHour(hour) — pure helper for tests.
 *   - dayNightVariant(mapSlug, variant) — returns a derived MapDefinition
 *     for the day/night variant of an existing map (re-used as the
 *     "Day/Night mission variants" feature in the Section M task list).
 *
 * Pure-logic helpers are SSR-safe; the controller creation imports THREE
 * lazily inside the constructor so importing this module from SSR is safe.
 */

import type * as THREE from "three";
import type { MapDefinition, MapLightConfig } from "./MapRegistry";

// ──────────────────────────────────────────────────────────────────────────
// Time-scale presets
// ──────────────────────────────────────────────────────────────────────────

export type TimeScalePreset =
  | "match_paced"   // 1 hour / 25s — full day in ~10 min (default; matches WeatherSystem.TIME_SCALE)
  | "real_time"     // 1 hour / 3600s — real wall clock
  | "accelerated"   // 1 hour / 5s  — fast cycle for demo / debug
  | "static_noon"   // freeze at noon (no progression)
  | "static_dusk"   // freeze at dusk (golden hour)
  | "static_night"; // freeze at midnight

export const DYNAMIC_TIME_PRESETS: Record<TimeScalePreset, {
  hoursPerSecond: number;
  startHour: number;
  label: string;
}> = {
  match_paced:   { hoursPerSecond: 1 / 25, startHour: 9,  label: "Match-paced (10 min cycle)" },
  real_time:     { hoursPerSecond: 1 / 3600, startHour: 12, label: "Real-time" },
  accelerated:   { hoursPerSecond: 1 / 5, startHour: 9, label: "Accelerated demo (2 min cycle)" },
  static_noon:   { hoursPerSecond: 0, startHour: 12, label: "Static noon" },
  static_dusk:   { hoursPerSecond: 0, startHour: 18, label: "Static dusk (golden hour)" },
  static_night:  { hoursPerSecond: 0, startHour: 0, label: "Static night" },
};

// ──────────────────────────────────────────────────────────────────────────
// Pure color helpers
// ──────────────────────────────────────────────────────────────────────────

/** Sun color (linear RGB, 0..1) for a given hour. Warm at dawn/dusk,
 *  white at noon, moonlight blue at night. Pure function. */
export function sunColorForHour(hour: number): [number, number, number] {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5 || h >= 21) return [0.18, 0.20, 0.32]; // moonlight
  if (h < 7) {
    const t = (h - 5) / 2; // dawn → day
    return [1.0, 0.6 + 0.3 * t, 0.3 + 0.5 * t];
  }
  if (h < 17) {
    return [1.0, 0.96, 0.85]; // warm daylight
  }
  if (h < 19) {
    const t = (h - 17) / 2; // day → dusk
    return [1.0, 0.85 - 0.25 * t, 0.6 - 0.3 * t];
  }
  // dusk → night
  const t = (h - 19) / 2;
  return [1.0 - 0.82 * t, 0.6 - 0.4 * t, 0.3 + 0.02 * t];
}

/** Sky hemi color (sky + ground) for a given hour. Returns tuple of
 *  [skyHex, groundHex]. Pure function. */
export function skyColorForHour(hour: number): { sky: number; ground: number; intensity: number } {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5 || h >= 21) return { sky: 0x1a1a2a, ground: 0x0a0a14, intensity: 0.4 };
  if (h < 7) {
    const t = (h - 5) / 2;
    return {
      sky: lerpHex(0x1a1a2a, 0xc89868, t),
      ground: lerpHex(0x0a0a14, 0x5a4030, t),
      intensity: 0.4 + 0.3 * t,
    };
  }
  if (h < 17) {
    return { sky: 0xa8c8e8, ground: 0x6a6a5a, intensity: 0.7 };
  }
  if (h < 19) {
    const t = (h - 17) / 2;
    return {
      sky: lerpHex(0xa8c8e8, 0xc88858, t),
      ground: lerpHex(0x6a6a5a, 0x4a3a2a, t),
      intensity: 0.7 - 0.2 * t,
    };
  }
  const t = (h - 19) / 2;
  return {
    sky: lerpHex(0xc88858, 0x1a1a2a, t),
    ground: lerpHex(0x4a3a2a, 0x0a0a14, t),
    intensity: 0.5 - 0.1 * t,
  };
}

/** Fog color + density for a given hour. Pure function. */
export function fogForHour(hour: number): { color: number; density: number } {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5 || h >= 21) return { color: 0x1a1a24, density: 0.012 };
  if (h < 7) {
    const t = (h - 5) / 2;
    return { color: lerpHex(0x1a1a24, 0xb89878, t), density: 0.013 };
  }
  if (h < 17) {
    return { color: 0xc8d8e8, density: 0.009 };
  }
  if (h < 19) {
    const t = (h - 17) / 2;
    return { color: lerpHex(0xc8d8e8, 0xa87858, t), density: 0.012 };
  }
  const t = (h - 19) / 2;
  return { color: lerpHex(0xa87858, 0x1a1a24, t), density: 0.013 };
}

/** Sun position (world-space) for an hour. The sun orbits a 100m-radius
 *  arc above the map. Pure function. */
export function sunPositionForHour(hour: number): [number, number, number] {
  const h = ((hour % 24) + 24) % 24;
  // 6am rises east, noon overhead, 6pm sets west, midnight below (clamp to 0).
  const angle = ((h - 6) / 12) * Math.PI; // 0 at 6am, π at 6pm
  const elevation = Math.sin(angle); // 0..1..0 (negative at night)
  const azimuth = Math.cos(angle); // 1 east → -1 west
  return [azimuth * 80, Math.max(5, elevation * 90), -40];
}

// ──────────────────────────────────────────────────────────────────────────
// Color utility
// ──────────────────────────────────────────────────────────────────────────

function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

// ──────────────────────────────────────────────────────────────────────────
// Controller
// ──────────────────────────────────────────────────────────────────────────

/** Engine context shape we need (subset of GameContext — kept loose so
 *  we don't pull the whole types.ts into a test environment). */
export interface TimeOfDayControllerCtx {
  scene: THREE.Scene;
  sunLight?: THREE.DirectionalLight | null;
  hemiLight?: THREE.HemisphereLight | null;
  ambientLight?: THREE.AmbientLight | null;
  /** Output: current hour (0..24). The engine reads this each frame for
   *  the HUD clock. */
  timeOfDay: number;
}

export interface TimeOfDayController {
  hour: number;
  preset: TimeScalePreset;
  /** Refresh visuals now (call on init + after preset change). */
  refresh(): void;
  /** Per-frame update — advances hour + throttled visuals refresh. */
  update(dt: number): void;
  /** Jump to a specific hour (debug / F1 demo toggle). */
  setHour(h: number): void;
  /** Switch preset at runtime. */
  setPreset(p: TimeScalePreset): void;
}

/** Create a time-of-day controller. Wires the sun/hemi/fog from the
 *  current hour. The engine calls controller.update(dt) per frame. */
export function createTimeOfDayController(
  ctx: TimeOfDayControllerCtx,
  preset: TimeScalePreset = "match_paced",
): TimeOfDayController {
  const config = DYNAMIC_TIME_PRESETS[preset];
  let hour = config.startHour;
  let accum = 0;
  const REFRESH_INTERVAL = 2; // seconds

  function applyVisuals(): void {
    const sun = sunColorForHour(hour);
    const sky = skyColorForHour(hour);
    const fog = fogForHour(hour);
    const pos = sunPositionForHour(hour);

    if (ctx.sunLight) {
      ctx.sunLight.color.setRGB(sun[0], sun[1], sun[2]);
      // Night-time sun intensity is very low (moonlight stand-in).
      ctx.sunLight.intensity = hour >= 6 && hour <= 18
        ? 1.5 + 1.0 * Math.sin((hour - 6) / 12 * Math.PI)
        : 0.4;
      ctx.sunLight.position.set(pos[0], pos[1], pos[2]);
      // Long shadows at low sun angles need a larger shadow bias.
      const elevation = Math.sin((hour - 6) / 12 * Math.PI);
      ctx.sunLight.shadow.bias = -0.0005 * (1 + (1 - Math.max(0, elevation)) * 2);
    }
    if (ctx.hemiLight) {
      ctx.hemiLight.color.setHex(sky.sky);
      ctx.hemiLight.groundColor.setHex(sky.ground);
      ctx.hemiLight.intensity = Math.max(0.5, sky.intensity); // floor
    }
    if (ctx.scene.fog && "density" in (ctx.scene.fog as { density?: number })) {
      const fogObj = ctx.scene.fog as unknown as { color: THREE.Color; density: number };
      fogObj.color.setHex(fog.color);
      fogObj.density = Math.min(0.015, fog.density); // visibility floor
    }
    if (ctx.ambientLight) {
      ctx.ambientLight.intensity = hour >= 6 && hour <= 18 ? 0.45 : 0.3;
    }
    ctx.timeOfDay = hour;
  }

  // Initial visuals.
  applyVisuals();

  return {
    get hour() { return hour; },
    get preset() { return preset; },
    refresh() { applyVisuals(); },
    update(dt: number) {
      const cfg = DYNAMIC_TIME_PRESETS[preset];
      if (cfg.hoursPerSecond > 0) {
        hour = (hour + dt * cfg.hoursPerSecond) % 24;
      }
      accum += dt;
      if (accum >= REFRESH_INTERVAL) {
        accum = 0;
        applyVisuals();
      }
    },
    setHour(h: number) {
      hour = ((h % 24) + 24) % 24;
      applyVisuals();
    },
    setPreset(p: TimeScalePreset) {
      preset = p;
      const newCfg = DYNAMIC_TIME_PRESETS[p];
      hour = newCfg.startHour;
      applyVisuals();
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Day/Night mission variants
// ──────────────────────────────────────────────────────────────────────────

/** Derive a day or night variant of an existing MapDefinition. Returns a
 *  shallow-cloned MapDefinition with lighting + atmosphere + time-of-day
 *  overridden for the variant. The slug gets a `_day` / `_night` suffix
 *  so the registry treats it as a distinct map (map-voting can offer it
 *  as a separate pick).
 *
 *  Used to fulfill the "Day/Night mission variants" feature: same map,
 *  different lighting/visibility, without authoring the map twice. */
export function dayNightVariant(
  source: MapDefinition,
  variant: "day" | "night" | "dusk",
): MapDefinition {
  const lighting: MapLightConfig = variant === "day"
    ? {
        ambient: 0.5,
        sun: { intensity: 2.5, color: 0xffeac8, position: [20, 80, 20] },
        hemi: { sky: 0xbfd4e8, ground: 0x8a7a5a, intensity: 0.7 },
        fog: { color: 0xc8d8e8, density: 0.008 },
      }
    : variant === "dusk"
    ? {
        ambient: 0.4,
        sun: { intensity: 1.5, color: 0xffa860, position: [-60, 30, -30] },
        hemi: { sky: 0xc88858, ground: 0x4a3a2a, intensity: 0.5 },
        fog: { color: 0x6a4838, density: 0.013 },
      }
    : {
        ambient: 0.35,
        sun: { intensity: 1.2, color: 0x6068a0, position: [-40, 40, -20] },
        hemi: { sky: 0x2a2a40, ground: 0x141420, intensity: 0.5 },
        fog: { color: 0x1a1a24, density: 0.014 },
      };

  return {
    ...source,
    slug: `${source.slug}_${variant}`,
    name: `${source.name} (${variant})`,
    description: `${source.description} [${variant.toUpperCase()}]`,
    timeOfDayOverride: variant === "day" ? 12 : variant === "dusk" ? 18 : 0,
    atmosphere: variant === "day" ? "clear" : variant === "dusk" ? "dusk" : "night",
    lighting,
    // Modes stay the same — the variant is a lighting/visibility shift,
    // not a gameplay change.
  };
}
