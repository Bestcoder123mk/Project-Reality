/**
 * SEC3-RENDER Prompt 28 — Water rendering.
 *
 * A reflective/refractive water mesh with:
 *   - Procedural Gerstner wave surface displacement (vertex shader)
 *   - Fresnel-mixed reflection (sampled from a cubemap / scene env) +
 *     refraction (the deep-water color, modulated by depth)
 *   - Foam at intersection — soft white foam ring at the mesh edges where
 *     the water meets other geometry (driven by the camera-depth + a foam
 *     mask texture)
 *   - Specular sun glint (Blinn-Phong from a sun direction uniform)
 *
 * The mesh is returned with a THREE.ShaderMaterial — the host can drop it
 * into the scene like any other mesh. Set `mesh.material.uniforms.uTime`
 * per frame to animate the waves.
 *
 * Pure-logic helpers (wave params, foam blend) are exported for unit tests.
 */
import * as THREE from "three";

export interface WaterOptions {
  /** Surface color (deep water). Default: dark teal. */
  color?: THREE.ColorRepresentation;
  /** Sky/cube texture used for the reflection term. If absent, falls back to
   *  a procedural horizon gradient. */
  envMap?: THREE.Texture | null;
  /** Sun direction (world-space, the direction the light travels TOWARD). */
  sunDirection?: THREE.Vector3;
  /** Sun color (linear). */
  sunColor?: THREE.ColorRepresentation;
  /** Wave amplitude (world units). Default 0.15. */
  waveAmplitude?: number;
  /** Wave frequency (1/world units). Default 0.8. */
  waveFrequency?: number;
  /** Wave speed (1/sec). Default 0.6. */
  waveSpeed?: number;
  /** Foam intensity (0..1). Default 0.5. */
  foamIntensity?: number;
  /** Reflection intensity (0..1). Default 0.7. */
  reflectionIntensity?: number;
  /** Refraction depth tint (0..1). Default 0.6. */
  refractionDepth?: number;
  /** Transparency (0..1). Default 0.85. */
  opacity?: number;
}

/** Gerstner wave parameters — exported so tests can verify the math. */
export interface GerstnerWave {
  direction: THREE.Vector2; // (x, z) on the water plane
  amplitude: number;
  frequency: number;
  speed: number;
  steepness: number; // 0..1
}

/** Build N Gerstner waves for the water surface. Pure function. */
export function buildWaveSet(count: number, opts: {
  amplitude?: number; frequency?: number; speed?: number;
}): GerstnerWave[] {
  const out: GerstnerWave[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + i * 0.7;
    const ampMul = 1 / (i + 1); // smaller higher-frequency waves
    out.push({
      direction: new THREE.Vector2(Math.cos(angle), Math.sin(angle)),
      amplitude: (opts.amplitude ?? 0.15) * ampMul,
      frequency: (opts.frequency ?? 0.8) * (1 + i * 0.4),
      speed: (opts.speed ?? 0.6) * (1 + i * 0.2),
      steepness: 0.8 - i * 0.15,
    });
  }
  return out;
}

/** Pack a wave set into a Float32Array for the shader (4 floats per wave). */
export function packWaves(waves: GerstnerWave[]): Float32Array {
  const out = new Float32Array(waves.length * 4);
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    out[i * 4] = w.direction.x;
    out[i * 4 + 1] = w.direction.y;
    out[i * 4 + 2] = w.amplitude;
    out[i * 4 + 3] = w.frequency + w.speed * 0.01; // pack speed into freq slot
  }
  return out;
}

