/**
 * Realism systems config — ballistics materials, medical items, weather, audio.
 * Mirrors the DB seed data so the engine can run without a live fetch on every shot.
 * Fetched once at match start from the API and cached.
 */

export interface BallisticsMaterial {
  slug: string;
  name: string;
  density: number; // kg/m^3
  thickness: number; // m
  penetration: number; // 0..1 resistance
  bulletStop: boolean;
  color: string;
}

/** Default material table (used until API data loads). Matches seed. */
export const DEFAULT_MATERIALS: BallisticsMaterial[] = [
  { slug: "drywall", name: "Drywall", density: 600, thickness: 0.10, penetration: 0.15, bulletStop: false, color: "#d8d4c8" },
  { slug: "wood", name: "Wood", density: 700, thickness: 0.12, penetration: 0.25, bulletStop: false, color: "#8a5a2b" },
  { slug: "sheet_metal", name: "Sheet Metal", density: 7850, thickness: 0.03, penetration: 0.45, bulletStop: false, color: "#b0b0b8" },
  { slug: "brick", name: "Brick", density: 1900, thickness: 0.15, penetration: 0.55, bulletStop: false, color: "#7a4a3a" },
  { slug: "sandbag", name: "Sandbag", density: 1600, thickness: 0.30, penetration: 0.35, bulletStop: false, color: "#c9b08a" },
  { slug: "glass", name: "Glass", density: 2500, thickness: 0.02, penetration: 0.05, bulletStop: false, color: "#b8d4e8" },
  { slug: "foliage", name: "Foliage", density: 300, thickness: 0.50, penetration: 0.02, bulletStop: false, color: "#4a7a3a" },
  { slug: "earth", name: "Earth", density: 1800, thickness: 0.50, penetration: 0.70, bulletStop: false, color: "#6a5a3a" },
  { slug: "concrete", name: "Concrete", density: 2400, thickness: 0.20, penetration: 0.85, bulletStop: false, color: "#6b6b6b" },
  { slug: "steel_plate", name: "Steel Plate", density: 7850, thickness: 0.10, penetration: 0.98, bulletStop: true, color: "#3a3a3e" },
];

/** Map level surface types to material slugs. The engine tags meshes with userData.material. */
export const SURFACE_MATERIAL_MAP: Record<string, string> = {
  wall: "concrete",
  building: "brick",
  crate: "wood",
  cover: "sandbag",
  container: "sheet_metal",
  barrel: "sheet_metal",
  ground: "earth",
  default: "concrete",
};

/**
 * Compute residual velocity after penetrating a material.
 * Per R3.1: v_res = v_impact * (1 - k * density * thickness / (v_impact^2))
 * k is calibrated so that rifles penetrate wood but not concrete,
 * and pistols struggle with thick materials.
 * Returns { velocity, penetrated, deflection }.
 */
export function computePenetration(
  vImpact: number,
  material: BallisticsMaterial,
  caliberK = 1500
): { velocity: number; penetrated: boolean; deflection: number } {
  if (material.bulletStop) {
    return { velocity: 0, penetrated: false, deflection: 0 };
  }
  const v2 = vImpact * vImpact;
  const factor = 1 - (caliberK * material.density * material.thickness) / Math.max(v2, 1);
  const vRes = vImpact * Math.max(0, factor);
  // If residual velocity too low, bullet stops inside material
  if (vRes < vImpact * 0.25) {
    return { velocity: 0, penetrated: false, deflection: 0 };
  }
  // Small Gaussian deflection on exit
  const deflection = (Math.random() - 0.5) * 0.04 * material.penetration;
  return { velocity: vRes, penetrated: true, deflection };
}

/** Fetch materials from API (cached). */
let cachedMaterials: BallisticsMaterial[] | null = null;
export async function fetchMaterials(): Promise<BallisticsMaterial[]> {
  if (cachedMaterials) return cachedMaterials;
  try {
    const res = await fetch("/api/ballistics/materials");
    if (res.ok) {
      const data = await res.json();
      cachedMaterials = data.materials as BallisticsMaterial[];
      return cachedMaterials;
    }
  } catch {
    // fall through
  }
  cachedMaterials = DEFAULT_MATERIALS;
  return cachedMaterials;
}

export function getMaterialBySlug(slug: string, table: BallisticsMaterial[]): BallisticsMaterial {
  return table.find((m) => m.slug === slug) ?? table[0];
}

// ---------- Medical (R3.3) ----------

export type CasualtyState = "ACTIVE" | "BLEEDING" | "FRACTURED" | "UNCONSCIOUS";

