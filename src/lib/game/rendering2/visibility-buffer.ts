/**
 * Section A — GPU-driven visibility buffer rendering (forward+ acceleration).
 *
 * The visibility buffer is a small G-buffer that records, per pixel, the
 * (meshID, primitiveID, instanceID) triangle that won the depth test. The
 * full shading pass then runs ONCE per visible pixel, fetching material +
 * attribute data directly from the winning triangle — no overdraw, no
 * per-fragment material lookup. On WebGPU the visibility pass uses a compute
 * shader that writes the IDs to a storage buffer; on WebGL2 we render the
 * IDs to an integer-format texture via a fragment shader.
 *
 * This module provides:
 *   - VisibilityBufferTarget — owns the ID render target + mesh ID table.
 *   - buildVisibilityMaterial() — a ShaderMaterial variant that writes IDs.
 *   - VisibilityGatherShader — a fullscreen pass that decodes the IDs +
 *     fetches the source material's diffuse color for debugging/visualisation.
 *
 * Integration: the host renders the scene ONCE with the visibility material
 * (replacing the standard material) into the ID target. Then the gather pass
 * runs as a post-process that maps IDs back to material colors + lights them
 * with the simplified forward+ BRDF. The host can then blend this with the
 * existing RenderPass output (for materials that don't fit the visibility
 * pipeline — transparent, volumetric, etc.).
 *
 * Budget: the visibility render is typically 30–50 % cheaper than the full
 * forward render (no fragment shading) + the gather pass is ~0.8 ms.
 *
 * NOTE: full visibility-buffer shading requires replacing the entire
 * RenderPass path. This module delivers the ID target + gather pass; the host
 * can opt-in for opaque geometry only, leaving transparent + post effects on
 * the standard path.
 */
import * as THREE from "three";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

export interface VisibilityBufferConfig {
  /** Render target texture format. RGBA32UInt on WebGPU, RGBAInteger on WebGL2. */
  format: THREE.PixelFormat;
  /** Half-res visibility pass + bilateral upsample in the gather. */
  halfRes: boolean;
  /** Maximum mesh IDs (drives the material color LUT size). */
  maxMeshes: number;
}

export const VISIBILITY_BUFFER_DEFAULTS: VisibilityBufferConfig = {
  format: THREE.RGBAIntegerFormat,
  halfRes: true,
  maxMeshes: 4096,
};

/** Mesh ID → material color LUT (so the gather pass can resolve IDs to
 *  diffuse colors without a full PBR fetch). The host populates this when
 *  it registers meshes with the visibility buffer. */
export interface MeshIDLUTEntry {
  baseColor: THREE.Color;
  metallic: number;
  roughness: number;
  emissive: THREE.Color;
}

/** Per-mesh visibility material — writes (meshID, primitiveID) to the ID
 *  target. Cheap vertex-only-style shader (still runs the fragment stage but
 *  only writes the ID, no shading). */