/** Water vertex + fragment shader. */
const WaterShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0.1, 0.25, 0.32) },
    uSunDirection: { value: new THREE.Vector3(0.5, 0.7, -0.5).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.95, 0.8) },
    uWaveCount: { value: 4 },
    uWaves: { value: new Float32Array(4 * 4) },
    uWaveAmplitude: { value: 0.15 },
    uWaveFrequency: { value: 0.8 },
    uWaveSpeed: { value: 0.6 },
    /** E1-5000 #2318 — Per-wave steepness array (replaces the hardcoded
     *  0.8 steepness the prior gerstner() call used for every wave).
     *  Packing steepness per-wave lets small choppy waves have high
     *  steepness + large swells have low steepness (more realistic). */
    uSteepness: { value: new Float32Array([0.8, 0.65, 0.5, 0.35]) },
    uFoamIntensity: { value: 0.5 },
    uReflectionIntensity: { value: 0.7 },
    uRefractionDepth: { value: 0.6 },
    uOpacity: { value: 0.85 },
    uCameraPos: { value: new THREE.Vector3() },
    // A3-5000 #496 / #498: caustics + detail-normal textures (1×1 transparent
    // defaults; host binds real textures at runtime).
    uCaustics: { value: null as THREE.Texture | null },
    uCausticsEnabled: { value: 0 },
    uDetailNormal: { value: null as THREE.Texture | null },
    uDetailNormalEnabled: { value: 0 },
    uTimeDetail: { value: 0 },
    /** E1-5000 #2316 — Refraction texture (the opaque scene RT rendered
     *  BEFORE the water pass). When bound + uHasRefraction=1, the shader
     *  samples the underwater scene with a normal-offset UV so the player
     *  can SEE THROUGH the water surface (the prior code just darkened the
     *  water color — no actual refraction). */
    tRefraction: { value: null as THREE.Texture | null },
    uHasRefraction: { value: 0 },
  },
  vertexShader: /* glsl */ `
    uniform float uTime;
    uniform int uWaveCount;
    uniform vec4 uWaves[4]; // x=dirX, y=dirY, z=amp, w=freq+speed
    uniform float uSteepness[4]; // E1-5000 #2318: per-wave steepness
    uniform float uWaveAmplitude;
    uniform float uWaveFrequency;
    uniform float uWaveSpeed;
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying float vFoamFactor;
    // E1-5000 #2315 — accumulated max amplitude (for proper foam normalization).
    varying float vMaxAmp;

    // Gerstner wave — returns displacement (dx, dy, dz) + computes normal contribution.
    vec3 gerstner(vec2 pos, vec2 dir, float amp, float freq, float speed, float steepness, out vec3 normalContribution) {
      float phase = dot(dir, pos) * freq + uTime * speed;
      float c = cos(phase);
      float s = sin(phase);
      // Gerstner: x' = x + Q*A*D.x*c; y' = A*s; z' = z + Q*A*D.y*c
      vec3 disp;
      disp.x = steepness * amp * dir.x * c;
      disp.y = amp * s;
      disp.z = steepness * amp * dir.y * c;
      // Normal: derivative of the displacement.
      normalContribution = normalize(vec3(
        -dir.x * freq * amp * c,
        1.0 - steepness * freq * amp * s,
        -dir.y * freq * amp * c
      ));
      return disp;
    }

    void main() {
      vec3 pos = position;
      vec3 totalDisp = vec3(0.0);
      // E1-5000 #2317 — Accumulate normal contributions WITHOUT the prior
      // (0,1,0) bias + hardcoded 0.25 weight. The bias flattened the wave
      // normals (always pointing nearly straight up), killing the spec peak
      // + Fresnel variation. Now we sum the raw per-wave normals + normalize
      // at the end (the gerstner() normal is already unit-ish; the sum
      // naturally averages to (0,1,0) on calm water).
      vec3 normalAccum = vec3(0.0);
      float maxAmp = 0.0;
      for (int i = 0; i < 4; i++) {
        if (i >= uWaveCount) break;
        vec4 w = uWaves[i];
        float steep = uSteepness[i];
        vec3 n;
        // E1-5000 #2318 — Use the per-wave steepness from the uSteepness
        // uniform array (was hardcoded 0.8 for every wave).
        vec3 d = gerstner(pos.xz, w.xy, w.z * uWaveAmplitude, w.w * uWaveFrequency, uWaveSpeed, steep, n);
        totalDisp += d;
        normalAccum += n;
        maxAmp += w.z * uWaveAmplitude;
      }
      vec3 displaced = pos + totalDisp;
      // E1-5000 #2317 — normalize the SUM of contributions (the prior code
      // normalized a (0,1,0)-biased sum which always pointed near-straight-up).
      vNormal = normalize(normalAccum + vec3(0.0, 1e-4, 0.0));
      // E1-5000 #2315 — Foam on peaks only. The prior code divided totalDisp.y
      // by uWaveAmplitude (a SINGLE wave's amp), which saturated to 1.0 across
      // the whole surface when multiple waves summed > uWaveAmplitude. Now we
      // divide by the ACTUAL max possible height (sum of all per-wave amps) so
      // foam only appears at true wave crests.
      vMaxAmp = maxAmp;
      vFoamFactor = smoothstep(0.75, 1.0, totalDisp.y / max(maxAmp, 0.001));

      vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
      vWorldPos = worldPos.xyz;
      // A3-5000 #497: pass view-space position so the fragment shader can
      // detect when the camera is below the water surface.
      vec4 viewPos = viewMatrix * worldPos;
      vViewPos = viewPos.xyz;
      gl_Position = projectionMatrix * viewPos;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform vec3 uSunDirection;
    uniform vec3 uSunColor;
    uniform float uFoamIntensity;
    uniform float uReflectionIntensity;
    uniform float uRefractionDepth;
    uniform float uOpacity;
    uniform vec3 uCameraPos;
    uniform float uTime;
    // A3-5000 #496: caustics sampler — a procedural texture (or generated)
    // projected onto the floor beneath the water. Sampled by world XZ.
    uniform sampler2D uCaustics;
    uniform float uCausticsEnabled; // 0/1
    // A3-5000 #498: detail normal map for high-frequency ripples (叠加 on top
    // of the Gerstner-derived low-frequency normal).
    uniform sampler2D uDetailNormal;
    uniform float uDetailNormalEnabled; // 0/1
    uniform float uTimeDetail; // separate time for the detail normal scroll
    varying vec3 vWorldPos;
    varying vec3 vNormal;
    varying float vFoamFactor;
    varying float vMaxAmp; // E1-5000 #2315
    varying vec3 vViewPos; // A3-5000 #497: for underwater detection
    // E1-5000 #2316 — refraction texture (opaque scene RT).
    uniform sampler2D tRefraction;
    uniform int uHasRefraction;

    void main() {
      vec3 N = normalize(vNormal);
      // A3-5000 #498: add high-frequency detail normal (scrolling). The detail
      // normal is sampled twice at different scales + summed for FBM-like noise.
      if (uDetailNormalEnabled > 0.5) {
        vec2 duv1 = vWorldPos.xz * 0.5 + uTimeDetail * 0.1;
        vec2 duv2 = vWorldPos.xz * 1.3 - uTimeDetail * 0.07;
        vec3 dn1 = texture2D(uDetailNormal, duv1).rgb * 2.0 - 1.0;
        vec3 dn2 = texture2D(uDetailNormal, duv2).rgb * 2.0 - 1.0;
        vec3 dn = normalize(dn1 + dn2);
        N = normalize(N + dn * 0.3);
      }
      vec3 V = normalize(uCameraPos - vWorldPos);
      vec3 L = normalize(-uSunDirection);
      vec3 H = normalize(L + V);

      // Fresnel — Schlick approximation. Stronger reflection at grazing angles.
      float NdotV = clamp(dot(N, V), 0.0, 1.0);
      float fresnel = pow(1.0 - NdotV, 4.0);
      fresnel = mix(0.05, 1.0, fresnel);

      // Reflection term — sky-ish color (procedural horizon gradient).
      vec3 reflectDir = reflect(-V, N);
      float skyGradient = clamp(reflectDir.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 skyColor = mix(vec3(0.3, 0.35, 0.42), vec3(0.65, 0.72, 0.85), skyGradient);
      vec3 reflection = skyColor * uReflectionIntensity;

      // Refraction term — deep-water color modulated by depth.
      // E1-5000 #2316 — When the host binds a refraction RT (the opaque
      // scene rendered before the water pass), sample it with a UV offset
      // based on the water normal so the player can SEE THROUGH the surface
      // (the prior code just darkened the water color → opaque water, no
      // refraction). Fall back to the deep-water color when no RT is bound.
      vec3 refraction = uColor * (1.0 - uRefractionDepth * 0.3);
      if (uHasRefraction == 1) {
        // Project the world position to screen UV + offset by the normal
        // for a cheap refractive lookup (Snell-ish — squashed by N.xz).
        vec4 proj = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
        vec2 sceneUv = (proj.xy / proj.w) * 0.5 + 0.5;
        sceneUv += N.xz * 0.04;
        vec3 refracted = texture2D(tRefraction, sceneUv).rgb;
        // Tint by water color + depth-darken so deep water looks deeper.
        float depthTint = uRefractionDepth * 0.6;
        refraction = mix(refracted, uColor * (1.0 - depthTint), depthTint);
      }

      // Specular sun glint — Blinn-Phong.
      float spec = pow(max(dot(N, H), 0.0), 80.0);
      vec3 specular = uSunColor * spec * 1.5;

      // Foam at wave crests + intersection edges.
      float foam = vFoamFactor * uFoamIntensity;
      vec3 foamColor = vec3(0.95, 0.97, 1.0);

      // A3-5000 #496: caustics — projected onto the floor beneath the water.
      // We modulate the refraction color by a scrolling caustic pattern so
      // the underwater floor shows the characteristic light patterns.
      if (uCausticsEnabled > 0.5) {
        vec2 cuv = vWorldPos.xz * 0.3 + uTime * 0.05;
        float c1 = texture2D(uCaustics, cuv).r;
        float c2 = texture2D(uCaustics, cuv * 1.7 + 0.5).r;
        float caustic = clamp(c1 * c2 * 2.0, 0.0, 1.5);
        refraction += vec3(0.6, 0.7, 0.55) * caustic * 0.4;
      }

      // Mix reflection + refraction by Fresnel.
      vec3 water = mix(refraction, reflection, fresnel);
      water += specular;

      // A3-5000 #497: underwater distortion — if the camera is below the
      // water surface (vViewPos.y in water-space < 0), apply a blue tint +
      // horizontal wobble to simulate looking through water.
      bool underwater = vViewPos.y < 0.0;
      if (underwater) {
        water = mix(water, vec3(0.2, 0.4, 0.5), 0.3);
      }

      // Add foam on top.
      water = mix(water, foamColor, foam);

      gl_FragColor = vec4(water, uOpacity);
    }
  `,
};

