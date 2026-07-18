#!/usr/bin/env python3
"""Split MapBuilder.ts (2472 lines) into per-concern modules.

Creates:
  src/lib/game/maps/MapBuilder/_shared.ts    — imports, BuiltMap/BuildContext
                                                 types, MaterialCache, helpers
                                                 (tagMesh, addBox, addCyl, ...)
  src/lib/game/maps/MapBuilder/geometry.ts   — buildMap, createGroundMaterial,
                                                 mergeGeometries, scatterAmbientDetail,
                                                 createGroundDust, getDustTexture
  src/lib/game/maps/MapBuilder/props.ts      — buildProp + all buildX prop
                                                 functions + AMK easter egg
  src/lib/game/maps/MapBuilder/lighting.ts   — applyMapLighting
  src/lib/game/maps/MapBuilder/lifecycle.ts  — clearMap

Rewrites MapBuilder.ts as a barrel that re-exports everything (so existing
imports keep working). Code is MOVED, not rewritten."""
from __future__ import annotations
import re
from pathlib import Path

SRC = Path("/home/z/my-project/src/lib/game/maps/MapBuilder.ts")
OUT_DIR = Path("/home/z/my-project/src/lib/game/maps/MapBuilder")
OUT_DIR.mkdir(parents=True, exist_ok=True)

text = SRC.read_text()
lines = text.splitlines(keepends=True)


def add_export_to_funcs(block: str) -> str:
    """Prepend `export ` to top-level `function`, `interface`, `type`, `class`,
    `const`-arrow declarations (only when at column 0)."""
    out = []
    for line in block.splitlines(keepends=True):
        if re.match(r'^(function |interface |type |class )', line):
            out.append("export " + line)
        elif re.match(r'^const [A-Z_][A-Za-z0-9_]* = ', line):
            # export const-only-arrow helpers like NO_RAYCAST
            out.append("export " + line)
        else:
            out.append(line)
    return "".join(out)


# (name, start_line_1idx, end_line_inclusive)
sections = [
    # _shared: lines 1..364 (header + imports + BuiltMap/BuildContext + helpers)
    ("_shared", 1, 364),
    # geometry — buildMap + createGroundMaterial (365..471)
    ("geometry_top", 365, 471),
    # props — buildProp + all buildX functions + AMK easter egg (472..2156)
    ("props", 472, 2156),
    # lighting — applyMapLighting (2157..2173)
    ("lighting", 2157, 2173),
    # lifecycle — clearMap (2175..2208)
    ("lifecycle", 2175, 2208),
    # geometry_bottom — mergeGeometries, mulberry32, scatterAmbientDetail,
    # hashString, createGroundDust, getDustTexture (2210..end)
    ("geometry_bottom", 2210, len(lines)),
]

blocks = {}
for name, start, end in sections:
    blocks[name] = "".join(lines[start - 1 : end])


# ─── _shared.ts ─────────────────────────────────────────────────────────────
# Adjust imports — _shared now lives at maps/MapBuilder/_shared.ts so `./textures`
# and `./systems/types` paths shift by one level.
shared_text = blocks["_shared"]
shared_text = shared_text.replace('from "../textures"', 'from "../../textures"')
shared_text = shared_text.replace('from "../systems/types"', 'from "../../systems/types"')
shared_text = shared_text.replace('from "../realism"', 'from "../../realism"')
shared_text = shared_text.replace('from "./MapRegistry"', 'from "../MapRegistry"')
# Add exports to the previously-private helpers.
shared_text = add_export_to_funcs(shared_text)
(OUT_DIR / "_shared.ts").write_text(shared_text)


# ─── props.ts ───────────────────────────────────────────────────────────────
props_header = '''import * as THREE from "three";
import type { MapProp } from "../MapRegistry";
import { SURFACE_MATERIAL_MAP } from "../../realism";
import type { BuildContext } from "./_shared";
import {
  NO_RAYCAST,
  tagMesh,
  markCollider,
  noRaycast,
  addBox,
  addCyl,
  addSphere,
  addMesh,
  registerDestructible,
} from "./_shared";

'''
# Add exports to functions in props block (buildProp was non-exported; buildX
# functions are already exported — `export ` prefix on already-exported decls
# would create `export export` which is invalid. Filter accordingly).
def add_export_if_missing(block: str) -> str:
    out = []
    for line in block.splitlines(keepends=True):
        m = re.match(r'^(function |interface |type |class )', line)
        if m and not line.startswith("export "):
            out.append("export " + line)
        else:
            out.append(line)
    return "".join(out)

