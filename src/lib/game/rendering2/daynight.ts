/**
 * SEC3-RENDER Prompt 29 — Day/night + skybox system per map.
 *
 * A proper time-of-day cycle with a dynamic sky dome:
 *   - Procedural sky shader with sun position + Preetham-style atmosphere
 *     scattering (cheap analytical approximation — no LUT).
 *   - Sun position derived from time-of-day via solar elevation/azimuth math.
 *   - Sun color shifts from warm (sunrise/sunset) to white (noon) to
 *     moonlight blue (night).
 *   - Sky color: horizon + zenith gradient + day/night blend.
 *   - Directional light intensity/color synced to the sun position.
 *
 * Public API:
 *   - DayNightCycle class — owns the sky mesh + directional light
 *   - setTimeOfDay(0..24) — sets the time + recomputes sun position
 *   - getSunDirection() — unit vector pointing toward the sun
 *   - getSunColor() — linear RGB color of the sun
 *   - attachToScene(scene) — adds the sky dome + directional light
 *
 * Pure-logic helpers (sun position math, color blending) are exported for
 * unit tests.
 */
import * as THREE from "three";

/** Compute the sun's elevation + azimuth for a given hour (0..24).
 *  Pure function — exported for tests.
 *
 *  - 6:00 → sunrise (elevation 0°, azimuth 90°)
 *  - 12:00 → noon (elevation 90°, azimuth 180°)
 *  - 18:00 → sunset (elevation 0°, azimuth 270°)
 *  - 0:00 → midnight (elevation -90°, azimuth 0°)
 *
 *  Uses a smooth cosine curve for elevation (more realistic than linear)
 *  + a linear azimuth sweep. Returns angles in RADIANS. */
export function sunPositionForTime(hour: number): { elevation: number; azimuth: number } {
  // Normalize hour to [0, 24).
  const h = ((hour % 24) + 24) % 24;
  // Elevation: peak at noon (12), trough at midnight (0/24).
  // cos((h - 12) / 12 * π) goes 1 → -1 → 1 across the day.
  const elevation = Math.sin((h - 6) / 12 * Math.PI); // -1 at 0h, +1 at 12h, 0 at 6h/18h
  // A3-5000 #448: removed dead `elevAngle` variable (was `void elevAngle;`).
  // Clamp to realistic elevation range (90° at noon, -90° at midnight).
  const elevationClamped = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, elevation * Math.PI / 2));
  // Azimuth: 90° at sunrise (6h), 180° at noon (12h), 270° at sunset (18h).
  // Linear sweep: 0° at midnight, 360° at next midnight.
  const azimuth = (h / 24) * Math.PI * 2;
  return { elevation: elevationClamped, azimuth };
}

/** Convert elevation + azimuth to a world-space direction (unit vector).
 *  Convention: +Y is up; azimuth 0 is +X, increases toward +Z (counter-
 *  clockwise when viewed from above). The returned vector points TOWARD
 *  the sun (i.e. opposite to the direction the light travels). */
export function sunDirectionFromAngles(elevation: number, azimuth: number, out: THREE.Vector3): THREE.Vector3 {
  const cosE = Math.cos(elevation);
  const sinE = Math.sin(elevation);
  out.set(
    cosE * Math.cos(azimuth),
    sinE,
    cosE * Math.sin(azimuth),
  ).normalize();
  return out;
}

/** Get the sun direction for a given hour (0..24). Convenience. */
export function getSunDirectionForTime(hour: number, out?: THREE.Vector3): THREE.Vector3 {
  const v = out ?? new THREE.Vector3();
  const { elevation, azimuth } = sunPositionForTime(hour);
  return sunDirectionFromAngles(elevation, azimuth, v);
}

