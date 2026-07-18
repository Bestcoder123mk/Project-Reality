/**
 * Section A — True-to-life water caustics (enhancement for water.ts).
 *
 * Caustics are the bright web-like patterns formed on the floor under water
 * when sunlight refracts through the wavy surface. Real caustics require
 * bidirectional ray tracing (surface → floor); this module approximates them
 * with a procedural SWE (shallow-water-equation) simulation that:
 *
 *   - Maintains a 2D height-field grid (CPU-side, double-buffered).
 *   - Steps the SWE simulation each frame (water-wave propagation).
 *   - Computes the refraction-direction map (gradient of the height field)
 *     → caustic intensity on the floor below.
 *   - Renders the caustic pattern as a screen-space post-process decal that
 *     projects onto the floor via the depth buffer (so caustics appear on
 *     geometry below water, not on the water surface itself).
 *
 * Integration: water.ts owns the water SURFACE; this module owns the FLOOR
 * caustics + the SWE simulation driving them. The host adds the caustic
 * post-process pass AFTER the water surface render + BEFORE the GI gather
 * pass (so the caustics participate in indirect lighting).
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface WaterCausticsConfig {
  /** SWE simulation grid resolution (NxN). Larger = sharper caustics. */
  gridResolution: number;
  /** World-space size of the caustic field (square meters). */
  worldSize: number;
  /** Water depth (meters) — affects caustic sharpness + intensity. */
  depth: number;
  /** Sun direction (world-space, the direction the light travels toward). */
  sunDirection: THREE.Vector3;
  /** Caustic intensity multiplier (0..2). */
  intensity: number;
  /** Caustic tint (linear color). */
  color: THREE.Color;
  /** Animation speed (1.0 = real-time). */
  speed: number;
  /** Wave amplitude (drives SWE init conditions). */
  waveAmplitude: number;
}

export const WATER_CAUSTICS_DEFAULTS: WaterCausticsConfig = {
  gridResolution: 128,
  worldSize: 40,
  depth: 1.5,
  sunDirection: new THREE.Vector3(-0.5, -0.7, -0.5).normalize(),
  intensity: 0.8,
  color: new THREE.Color(0.6, 0.85, 0.95),
  speed: 1.0,
  waveAmplitude: 0.15,
};

/** SWE simulation state — double-buffered height-field + velocity field. */
export interface SWESimulation {
  height: Float32Array;     // current height field
  heightPrev: Float32Array; // previous frame (for time integration)
  velocity: Float32Array;   // 2D velocity field (interleaved x, z)
  resolution: number;
}

/** Create a new SWE simulation. */
export function createSWESimulation(resolution: number): SWESimulation {
  const n = resolution * resolution;
  return {
    height: new Float32Array(n),
    heightPrev: new Float32Array(n),
    velocity: new Float32Array(n * 2),
    resolution,
  };
}

/** Initialize the SWE height field with a small Gaussian bump + noise. */
export function initSWESimulation(
  sim: SWESimulation,
  amplitude: number,
): void {
  const n = sim.resolution;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x - n / 2) / (n / 2);
      const dy = (y - n / 2) / (n / 2);
      const r = Math.hypot(dx, dy);
      const bump = Math.exp(-r * r * 4) * amplitude;
      const noise = (Math.random() - 0.5) * amplitude * 0.2;
      sim.height[y * n + x] = bump + noise;
      sim.heightPrev[y * n + x] = sim.height[y * n + x];
    }
  }
}

/** Step the SWE simulation — single Jacobi iteration of the wave equation.
 *  d²h/dt² = c² ∇²h  →  h(t+dt) = 2 h(t) - h(t-dt) + c² dt² ∇²h. */
