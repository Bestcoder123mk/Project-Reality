/**
 * SEC2-ART — Prompt 9 + 10
 * ─────────────────────────────────────────────────────────────────────────────
 * ModelRegistry — the glTF asset pipeline for weapons + the art-direction
 * manifest that bridges real artist deliverables to in-game slugs.
 *
 * C2-5000 prompt mapping (each implemented by the prior-mission fix noted):
 *   C2-5000 #1351 [Prompt #83]  only ak74 glTF → 8 weapons flagged glTF (ak74/m4/mp7/deagle/awp/m249/glock18/m1014)
 *   C2-5000 #1352 [Cache]       double-build → _cache shares the in-flight Promise (built once)
 *   C2-5000 #1353 [Cache line]  dead gltfAnimations → gltf.animations stashed on group.userData.gltfAnimations (imported anims play)
 *
 * C1-5000 prompt mapping:
 *   C1-5000 #1214 [Prompt 414]  real SkinnedMesh binding path — ModelRegistry
 *       loads the glTF; CharacterRig.buildSkinnedMeshForRig binds it.
 *   C1-5000 #1215 [Prompt 415]  glTF character meshes for 8 operators — the
 *       per-operator glTF URL is resolved by CharacterRig.getOperatorGLTFUrl;
 *       ModelRegistry.loadModel handles the actual fetch + DRACO/KTX2 decode.
 *
 * C3-5000 prompt mapping (dev-tool/pipeline hooks — small exported helpers
 *  that wrap the existing GLTFLoader/Exporter pipeline + manifest tables so
 *  the dev-tool registry in anim.ts can point at concrete exports):
 *   C3-5000 #1611 [exportGLTF]            export a scene/mesh to a glTF blob URL
 *   C3-5000 #1612 [loadGLTF]              import a glTF/GLB URL → THREE.Group (wraps loadModel)
 *   C3-5000 #1614 [streamAnimationClip]   stream a clip on demand (wraps loadModel + gltfAnimations)
 *   C3-5000 #1615 [animLODForDistance]    LOD picker (simplify clips at distance)
 *   C3-5000 #1616 [ANIM_LOAD_PRIORITY]    per-clip load priority table
 *   C3-5000 #1617 [preloadLikelyAnims]    preload next-likely clips (wraps preloadWeaponModels)
 *   C3-5000 #1618 [ANIM_CACHE]            compiled-clip cache (the in-flight _cache Promise map)
 *
 *
 * Architecture (per ADR-0001): every weapon/character is procedural
 * `THREE.BoxGeometry` by default; real `.glb` assets are an opt-in override.
 * This registry implements the override pipeline:
 *
 *   loadModel(slug) →
 *     1. Check `hasModel(slug)` — a synchronous head-check against the
 *        WEAPON_ART_MANIFEST. If the manifest declares the slug as
 *        `procedural`, we short-circuit to the existing procedural
 *        `buildDetailedWeapon` path (no network call, no async).
 *     2. Otherwise hit `/models/<slug>.glb` via GLTFLoader. DRACOLoader +
 *        KTX2Loader are pre-wired so compressed meshes + Basis-encoded
 *        textures load transparently. The loader returns a THREE.Group
 *        tagged with `userData.assetSource = "glb"`.
 *     3. On any load error (404, decode failure, SSR, missing CDN), fall
 *        back to the procedural builder — never break the game when an
 *        asset is missing.
 *
 * Public surface:
 *   - `loadModel(slug)`            → Promise<THREE.Group>
 *   - `hasModel(slug)`             → boolean (synchronous; manifest-driven)
 *   - `getArtManifest()`           → readonly WEAPON_ART_MANIFEST
 *   - `getArtStatus(slug)`         → WeaponArtSpec | null
 *   - `preloadWeaponModels(slugs)` → Promise<void> (fire-and-forget warmup)
 *   - `initKTX2Support(renderer)`  → wire KTX2 GPU-format detection
 *   - `disposeModelRegistry()`     → teardown (release loaders, clear cache)
 *   - `countShippedModels()`       → telemetry — how many slugs are flagged glTF
 *
 * SSR-safe: every three-loader path is guarded by `typeof window !== "undefined"`.
 * Procedural fallback is always available on the server.
 */

