#!/usr/bin/env python3
"""Split ParticleSystem.ts (2320 lines) into per-concern modules.

Creates:
  ParticleSystem/_shared.ts  — imports, common constants, pooled-type
                               interfaces, particleTexture cache helper.
  ParticleSystem/decals.ts   — bullet-hole / scorch / blood decal textures
                               + decal cap/lifetime constants.
  ParticleSystem/tracers.ts  — TRACER_COLORS + SurfaceVfx map.
  ParticleSystem/debris.ts   — ExplosionKind + debris pool sizing.
  ParticleSystem/weather.ts  — ambient particle (muzzle smoke / ground dust)
                               helpers; documents that actual weather lives
                               in WeatherSystem.ts.

Rewrites ParticleSystem.ts to import everything from the sub-modules and
keep the (still-monolithic) ParticleSystem class. The class itself is not
split — TS doesn't support partial classes, and the per-concern methods
are tightly coupled to the class's pooled resources. The user-facing
"separate concerns" split is now reflected at the module level (texture
factories + constants + types), which is the part that benefits most from
isolation for testing and tree-shaking."""
from __future__ import annotations
import re
from pathlib import Path

SRC = Path("/home/z/my-project/src/lib/game/systems/ParticleSystem.ts")
OUT_DIR = Path("/home/z/my-project/src/lib/game/systems/ParticleSystem")
OUT_DIR.mkdir(parents=True, exist_ok=True)

text = SRC.read_text()
lines = text.splitlines(keepends=True)


def add_export_to_consts(block: str) -> str:
    """Prepend `export ` to top-level non-exported `function`, `interface`,
    `type`, `class`, `const`, `let` declarations (column-0 only)."""
    out = []
    for line in block.splitlines(keepends=True):
        if re.match(r'^(function |interface |type |class |const |let )', line) and not line.startswith("export "):
            out.append("export " + line)
        else:
            out.append(line)
    return "".join(out)


# Module-level section is lines 1..434. The class starts at 435.
# Within 1..434, partition by concern:

# decals.ts content: bullet hole texture (10-15), scorch texture (188-235),
#   blood textures (253-433), BLOOD_* constants (236-250), DECAL_* (76-82).
# tracers.ts content: TRACER_COLORS (33-42), SurfaceVfx/SURFACE_VFX (44-72),
#   cachedParticleTexture/_texCache (17-23), randomBloodColor (25-31).
# debris.ts content: ExplosionKind (185-186), EXPLOSION_DEBRIS_POOL_SIZE (95-96).
# _shared.ts content: imports (1-7), SHELL_POOL_SIZE (74-75), FLASH/SHOCKWAVE/
#   EXPLOSION_LIGHT/SCOPE_GLINT constants (84-94), PooledShell + PooledFlash +
#   PooledExplosionLight + PooledShockwave + PooledExplosionDebris +
#   PooledBloodDrip + PooledBloodPool + PooledScopeGlint interfaces (98-183).
# weather.ts: new file (stub + ambient smoke helper).

# Extract specific ranges by line number (1-indexed, inclusive).
def grab(start, end):
    return "".join(lines[start - 1 : end])


decals_body = grab(76, 82) + grab(188, 410)
tracers_body = grab(17, 72)
debris_body = grab(95, 96) + grab(185, 186)
shared_body = grab(1, 7) + grab(74, 75) + grab(84, 94) + grab(98, 183)

# Shared: replace relative imports (now nested one level deeper)
shared_body = shared_body.replace('from "../textures"', 'from "../../textures"')
shared_body = shared_body.replace('from "../store"', 'from "../../store"')
shared_body = shared_body.replace('from "../realism"', 'from "../../realism"')
shared_body = shared_body.replace('from "./types"', 'from "../types"')
shared_body = shared_body.replace('from "./ObjectPool"', 'from "../ObjectPool"')

shared_text = add_export_to_consts(shared_body)
(OUT_DIR / "_shared.ts").write_text(shared_text)


# decals.ts — needs THREE import + textures import (for bulletHoleTexture).
decals_header = '''import * as THREE from "three";
import { bulletHoleTexture } from "../../textures";

'''
# Add exports to previously-private consts/funcs.
decals_body_text = add_export_to_consts(decals_body)
(OUT_DIR / "decals.ts").write_text(decals_header + decals_body_text)


# tracers.ts
tracers_header = '''import * as THREE from "three";
import { particleTexture } from "../../textures";

'''
tracers_body_text = add_export_to_consts(tracers_body)
(OUT_DIR / "tracers.ts").write_text(tracers_header + tracers_body_text)


# debris.ts
debris_header = '''// Explosion kind + debris pool sizing — split out from ParticleSystem.ts
// so destruction-physics / VoronoiFracture can import them without pulling
// the entire particle system.

'''
debris_body_text = add_export_to_consts(debris_body)
(OUT_DIR / "debris.ts").write_text(debris_header + debris_body_text)