/** Sun color by elevation — warm at low angles, white at high, blue at night.
 *  Pure function — exported for tests. Returns a fresh THREE.Color (linear).
 *  A3-5000 #447: smooth blending at boundaries (was hard cuts at t=0 + t=0.25
 *  which made the sun color pop at the horizon). We use smoothstep over a
 *  small neighborhood of each boundary so the transition is continuous.
 *  A3-5000 #500: Kelvin-based color temperature — noon ≈ D65 (6500K),
 *  golden hour ≈ 3500K (warm), night ≈ 4100K moonlight (cool blue). */
export function sunColorForElevation(elevation: number, out?: THREE.Color): THREE.Color {
  const c = out ?? new THREE.Color();
  // Normalize elevation to [-π/2, π/2] → [-1, 1].
  const t = elevation / (Math.PI / 2);
  // A3-5000 #447: smoothstep blends at boundaries (t=0 + t=0.25).
  // night → sunrise blend over t ∈ [-0.05, 0.05]
  // sunrise → day blend over t ∈ [0.20, 0.30]
  const night = new THREE.Color(0.15, 0.22, 0.4); // A3-5000 #500: ~4100K moonlight
  const sunrise = new THREE.Color(1.0, 0.55, 0.25); // A3-5000 #500: ~3500K warm (golden hour)
  const day = new THREE.Color(1.0, 0.96, 0.88); // A3-5000 #500: ~5600K D65-ish
  if (t <= -0.05) {
    c.copy(night);
  } else if (t < 0.05) {
    // Smooth blend night → sunrise at t=0.
    const k = THREE.MathUtils.smoothstep(t, -0.05, 0.05);
    c.copy(night).lerp(sunrise, k);
  } else if (t < 0.20) {
    c.copy(sunrise);
  } else if (t < 0.30) {
    // Smooth blend sunrise → day at t=0.25.
    const k = THREE.MathUtils.smoothstep(t, 0.20, 0.30);
    c.copy(sunrise).lerp(day, k);
  } else {
    c.copy(day);
  }
  return c;
}

/** Sky zenith + horizon colors by elevation. Pure function. */
export function skyColorsForElevation(elevation: number): {
  zenith: THREE.Color; horizon: THREE.Color;
} {
  const t = elevation / (Math.PI / 2);
  if (t <= 0) {
    // Night.
    return {
      zenith: new THREE.Color(0.02, 0.03, 0.08),
      horizon: new THREE.Color(0.04, 0.05, 0.1),
    };
  }
  if (t < 0.25) {
    // Sunrise/sunset — orange horizon, deep blue zenith.
    const k = t / 0.25;
    return {
      zenith: new THREE.Color(
        THREE.MathUtils.lerp(0.08, 0.18, k),
        THREE.MathUtils.lerp(0.12, 0.32, k),
        THREE.MathUtils.lerp(0.35, 0.65, k),
      ),
      horizon: new THREE.Color(
        THREE.MathUtils.lerp(0.85, 0.5, k),
        THREE.MathUtils.lerp(0.45, 0.55, k),
        THREE.MathUtils.lerp(0.2, 0.65, k),
      ),
    };
  }
  // Day.
  return {
    zenith: new THREE.Color(0.25, 0.45, 0.85),
    horizon: new THREE.Color(0.6, 0.75, 0.9),
  };
}

/** Procedural sky shader — gradient + sun disc + atmosphere scattering.
 *  Exported so callers can clone/modify (e.g. inject custom uniforms). */