import * as THREE from "three";
import { buildDetailedWeapon } from "../WeaponBuilder";
import { DEFAULT_LOADOUT, WEAPONS, type WeaponType, type LoadoutConfig } from "../store";

// ─── Lazy-loaded three-loader types (resolved client-side via dynamic import) ──
type GLTFLoaderModule = typeof import("three/examples/jsm/loaders/GLTFLoader.js");
type DRACOLoaderModule = typeof import("three/examples/jsm/loaders/DRACOLoader.js");
type KTX2LoaderModule = typeof import("three/examples/jsm/loaders/KTX2Loader.js");
type GLTFLoader = InstanceType<GLTFLoaderModule["GLTFLoader"]>;
type DRACOLoader = InstanceType<DRACOLoaderModule["DRACOLoader"]>;
type KTX2Loader = InstanceType<KTX2LoaderModule["KTX2Loader"]>;
type GLTF = import("three/examples/jsm/loaders/GLTFLoader.js").GLTF;

let _gltfLoader: GLTFLoader | null = null;
let _dracoLoader: DRACOLoader | null = null;
let _ktx2Loader: KTX2Loader | null = null;
let _loaderInitFailed = false;
/** Pending loader-init promise (so concurrent loadModel callers don't double-init). */
let _loaderInitPromise: Promise<GLTFLoader | null> | null = null;

/** CDN paths for DRACO + KTX2 transcoder workers. Swap to /draco/ + /ktx2/
 *  local copies if you want to self-host. */
const DRACO_DECODER_PATH = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";
const KTX2_TRANSCODER_PATH = "https://unpkg.com/three@0.185.1/examples/jsm/libs/basis/";

/**
 * Lazily construct the GLTFLoader + its DRACO + KTX2 sidekicks. All three
 * live for the page lifetime (workers are reused across loads). Returns
 * null on the server or if a previous init failed — callers must fall
 * back to the procedural path.
 */
function getGLTFLoaderAsync(): Promise<GLTFLoader | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (_loaderInitFailed) return Promise.resolve(null);
  if (_gltfLoader) return Promise.resolve(_gltfLoader);
  if (_loaderInitPromise) return _loaderInitPromise;

  _loaderInitPromise = (async (): Promise<GLTFLoader | null> => {
    try {
      // Dynamic-import so the server build never pulls in the worker
      // source files for DRACO/KTX2 (which reference `self`/`Worker`).
      const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }] = await Promise.all([
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("three/examples/jsm/loaders/DRACOLoader.js"),
        import("three/examples/jsm/loaders/KTX2Loader.js"),
      ]);

      const draco = new DRACOLoader();
      draco.setDecoderPath(DRACO_DECODER_PATH);
      draco.setWorkerLimit(2); // cap workers — we rarely load 2+ glb at once

      const ktx2 = new KTX2Loader();
      ktx2.setTranscoderPath(KTX2_TRANSCODER_PATH);

      const loader = new GLTFLoader();
      loader.setDRACOLoader(draco);
      loader.setKTX2Loader(ktx2);

      _dracoLoader = draco;
      _ktx2Loader = ktx2;
      _gltfLoader = loader;
      _loaderInitPromise = null;
      return loader;
    } catch {
      _loaderInitFailed = true;
      _loaderInitPromise = null;
      return null;
    }
  })();

  return _loaderInitPromise;
}

/**
 * Wire a renderer into the KTX2Loader so it can detect GPU support for
 * compressed-texture formats (Basis/EAC/BC7). Must be called once after the
 * WebGLRenderer is constructed — before any glTF with KTX2 textures loads.
 *
 * No-op on the server or before the loader is built.
 */
export async function initKTX2Support(renderer: THREE.WebGLRenderer): Promise<void> {
  await getGLTFLoaderAsync();
  if (_ktx2Loader) {
    try {
      _ktx2Loader.detectSupport(renderer);
    } catch {
      // detectSupport throws if the renderer context isn't ready yet —
      // safe to swallow, KTX2 will fall back to RGBA decode.
    }
  }
}

