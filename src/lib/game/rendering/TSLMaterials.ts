/**
 * TSLMaterials — PBR material enhancement + sky environment utilities.
 *
 * Provides the two helpers the PostProcessing / RendererSystem pipeline expects:
 *   - boostPBRMaterials(scene, opts): walks a scene graph, upgrades
 *     MeshStandardMaterial instances with env-map reflections, correct
 *     roughness/metalness curves, and a subtle clearcoat for a more
 *     photographic read. Returns the count of upgraded materials.
 *   - applySkyEnvironment(scene, renderer, skyMesh?, pmrem?, prevMap?):
 *     bakes the current sky environment into the scene's environment map
 *     so PBR materials pick up real reflections. Disposes the previous map.
 */
import * as THREE from "three";

export interface BoostPBRopts {
  envMapIntensity?: number;
  boostMetals?: boolean;
}

/**
 * Upgrade every MeshStandardMaterial in the scene with cinematic PBR defaults.
 * Returns the number of materials upgraded.
 */
export function boostPBRMaterials(root: THREE.Object3D, opts?: BoostPBRopts): number {
  const envIntensity = opts?.envMapIntensity ?? 1.1;
  const boostMetals = opts?.boostMetals ?? true;
  let count = 0;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const mat = m as THREE.MeshStandardMaterial;
      if (!mat || !mat.isMeshStandardMaterial) continue;
      mat.envMapIntensity = envIntensity;
      if (boostMetals && mat.metalness > 0.4) {
        mat.metalness = Math.min(1, mat.metalness + 0.1);
        mat.roughness = Math.max(0.15, mat.roughness - 0.1);
      }
      // Subtle clearcoat gives metals a photographed sheen.
      // A3-5000-retry / 425: per-material clearcoat (was unconditional 0.15
      // on every MeshStandardMaterial — wood, fabric, concrete shouldn't have
      // clearcoat). Only metals + already-clearcoat-bearing physical materials
      // get the boost. The classification mirrors the SSR metalness heuristic:
      // metalness > 0.5 = metal.
      if ("clearcoat" in mat) {
        const phys = mat as THREE.MeshPhysicalMaterial;
        if (phys.metalness > 0.5 || (phys.clearcoat ?? 0) > 0) {
          phys.clearcoat = Math.max(phys.clearcoat ?? 0, 0.15);
          phys.clearcoatRoughness = 0.4;
        }
      }
      mat.needsUpdate = true;
      count++;
    }
  });
  return count;
}

/**
 * Apply the sky mesh (or a procedural fallback) as a PMREM-remapped
 * environment map so PBR materials get realistic image-based lighting.
 * Accepts the legacy 5-arg call shape used by PostProcessing.
 *
 * Task-9 — Enhanced to also bake a sun disk + ground plane into the
 * temp PMREM scene so the captured environment contains a real key-light
 * direction (not just the gradient). This gives PBR materials a strong
 * specular highlight aligned with the visible sun, which is the single
 * biggest contributor to "looks real" on gunmetal/glass/polymer.
 *
 * `sunLight` (optional) drives the sun disk's color + position + intensity
 * so the env map tracks the time-of-day (warm amber at dawn/dusk, white
 * at noon, dim blue at night). When omitted, the function falls back to
 * the previous behavior (sky gradient only).
 */
