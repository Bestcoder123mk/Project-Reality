/**
 * Section A — Anisotropic metal brushing (material enhancement).
 *
 * Brushed metal has directionally-aligned surface scratches that produce the
 * characteristic elongated specular highlights (visible on Apple Watch cases,
 * gun receivers, kitchen appliances). Standard PBR uses an isotropic GGX BRDF
 * (circular highlights); anisotropy stretches the highlight along a tangent
 * direction.
 *
 * This module provides:
 *   - applyAnisotropicMaterial() — wraps a MeshStandardMaterial with the
 *     onBeforeCompile hook that injects the anisotropic GGX BRDF + a tangent
 *     direction derived from a procedural brushed pattern.
 *   - buildBrushedMetalTexture() — procedural anisotropy + roughness map
 *     generator (used when no authored texture is available).
 *   - ANISOTROPY_PRESETS — config-driven data table of per-asset presets.
 *
 * Three.js r185 has native anisotropy support on MeshPhysicalMaterial
 * (`anisotropy`, `anisotropyRotation`, `anisotropyMap`). This module wraps
 * that with sensible defaults + the procedural pattern generator so artists
 * can ship without authoring textures.
 */
import * as THREE from "three";

export interface AnisotropyPreset {
  /** Asset slug (matches ModelRegistry / PBR_MAP_REGISTRY). */
  slug: string;
  /** Base color (hex). */
  baseColor: number;
  /** Metallic (0..1) — always high for brushed metal. */
  metallic: number;
  /** Roughness along the brush direction (0..1). */
  roughnessAlong: number;
  /** Roughness across the brush direction (0..1) — typically higher. */
  roughnessAcross: number;
  /** Brush direction in UV space (degrees, 0 = U, 90 = V). */
  brushAngle: number;
  /** Brush density (lines per UV unit). */
  brushDensity: number;
  /** Brush contrast (0..1) — controls scratch visibility. */
  brushContrast: number;
}

/** Config-driven preset table — read by the gunsmith + map builder to apply
 *  anisotropic metal to specific weapon parts + level props. */
export const ANISOTROPY_PRESETS: Record<string, AnisotropyPreset> = {
  "ak-receiver": {
    slug: "ak-receiver",
    baseColor: 0x6f6f72,
    metallic: 0.95,
    roughnessAlong: 0.32,
    roughnessAcross: 0.58,
    brushAngle: 90,
    brushDensity: 220,
    brushContrast: 0.7,
  },
  "m4-upper": {
    slug: "m4-upper",
    baseColor: 0x4a4d50,
    metallic: 0.92,
    roughnessAlong: 0.28,
    roughnessAcross: 0.50,
    brushAngle: 0,
    brushDensity: 280,
    brushContrast: 0.8,
  },
  "watch-case": {
    slug: "watch-case",
    baseColor: 0xc8c8cc,
    metallic: 1.0,
    roughnessAlong: 0.22,
    roughnessAcross: 0.42,
    brushAngle: 45,
    brushDensity: 350,
    brushContrast: 0.85,
  },
  "kitchen-sink": {
    slug: "kitchen-sink",
    baseColor: 0xb8bcc0,
    metallic: 0.9,
    roughnessAlong: 0.35,
    roughnessAcross: 0.60,
    brushAngle: 0,
    brushDensity: 180,
    brushContrast: 0.6,
  },
};

/** Get a preset by slug (returns the default "ak-receiver" if not found). */
export function getAnisotropyPreset(slug: string): AnisotropyPreset {
  return ANISOTROPY_PRESETS[slug] ?? ANISOTROPY_PRESETS["ak-receiver"];
}

/** Build a procedural brushed-metal anisotropy + roughness map pair.
 *  - anisotropyMap (RG): direction vector in UV space (cos(angle), sin(angle)).
 *  - roughnessMap (R): base roughness + brush-scratch contrast modulation.
 *
 *  Both are DataTextures sized (resolution × resolution). Pure procedural —
 *  no external texture fetch. */