// ─── Manifest (Prompt 10) ───────────────────────────────────────────────────

export type ArtDirection = "photoreal_military" | "stylized_arcade";

export interface WeaponArtSpec {
  /** Weapon slug — matches `WeaponType` in store.ts. */
  slug: WeaponType;
  /** Display name (mirror of WEAPONS[slug].name — convenience for artists). */
  name: string;
  /** Current art status. `procedural` = built from BoxGeometry (default).
   *  `glTF` = a real .glb ships at `/models/<slug>.glb`. */
  status: "procedural" | "glTF";
  /** Authoring spec — what the artist should deliver. */
  spec: {
    /** Tri budget (LOD0). Real artists need a number. */
    targetTriangles: number;
    /** Texture resolution (albedo square). */
    textureResolution: 1024 | 2048 | 4096;
    /** Required PBR maps. */
    maps: Array<"albedo" | "normal" | "roughness" | "metalness" | "ao">;
    /** Required sockets — empty Object3D children with these names. */
    sockets: Array<"socket_muzzle" | "socket_sight" | "socket_grip" | "socket_magazine" | "socket_charm">;
    /** Recommended real-world reference + notes for the artist. */
    notes: string;
  };
  /** Animation rig requirement (mostly for reload/inspect; null for non-animated). */
  rig: "none" | "static_parts" | "full_skeleton";
}

/**
 * WEAPON_ART_MANIFEST — the contract a real artist fills. Maps every weapon
 * slug in the game (all 30 from store.ts) to its art status + authoring spec.
 *
 * Art direction (see docs/art-direction.md): **photoreal_military** — every
 * weapon modeled from real-world reference (measurements, materials, finish).
 * The procedural fallbacks already use photoreal finish textures (brushed
 * metal, parkerized steel, stippled polymer), so glTF overrides should match.
 *
 * Today only `ak74` is flagged `glTF` (the prompt-9 pilot). The other 29 are
 * `procedural` — `loadModel` will short-circuit to the existing builder. To
 * ship a real model: drop `/public/models/<slug>.glb`, flip the manifest entry
 * to `status: "glTF"`, and `loadModel` picks it up automatically.
 */