export function stepSWESimulation(sim: SWESimulation, dt: number): void {
  const n = sim.resolution;
  const c2 = 1.0; // wave speed squared (normalized)
  const damp = 0.995; // damping to prevent ringing
  // Swap height + heightPrev.
  const tmp = sim.heightPrev;
  sim.heightPrev = sim.height;
  sim.height = tmp;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      const laplacian =
        sim.heightPrev[i - 1] +
        sim.heightPrev[i + 1] +
        sim.heightPrev[i - n] +
        sim.heightPrev[i + n] -
        4 * sim.heightPrev[i];
      sim.height[i] =
        (2 * sim.heightPrev[i] - sim.height[i] + c2 * dt * dt * laplacian) * damp;
    }
  }
  // Boundary — zero Dirichlet (waves reflect inverted at the boundary).
  for (let i = 0; i < n; i++) {
    sim.height[i] = 0;
    sim.height[(n - 1) * n + i] = 0;
    sim.height[i * n] = 0;
    sim.height[i * n + n - 1] = 0;
  }
}

/** Convert the SWE height field to a caustic-intensity texture. Caustic
 *  intensity ≈ ∇²h (the Laplacian of the height field — focusing occurs
 *  where the surface is concave). */
export function computeCausticIntensity(
  sim: SWESimulation,
  out: Uint8Array,
  intensity: number,
): void {
  const n = sim.resolution;
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      const lap =
        sim.height[i - 1] +
        sim.height[i + 1] +
        sim.height[i - n] +
        sim.height[i + n] -
        4 * sim.height[i];
      // Caustic intensity = max(0, -lap) (concave surface focuses light).
      const c = Math.max(0, -lap) * intensity;
      const o = i * 4;
      out[o] = Math.min(255, c * 255 * 4) | 0;
      out[o + 1] = Math.min(255, c * 255 * 4) | 0;
      out[o + 2] = Math.min(255, c * 255 * 4) | 0;
      out[o + 3] = 255;
    }
  }
}