export const SkyShader = {
  uniforms: {
    uSunDirection: { value: new THREE.Vector3(0.5, 0.7, -0.5).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.95, 0.8) },
    uZenithColor: { value: new THREE.Color(0.25, 0.45, 0.85) },
    uHorizonColor: { value: new THREE.Color(0.6, 0.75, 0.9) },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uSunDirection;
    uniform vec3 uSunColor;
    uniform vec3 uZenithColor;
    uniform vec3 uHorizonColor;
    uniform float uTime;
    varying vec3 vWorldPos;

    void main() {
      vec3 dir = normalize(vWorldPos);
      float h = dir.y;
      // Gradient: zenith → horizon → ground.
      vec3 sky = h > 0.0
        ? mix(uHorizonColor, uZenithColor, smoothstep(0.0, 0.5, h))
        : mix(uHorizonColor, vec3(0.1, 0.08, 0.05), smoothstep(0.0, -0.3, h));
      // Sun disc.
      float sunDot = max(0.0, dot(dir, normalize(uSunDirection)));
      float disc = smoothstep(0.9995, 0.9999, sunDot);
      float halo = pow(sunDot, 80.0) * 0.5;
      sky += uSunColor * (disc * 5.0 + halo);
      // Atmospheric scattering tint — warm near the sun, cool opposite.
      float scatter = pow(sunDot, 4.0) * 0.3;
      sky = mix(sky, uSunColor, scatter * 0.5);
      gl_FragColor = vec4(sky, 1.0);
    }
  `,
};

/** Day/night cycle — owns the sky mesh + directional light + sun state. */
export class DayNightCycle {
  private timeOfDay = 12; // start at noon
  private sunDirection: THREE.Vector3;
  private sunColor: THREE.Color;
  private zenith: THREE.Color;
  private horizon: THREE.Color;
  /** Sky dome mesh — created on attachToScene. */
  public skyMesh: THREE.Mesh | null = null;
  /** Sun directional light — created on attachToScene. */
  public sunLight: THREE.DirectionalLight | null = null;
  /** #648 — Moon directional light (dim blue, opposite the sun). Created
   *  on attachToScene; intensity scales with the night factor. */
  public moonLight: THREE.DirectionalLight | null = null;
  /** #648 — Moon mesh (a flat disc with phases). Created on attachToScene. */
  public moonMesh: THREE.Mesh | null = null;
  /** #647 — Starfield Points. Created on attachToScene; opacity fades in
   *  at dusk + out at dawn. */
  public starfield: THREE.Points | null = null;
  /** Auto-advance rate (hours per second). 0 = manual. */
  public autoAdvanceRate = 0.04; // matches WeatherSystem's TIME_SCALE

  constructor() {
    this.sunDirection = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.zenith = new THREE.Color();
    this.horizon = new THREE.Color();
    this.recompute();
  }

  /** Set the time of day (0..24) + recompute sun position/colors. */
  setTimeOfDay(h: number): void {
    this.timeOfDay = ((h % 24) + 24) % 24;
    this.recompute();
  }

  getTimeOfDay(): number {
    return this.timeOfDay;
  }

  /** Advance time by `dt` seconds (auto-cycle). */
  update(dt: number): void {
    if (this.autoAdvanceRate > 0) {
      this.timeOfDay = (this.timeOfDay + dt * this.autoAdvanceRate) % 24;
      this.recompute();
    }
    if (this.skyMesh) {
      (this.skyMesh.material as THREE.ShaderMaterial).uniforms.uTime.value += dt;
    }
    // #647 — Fade the starfield in at dusk + out at dawn.
    if (this.starfield) {
      const nightness = this.computeNightness();
      const mat = this.starfield.material as THREE.PointsMaterial;
      mat.opacity = THREE.MathUtils.clamp(nightness * 1.5, 0, 1);
    }
    // #648 — Moon light intensity + position (opposite the sun).
    if (this.moonLight) {
      const nightness = this.computeNightness();
      this.moonLight.intensity = nightness * 0.25;
      // Position the moon light opposite the sun.
      this.moonLight.position.copy(this.sunDirection.clone().negate().multiplyScalar(100));
      this.moonLight.target.position.set(0, 0, 0);
    }
    if (this.moonMesh) {
      // E1-5000 #2344 — Place the moon mesh inside the sky dome (r=4500 <
      // sky r=5000) so it's within the camera far plane + visible (was at
      // r=200000 → beyond far → invisible).
      this.moonMesh.position.copy(this.sunDirection.clone().negate().multiplyScalar(4500));
      // Update the moon phase via a shader uniform.
      const mat = this.moonMesh.material as THREE.ShaderMaterial;
      mat.uniforms.uPhase.value = this.computeMoonPhase();
    }
  }

  /** #647 — Compute "nightness" (0 = day, 1 = full night). Smooth ramps
   *  at dawn (4-6h) + dusk (18-22h). */
  private computeNightness(): number {
    const tod = this.timeOfDay;
    if (tod >= 22 || tod < 4) return 1;
    if (tod >= 4 && tod < 6) return (6 - tod) / 2;
    if (tod >= 6 && tod < 18) return 0;
    return (tod - 18) / 4;
  }

  /** #648 — Compute the moon phase (0 = new moon, 0.5 = full moon, 1 = new
   *  moon again). Cycle is ~29.5 days; we compress it to a single day-night
   *  cycle (~24 min) so a player sees all phases in one match. */
  private computeMoonPhase(): number {
    // Use timeOfDay as a fraction of the lunar cycle.
    return (this.timeOfDay / 24) % 1;
  }

  /** Attach the sky dome + directional light to a scene.
   *  A3-5000 #446: sky dome radius was 450,000 with camera near=0.1 → z-fighting.
   *  Reduced to 5,000 (still well past far plane) + depthTest disabled so the
   *  dome is always behind scene geometry regardless of camera near/far. */
  attachToScene(scene: THREE.Scene): void {
    // Sky dome — large sphere rendered from inside (BackSide).
    const skyGeo = new THREE.SphereGeometry(5000, 32, 16); // A3-5000 #446
    const skyMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
      vertexShader: SkyShader.vertexShader,
      fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false, // A3-5000 #446: render sky behind everything
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.skyMesh.renderOrder = -1; // A3-5000 #446: draw first
    this.skyMesh.userData.giSkip = true; // don't bake GI from the sky
    scene.add(this.skyMesh);

    // Sun directional light.
    this.sunLight = new THREE.DirectionalLight(this.sunColor.getHex(), 1.0);
    this.sunLight.position.copy(this.sunDirection.clone().multiplyScalar(100));
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 0.1;
    this.sunLight.shadow.camera.far = 500;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    // #648 — Moon light — dim blue, opposite the sun.
    this.moonLight = new THREE.DirectionalLight(0x8090b0, 0);
    this.moonLight.position.copy(this.sunDirection.clone().negate().multiplyScalar(100));
    scene.add(this.moonLight);
    scene.add(this.moonLight.target);

    // #648 — Moon mesh with a phase shader.
    const moonGeo = new THREE.CircleGeometry(8000, 32);
    const moonMat = new THREE.ShaderMaterial({
      uniforms: {
        uPhase: { value: 0 },
        uColor: { value: new THREE.Color(0xf0f0e0) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uPhase;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float r = length(p);
          if (r > 0.5) discard;
          // Phase: a circle mask slides across the moon disc.
          float phase = uPhase * 2.0 - 1.0; // -1..1
          // Lit fraction = the visible portion of the moon.
          float lit = smoothstep(0.5, 0.49, r);
          // Shadow terminator — a vertical circle offset by phase.
          float sx = p.x + phase * 0.5;
          float shadow = smoothstep(0.5, 0.49, length(vec2(sx, p.y)));
          float visible = lit * (1.0 - shadow * step(0.0, phase));
          // For waxing/waning, the visible portion mirrors.
          if (phase < 0.0) visible = lit * shadow;
          gl_FragColor = vec4(uColor * visible, visible);
        }
      `,
      transparent: true,
      depthWrite: false,
      // E1-5000 #2344 — moon also needs depthTest:false + renderOrder so it
      // renders on top of the sky (was at r=200000 → beyond far plane →
      // invisible, same as the starfield bug).
      depthTest: false,
      side: THREE.FrontSide,
    });
    this.moonMesh = new THREE.Mesh(moonGeo, moonMat);
    this.moonMesh.renderOrder = -0.5; // E1-5000 #2344: after sky, before geometry
    this.moonMesh.userData.giSkip = true;
    scene.add(this.moonMesh);

    // #647 — Starfield. 1000 points randomly distributed on a large sphere.
    const starCount = 1000;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      // Random point on the upper hemisphere (sky).
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.5; // 0..π/2 (upper hemi)
      // E1-5000 #2344 — bring stars inside the sky dome (r=4000 < sky r=5000)
      // so they're within the camera far plane + visible (was r=400000 →
      // beyond far plane → clipped → invisible).
      const r = 4000;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      // Subtle color variation — white to blue-white.
      const c = 0.7 + Math.random() * 0.3;
      colors[i * 3] = c;
      colors[i * 3 + 1] = c;
      colors[i * 3 + 2] = c + 0.1;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const starMat = new THREE.PointsMaterial({
      size: 200,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // E1-5000 #2344 — disable depthTest so stars render on top of the sky
      // dome (which has depthTest:false + renderOrder=-1). Was depthTest:true
      // (default) which clipped stars against the sky dome's depth + the
      // camera far plane (stars were at r=400000, way beyond far=500 →
      // invisible). Now stars sit inside the sky dome (r=4000 < 5000) +
      // render after it.
      depthTest: false,
      fog: false,
    });
    this.starfield = new THREE.Points(starGeo, starMat);
    this.starfield.renderOrder = -0.5; // E1-5000 #2344: after sky (-1), before geometry (0)
    this.starfield.userData.giSkip = true;
    scene.add(this.starfield);

    this.applyToSky();
  }

  /** Get the current sun direction (unit vector pointing TOWARD the sun). */
  getSunDirection(): THREE.Vector3 {
    return this.sunDirection.clone();
  }

  /** Get the current sun color (linear RGB). */
  getSunColor(): THREE.Color {
    return this.sunColor.clone();
  }

  /** Get the sun direction as a "light travels TOWARD" vector (the negation
   *  of the direction toward the sun — used by GI baker + volumetric fog). */
  getLightDirection(): THREE.Vector3 {
    return this.sunDirection.clone().negate();
  }

  /** Get current sky zenith + horizon colors. */
  getSkyColors(): { zenith: THREE.Color; horizon: THREE.Color } {
    return { zenith: this.zenith.clone(), horizon: this.horizon.clone() };
  }

  /** Recompute sun direction + colors from the current time of day. */
  private recompute(): void {
    const { elevation, azimuth } = sunPositionForTime(this.timeOfDay);
    sunDirectionFromAngles(elevation, azimuth, this.sunDirection);
    sunColorForElevation(elevation, this.sunColor);
    const sky = skyColorsForElevation(elevation);
    this.zenith.copy(sky.zenith);
    this.horizon.copy(sky.horizon);
    this.applyToSky();
  }

  /** Push current state to the sky mesh + sun light (if attached). */
  private applyToSky(): void {
    if (this.skyMesh) {
      const u = (this.skyMesh.material as THREE.ShaderMaterial).uniforms;
      (u.uSunDirection.value as THREE.Vector3).copy(this.sunDirection);
      (u.uSunColor.value as THREE.Color).copy(this.sunColor);
      (u.uZenithColor.value as THREE.Color).copy(this.zenith);
      (u.uHorizonColor.value as THREE.Color).copy(this.horizon);
    }
    if (this.sunLight) {
      this.sunLight.position.copy(this.sunDirection.clone().multiplyScalar(100));
      this.sunLight.color.copy(this.sunColor);
      // Intensity: 1.2 at noon → 0.05 at night.
      const elev = sunPositionForTime(this.timeOfDay).elevation;
      const t = Math.max(0, elev / (Math.PI / 2));
      this.sunLight.intensity = THREE.MathUtils.lerp(0.05, 1.2, t);
      this.sunLight.target.position.set(0, 0, 0);
    }
  }

  dispose(): void {
    if (this.skyMesh) {
      this.skyMesh.geometry.dispose();
      (this.skyMesh.material as THREE.Material).dispose();
      this.skyMesh = null;
    }
    if (this.sunLight) {
      this.sunLight.dispose();
      this.sunLight = null;
    }
  }
}