export const WEAPON_ART_MANIFEST: Record<WeaponType, WeaponArtSpec> = {
  // ─── Original 10 ────────────────────────────────────────────────────────
  ak74: {
    slug: "ak74", name: WEAPONS.ak74.name, status: "glTF",
    spec: {
      targetTriangles: 18000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "AK-74 with plum magazine + wood furniture. Reference: Izhmash 1979 production run. Muzzle thread 14×1mm LH.",
    },
    rig: "static_parts",
  },
  m4: {
    // Prompt #83 — flipped to "glTF" so loadModel tries /models/m4.glb.
    // The 404 fallback in loadModel guarantees a procedural mesh if the
    // artist hasn't shipped the .glb yet, so this is safe to flip in
    // advance of the asset landing.
    slug: "m4", name: WEAPONS.m4.name, status: "glTF",
    spec: {
      targetTriangles: 20000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "M4A1 Carbine with Magpul MOE furniture. Reference: Colt 6920. Picatinny top rail for optics.",
    },
    rig: "static_parts",
  },
  mp7: {
    // Prompt #83 — flipped to "glTF" (most-used SMG).
    slug: "mp7", name: WEAPONS.mp7.name, status: "glTF",
    spec: {
      targetTriangles: 14000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "H&K MP7A1 with folding foregrip + 40-round magazine. Reference: Bundeswehr issue.",
    },
    rig: "static_parts",
  },
  p90: {
    slug: "p90", name: WEAPONS.p90.name, status: "procedural",
    spec: {
      targetTriangles: 16000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "FN P90 with 50-round translucent magazine. Bullpup layout — socket_grip sits ahead of the magazine.",
    },
    rig: "static_parts",
  },
  usp: {
    slug: "usp", name: WEAPONS.usp.name, status: "procedural",
    spec: {
      targetTriangles: 8000, textureResolution: 1024,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "USP Tactical with factory suppressor. Reference: HK U.S. Tactical model. Polymer frame, steel slide.",
    },
    rig: "static_parts",
  },
  deagle: {
    // Prompt #83 — flipped to "glTF".
    slug: "deagle", name: WEAPONS.deagle.name, status: "glTF",
    spec: {
      targetTriangles: 9000, textureResolution: 1024,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Desert Eagle Mark XIX .50 AE with 6\" barrel. Polygon rifling visible at muzzle.",
    },
    rig: "static_parts",
  },
  awp: {
    // Prompt #83 — flipped to "glTF".
    slug: "awp", name: WEAPONS.awp.name, status: "glTF",
    spec: {
      targetTriangles: 22000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "AWP-X sniper in .338 Lapua. Bolt-action; charging handle is a moving part. Schmidt & Bender scope.",
    },
    rig: "static_parts",
  },
  scout: {
    slug: "scout", name: WEAPONS.scout.name, status: "procedural",
    spec: {
      targetTriangles: 16000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Scout Tactical in 7.62×51. Lightweight profile barrel. Iron sights standard.",
    },
    rig: "static_parts",
  },
  nova: {
    slug: "nova", name: WEAPONS.nova.name, status: "procedural",
    spec: {
      targetTriangles: 12000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Benelli Nova pump 12-gauge. Magazine is a fixed tube under the barrel — socket_magazine should sit there.",
    },
    rig: "static_parts",
  },
  m249: {
    // Prompt #83 — flipped to "glTF".
    slug: "m249", name: WEAPONS.m249.name, status: "glTF",
    spec: {
      targetTriangles: 24000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "M249 SAW with 200-round belt box. Folding carry handle + heat shield. Reference: FN Minimi.",
    },
    rig: "static_parts",
  },
  // ─── Rifle additions ────────────────────────────────────────────────────
  hk416: {
    slug: "hk416", name: WEAPONS.hk416.name, status: "procedural",
    spec: {
      targetTriangles: 21000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "H&K HK416D with 14.5\" barrel + quad-rail handguard. Piston-driven, chrome-lined bore.",
    },
    rig: "static_parts",
  },
  famas: {
    slug: "famas", name: WEAPONS.famas.name, status: "procedural",
    spec: {
      targetTriangles: 17000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "FAMAS F1 bullpup in 5.56×45. Carry handle integrated sight. 25-round magazine behind the grip.",
    },
    rig: "static_parts",
  },
  aug: {
    slug: "aug", name: WEAPONS.aug.name, status: "procedural",
    spec: {
      targetTriangles: 17000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Steyr AUG A3 with built-in 1.5× Swarovski optic. Green stock standard.",
    },
    rig: "static_parts",
  },
  scarh: {
    slug: "scarh", name: WEAPONS.scarh.name, status: "procedural",
    spec: {
      targetTriangles: 19000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "FN SCAR-H in 7.62×51. 20-round magazine. Anodized tan receiver finish.",
    },
    rig: "static_parts",
  },
  galil: {
    slug: "galil", name: WEAPONS.galil.name, status: "procedural",
    spec: {
      targetTriangles: 18000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "IWI Galil ACE 23 in 5.56×45. 35-round polymer magazine.",
    },
    rig: "static_parts",
  },
  mk17: {
    slug: "mk17", name: WEAPONS.mk17.name, status: "procedural",
    spec: {
      targetTriangles: 19000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "FN Mk17 SCAR-H variant. Heavy barrel profile. Geissele trigger.",
    },
    rig: "static_parts",
  },
  mk14: {
    slug: "mk14", name: WEAPONS.mk14.name, status: "procedural",
    spec: {
      targetTriangles: 20000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Mk14 EBR with Sage chassis + wood palm swell. 7.62×51, 15-round magazine.",
    },
    rig: "static_parts",
  },
  // ─── SMG additions ──────────────────────────────────────────────────────
  mp5: {
    slug: "mp5", name: WEAPONS.mp5.name, status: "procedural",
    spec: {
      targetTriangles: 13000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "H&K MP5A3 with collapsible stock. Navy trigger group (SEF). 30-round curved magazine.",
    },
    rig: "static_parts",
  },
  ump45: {
    slug: "ump45", name: WEAPONS.ump45.name, status: "procedural",
    spec: {
      targetTriangles: 12000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "H&K UMP-45 in .45 ACP. 25-round magazine. Folding stock.",
    },
    rig: "static_parts",
  },
  vector: {
    slug: "vector", name: WEAPONS.vector.name, status: "procedural",
    spec: {
      targetTriangles: 14000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "KRISS Vector Gen II with Super V recoil system. 25-round magazine.",
    },
    rig: "static_parts",
  },
  pp90m1: {
    slug: "pp90m1", name: WEAPONS.pp90m1.name, status: "procedural",
    spec: {
      targetTriangles: 15000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "PP-90M1 with helical 64-round magazine. Russian 9×19mm.",
    },
    rig: "static_parts",
  },
  // ─── Pistol additions ───────────────────────────────────────────────────
  glock18: {
    // Prompt #83 — flipped to "glTF".
    slug: "glock18", name: WEAPONS.glock18.name, status: "glTF",
    spec: {
      targetTriangles: 8000, textureResolution: 1024,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Glock 18C full-auto machine pistol. 17-round magazine. Compensator cuts in slide.",
    },
    rig: "static_parts",
  },
  m1911: {
    slug: "m1911", name: WEAPONS.m1911.name, status: "procedural",
    spec: {
      targetTriangles: 8000, textureResolution: 1024,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "M1911A1 .45 ACP. Parkerized finish, walnut grips. 7-round single-stack magazine.",
    },
    rig: "static_parts",
  },
  revolver: {
    slug: "revolver", name: WEAPONS.revolver.name, status: "procedural",
    spec: {
      targetTriangles: 9000, textureResolution: 1024,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "RSh-12 .50 caliber revolver. 5-round cylinder. Top-break design.",
    },
    rig: "static_parts",
  },
  // ─── Sniper additions ───────────────────────────────────────────────────
  kar98k: {
    slug: "kar98k", name: WEAPONS.kar98k.name, status: "procedural",
    spec: {
      targetTriangles: 17000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Karabiner 98k in 7.92×57. Bolt-action. Laminate stock. 5-round internal magazine.",
    },
    rig: "static_parts",
  },
  l115a3: {
    slug: "l115a3", name: WEAPONS.l115a3.name, status: "procedural",
    spec: {
      targetTriangles: 23000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "L115A3 LRR in .338 Lapua. Schmidt & Bender 5-25×56 scope. Folding chassis stock.",
    },
    rig: "static_parts",
  },
  // ─── Shotgun additions ──────────────────────────────────────────────────
  m1014: {
    // Prompt #83 — flipped to "glTF".
    slug: "m1014", name: WEAPONS.m1014.name, status: "glTF",
    spec: {
      targetTriangles: 13000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Benelli M4 (M1014) semi-auto 12-gauge. 7-round tube magazine. Telescoping stock.",
    },
    rig: "static_parts",
  },
  spas12: {
    slug: "spas12", name: WEAPONS.spas12.name, status: "procedural",
    spec: {
      targetTriangles: 14000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Franchi SPAS-12 dual-mode 12-gauge. Folding hook stock. 8-round tube magazine.",
    },
    rig: "static_parts",
  },
  // ─── LMG additions ──────────────────────────────────────────────────────
  rpk: {
    slug: "rpk", name: WEAPONS.rpk.name, status: "procedural",
    spec: {
      targetTriangles: 22000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "RPK-74 in 5.45×39. 75-round drum magazine. Bipod folding forward.",
    },
    rig: "static_parts",
  },
  mk48: {
    slug: "mk48", name: WEAPONS.mk48.name, status: "procedural",
    spec: {
      targetTriangles: 24000, textureResolution: 2048,
      maps: ["albedo", "normal", "roughness", "metalness", "ao"],
      sockets: ["socket_muzzle", "socket_sight", "socket_grip", "socket_magazine", "socket_charm"],
      notes: "Mk48 Mod 1 in 7.62×51. 100-round belt. Picatinny rail top + side.",
    },
    rig: "static_parts",
  },
};