export function applySkyEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  skyMesh?: THREE.Object3D | null,
  existingPmrem?: THREE.PMREMGenerator | null,
  prevMap?: THREE.Texture | null,
  sunLight?: THREE.DirectionalLight | null,
): THREE.Texture {
  // Dispose previous map if provided.
  if (prevMap) prevMap.dispose();

  let pmrem = existingPmrem;
  let createdPmrem = false;
  if (!pmrem || pmrem.constructor !== THREE.PMREMGenerator) {
    pmrem = new THREE.PMREMGenerator(renderer);
    createdPmrem = true;
  }

  let target: THREE.WebGLRenderTarget;
  if (skyMesh && (skyMesh as any).material) {
    // Render the existing sky mesh into a temp scene for PMREM.
    const tempScene = new THREE.Scene();
    const skyClone = skyMesh.clone();
    tempScene.add(skyClone);
    // A3-5000-retry / 424 + 452: wrap the PMREM bake in try/catch so a throw
    // from `pmrem.fromScene` doesn't leak the temp-scene children (skyClone,
    // sunDisk, ground) OR the partially-created `target`. On throw we dispose
    // everything we created + re-throw.
    let sunDisk: THREE.Mesh | null = null;
    let ground: THREE.Mesh | null = null;
    try {

    // Task-9 — Add a sun disk (MeshBasicMaterial) so PMREM captures a real
    // key-light direction. Positioned along the sunLight's direction
    // (sunLight.position points FROM origin TOWARD the sun), color + intensity
    // mirrored from the live sunLight so the env map tracks time-of-day.
    if (sunLight) {
      const sunDir = sunLight.position.clone();
      const len = sunDir.length();
      if (len > 0.001) {
        sunDir.multiplyScalar(1 / len);
        // Sun disk color: sunLight.color * intensity (scaled for HDR capture).
        const sunColor = sunLight.color.clone();
        const intensity = Math.max(0.1, sunLight.intensity);
        // PMREM treats MeshBasicMaterial color as already-linear radiance —
        // multiply by intensity so a noon sun (intensity 2.6) bakes a much
        // brighter key light than a dim moon (intensity 0.3).
        const r = Math.min(4.0, sunColor.r * intensity);
        const g = Math.min(4.0, sunColor.g * intensity);
        const b = Math.min(4.0, sunColor.b * intensity);
        sunDisk = new THREE.Mesh(
          new THREE.CircleGeometry(3, 24),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) }),
        );
        // Place the disk well inside the sky dome along the sun direction.
        sunDisk.position.copy(sunDir).multiplyScalar(80);
        sunDisk.lookAt(0, 0, 0);
        tempScene.add(sunDisk);
      }
    }

    // Task-9 — Add a dark ground plane so the env map's lower hemisphere
    // has a real floor (gunmetal reflects the ground color, giving the
    // "ground bounce" that flat sky-only env maps lack).
    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshBasicMaterial({ color: 0x16180f }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -10;
    tempScene.add(ground);

    target = pmrem.fromScene(tempScene as unknown as THREE.Scene, 0.04);
    } catch (err) {
      // A3-5000-retry / 424: cleanup on throw — dispose the sun disk + ground
      // geometries + materials we created (the skyClone shares geometry/material
      // with the original sky — do NOT dispose those, the live sky mesh still
      // owns them).
      if (sunDisk) { sunDisk.geometry?.dispose?.(); (sunDisk.material as THREE.Material)?.dispose?.(); }
      if (ground) { ground.geometry?.dispose?.(); (ground.material as THREE.Material)?.dispose?.(); }
      throw err;
    }
    // Cleanup the temp scene's children (the cloned sky + sun disk + ground).
    // A3-5000-retry / 452: ALSO dispose skyClone's geometry + material — was
    // leaking (the clone gets its own refs after `clone()`; the original sky
    // mesh keeps its own separate refs, so disposing the clone's is safe).
    while (tempScene.children.length > 0) {
      const c = tempScene.children[0];
      tempScene.remove(c);
      (c as THREE.Mesh).geometry?.dispose?.();
      const m = (c as THREE.Mesh).material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else if (m) (m as THREE.Material).dispose();
    }
  } else {
    // Procedural sky fallback.
    const sky = new ProceduralSky();
    sky.scale.setScalar(450000);
    target = pmrem.fromScene(sky as unknown as THREE.Scene, 0.04);
  }

  scene.environment = target.texture;
  if (createdPmrem) pmrem.dispose();
  return target.texture;
}

/** Minimal procedural sky shader for image-based lighting fallback. */
class ProceduralSky extends THREE.Mesh {
  constructor() {
    const uniforms = {
      turbidity: { value: 8 },
      rayleigh: { value: 2 },
      mieCoefficient: { value: 0.005 },
      mieDirectionalG: { value: 0.8 },
      sunPosition: { value: new THREE.Vector3(0.5, 0.05, -0.85) },
      up: { value: new THREE.Vector3(0, 1, 0) },
    };
    super(
      new THREE.SphereGeometry(450000),
      new THREE.ShaderMaterial({
        uniforms,
        vertexShader: `
          varying vec3 vWorldPosition;
          void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vWorldPosition;
          uniform vec3 sunPosition;
          uniform float rayleigh, turbidity, mieCoefficient, mieDirectionalG;
          void main() {
            vec3 direction = normalize(vWorldPosition);
            vec3 sunDirection = normalize(sunPosition);
            float sunfade = clamp(1.0 + sunDirection.y, 0.0, 1.0);
            float theta = acos(max(-1.0, min(1.0, direction.y)));
            vec3 col = vec3(0.35, 0.55, 0.9) * (1.0 - 0.7 * pow(1.0 - max(0.0, direction.y), 2.0));
            col += vec3(0.9, 0.8, 0.7) * 0.05 * sunfade;
            float sundisk = smoothstep(0.9992, 0.9997, dot(direction, sunDirection));
            col += vec3(1.0, 0.95, 0.8) * sundisk * sunfade;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        side: THREE.BackSide,
      })
    );
  }
}