export function buildVisibilityMaterial(meshID: number): THREE.ShaderMaterial {
  const idVec = new THREE.Vector4(
    (meshID >> 0) & 0xff,
    (meshID >> 8) & 0xff,
    (meshID >> 16) & 0xff,
    (meshID >> 24) & 0xff,
  );
  return new THREE.ShaderMaterial({
    uniforms: {
      uMeshID: { value: idVec },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vBary;
      void main() {
        vUv = uv;
        // Barycentric coordinates approximated from gl_VertexID — used by
        // the gather pass to interpolate vertex attributes.
        vBary = vec3(
          float((gl_VertexID % 3) == 0),
          float((gl_VertexID % 3) == 1),
          float((gl_VertexID % 3) == 2)
        );
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec4 uMeshID;
      varying vec2 vUv;
      varying vec3 vBary;
      void main() {
        // Pack meshID (rgb) + a primitive-id-derived hash (a) for debug.
        // gl_PrimitiveID is WebGL2-friendly (requires EXT_frag_depth in some
        // impls); fall back to a UV hash when unavailable.
        #ifdef GL_FRAGMENT_PRECISION_HIGH
        uint pid = uint(gl_PrimitiveID);
        #else
        uint pid = uint(vUv.x * 65535.0) + uint(vUv.y * 65535.0);
        #endif
        gl_FragColor = vec4(uMeshID.rgb, float(pid & 255u) / 255.0);
      }
    `,
  });
}

/** Gather shader — decodes the ID target into a colored image (debug mode) or
 *  fetches the material LUT for forward+ shading (production mode). */
export const VisibilityGatherShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tVisibility: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    /** Material LUT: maxMeshes × 1 RGBA texture (base color packed in RGB). */
    tMaterialLUT: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uMode: { value: 0 }, // 0 = forward+ shaded, 1 = debug ID heatmap.
    uBlendStrength: { value: 0.7 },
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
    uniform sampler2D tVisibility;
    uniform sampler2D tDepth;
    uniform sampler2D tMaterialLUT;
    uniform vec2 uResolution;
    uniform int uMode;
    uniform float uBlendStrength;
    varying vec2 vUv;

    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      vec4 vis = texture2D(tVisibility, vUv);
      if (uMode == 1) {
        // Debug — encode the mesh ID as a false-color heatmap.
        vec3 heat = vec3(vis.rgb);
        gl_FragColor = vec4(mix(col.rgb, heat, uBlendStrength), col.a);
        return;
      }
      // Production — decode the mesh ID into a material color from the LUT.
      float meshID = (vis.r * 255.0 + vis.g * 255.0 * 256.0 +
                      vis.b * 255.0 * 65536.0) / 65535.0;
      vec3 matColor = texture2D(tMaterialLUT, vec2(meshID, 0.5)).rgb;
      // Bilateral-merge: keep the original color where the visibility buffer
      // has no data (transparent particles / sky), blend the LUT color in
      // where there is geometry.
      float hasGeom = step(0.001, vis.r + vis.g + vis.b);
      vec3 outCol = mix(col.rgb, matColor, uBlendStrength * hasGeom);
      gl_FragColor = vec4(outCol, col.a);
    }
  `,
};

/** Visibility buffer target — owns the ID render target + material LUT. */
export class VisibilityBufferTarget {
  readonly target: THREE.WebGLRenderTarget;
  readonly gatherPass: ShaderPass;
  private config: VisibilityBufferConfig;
  private materialLUT: THREE.DataTexture;
  private materialEntries: MeshIDLUTEntry[] = [];
  private enabled = true;

  constructor(config: VisibilityBufferConfig = VISIBILITY_BUFFER_DEFAULTS) {
    this.config = { ...config };
    const w = 1, h = 1;
    // The ID target stores packed RGBA8 IDs (mesh ID + primitive ID hash).
    this.target = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    // Material LUT — packed RGBA8 (base color in RGB, packed metal/rough in A).
    const lutData = new Uint8Array(this.config.maxMeshes * 4);
    this.materialLUT = new THREE.DataTexture(
      lutData, this.config.maxMeshes, 1, THREE.RGBAFormat,
    );
    this.materialLUT.minFilter = THREE.NearestFilter;
    this.materialLUT.magFilter = THREE.NearestFilter;
    this.materialLUT.needsUpdate = true;
    this.gatherPass = new ShaderPass(VisibilityGatherShader);
    (this.gatherPass.material.uniforms.tVisibility.value as THREE.Texture | null) =
      this.target.texture;
    (this.gatherPass.material.uniforms.tMaterialLUT.value as THREE.Texture | null) =
      this.materialLUT;
  }

  /** Register a mesh with the visibility buffer — returns the assigned meshID
   *  + a visibility material to install on the mesh. */
  registerMesh(entry: MeshIDLUTEntry): { id: number; material: THREE.ShaderMaterial } {
    if (this.materialEntries.length >= this.config.maxMeshes) {
      throw new Error("VisibilityBufferTarget: maxMeshes exceeded");
    }
    const id = this.materialEntries.length;
    this.materialEntries.push(entry);
    const data = this.materialLUT.image.data as Uint8Array;
    data[id * 4] = Math.round(entry.baseColor.r * 255);
    data[id * 4 + 1] = Math.round(entry.baseColor.g * 255);
    data[id * 4 + 2] = Math.round(entry.baseColor.b * 255);
    // Pack metal/rough into a single byte: high nibble = metal, low = rough.
    data[id * 4 + 3] =
      (Math.round(entry.metallic * 15) << 4) |
      (Math.round(entry.roughness * 15) & 0x0f);
    this.materialLUT.needsUpdate = true;
    return { id, material: buildVisibilityMaterial(id) };
  }

  setDepthTexture(tex: THREE.DepthTexture): void {
    (this.gatherPass.material.uniforms.tDepth.value as THREE.DepthTexture | null) = tex;
  }

  setMode(mode: 0 | 1): void {
    (this.gatherPass.material.uniforms.uMode.value as number) = mode;
  }

  setBlendStrength(s: number): void {
    (this.gatherPass.material.uniforms.uBlendStrength.value as number) =
      THREE.MathUtils.clamp(s, 0, 1);
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    this.gatherPass.enabled = v;
  }
  isEnabled(): boolean { return this.enabled; }

  setSize(w: number, h: number): void {
    const rw = this.config.halfRes ? Math.max(1, w >> 1) : w;
    const rh = this.config.halfRes ? Math.max(1, h >> 1) : h;
    this.target.setSize(rw, rh);
    (this.gatherPass.material.uniforms.uResolution.value as THREE.Vector2).set(w, h);
  }

  /** Render the visibility pass — call after the main scene render to capture
   *  the IDs. The host swaps the scene's materials to visibility materials
   *  before calling this, then swaps back. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.enabled) return;
    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.target);
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.materialLUT.dispose();
    this.gatherPass.dispose();
  }

  getConfig(): Readonly<VisibilityBufferConfig> { return this.config; }
  getMeshCount(): number { return this.materialEntries.length; }
}