export const WaterCausticsShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    tCaustics: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() },
    uInverseProjection: { value: new THREE.Matrix4() },
    uInverseView: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uIntensity: { value: 0.8 },
    uColor: { value: new THREE.Color(0.6, 0.85, 0.95) },
    uWorldSize: { value: 40.0 },
    uWaterLevel: { value: 0.0 },
    uMaxDepth: { value: 5.0 },
    uSunDirection: { value: new THREE.Vector3(-0.5, -0.7, -0.5).normalize() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tCaustics;
    uniform mat4 uProjection;
    uniform mat4 uInverseProjection;
    uniform mat4 uInverseView;
    uniform vec2 uResolution;
    uniform float uIntensity;
    uniform vec3 uColor;
    uniform float uWorldSize;
    uniform float uWaterLevel;
    uniform float uMaxDepth;
    uniform vec3 uSunDirection;
    varying vec2 vUv;

    vec3 reconstructViewPos(vec2 uv, float depth) {
      float z = depth * 2.0 - 1.0;
      vec4 clip = vec4(uv * 2.0 - 1.0, z, 1.0);
      vec4 view = uInverseProjection * clip;
      return view.xyz / max(abs(view.w), 1e-6);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      if (uIntensity < 0.001) { gl_FragColor = col; return; }
      float depth = texture2D(tDepth, vUv).r;
      if (depth >= 0.9999) { gl_FragColor = col; return; }
      // Reconstruct world position.
      vec3 viewPos = reconstructViewPos(vUv, depth);
      vec4 worldPos4 = uInverseView * vec4(viewPos, 1.0);
      vec3 worldPos = worldPos4.xyz;
      // Only apply caustics BELOW the water level.
      if (worldPos.y > uWaterLevel - 0.05) {
        gl_FragColor = col;
        return;
      }
      // Depth below water (clamped to uMaxDepth for falloff).
      float depthBelow = clamp(uWaterLevel - worldPos.y, 0.0, uMaxDepth);
      float depthFalloff = 1.0 - depthBelow / uMaxDepth;
      // Project the caustic texture onto the floor — tiles every uWorldSize.
      vec2 causticUv = worldPos.xz / uWorldSize + 0.5;
      vec3 caustic = texture2D(tCaustics, causticUv).rgb;
      // Apply the caustic color + intensity + depth falloff.
      vec3 causticColor = caustic * uColor * uIntensity * depthFalloff;
      // Additive blend — caustics only brighten (never darken).
      gl_FragColor = vec4(col.rgb + causticColor, col.a);
    }
  `,
};

/** Water caustics pass — owns the SWE simulation + caustic texture. */
export class WaterCausticsPass {
  readonly pass: ShaderPass;
  private config: WaterCausticsConfig;
  private enabled = true;
  private sim: SWESimulation;
  private causticTexture: THREE.DataTexture;
  private causticData: Uint8Array;
  private accum = 0;

  constructor(config: WaterCausticsConfig = { ...WATER_CAUSTICS_DEFAULTS }) {
    this.config = { ...config };
    this.sim = createSWESimulation(this.config.gridResolution);
    initSWESimulation(this.sim, this.config.waveAmplitude);
    this.causticData = new Uint8Array(this.config.gridResolution * this.config.gridResolution * 4);
    this.causticTexture = new THREE.DataTexture(
      this.causticData,
      this.config.gridResolution,
      this.config.gridResolution,
      THREE.RGBAFormat,
    );
    this.causticTexture.wrapS = THREE.RepeatWrapping;
    this.causticTexture.wrapT = THREE.RepeatWrapping;
    this.causticTexture.needsUpdate = true;
    this.pass = new ShaderPass(WaterCausticsShader);
    const u = this.pass.material.uniforms;
    u.tCaustics.value = this.causticTexture;
    u.uIntensity.value = this.config.intensity;
    u.uColor.value = this.config.color;
    u.uWorldSize.value = this.config.worldSize;
    u.uSunDirection.value = this.config.sunDirection;
  }

  setDepthTexture(tex: THREE.DepthTexture): void {
    (this.pass.material.uniforms.tDepth.value as THREE.DepthTexture | null) = tex;
  }

  setWaterLevel(y: number): void {
    (this.pass.material.uniforms.uWaterLevel.value as number) = y;
  }

  setSunDirection(dir: THREE.Vector3): void {
    (this.pass.material.uniforms.uSunDirection.value as THREE.Vector3)
      .copy(dir).normalize();
  }

  setIntensity(i: number): void {
    this.config.intensity = THREE.MathUtils.clamp(i, 0, 2);
    (this.pass.material.uniforms.uIntensity.value as number) = this.config.intensity;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.pass.enabled = v;
  }
  isEnabled(): boolean { return this.enabled; }

  /** Per-frame update — steps the SWE simulation + recomputes the caustic
   *  intensity texture. Called by the host at most once per frame. */
  update(dt: number, camera: THREE.Camera): void {
    if (!this.enabled) return;
    this.accum += dt * this.config.speed;
    // Step the SWE simulation at a fixed dt (multiple sub-steps if the frame
    // dt is large — keeps the simulation stable).
    const subSteps = Math.min(4, Math.ceil(dt * 60));
    const subDt = dt / subSteps;
    for (let i = 0; i < subSteps; i++) {
      stepSWESimulation(this.sim, subDt);
    }
    // Compute the caustic intensity texture.
    computeCausticIntensity(this.sim, this.causticData, this.config.intensity);
    this.causticTexture.needsUpdate = true;
    // Update camera matrices.
    camera.updateMatrixWorld();
    const u = this.pass.material.uniforms;
    (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (u.uInverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uInverseView.value as THREE.Matrix4).copy(camera.matrixWorld);
  }

  setSize(w: number, h: number): void {
    (this.pass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  /** Drop a ripple into the SWE simulation at a world position (e.g. when
   *  a player walks into water or a bullet hits the surface). */
  addRipple(worldX: number, worldZ: number, strength: number): void {
    const n = this.config.gridResolution;
    const cx = Math.round((worldX / this.config.worldSize + 0.5) * n);
    const cz = Math.round((worldZ / this.config.worldSize + 0.5) * n);
    if (cx < 1 || cx >= n - 1 || cz < 1 || cz >= n - 1) return;
    // Apply a small Gaussian dip at the impact point.
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const r2 = dx * dx + dy * dy;
        const falloff = Math.exp(-r2 * 0.5);
        const i = (cz + dy) * n + (cx + dx);
        this.sim.height[i] -= strength * falloff;
      }
    }
  }

  dispose(): void {
    this.pass.dispose();
    this.causticTexture.dispose();
  }

  getConfig(): Readonly<WaterCausticsConfig> { return this.config; }
  getSimulation(): Readonly<SWESimulation> { return this.sim; }
}