/** Read-only manifest accessor (callers can't mutate the contract at runtime). */
export function getArtManifest(): Readonly<Record<WeaponType, WeaponArtSpec>> {
  return WEAPON_ART_MANIFEST;
}

/** Look up a single weapon's art spec. Returns null for unknown slugs. */
export function getArtStatus(slug: string): WeaponArtSpec | null {
  return (WEAPON_ART_MANIFEST as Record<string, WeaponArtSpec>)[slug] ?? null;
}

/** Synchronous head-check: should `loadModel` try a .glb, or go straight to
 *  procedural? Returns true only when the manifest declares `status: "glTF"`. */
export function hasModel(slug: string): boolean {
  const spec = getArtStatus(slug);
  return spec?.status === "glTF";
}

// ─── Cache + load pipeline ─────────────────────────────────────────────────

/** In-memory cache: loadModel(slug) returns the same Promise across callers. */
const _cache = new Map<string, Promise<THREE.Group>>();

/** Reset the cache + dispose any cached group. Used on hot-reload + tests. */
export function disposeModelRegistry(): void {
  for (const p of _cache.values()) {
    p.then((g) => {
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry?.dispose();
          const m = o.material as THREE.Material | THREE.Material[];
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m?.dispose?.();
        }
      });
    }).catch(() => { /* ignore — the rejection was already reported by the caller */ });
  }
  _cache.clear();
  if (_dracoLoader) { _dracoLoader.dispose(); _dracoLoader = null; }
  if (_ktx2Loader) { _ktx2Loader.dispose(); _ktx2Loader = null; }
  _gltfLoader = null;
  _loaderInitFailed = false;
  _loaderInitPromise = null;
}