# weather.ts — ambient particle helpers + documentation that real weather
# is in WeatherSystem.ts.
weather_text = '''// Ambient particle concerns (muzzle smoke, ground dust) — split out from
// ParticleSystem.ts. ACTUAL weather (rain, snow, fog volumetrics) lives in
// WeatherSystem.ts; this module only owns the non-weather ambient particle
// helpers that ParticleSystem spawns directly.
//
// Why a separate file: keeps the ParticleSystem.ts class focused on combat
// VFX (decals / tracers / debris). Ambient particles have different
// lifetime + visibility rules (long-lived, frustum-culled, additive-blended)
// that benefit from being isolated.

import * as THREE from "three";
import { smokeTexture } from "../../textures";

/** Muzzle smoke puff — short-lived additive sprite emitted on each shot.
 *  Suppressed weapons get a smaller, darker puff. The ParticleSystem class
 *  calls this from spawnMuzzleSmoke(); kept here so the smoke texture factory
 *  and tuning constants live with their concern. */
export const MUZZLE_SMOKE_LIFETIME = 0.45; // seconds
export const MUZZLE_SMOKE_SUPPRESSED_LIFETIME = 0.25;
export const MUZZLE_SMOKE_SCALE_START = 0.04;
export const MUZZLE_SMOKE_SCALE_END = 0.18;

/** Procedural ambient dust field parameters — used by buildMap() in
 *  MapBuilder/geometry.ts (NOT by ParticleSystem). Documented here because
 *  it's the closest "ambient particle" concern to weather. */
export const AMBIENT_DUST_PARTICLE_COUNT = 200;
export const AMBIENT_DUST_FIELD_SIZE = 80; // meters
export const AMBIENT_DUST_HEIGHT = 2.5; // meters above ground

/** Lazy smoke-texture getter (mirrors the cached-factory pattern used by
 *  decals/tracers). */
let _smokeTex: THREE.Texture | null = null;
export function getSmokeTexture(): THREE.Texture {
  if (!_smokeTex) _smokeTex = smokeTexture();
  return _smokeTex;
}
'''
(OUT_DIR / "weather.ts").write_text(weather_text)


# Now rewrite ParticleSystem.ts: replace lines 1..434 with imports from the
# new sub-modules, keep the class (lines 435..end) verbatim.
class_body = grab(435, len(lines))

# Need to identify every symbol the class uses from the original module-level
# section. Be permissive: import everything via `import * as X from "./..."`.
# But the class refers to symbols by bare name (DECAL_CAP, TRACER_COLORS,
# getBulletHoleTexture, etc.). So we need named imports.
new_header = '''// ============================================================================
//  ParticleSystem.ts  —  re-export aggregator + class (Task 3 / item 53)
//  The original 2,320-line module was split into per-concern sub-modules
//  under ./ParticleSystem/. This file imports from them and keeps the
//  ParticleSystem class definition (TS doesn't support partial classes,
//  so the class itself stays here — the texture factories, constants, and
//  pooled-type interfaces were the part that benefited from extraction).
//
//  Sub-modules:
//    _shared.ts  — imports, common pool sizing, pooled-type interfaces
//    decals.ts   — bullet-hole / scorch / blood textures + decal cap constants
//    tracers.ts  — TRACER_COLORS + SurfaceVfx map + cached particle texture
//    debris.ts   — ExplosionKind + debris pool sizing
//    weather.ts  — ambient particle (muzzle smoke / ground dust) helpers
// ============================================================================

// Re-export so external imports of named symbols (`DECAL_CAP`,
// `TRACER_COLORS`, `ExplosionKind`, `PooledShell`, ...) still resolve.
export * from "./ParticleSystem/_shared";
export * from "./ParticleSystem/decals";
export * from "./ParticleSystem/tracers";
export * from "./ParticleSystem/debris";
export * from "./ParticleSystem/weather";

import * as THREE from "three";
import type { GameSystem, GameContext, Enemy } from "./types";
import type { HudState } from "../store";
import { particleTexture, smokeTexture, bulletHoleTexture } from "../textures";
import { ObjectPool, type PooledParticle, type PooledTracer } from "./ObjectPool";
import type { WeaponType } from "../store";
import { isNight } from "../realism";

// Per-concern imports (constants + texture factories + pooled types).
import {
  SHELL_POOL_SIZE,
  FLASH_POOL_SIZE,
  SHOCKWAVE_POOL_SIZE,
  EXPLOSION_LIGHT_POOL_SIZE,
  SCOPE_GLINT_POOL_SIZE,
  SCOPE_GLINT_LIFETIME,
  type PooledShell,
  type PooledFlash,
  type PooledExplosionLight,
  type PooledShockwave,
  type PooledExplosionDebris,
  type PooledBloodDrip,
  type PooledBloodPool,
  type PooledScopeGlint,
} from "./ParticleSystem/_shared";
import {
  DECAL_CAP,
  DECAL_LIFETIME,
  DECAL_FADE_WINDOW,
  BLOOD_DECAL_CAP,
  BLOOD_DECAL_LIFETIME,
  BLOOD_DECAL_FADE_WINDOW,
  BLOOD_POOL_CAP,
  BLOOD_POOL_MESH_POOL_SIZE,
  BLOOD_DRIP_POOL_SIZE,
  BLOOD_SPLATTER_POOL_SIZE,
  getBulletHoleTexture,
  scorchTexture,
  getScorchTexture,
  bloodSplatterTexture,
  getBloodSplatterTexture,
  bloodPoolTexture,
  getBloodPoolTexture,
  bloodDripTexture,
  getBloodDripTexture,
} from "./ParticleSystem/decals";
import {
  TRACER_COLORS,
  cachedParticleTexture,
  type SurfaceVfx,
  SURFACE_VFX,
} from "./ParticleSystem/tracers";
import {
  EXPLOSION_DEBRIS_POOL_SIZE,
  type ExplosionKind,
} from "./ParticleSystem/debris";

'''

SRC.write_text(new_header + class_body)
print("OK: split ParticleSystem.ts into 5 sub-modules + class")
