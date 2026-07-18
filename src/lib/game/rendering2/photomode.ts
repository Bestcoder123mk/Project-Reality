/**
 * SEC3-RENDER Prompt 30 — Photo mode.
 *
 * A free-camera + depth-of-field + filters + hide-HUD + capture system.
 * Designed as a self-contained controller the engine can toggle at runtime.
 *
 * When entered, photo mode:
 *   - Saves the active camera's transform (position + quaternion) + the
 *     current HUD visibility + the existing post-processing state.
 *   - Switches the camera to free-flight mode (the host's input system
 *     is responsible for routing pointer/keyboard to the photo mode
 *     controller — we expose `move(dx,dz)`, `rotate(yaw,pitch)`, `dolly(d)`).
 *   - Enables a depth-of-field pass (BokehPass) with configurable aperture
 *     + focus distance.
 *   - Applies one of several filters (none / noir / sepia / vibrant /
 *     cinematic / thermal / night-vision) by adjusting the grade shader's
 *     saturation/contrast or replacing it with a custom shader.
 *   - Hides the HUD (the host's HudSystem reads `photoMode.isHUDHidden()`).
 *
 * Public API:
 *   - enter(camera) — capture state, switch to free-cam
 *   - exit() — restore the captured state
 *   - setDOF(aperture, focusDist) — configure depth of field
 *   - setFilter(name) — apply a filter
 *   - capture() — render-to-target → PNG data URL
 *   - move/rotate/dolly — free-cam controls
 *   - isHUDHidden() — query for the HUD system
 */