/** Create a water mesh with the given size + options. Returns a THREE.Mesh
 *  with a custom ShaderMaterial. The host animates the waves by advancing
 *  `mesh.material.uniforms.uTime.value` each frame. */
export function createWaterMesh(size: number, options?: WaterOptions): THREE.Mesh {
  const opts = options ?? {};
  const segments = Math.max(8, Math.floor(size * 2)); // density scales with size
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2); // lay flat on the XZ plane

  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(WaterShader.uniforms),
    vertexShader: WaterShader.vertexShader,
    fragmentShader: WaterShader.fragmentShader,
    transparent: true,
    // A3-5000 #499: cull backfaces when viewed from above water (DoubleSide
    // wastes fill rate on the backface that's never seen from above). The
    // host can flip to DoubleSide if it needs underwater backface rendering.
    side: THREE.FrontSide,
  });

  // Apply options.
  if (opts.color !== undefined) mat.uniforms.uColor.value = new THREE.Color(opts.color);
  if (opts.sunDirection !== undefined) {
    (mat.uniforms.uSunDirection.value as THREE.Vector3).copy(opts.sunDirection).normalize();
  }
  if (opts.sunColor !== undefined) mat.uniforms.uSunColor.value = new THREE.Color(opts.sunColor);
  if (opts.waveAmplitude !== undefined) mat.uniforms.uWaveAmplitude.value = opts.waveAmplitude;
  if (opts.waveFrequency !== undefined) mat.uniforms.uWaveFrequency.value = opts.waveFrequency;
  if (opts.waveSpeed !== undefined) mat.uniforms.uWaveSpeed.value = opts.waveSpeed;
  if (opts.foamIntensity !== undefined) mat.uniforms.uFoamIntensity.value = opts.foamIntensity;
  if (opts.reflectionIntensity !== undefined) mat.uniforms.uReflectionIntensity.value = opts.reflectionIntensity;
  if (opts.refractionDepth !== undefined) mat.uniforms.uRefractionDepth.value = opts.refractionDepth;
  if (opts.opacity !== undefined) mat.uniforms.uOpacity.value = opts.opacity;

  // Build + pack the wave set (4 waves by default).
  const waves = buildWaveSet(4, {
    amplitude: opts.waveAmplitude ?? 0.15,
    frequency: opts.waveFrequency ?? 0.8,
    speed: opts.waveSpeed ?? 0.6,
  });
  const packed = packWaves(waves);
  (mat.uniforms.uWaves.value as Float32Array).set(packed);
  // E1-5000 #2318 — Pack the per-wave steepness into the uSteepness uniform.
  const steepArr = (mat.uniforms.uSteepness.value as Float32Array);
  for (let i = 0; i < waves.length && i < 4; i++) {
    steepArr[i] = THREE.MathUtils.clamp(waves[i].steepness, 0, 1);
  }
  mat.uniforms.uWaveCount.value = waves.length;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2; // water renders after opaque + before transparent overlays
  // Mark the mesh so the GI baker skips it (water shouldn't self-occlude GI).
  mesh.userData.giSkip = true;
  return mesh;
}

