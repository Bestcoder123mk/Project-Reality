/**
 * Section E — Holographic skin material.
 *
 * A holographic foil wrap shifts iridescently as the view angle changes —
 * like a pearlescent car paint, a holo Pokemon card, or an oil-slick on
 * water. Section E prompts call this out by name ("holographic foil wrap
 * named 'Spectral Drift' / 'Aurora'").
 *
 * Implementation: a custom ShaderMaterial that computes an iridescence
 * angle from view-direction vs surface-normal, then samples from a
 * procedural rainbow gradient (palette-derived). Adds a subtle fresnel
 * rim that intensifies the holographic effect at grazing angles.
 *
 * The palette's 3-5 colors form a gradient that the iridescence sweeps
 * across as the view angle changes — so each entry gets a unique holographic
 * signature (cool palettes shimmer blue-green, warm palettes shimmer
 * red-gold).
 */
import * as THREE from "three";
import type { SkinCatalogEntry } from "./skin-catalog";

// ─── Public types ───────────────────────────────────────────────────────────

export interface HolographicConfig {
  /** Iridescence intensity 0..1 — how strong the color shift is. */
  iridescence: number;
  /** Rim-light intensity 0..1 — fresnel glow at grazing angles. */
  rimIntensity: number;
  /** Palette — 3..5 colors swept by the iridescence angle. */
  palette: THREE.Color[];
  /** Sweep speed — how fast the iridescence shifts with time. */
  sweepSpeed: number;
  /** Base roughness / metalness for the underlying surface. */
  roughness: number;
  metalness: number;
}

export interface HolographicMaterial {
  material: THREE.ShaderMaterial;
  /** Per-frame update — pass the elapsed time (seconds) + optional view dir. */
  update: (timeSec: number, viewDir?: THREE.Vector3) => void;
  dispose: () => void;
  config: HolographicConfig;
}

// ─── Build the material ─────────────────────────────────────────────────────

const _shaderCache = new WeakMap<SkinCatalogEntry, HolographicMaterial>();

