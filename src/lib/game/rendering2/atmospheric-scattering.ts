/**
 * Section A — Atmospheric scattering (Rayleigh + Mie).
 * Real sky color comes from sunlight scattering through the atmosphere:
 *   - Rayleigh: air molecules scatter short wavelengths (blue) more → blue sky.
 *   - Mie: aerosols/dust scatter all wavelengths with a forward lobe → haze.
 * Exposes:
 *   - rayleighPhase() / miePhase() — pure phase-function evaluators.
 *   - atmosphericScatter() — view-ray scattering integral (pure).
 *   - createAtmosphericSkyMaterial() — sky-dome ShaderMaterial.
 *   - AerialPerspectivePass — post-process aerial-perspective tint.
 *   - ATMOSPHERE_DEFAULTS — config-driven data table.
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface AtmosphereConfig {
  rayleighCoefficients: THREE.Vector3;
  mieCoefficient: number;
  mieDirectionalG: number;
  sunIntensity: number;
  thickness: number;
  samples: number;
}

export const ATMOSPHERE_DEFAULTS: AtmosphereConfig = {
  rayleighCoefficients: new THREE.Vector3(5.5e-6, 13.0e-6, 22.4e-6),
  mieCoefficient: 21e-6,
  mieDirectionalG: 0.758,
  sunIntensity: 22.0,
  thickness: 1.0,
  samples: 8,
};

/** Rayleigh phase function — angular distribution for air molecules. */
export function rayleighPhase(cosTheta: number): number {
  return (3.0 / (16.0 * Math.PI)) * (1.0 + cosTheta * cosTheta);
}

/** Mie phase function — Henyey-Greenstein approximation. */
export function miePhase(cosTheta: number, g: number): number {
  const g2 = g * g;
  const num = (1.0 - g2) * (1.0 + cosTheta * cosTheta);
  const denom = (1.0 + g2 - 2.0 * g * cosTheta) * Math.sqrt(1.0 + g2 - 2.0 * g * cosTheta);
  return (3.0 / (8.0 * Math.PI)) * num / Math.max(denom, 1e-6);
}

/** Evaluate atmospheric scattering for a single view ray. Pure. */
export function atmosphericScatter(
  viewDir: THREE.Vector3, sunDir: THREE.Vector3,
  config: AtmosphereConfig = ATMOSPHERE_DEFAULTS,
): THREE.Color {
  const cosTheta = viewDir.dot(sunDir);
  const zenith = Math.max(0.0, viewDir.y);
  const opticalDepth = config.thickness / Math.max(zenith, 0.05);
  const betaR = config.rayleighCoefficients.clone().multiplyScalar(opticalDepth);
  const rayleigh = new THREE.Vector3(Math.exp(-betaR.x), Math.exp(-betaR.y), Math.exp(-betaR.z));
  const mie = Math.exp(-config.mieCoefficient * opticalDepth);
  const pr = rayleighPhase(cosTheta);
  const pm = miePhase(cosTheta, config.mieDirectionalG);
  const sun = new THREE.Vector3(1.0, 0.95, 0.88).multiplyScalar(config.sunIntensity);
  return new THREE.Color(
    sun.x * (rayleigh.x * pr + mie * pm) * 0.05,
    sun.y * (rayleigh.y * pr + mie * pm) * 0.05,
    sun.z * (rayleigh.z * pr + mie * pm) * 0.05,
  );
}

const SCATTER_GLSL = `
  float rayleighPhase(float c) { return (3.0 / 16.0 * 3.14159265) * (1.0 + c * c); }
  float miePhase(float c, float g) {
    float g2 = g * g;
    float num = (1.0 - g2) * (1.0 + c * c);
    float denom = (1.0 + g2 - 2.0 * g * c) * sqrt(max(1.0 + g2 - 2.0 * g * c, 1e-6));
    return (3.0 / 8.0 * 3.14159265) * num / max(denom, 1e-6);
  }
  vec3 scatterColor(vec3 viewDir, vec3 sunDir, vec3 rayleighCoef, float mie, float g, float sunInt, float thickness) {
    float cosTheta = dot(viewDir, sunDir);
    float zenith = max(viewDir.y, 0.0);
    float opticalDepth = thickness / max(zenith, 0.05);
    vec3 betaR = rayleighCoef * opticalDepth;
    vec3 rayleigh = vec3(exp(-betaR.x), exp(-betaR.y), exp(-betaR.z));
    float m = exp(-mie * opticalDepth);
    float pr = rayleighPhase(cosTheta);
    float pm = miePhase(cosTheta, g);
    return sunDir * sunInt * (rayleigh * pr + vec3(m) * pm) * 0.05;
  }
`;