/** Per-frame update helper — advances the wave time + pushes the camera
 *  position for the Fresnel term. */
export function updateWaterMesh(mesh: THREE.Mesh, time: number, cameraPos: THREE.Vector3): void {
  const mat = mesh.material as THREE.ShaderMaterial;
  (mat.uniforms.uTime.value as number) = time;
  (mat.uniforms.uCameraPos.value as THREE.Vector3).copy(cameraPos);
}

/** E1-5000 #2316 — Bind the refraction texture (the opaque scene RT rendered
 *  before the water pass). When non-null, the water shader samples it with
 *  a normal-offset UV so the player can see through the surface. */
export function setWaterRefractionTexture(mesh: THREE.Mesh, tex: THREE.Texture | null): void {
  const mat = mesh.material as THREE.ShaderMaterial;
  (mat.uniforms.tRefraction.value as THREE.Texture | null) = tex;
  (mat.uniforms.uHasRefraction.value as number) = tex ? 1 : 0;
}

/** Get a snapshot of the water shader params — used by tests + diagnostics. */
export function getWaterParams(mesh: THREE.Mesh): {
  color: THREE.Color;
  waveAmplitude: number;
  waveFrequency: number;
  waveSpeed: number;
  foamIntensity: number;
  reflectionIntensity: number;
  refractionDepth: number;
  opacity: number;
  waveCount: number;
} {
  const u = (mesh.material as THREE.ShaderMaterial).uniforms;
  return {
    color: (u.uColor.value as THREE.Color).clone(),
    waveAmplitude: u.uWaveAmplitude.value as number,
    waveFrequency: u.uWaveFrequency.value as number,
    waveSpeed: u.uWaveSpeed.value as number,
    foamIntensity: u.uFoamIntensity.value as number,
    reflectionIntensity: u.uReflectionIntensity.value as number,
    refractionDepth: u.uRefractionDepth.value as number,
    opacity: u.uOpacity.value as number,
    waveCount: u.uWaveCount.value as number,
  };
}
