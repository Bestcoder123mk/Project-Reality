import * as THREE from "three";

/**
 * V1.3 — Tactical environment map.
 *
 * Builds a procedural HDRI-style environment scene (no external .hdr file
 * needed) and pre-filters it via PMREMGenerator for real-time PBR reflections.
 *
 * The environment is a tactical-dusk look:
 *   - A warm amber key light from upper-right (simulates low sun / hangar lamp)
 *   - A cool steel-blue fill from the opposite side
 *   - A dark olive/charcoal ground
 *   - A soft gradient sky dome (dusk: deep teal top → warm amber horizon)
 *
 * This single environment drives every PBR material's reflections (gunmetal,
 * glass scopes, polymer furniture, visors) — the biggest "looks real" lever
 * per the master prompt. Used by the in-game scene, the Gunsmith podium, and
 * the Operator preview podium so they all share one coherent light identity.
 */
/** Per-renderer cache — PMREM textures are tied to a specific WebGL context,
 *  so the game renderer, the Gunsmith podium renderer, and the Operator
 *  preview renderer each get their own cached env map. */
const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

export function buildTacticalEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture | null {
  const cached = envCache.get(renderer);
  if (cached) return cached;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();

    // Build a small environment scene — PMREM will pre-filter it.
    const envScene = new THREE.Scene();
    // A3-5000-retry / 451: track the env-scene's geometries + materials so we
    // can dispose them after `pmrem.fromScene` consumes them (was a per-renderer
    // leak — mitigated by WeakMap cache, but a context-loss cascade re-builds
    // the env repeatedly + leaks GPU memory).
    const envGeoList: THREE.BufferGeometry[] = [];
    const envMatList: THREE.Material[] = [];

    // Gradient sky dome (dusk: deep teal → warm amber horizon).
    // A3-5000-retry / 422: the chunk `gl_FragColor = vec4( outgoingLight, diffuseColor.a );`
    // was refactored away in Three.js r155+. The replace silently failed → sky
    // remained default. We now (a) check the chunk exists before replacing +
    // (b) ALSO replace the r155+ equivalent (`gl_FragColor = vec4( outgoingLight, diffuseColor.a );`
    // moved into `#include <output_fragment>`). If neither chunk is found, we
    // fall back to injecting the sky-gradient code via `onBeforeCompile`'s
    // `shader.fragmentShader` direct append (less robust but always works).
    const skyGeo = new THREE.SphereGeometry(50, 32, 16);
    envGeoList.push(skyGeo);
    const skyMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
    envMatList.push(skyMat);
    skyMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWorldPos;",
      ).replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvec4 wp = modelMatrix * vec4(position, 1.0); vWorldPos = wp.xyz;",
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vWorldPos;\nuniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom;",
      );
      // A3-5000-retry / 423: removed the meaningless `#include <dashing_fragment>`
      // replace — dashing_fragment is for LineDashedMaterial, not sky. Misleading.
      const skyGradientGLSL = `float h = normalize(vWorldPos).y;
         vec3 sky = h > 0.0
           ? mix(uHorizon, uTop, smoothstep(0.0, 0.7, h))
           : mix(uHorizon, uBottom, smoothstep(0.0, -0.4, h));
         gl_FragColor = vec4(sky, 1.0);`;
      // A3-5000-retry / 422: try multiple known chunk locations (Three.js r155+
      // moved the output write into `#include <output_fragment>`; older versions
      // had it inline as `gl_FragColor = vec4( outgoingLight, diffuseColor.a );`).
      const r155PlusChunk = "gl_FragColor = vec4( outgoingLight, diffuseColor.a );";
      const outputFragmentInclude = "#include <output_fragment>";
      if (shader.fragmentShader.includes(r155PlusChunk)) {
        shader.fragmentShader = shader.fragmentShader.replace(r155PlusChunk, skyGradientGLSL);
      } else if (shader.fragmentShader.includes(outputFragmentInclude)) {
        // Three.js r155+ — replace the output_fragment include with our sky write.
        shader.fragmentShader = shader.fragmentShader.replace(outputFragmentInclude, skyGradientGLSL);
      } else {
        // Fallback: append the sky write at the end of main(). Less robust
        // (overrides whatever the material wrote), but always applies the gradient.
        shader.fragmentShader = shader.fragmentShader.replace(
          /^(void main\(\) \{[\s\S]*?)\}(?:\s*)$/m,
          `$1  ${skyGradientGLSL}\n}`,
        );
      }
      shader.uniforms.uTop = { value: new THREE.Color(0.05, 0.09, 0.12) };
      shader.uniforms.uHorizon = { value: new THREE.Color(0.22, 0.16, 0.10) };
      shader.uniforms.uBottom = { value: new THREE.Color(0.02, 0.03, 0.03) };
      skyMat.userData.shader = shader;
    };
    envScene.add(new THREE.Mesh(skyGeo, skyMat));

    // Warm amber key light — a glowing disc upper-right (the "hangar lamp").
    const keyGeo = new THREE.CircleGeometry(8, 32);
    envGeoList.push(keyGeo);
    const keyMat = new THREE.MeshBasicMaterial({ color: 0xffb060 });
    envMatList.push(keyMat);
    const keyDisc = new THREE.Mesh(keyGeo, keyMat);
    keyDisc.position.set(18, 16, -12);
    keyDisc.lookAt(0, 0, 0);
    envScene.add(keyDisc);

    // Cool steel-blue fill — opposite side, dimmer.
    const fillGeo = new THREE.CircleGeometry(6, 32);
    envGeoList.push(fillGeo);
    const fillMat = new THREE.MeshBasicMaterial({ color: 0x4a6a8a });
    envMatList.push(fillMat);
    const fillDisc = new THREE.Mesh(fillGeo, fillMat);
    fillDisc.position.set(-16, 8, 10);
    fillDisc.lookAt(0, 0, 0);
    envScene.add(fillDisc);

    // Dark olive ground plane (reflects up into gunmetal).
    const groundGeo = new THREE.PlaneGeometry(100, 100);
    envGeoList.push(groundGeo);
    const groundMat = new THREE.MeshBasicMaterial({ color: 0x14160f });
    envMatList.push(groundMat);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -10;
    envScene.add(ground);

    const envMap = pmrem.fromScene(envScene, 0.04).texture;
    pmrem.dispose();
    // A3-5000-retry / 451: dispose the env-scene's geometries + materials now
    // that PMREM has consumed them. Without this, every context-loss re-build
    // leaks 4 geometries + 4 materials.
    for (const g of envGeoList) g.dispose();
    for (const m of envMatList) m.dispose();
    envCache.set(renderer, envMap);
    return envMap;
  } catch (err) {
    console.warn("[TacticalEnvironment] PMREM generation failed:", err);
    return null;
  }
}

/** Apply the tactical environment to a scene as the PBR reflection source.
 *  Returns true if applied, false if unavailable (caller falls back gracefully). */
export function applyTacticalEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
): boolean {
  const env = buildTacticalEnvironment(renderer);
  if (!env) return false;
  scene.environment = env;
  return true;
}

/** Clear the cached environment for a renderer (used when the context is lost). */
export function invalidateTacticalEnvironment(renderer?: THREE.WebGLRenderer) {
  if (renderer) envCache.delete(renderer);
}