export function createHolographicMaterial(
  entry: SkinCatalogEntry,
  opts?: Partial<HolographicConfig>,
): HolographicMaterial {
  const cached = _shaderCache.get(entry);
  if (cached) return cached;

  const palette = entry.colors.map((c) => new THREE.Color(c));
  if (palette.length < 2) {
    palette.push(new THREE.Color("#ffffff"));
  }

  const config: HolographicConfig = {
    iridescence: 0.85,
    rimIntensity: 0.7,
    palette,
    sweepSpeed: 0.4,
    roughness: 0.25,
    metalness: 0.85,
    ...opts,
  };

  const uniforms: { [k: string]: THREE.IUniform } = {
    uPalette: { value: config.palette.map((c) => c.clone()) },
    uPaletteSize: { value: config.palette.length },
    uIridescence: { value: config.iridescence },
    uRimIntensity: { value: config.rimIntensity },
    uTime: { value: 0 },
    uSweepSpeed: { value: config.sweepSpeed },
    uRoughness: { value: config.roughness },
    uMetalness: { value: config.metalness },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      uniform vec3 uPalette[8];
      uniform int uPaletteSize;
      uniform float uIridescence;
      uniform float uRimIntensity;
      uniform float uTime;
      uniform float uSweepSpeed;
      uniform float uRoughness;
      uniform float uMetalness;

      // Sample the palette at 0..1 — linear interpolation across the colors.
      vec3 samplePalette(float t) {
        t = clamp(t, 0.0, 0.9999);
        float scaled = t * float(uPaletteSize - 1);
        int idx = int(floor(scaled));
        float frac = scaled - float(idx);
        // Manual unrolled lookup (GLSL ES doesn't allow dynamic indexing).
        vec3 c0 = uPalette[0];
        vec3 c1 = uPalette[0];
        vec3 c2 = uPalette[0];
        for (int i = 0; i < 8; i++) {
          if (i == idx) { c0 = uPalette[i]; c1 = uPalette[i+1 < uPaletteSize ? i+1 : i]; c2 = uPalette[i]; break; }
        }
        return mix(c0, c1, frac);
      }

      // Iridescence — thin-film interference approximation. The "film
      // thickness" varies with view-angle + a slow time sweep.
      float thinFilm(float ndv, float t) {
        return ndv * 0.5 + 0.5 + sin(t * uSweepSpeed) * 0.2;
      }

      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(vViewDir);
        float ndv = max(dot(N, V), 0.0);
        float fresnel = pow(1.0 - ndv, 4.0);

        // Iridescence sweep — the palette index shifts with angle + time.
        float film = thinFilm(ndv, uTime);
        float sweep = fract(film + uTime * uSweepSpeed * 0.15);
        vec3 holoColor = samplePalette(sweep);

        // Apply iridescence strength — lerp between a neutral base (first
        // palette color) and the swept color.
        vec3 base = uPalette[0];
        vec3 albedo = mix(base, holoColor, uIridescence);

        // Basic lambert + specular for the underlying metallic surface.
        vec3 lightDir = normalize(vec3(0.5, 1.0, 0.7));
        float ndl = max(dot(N, lightDir), 0.0);
        vec3 H = normalize(lightDir + V);
        float spec = pow(max(dot(N, H), 0.0), mix(8.0, 128.0, 1.0 - uRoughness));
        vec3 ambient = vec3(0.3, 0.32, 0.36);

        vec3 lit = albedo * (ambient + ndl * 0.7) + spec * uMetalness * 0.8;

        // Fresnel rim — the holographic "sheen" intensifies at grazing
        // angles. The rim color sweeps through the palette too.
        vec3 rimColor = samplePalette(fract(sweep + 0.3));
        lit += rimColor * fresnel * uRimIntensity;

        // Subtle anisotropic streak — moves along the surface with time.
        float streak = sin(vUv.y * 80.0 + uTime * uSweepSpeed * 2.0) * 0.5 + 0.5;
        lit += albedo * streak * fresnel * 0.15;

        gl_FragColor = vec4(lit, 1.0);
      }
    `,
  });

  const update = (timeSec: number, _viewDir?: THREE.Vector3): void => {
    uniforms.uTime.value = timeSec;
  };

  const dispose = (): void => {
    material.dispose();
    _shaderCache.delete(entry);
  };

  const result: HolographicMaterial = { material, update, dispose, config };
  _shaderCache.set(entry, result);
  return result;
}

// ─── Apply to a mesh ────────────────────────────────────────────────────────

/**
 * Apply a holographic material to a THREE.Mesh. Returns the material
 * controller (or null if the entry's pattern isn't holographic).
 *
 * The caller is responsible for calling `update(timeSec)` each frame
 * (the rendering loop wires this up).
 */
export function applyHolographicToMesh(
  mesh: THREE.Mesh,
  entry: SkinCatalogEntry,
): HolographicMaterial | null {
  if (entry.pattern !== "holographic_foil") return null;
  const holo = createHolographicMaterial(entry);
  mesh.material = holo.material;
  return holo;
}

/** All catalog entries that use the holographic pattern. */
export function getHolographicSkins(allEntries: SkinCatalogEntry[]): SkinCatalogEntry[] {
  return allEntries.filter((e) => e.pattern === "holographic_foil");
}

// ─── Iridescence quality presets ────────────────────────────────────────────

/** Quality preset — lower-end devices drop the time sweep + streak. */
export type HolographicQuality = "low" | "medium" | "high";

export function holographicConfigForQuality(
  quality: HolographicQuality,
  entry: SkinCatalogEntry,
): Partial<HolographicConfig> {
  switch (quality) {
    case "low":
      return { iridescence: 0.6, rimIntensity: 0.4, sweepSpeed: 0 };
    case "medium":
      return { iridescence: 0.8, rimIntensity: 0.6, sweepSpeed: 0.3 };
    case "high":
    default:
      return { iridescence: 0.95, rimIntensity: 0.8, sweepSpeed: 0.5 };
  }
}