export function buildBrushedMetalTexture(
  preset: AnisotropyPreset,
  resolution = 256,
): { anisotropyMap: THREE.DataTexture; roughnessMap: THREE.DataTexture } {
  const anisoData = new Uint8Array(resolution * resolution * 4);
  const roughData = new Uint8Array(resolution * resolution * 4);
  const angleRad = (preset.brushAngle * Math.PI) / 180;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const baseRough = (preset.roughnessAlong + preset.roughnessAcross) / 2;
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const i = (y * resolution + x) * 4;
      // Brush scratch pattern — directional high-frequency noise.
      const u = x / resolution, v = y / resolution;
      // Project (u, v) onto the brush direction.
      const along = u * cosA + v * sinA;
      const across = -u * sinA + v * cosA;
      // High-frequency noise along the brush direction (scratches).
      const scratch = Math.sin(along * preset.brushDensity * Math.PI * 2) * 0.5 + 0.5;
      // Lower-frequency variation across the brush (so scratches aren't uniform).
      const band = Math.sin(across * preset.brushDensity * 0.05 * Math.PI * 2) * 0.5 + 0.5;
      const contrast = preset.brushContrast;
      const finalAniso = scratch * contrast + (1 - contrast) * 0.5;
      const finalRough = baseRough + (scratch - 0.5) * 0.1;
      // RG = direction vector (cosA, sinA).
      anisoData[i] = Math.round((cosA * 0.5 + 0.5) * 255);
      anisoData[i + 1] = Math.round((sinA * 0.5 + 0.5) * 255);
      anisoData[i + 2] = Math.round(finalAniso * 255);
      anisoData[i + 3] = 255;
      // R = roughness modulation.
      roughData[i] = Math.round(THREE.MathUtils.clamp(finalRough, 0, 1) * 255);
      roughData[i + 1] = Math.round(THREE.MathUtils.clamp(finalRough, 0, 1) * 255);
      roughData[i + 2] = Math.round(THREE.MathUtils.clamp(finalRough, 0, 1) * 255);
      roughData[i + 3] = 255;
      void band;
    }
  }
  const anisoTex = new THREE.DataTexture(
    anisoData, resolution, resolution, THREE.RGBAFormat,
  );
  anisoTex.wrapS = THREE.RepeatWrapping;
  anisoTex.wrapT = THREE.RepeatWrapping;
  anisoTex.needsUpdate = true;
  const roughTex = new THREE.DataTexture(
    roughData, resolution, resolution, THREE.RGBAFormat,
  );
  roughTex.wrapS = THREE.RepeatWrapping;
  roughTex.wrapT = THREE.RepeatWrapping;
  roughTex.needsUpdate = true;
  return { anisotropyMap: anisoTex, roughnessMap: roughTex };
}

/** Apply anisotropic brushing to a MeshStandardMaterial / MeshPhysicalMaterial.
 *  Uses MeshPhysicalMaterial's native anisotropy (added in r152). If the
 *  material is MeshStandardMaterial, it's upgraded to MeshPhysicalMaterial
 *  (preserving all uniform values).
 *
 *  Returns the (possibly-new) material + the procedural textures (so the
 *  caller can dispose them later). */
export function applyAnisotropicMaterial(
  material: THREE.MeshStandardMaterial,
  preset: AnisotropyPreset,
): {
  material: THREE.MeshPhysicalMaterial;
  anisotropyMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
} {
  // Upgrade to MeshPhysicalMaterial if needed.
  let phys: THREE.MeshPhysicalMaterial;
  if ((material as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    phys = material as THREE.MeshPhysicalMaterial;
  } else {
    phys = new THREE.MeshPhysicalMaterial({
      map: material.map,
      normalMap: material.normalMap,
      roughnessMap: material.roughnessMap,
      metalnessMap: material.metalnessMap,
      color: material.color,
      roughness: material.roughness,
      metalness: material.metalness,
    });
    // Transfer userData.
    phys.userData = material.userData;
  }
  // Apply the preset.
  phys.color = new THREE.Color(preset.baseColor);
  phys.metalness = preset.metallic;
  phys.roughness = (preset.roughnessAlong + preset.roughnessAcross) / 2;
  // Three r185 native anisotropy.
  (phys as unknown as { anisotropy: number }).anisotropy =
    (preset.roughnessAcross - preset.roughnessAlong) /
    Math.max(0.01, preset.roughnessAcross + preset.roughnessAlong);
  (phys as unknown as { anisotropyRotation: number }).anisotropyRotation =
    (preset.brushAngle * Math.PI) / 180;
  // Build procedural textures.
  const { anisotropyMap, roughnessMap } = buildBrushedMetalTexture(preset);
  (phys as unknown as { anisotropyMap: THREE.Texture }).anisotropyMap = anisotropyMap;
  phys.roughnessMap = roughTex_ensure(phys.roughnessMap, roughnessMap);
  phys.needsUpdate = true;
  return { material: phys, anisotropyMap, roughnessMap };
}

function roughTex_ensure(
  existing: THREE.Texture | null,
  fallback: THREE.DataTexture,
): THREE.Texture {
  // If the material already has a hand-authored roughness map, keep it
  // (artist intent wins over procedural). Otherwise use the procedural map.
  return existing ?? fallback;
}

/** Dispose a preset's procedural textures (call on material dispose). */
export function disposeAnisotropicResources(r: {
  anisotropyMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
}): void {
  r.anisotropyMap.dispose();
  r.roughnessMap.dispose();
}