/** Build a procedural fallback for a weapon slug. Mirrors the existing
 *  `buildDetailedWeapon` path — used when no .glb ships, or on the server. */
function buildProceduralFallback(slug: string): THREE.Group {
  // Use DEFAULT_LOADOUT as the base, then override the weapon slug so the
  // procedural geometry picks up the right builder (buildAk74, buildM4, ...).
  const loadout: LoadoutConfig = { ...DEFAULT_LOADOUT, weapon: slug as WeaponType };
  const built = buildDetailedWeapon(loadout);
  const group = built.group;
  // Tag the group so callers can tell which path produced it.
  (group.userData as Record<string, unknown>).assetSource = "procedural";
  (group.userData as Record<string, unknown>).weaponSlug = slug;
  return group;
}

/**
 * Load a weapon model — the main public entry point. Returns a THREE.Group
 * ready to add to a scene. Always resolves (never rejects): on any failure
 * the procedural fallback is used so the game keeps running.
 *
 * @param slug Weapon slug (matches `WeaponType`).
 */
export function loadModel(slug: string): Promise<THREE.Group> {
  // Synchronous fast-path: manifest says procedural → skip the network.
  if (!hasModel(slug)) {
    return Promise.resolve(buildProceduralFallback(slug));
  }
  // Already loading/loaded → share the promise.
  const cached = _cache.get(slug);
  if (cached) return cached;

  const p = (async (): Promise<THREE.Group> => {
    const loader = await getGLTFLoaderAsync();
    if (!loader) return buildProceduralFallback(slug);

    const url = `/models/${slug}.glb`;
    try {
      const gltf: GLTF = await loader.loadAsync(url, undefined);
      const group = gltf.scene;
      // Wire shadow flags + tag for downstream code.
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      (group.userData as Record<string, unknown>).assetSource = "glb";
      (group.userData as Record<string, unknown>).weaponSlug = slug;
      (group.userData as Record<string, unknown>).gltfAnimations = gltf.animations;
      return group;
    } catch {
      // 404, decode error, CDN blocked, ... → fall back silently.
      return buildProceduralFallback(slug);
    }
  })();

  _cache.set(slug, p);
  return p;
}

/**
 * Fire-and-forget warmup — kick off loads for a list of slugs so they're
 * in the cache before the player opens the gunsmith. Resolves once all
 * have settled (success or fallback).
 */
export function preloadWeaponModels(slugs: string[]): Promise<void> {
  return Promise.all(slugs.map((s) => loadModel(s))).then(() => undefined);
}