export interface MedicalItemConfig {
  slug: string;
  name: string;
  type: "BANDAGE" | "SPLINT" | "EPINEPHRINE" | "MEDKIT";
  price: number;
  healAmount: number;
  useTime: number; // ms
  description: string;
}

export const DEFAULT_MEDICAL_ITEMS: MedicalItemConfig[] = [
  { slug: "bandage", name: "Bandage", type: "BANDAGE", price: 50, healAmount: 0, useTime: 4000, description: "Stops bleeding. Channelled 4s." },
  { slug: "splint", name: "Splint", type: "SPLINT", price: 100, healAmount: 0, useTime: 6000, description: "Repairs fracture. Channelled 6s." },
  { slug: "epi", name: "Epinephrine", type: "EPINEPHRINE", price: 200, healAmount: 0, useTime: 3000, description: "Revives from unconsciousness." },
  { slug: "medkit", name: "Field Medkit", type: "MEDKIT", price: 400, healAmount: 50, useTime: 8000, description: "Restores 50 HP. Channelled 8s." },
];

// ---------- Weather (R6.1) ----------

export interface WeatherState {
  timeOfDay: number; // 0..24 hours
  cloudCover: number; // 0..1
  precipitation: number; // 0..1 (0=none, 1=heavy)
  windSpeed: number; // 0..15 m/s
  windDirection: number; // radians
  fogDensity: number; // 0..1
  /** Task-3 — surface wetness 0..1. Derived from precipitation in
   *  WeatherSystem.update (lerps up when raining, decays back to 0 when
   *  not). Drives RendererSystem.updateWeatherVisuals to reduce the
   *  ground material's roughness + boost its envMapIntensity so wet
   *  surfaces read as glossy + mirror-reflective (Prompt #9). */
  wetness: number;
}

export const DEFAULT_WEATHER: WeatherState = {
  timeOfDay: 9, // 9am — morning
  cloudCover: 0.3,
  precipitation: 0,
  windSpeed: 3,
  windDirection: 0.5,
  fogDensity: 0.012,
  wetness: 0,
};

/** Compute sun direction from time of day (0=midnight, 12=noon, 18=sunset). */
export function sunDirection(timeOfDay: number): { elevation: number; azimuth: number; intensity: number } {
  // sun angle: at 6am rises (elevation 0), noon peak (90), 6pm sets (0), night negative
  const t = (timeOfDay - 6) / 12; // 0 at 6am, 1 at 6pm
  const elevation = Math.sin(t * Math.PI) * Math.PI / 2; // 0..pi/2..0
  const intensity = Math.max(0, Math.sin(t * Math.PI));
  const azimuth = -Math.PI * 0.4 + t * Math.PI * 0.8; // east to west
  return { elevation, azimuth, intensity };
}

/** Is it night time (sun below horizon)? */
export function isNight(timeOfDay: number): boolean {
  return timeOfDay < 6 || timeOfDay > 18;
}

/** Sky top/mid/bottom colors based on time of day. */
export function skyColors(timeOfDay: number): { top: [number, number, number]; mid: [number, number, number]; bottom: [number, number, number] } {
  const night: [number, number, number] = [0.04, 0.05, 0.09];
  const dawn: [number, number, number] = [0.35, 0.3, 0.4];
  const day: [number, number, number] = [0.29, 0.41, 0.54];
  const dusk: [number, number, number] = [0.5, 0.35, 0.3];

  const lerp = (a: number[], b: number[], t: number): [number, number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];

  if (timeOfDay < 5) return { top: night, mid: night, bottom: night };
  if (timeOfDay < 7) {
    const t = (timeOfDay - 5) / 2;
    return { top: lerp(night, dawn, t), mid: lerp(night, dawn, t), bottom: lerp(night, [0.6, 0.45, 0.35], t) };
  }
  if (timeOfDay < 17) {
    const t = Math.min(1, (timeOfDay - 7) / 4);
    return { top: lerp(dawn, day, t), mid: lerp(dawn, [0.72, 0.64, 0.48], t), bottom: lerp([0.6, 0.45, 0.35], [0.83, 0.77, 0.62], t) };
  }
  if (timeOfDay < 20) {
    const t = (timeOfDay - 17) / 3;
    return { top: lerp(day, dusk, t), mid: lerp([0.72, 0.64, 0.48], dusk, t), bottom: lerp([0.83, 0.77, 0.62], [0.7, 0.45, 0.3], t) };
  }
  const t = (timeOfDay - 20) / 4;
  return { top: lerp(dusk, night, t), mid: lerp(dusk, night, t), bottom: lerp([0.7, 0.45, 0.3], night, t) };
}