props_body = add_export_if_missing(blocks["props"])
(OUT_DIR / "props.ts").write_text(props_header + props_body)


# ─── lighting.ts ────────────────────────────────────────────────────────────
lighting_header = '''import * as THREE from "three";
import type { GameContext } from "../../systems/types";
import type { MapDefinition } from "../MapRegistry";

'''
lighting_body = blocks["lighting"]  # applyMapLighting already exported
(OUT_DIR / "lighting.ts").write_text(lighting_header + lighting_body)


# ─── lifecycle.ts ───────────────────────────────────────────────────────────
lifecycle_header = '''import * as THREE from "three";
import type { GameContext } from "../../systems/types";

'''
lifecycle_body = blocks["lifecycle"]  # clearMap already exported
(OUT_DIR / "lifecycle.ts").write_text(lifecycle_header + lifecycle_body)


# ─── geometry.ts ────────────────────────────────────────────────────────────
# Combine geometry_top + geometry_bottom (mergeGeometries etc), with imports
# from _shared, props, lighting.
geometry_header = '''import * as THREE from "three";
import type { GameContext, Collider, DestructibleProp } from "../../systems/types";
import type { MapDefinition } from "../MapRegistry";
import {
  sandTexture,
  concreteTexture,
  concreteRoughnessTexture,
} from "../../textures";
import type { BuildContext, MaterialCache } from "./_shared";
import { MaterialCache as MaterialCacheClass } from "./_shared";
import { buildProp, addAMKEasterEgg } from "./props";

'''
# The geometry_top block references `MaterialCache` constructor directly. Since
# we already exported `MaterialCache` class from _shared, just import it.
# But we aliased it as `MaterialCacheClass` above — undo the alias to keep code
# working verbatim. Replace `MaterialCache` -> use directly.
geometry_header = '''import * as THREE from "three";
import type { GameContext, Collider, DestructibleProp } from "../../systems/types";
import type { MapDefinition } from "../MapRegistry";
import {
  sandTexture,
  concreteTexture,
  concreteRoughnessTexture,
} from "../../textures";
import {
  MaterialCache,
  type BuildContext,
} from "./_shared";
import { buildProp, addAMKEasterEgg } from "./props";

'''
# Add exports to functions in geometry_top + geometry_bottom if not already.
geo_body = add_export_if_missing(blocks["geometry_top"]) + "\n" + add_export_if_missing(blocks["geometry_bottom"])
(OUT_DIR / "geometry.ts").write_text(geometry_header + geo_body)


# ─── Rewrite MapBuilder.ts as barrel ────────────────────────────────────────
barrel = '''// ============================================================================
//  MapBuilder.ts  —  re-export aggregator (Task 3 / item 52)
//  Original 2,472-line monolith split into per-concern modules under
//  ./MapBuilder/. This file remains the public entry point so existing imports
//  (`from "$lib/game/maps/MapBuilder"`) keep working.
//
//  Sub-modules:
//    _shared.ts    — BuiltMap/BuildContext types, MaterialCache, helper
//                    builders (tagMesh, addBox, addCyl, addSphere, ...)
//    geometry.ts   — buildMap (geometry generation + chunk grouping),
//                    createGroundMaterial, scatterAmbientDetail, ground dust
//    props.ts      — buildProp dispatcher + every per-prop buildX function
//                    (crates, sandbags, containers, barrels, buildings, ...)
//                    + AMK easter egg.
//    lighting.ts   — applyMapLighting (sun / hemi / fog floor enforcement)
//    lifecycle.ts  — clearMap (scene teardown on map switch)
//
//  KNOWN LIMITATION: re-export aggregation — bundlers still pull every
//  sub-module into the entry chunk. True lazy-loading requires dynamic import
//  of geometry/buildMap at the call site (see MapRegistry.ts item 61).
// ============================================================================

export * from "./MapBuilder/_shared";
export * from "./MapBuilder/geometry";
export * from "./MapBuilder/props";
export * from "./MapBuilder/lighting";
export * from "./MapBuilder/lifecycle";
'''
SRC.write_text(barrel)
print("OK: split MapBuilder.ts into 5 modules under MapBuilder/")