/** Sky-dome material — renders the full Rayleigh + Mie model. */
export function createAtmosphericSkyMaterial(
  config: AtmosphereConfig = ATMOSPHERE_DEFAULTS,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDirection: { value: new THREE.Vector3(0.5, 0.7, -0.5).normalize() },
      uSunColor: { value: new THREE.Color(1.0, 0.95, 0.82) },
      uRayleigh: { value: config.rayleighCoefficients.clone() },
      uMie: { value: config.mieCoefficient },
      uMieG: { value: config.mieDirectionalG },
      uSunIntensity: { value: config.sunIntensity },
      uThickness: { value: config.thickness },
      uHorizonColor: { value: new THREE.Color(0.7, 0.65, 0.55) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldDir;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldDir = normalize(wp.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorldDir;
      uniform vec3 uSunDirection; uniform vec3 uSunColor; uniform vec3 uRayleigh;
      uniform float uMie; uniform float uMieG; uniform float uSunIntensity;
      uniform float uThickness; uniform vec3 uHorizonColor;
      ${SCATTER_GLSL}
      void main() {
        vec3 viewDir = normalize(vWorldDir);
        vec3 col = scatterColor(viewDir, uSunColor, uRayleigh, uMie, uMieG, uSunIntensity, uThickness);
        float horizonMix = 1.0 - smoothstep(0.0, 0.25, max(viewDir.y, 0.0));
        col = mix(col, uHorizonColor * uSunIntensity * 0.02, horizonMix * 0.6);
        if (viewDir.y < 0.0) col = uHorizonColor * 0.4 * (1.0 + viewDir.y);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide, depthWrite: false, depthTest: false,
  });
}

export const AerialPerspectiveShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uProjection: { value: new THREE.Matrix4() },
    uInverseProjection: { value: new THREE.Matrix4() },
    uInverseView: { value: new THREE.Matrix4() },
    uSunDirection: { value: new THREE.Vector3(-0.5, 0.7, -0.5).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.95, 0.82) },
    uRayleigh: { value: new THREE.Vector3(5.5e-6, 13.0e-6, 22.4e-6) },
    uMie: { value: 21e-6 }, uMieG: { value: 0.758 },
    uSunIntensity: { value: 22.0 }, uThickness: { value: 1.0 },
    uFogStart: { value: 30.0 }, uFogEnd: { value: 200.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform mat4 uProjection; uniform mat4 uInverseProjection; uniform mat4 uInverseView;
    uniform vec3 uSunDirection; uniform vec3 uSunColor; uniform vec3 uRayleigh;
    uniform float uMie; uniform float uMieG; uniform float uSunIntensity;
    uniform float uThickness; uniform float uFogStart; uniform float uFogEnd;
    varying vec2 vUv;
    ${SCATTER_GLSL}
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).r;
      if (depth >= 0.9999) { gl_FragColor = col; return; }
      vec4 view = uInverseProjection * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec3 viewPos = view.xyz / max(abs(view.w), 1e-6);
      vec3 worldPos = (uInverseView * vec4(viewPos, 1.0)).xyz;
      float dist = length(worldPos - cameraPosition);
      float fogFactor = clamp((dist - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
      if (fogFactor < 0.001) { gl_FragColor = col; return; }
      vec3 viewDir = normalize(worldPos - cameraPosition);
      vec3 scatter = scatterColor(viewDir, uSunColor, uRayleigh, uMie, uMieG, uSunIntensity, uThickness);
      gl_FragColor = vec4(mix(col.rgb, scatter, fogFactor * 0.7), col.a);
    }
  `,
};

/** Aerial-perspective post-process pass. */
export class AerialPerspectivePass {
  readonly pass: ShaderPass;
  private enabled = true;
  constructor(config: AtmosphereConfig = ATMOSPHERE_DEFAULTS) {
    this.pass = new ShaderPass(AerialPerspectiveShader);
    const u = this.pass.material.uniforms;
    (u.uRayleigh.value as THREE.Vector3).copy(config.rayleighCoefficients);
    (u.uMie.value as number) = config.mieCoefficient;
    (u.uMieG.value as number) = config.mieDirectionalG;
    (u.uSunIntensity.value as number) = config.sunIntensity;
    (u.uThickness.value as number) = config.thickness;
  }
  setDepthTexture(tex: THREE.DepthTexture): void { (this.pass.material.uniforms.tDepth.value as THREE.DepthTexture | null) = tex; }
  setSunDirection(dir: THREE.Vector3): void { (this.pass.material.uniforms.uSunDirection.value as THREE.Vector3).copy(dir).normalize(); }
  setSunColor(c: THREE.Color): void { (this.pass.material.uniforms.uSunColor.value as THREE.Color).copy(c); }
  setFogRange(start: number, end: number): void {
    (this.pass.material.uniforms.uFogStart.value as number) = start;
    (this.pass.material.uniforms.uFogEnd.value as number) = end;
  }
  setEnabled(v: boolean): void { this.enabled = v; this.pass.enabled = v; }
  isEnabled(): boolean { return this.enabled; }
  update(camera: THREE.Camera): void {
    if (!this.enabled) return;
    camera.updateMatrixWorld();
    const u = this.pass.material.uniforms;
    (u.uProjection.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (u.uInverseProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uInverseView.value as THREE.Matrix4).copy(camera.matrixWorld);
  }
  setSize(_w: number, _h: number): void { void _w; void _h; }
  dispose(): void { this.pass.dispose(); }
}