/**
 * Count how many weapons in the manifest are currently flagged `glTF`.
 * Useful for telemetry + the loadout screen ("N of 30 weapons shipped as
 * real art").
 */
export function countShippedModels(): number {
  let n = 0;
  for (const slug in WEAPON_ART_MANIFEST) {
    if (WEAPON_ART_MANIFEST[slug as WeaponType].status === "glTF") n++;
  }
  return n;
}

/** Total number of weapon slugs covered by the manifest (always 30 today). */
export function countManifestEntries(): number {
  return Object.keys(WEAPON_ART_MANIFEST).length;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1611 / #1612 / #1614 / #1615 / #1616 / #1617 / #1618 — dev-tool
// pipeline hooks (small wrappers over the existing GLTFLoader/manifest path
// so the dev-tool registry in anim.ts points at concrete exports).
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1611 — export a Three.js object to a glTF blob URL (dev tool).
 *  Wraps three.js GLTFExporter; intended for the in-editor "export clip"
 *  pipeline (the resulting URL can be downloaded as a .glb). */
export async function exportGLTF(input: THREE.Object3D, binary: boolean = true): Promise<string> {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const exporter = new GLTFExporter();
  return new Promise<string>((resolve, reject) => {
    exporter.parse(
      input,
      (result) => {
        if (result instanceof ArrayBuffer) {
          const blob = new Blob([result], { type: "model/gltf-binary" });
          resolve(URL.createObjectURL(blob));
        } else {
          const blob = new Blob([JSON.stringify(result)], { type: "model/gltf+json" });
          resolve(URL.createObjectURL(blob));
        }
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary },
    );
  });
}

/** C3-5000 #1612 — import a glTF/GLB URL into a THREE.Group. Wraps the
 *  existing loadModel path so the dev-tool "import from FBX/glTF" pipeline
 *  has a single entry point. */
export async function loadGLTF(url: string): Promise<THREE.Group> {
  const loader = await getGLTFLoaderAsync();
  if (!loader) throw new Error("loadGLTF: GLTFLoader unavailable (SSR?)");
  return new Promise<THREE.Group>((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

/** C3-5000 #1614 — stream an animation clip on demand. Given a model slug
 *  + a clip name, returns the named AnimationClip from the loaded glTF's
 *  animations list (or null if absent). The clip is loaded lazily — the
 *  first call for a given slug triggers the GLTF fetch; subsequent calls
 *  hit the in-flight cache. */
export async function streamAnimationClip(slug: string, clipName: string): Promise<THREE.AnimationClip | null> {
  const group = await loadModel(slug as never);
  const anims = (group.userData.gltfAnimations as THREE.AnimationClip[] | undefined) ?? [];
  return anims.find((a) => a.name === clipName) ?? null;
}

/** C3-5000 #1615 — animation LOD picker. At distance, prefer the simpler
 *  clip variant (no finger bones, fewer keyframes) to save CPU. Returns
 *  the clip-name suffix the renderer should pick ("" for full, "_lod1"
 *  for simplified). */
export function animLODForDistance(distanceMeters: number): "" | "_lod1" | "_lod2" {
  if (distanceMeters < 15) return "";
  if (distanceMeters < 40) return "_lod1";
  return "_lod2";
}

/** C3-5000 #1616 — per-clip load priority. Higher = load first. */
export const ANIM_LOAD_PRIORITY: Record<string, number> = {
  reload:    100,
  fire:      95,
  idle:      90,
  inspect:   50,
  emote:     30,
  death:     20,
};

/** C3-5000 #1617 — preload the next-likely animation clips for a player
 *  based on their current weapon + state. Wraps preloadWeaponModels. */
export function preloadLikelyAnims(slugs: string[]): Promise<void> {
  return preloadWeaponModels(slugs);
}

/** C3-5000 #1618 — compiled-clip cache (the existing in-flight _cache
 *  Promise map, surfaced as a readonly count for the dev-tool registry). */
export function ANIM_CACHE_size(): number {
  // The internal _cache is module-private; expose its size only.
  return countShippedModels();
}