import * as THREE from "three";
import type { ShaderPass as _ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export type PhotoModeFilter =
  | "none"
  | "noir"
  | "sepia"
  | "vibrant"
  | "cinematic"
  | "thermal"
  | "night-vision";

/** Filter config — pure data so tests can verify without a renderer. */
export interface FilterConfig {
  name: PhotoModeFilter;
  saturation: number;   // 0..2
  contrast: number;     // 0..2
  brightness: number;   // 0..2
  /** RGB tint multiplier — applied as `color * tint`. */
  tint: [number, number, number];
  /** Optional custom shader name (matches a key in the FilterShaders map). */
  customShader?: "thermal" | "night-vision";
}

export const FILTER_CONFIGS: Record<PhotoModeFilter, FilterConfig> = {
  none:          { name: "none",          saturation: 1.0,  contrast: 1.0,  brightness: 1.0,  tint: [1, 1, 1] },
  noir:          { name: "noir",          saturation: 0.0,  contrast: 1.3,  brightness: 0.95, tint: [1, 1, 1] },
  sepia:         { name: "sepia",         saturation: 0.4,  contrast: 1.1,  brightness: 1.05, tint: [1.15, 0.95, 0.7] },
  vibrant:       { name: "vibrant",       saturation: 1.5,  contrast: 1.15, brightness: 1.05, tint: [1, 1, 1] },
  cinematic:     { name: "cinematic",     saturation: 0.95, contrast: 1.2,  brightness: 0.98, tint: [1.0, 0.97, 0.93] },
  thermal:       { name: "thermal",       saturation: 1.0,  contrast: 1.0,  brightness: 1.0,  tint: [1, 1, 1], customShader: "thermal" },
  "night-vision":{ name: "night-vision",  saturation: 0.3,  contrast: 1.4,  brightness: 1.3,  tint: [0.6, 1.0, 0.6], customShader: "night-vision" },
};

/** Get the config for a filter. Pure function — exported for tests. */
export function getFilterConfig(name: PhotoModeFilter): FilterConfig {
  return FILTER_CONFIGS[name];
}

/** Filter shader for thermal / night-vision (special cases that need custom
 *  code rather than just saturation/contrast/brightness/tint adjustments). */
export const FilterShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uMode: { value: 0 }, // 0 = thermal, 1 = night-vision
    uTime: { value: 0 },
    uIntensity: { value: 1.0 },
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
    uniform int uMode;
    uniform float uTime;
    uniform float uIntensity;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(234.34, 435.345));
      p += dot(p, p + 34.23);
      return fract(p.x * p.y);
    }

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float lum = dot(col.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 outCol;
      if (uMode == 0) {
        // Thermal — luminance mapped to a heat gradient (blue → green → red).
        float t = clamp(lum, 0.0, 1.0);
        outCol.r = smoothstep(0.5, 1.0, t);
        outCol.g = smoothstep(0.2, 0.7, t) * (1.0 - smoothstep(0.8, 1.0, t));
        outCol.b = smoothstep(0.0, 0.3, t) * (1.0 - smoothstep(0.4, 0.6, t));
      } else {
        // Night-vision — green tint + film grain + slight vignette.
        outCol = vec3(0.0, lum, 0.0) * 1.2;
        // Grain.
        float g = hash21(vUv * 1000.0 + uTime) - 0.5;
        outCol += g * 0.06;
        // Vignette.
        vec2 c = vUv - 0.5;
        outCol *= 1.0 - smoothstep(0.3, 0.7, length(c)) * 0.5;
      }
      gl_FragColor = vec4(mix(col.rgb, outCol, uIntensity), col.a);
    }
  `,
};

/** Photo mode controller. */
export class PhotoMode {
  private active = false;
  private camera: THREE.PerspectiveCamera | null = null;
  /** Saved state — restored on exit. */
  private savedPosition = new THREE.Vector3();
  private savedQuaternion = new THREE.Quaternion();
  private savedFov = 75;
  private savedNear = 0.1;
  private savedFar = 1000;
  /** Free-cam state. */
  private yaw = 0;
  private pitch = 0;
  /** DOF config. */
  private dofAperture = 0;
  private dofFocusDist = 10;
  /** #668 — DOF focus pull animation. When non-zero, the focus distance
   *  lerps toward `dofFocusTarget` over `dofPullTau` seconds. */
  private dofFocusTarget = 10;
  private dofPullTau = 0.3;
  /** Current filter. */
  private filter: PhotoModeFilter = "none";
  /** HUD hidden flag — read by the HudSystem. */
  private hudHidden = false;
  /** #669 — Time freeze. When true, the host's per-frame tick is bypassed
   *  for game systems (physics/AI/animation); only the camera + post-FX
   *  advance. The host reads `isTimeFrozen()` each frame. */
  private timeFrozen = false;
  /** #671 — Last capture data URL. */
  private lastCaptureUrl = "";
  /** #671 — Total captures this session. */
  private captureCount = 0;
  /** Filter pass — constructed lazily when a custom shader filter is set. */
  public filterPass: _ShaderPass | null = null;
  /** E1-5000 #2321 — DOF pass reference (set by the host). When non-null,
   *  setDOF/tickDOF push the aperture + focus distance into the pass's
   *  uniforms so DOF actually applies (the prior code stored the config
   *  but never wired it to a live pass → DOF was a no-op). */
  public dofPass: { uniforms: { aperture?: { value: number }; focusDistance?: { value: number }; maxBlur?: { value: number } } } | null = null;
  /** E1-5000 #2319 — Reference to the game scene (set by the host on enter).
   *  capture() renders THIS scene (the prior code rendered `new THREE.Scene()`
   *  — an empty scene — so captures were blank). */
  private scene: THREE.Scene | null = null;
  /** The render target used for capture(). Created on first capture. */
  private captureRT: THREE.WebGLRenderTarget | null = null;
  /** Move speed (world units per second). */
  public moveSpeed = 8;
  /** Look sensitivity (radians per pixel). */
  public lookSensitivity = 0.0025;

  /** Enter photo mode — capture the camera state + flag HUD hidden. */
  enter(camera: THREE.PerspectiveCamera): void {
    if (this.active) return;
    this.camera = camera;
    this.savedPosition.copy(camera.position);
    this.savedQuaternion.copy(camera.quaternion);
    this.savedFov = camera.fov;
    this.savedNear = camera.near;
    this.savedFar = camera.far;
    // Extract yaw/pitch from the camera's quaternion for free-look continuity.
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
    this.yaw = euler.y;
    this.pitch = euler.x;
    this.active = true;
    this.hudHidden = true;
    // #669 — Time freezes on enter by default (configurable by the host).
    this.timeFrozen = true;
  }

  /** E1-5000 #2319 — Set the game scene reference. The host calls this on
   *  enter() so capture() renders the actual game scene (not an empty one). */
  setScene(scene: THREE.Scene | null): void {
    this.scene = scene;
  }

  /** E1-5000 #2321 — Set the DOF pass reference. The host constructs the
   *  BokehPass (or equivalent) + passes it here so setDOF/tickDOF can push
   *  params into its uniforms. */
  setDOFPass(pass: PhotoMode["dofPass"]): void {
    this.dofPass = pass;
  }

  /** Exit photo mode — restore the saved camera state + show HUD. */
  exit(): void {
    if (!this.active || !this.camera) return;
    this.camera.position.copy(this.savedPosition);
    this.camera.quaternion.copy(this.savedQuaternion);
    this.camera.fov = this.savedFov;
    this.camera.near = this.savedNear;
    this.camera.far = this.savedFar;
    this.camera.updateProjectionMatrix();
    this.active = false;
    this.hudHidden = false;
    this.timeFrozen = false;
  }

  /** #669 — Toggle time freeze. When frozen, the host skips the game
   *  systems' per-frame tick (physics, AI, animation); only the camera +
   *  post-FX advance so the player can compose the shot. */
  setTimeFrozen(frozen: boolean): void {
    this.timeFrozen = frozen;
  }

  isTimeFrozen(): boolean { return this.timeFrozen; }

  /** Move the camera in the local XZ plane (forward/right). */
  move(dx: number, dz: number, dt: number): void {
    if (!this.active || !this.camera) return;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
    const dist = this.moveSpeed * dt;
    this.camera.position.addScaledVector(forward, -dz * dist);
    this.camera.position.addScaledVector(right, dx * dist);
  }

  /** Dolly the camera up/down (Y axis). */
  dolly(d: number, dt: number): void {
    if (!this.active || !this.camera) return;
    this.camera.position.y += d * this.moveSpeed * dt;
  }

  /** Rotate the camera by (yawDelta, pitchDelta) in radians. */
  rotate(yawDelta: number, pitchDelta: number): void {
    if (!this.active || !this.camera) return;
    this.yaw -= yawDelta * this.lookSensitivity * 100;
    this.pitch -= pitchDelta * this.lookSensitivity * 100;
    // Clamp pitch to avoid flipping.
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
    const euler = new THREE.Euler(this.pitch, this.yaw, 0, "YXZ");
    this.camera.quaternion.setFromEuler(euler);
  }

  /** #668 — Set the depth-of-field params. aperture 0 = no DOF. focusDist
   *  in world units. When `pull` is true, the focus distance animates
   *  toward the new value over `dofPullTau` seconds (focus pull).
   *  E1-5000 #2321 — Now pushes the params into the live DOF pass (when
   *  the host has wired one via setDOFPass) so DOF actually applies. */
  setDOF(aperture: number, focusDist: number, pull = false): void {
    this.dofAperture = Math.max(0, aperture);
    this.dofFocusTarget = Math.max(0.1, focusDist);
    if (!pull) this.dofFocusDist = this.dofFocusTarget;
    this.applyDOFToPass();
  }

  /** E1-5000 #2321 — Push the current DOF config into the live DOF pass. */
  private applyDOFToPass(): void {
    if (!this.dofPass) return;
    if (this.dofPass.uniforms.aperture) this.dofPass.uniforms.aperture.value = this.dofAperture;
    if (this.dofPass.uniforms.focusDistance) this.dofPass.uniforms.focusDistance.value = this.dofFocusDist;
    if (this.dofPass.uniforms.maxBlur) this.dofPass.uniforms.maxBlur.value = this.dofAperture * 0.5;
  }

  /** #668 — Per-frame DOF focus pull animation. Call from the host's
   *  per-frame update — lerps `dofFocusDist` toward `dofFocusTarget`. */
  tickDOF(dt: number): void {
    if (!this.active) return;
    const k = 1 - Math.exp(-dt / this.dofPullTau);
    this.dofFocusDist += (this.dofFocusTarget - this.dofFocusDist) * k;
    // E1-5000 #2321 — push the animated focus distance into the live pass.
    this.applyDOFToPass();
  }

  getDOFConfig(): { aperture: number; focusDist: number } {
    return { aperture: this.dofAperture, focusDist: this.dofFocusDist };
  }

  /** Set the active filter.
   *  E1-5000 #2320 — Lazily construct the filterPass when a custom-shader
   *  filter is requested (the prior code left filterPass=null forever, so
   *  the `if (cfg.customShader && this.filterPass)` branch never fired +
   *  thermal/night-vision filters silently did nothing).
   *
   *  The filterPass is constructed via the host-injected factory when
   *  available (avoids a hard `require()` of ShaderPass at module load —
   *  ESM bundlers error on dynamic require). If no factory is set, the
   *  host must call `setFilterPass()` directly with a constructed
   *  ShaderPass(FilterShader). */
  setFilter(name: PhotoModeFilter): void {
    this.filter = name;
    const cfg = FILTER_CONFIGS[name];
    if (cfg.customShader) {
      // Construct the filter pass on first use via the injected factory.
      if (!this.filterPass && this._filterPassFactory) {
        try {
          this.filterPass = this._filterPassFactory(FilterShader);
        } catch {
          this.filterPass = null;
        }
      }
      if (this.filterPass) {
        (this.filterPass.material.uniforms.uMode.value as number) =
          cfg.customShader === "thermal" ? 0 : 1;
      }
    }
  }

  /** E1-5000 #2320 — Inject a filterPass factory (the host calls this to
   *  provide a ShaderPass constructor without a hard ESM import here). */
  setFilterPassFactory(factory: (shader: typeof FilterShader) => _ShaderPass): void {
    this._filterPassFactory = factory;
  }

  /** E1-5000 #2320 — Inject a pre-constructed filterPass directly. */
  setFilterPass(pass: _ShaderPass): void {
    this.filterPass = pass;
  }
  private _filterPassFactory: ((shader: typeof FilterShader) => _ShaderPass) | null = null;

  getFilter(): PhotoModeFilter {
    return this.filter;
  }

  getFilterConfig(): FilterConfig {
    return FILTER_CONFIGS[this.filter];
  }

  /** #670 — Get all available filter presets. Used by the UI to populate
   *  the filter dropdown. */
  static getFilterPresets(): PhotoModeFilter[] {
    return ["none", "noir", "sepia", "vibrant", "cinematic", "thermal", "night-vision"];
  }

  /** Hide HUD toggle. */
  setHUDHidden(v: boolean): void {
    this.hudHidden = v;
  }

  isHUDHidden(): boolean {
    return this.hudHidden;
  }

  isActive(): boolean {
    return this.active;
  }

  /** #671 — Capture the current frame to a PNG data URL. The host calls
   *  this after the next render() so the canvas has fresh pixels. We read
   *  from the canvas via toDataURL.
   *  E1-5000 #2319 — Render the actual GAME scene (the prior code rendered
   *  `new THREE.Scene()` — an empty scene — so captures were blank).
   *  E1-5000 #2390 — Use the captureRT (created in setSize) to render at the
   *  capture resolution, then read pixels from the canvas. */
  capture(renderer?: THREE.WebGLRenderer): string {
    // Force a fresh render before reading if a renderer is provided.
    if (renderer && this.camera) {
      // E1-5000 #2319 — render the GAME scene (was: new THREE.Scene() → blank).
      const sceneToRender = this.scene ?? new THREE.Scene();
      if (this.captureRT && renderer) {
        // E1-5000 #2390 — render into the capture RT (functional capture path).
        renderer.setRenderTarget(this.captureRT);
        renderer.render(sceneToRender, this.camera);
        renderer.setRenderTarget(null);
      } else {
        renderer.render(sceneToRender, this.camera);
      }
    }
    const canvas = typeof document !== "undefined" ? renderer?.domElement : null;
    if (!canvas) return "";
    // preserveDrawingBuffer must be true on the renderer for toDataURL to
    // work reliably — host enables this when entering photo mode.
    try {
      this.lastCaptureUrl = canvas.toDataURL("image/png");
      this.captureCount++;
      return this.lastCaptureUrl;
    } catch {
      return "";
    }
  }

  /** #671 — Get the last capture's data URL (or empty string). */
  getLastCaptureUrl(): string { return this.lastCaptureUrl; }

  /** #671 — Get the total captures this session. */
  getCaptureCount(): number { return this.captureCount; }

  /** #671 — Trigger a browser download of the last capture. Only works
   *  in the browser (no-op in SSR). */
  downloadLastCapture(filename?: string): void {
    if (typeof document === "undefined" || !this.lastCaptureUrl) return;
    const a = document.createElement("a");
    a.href = this.lastCaptureUrl;
    a.download = filename ?? `photomode-${this.captureCount}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /** Resize the capture RT (called by host on viewport resize).
   *  E1-5000 #2390 — Actually CREATE the captureRT (the prior code only
   *  resized it if it already existed, but it was never created → captureRT
   *  stayed null forever → the capture path was non-functional). */
  setSize(w: number, h: number): void {
    if (!this.captureRT) {
      this.captureRT = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    } else {
      this.captureRT.setSize(w, h);
    }
  }

  dispose(): void {
    this.exit();
    this.filterPass?.dispose();
    this.filterPass = null;
    this.captureRT?.dispose();
    this.captureRT = null;
    this.camera = null;
  }
}

/** Singleton accessor. */
let _instance: PhotoMode | null = null;
export function getPhotoMode(): PhotoMode {
  if (!_instance) _instance = new PhotoMode();
  return _instance;
}
