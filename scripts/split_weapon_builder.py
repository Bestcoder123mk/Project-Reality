#!/usr/bin/env python3
"""Split WeaponBuilder.ts (3062 lines) into per-category modules.

Creates:
  src/lib/game/WeaponBuilder/_shared.ts     — imports, types, materials, helper builders
  src/lib/game/WeaponBuilder/rifles.ts      — buildAk74, buildM4
  src/lib/game/WeaponBuilder/smgs.ts        — buildMp7, buildP90
  src/lib/game/WeaponBuilder/pistols.ts     — buildUsp, buildDeagle
  src/lib/game/WeaponBuilder/snipers.ts     — buildAwp, buildScout
  src/lib/game/WeaponBuilder/shotguns.ts    — buildNova
  src/lib/game/WeaponBuilder/lmg.ts         — buildM249 + LMG helpers
  src/lib/game/WeaponBuilder/attachments.ts — applyMuzzleAttachment, applyOpticAttachment, applyForegrip

Rewrites WeaponBuilder.ts as an aggregator:
  export * from "./WeaponBuilder/_shared";
  export * from "./WeaponBuilder/rifles";
  ...
  plus the dispatcher (BuiltWeapon + buildDetailedWeapon).

This is a code-moving refactor — no logic changes."""
from __future__ import annotations
import re
import sys
from pathlib import Path

SRC = Path("/home/z/my-project/src/lib/game/WeaponBuilder.ts")
OUT_DIR = Path("/home/z/my-project/src/lib/game/WeaponBuilder")
OUT_DIR.mkdir(parents=True, exist_ok=True)

text = SRC.read_text()
lines = text.splitlines(keepends=True)

# Section map: (name, start_line_1indexed, end_line_inclusive, prepend_export_to_funcs)
# All ranges verified against grep above.
sections = [
    # _shared: lines 1..1875 (imports + normals + materials + helpers + parts)
    ("_shared", 1, 1875),
    # rifles: AK + M4 (lines 1996..2192)
    ("rifles", 1996, 2192),
    # smgs: MP7 + P90 (lines 2193..2430)
    ("smgs", 2193, 2430),
    # pistols: USP + Deagle (lines 2431..2634)
    ("pistols", 2431, 2634),
    # snipers: AWP + Scout (lines 2635..2725)
    ("snipers", 2635, 2725),
    # shotguns: Nova (lines 2726..2826)
    ("shotguns", 2726, 2826),
    # lmg: M249 + helpers (lines 2827..3016)
    ("lmg", 2827, 3016),
    # attachments: applyMuzzleAttachment, applyOpticAttachment, applyForegrip (lines 3017..3063)
    ("attachments", 3017, 3063),
]

# Import header used by per-category files (rifles/smgs/etc).
# The _shared module exports all helpers and the WeaponMaterials type.
PER_CATEGORY_HEADER = '''import * as THREE from "three";
import type { LoadoutConfig } from "../store";
import type { WeaponMaterials } from "./_shared";
import {
  part,
  addWearScratches,
  buildTaperedReceiver,
  buildRail,
  buildTakedownPins,
  buildRivets,
  buildMarkingDecal,
  buildBarrel,
  buildFlashHider,
  buildCompensator,
  buildSuppressor,
  buildIronSights,
  buildM4Stock,
  buildAkStock,
  buildSniperStock,
  buildPistolGrip,
  buildAkMag,
  buildStanagMag,
  buildP90Mag,
  buildTriggerGroup,
  buildTHandle,
  buildSideHandle,
  buildEjectionPort,
  buildSelector,
  buildBoltHandle,
  buildScopeRings,
  buildScopeReticle,
  buildScope,
  buildRedDot,
  buildHolo,
  buildAcog,
  buildSlide,
  buildBeveledReceiver,
  buildPicatinnyRailExtruded,
  buildRibbedGrip,
  buildCurvedMagazine,
  pickReceiverMaterial,
} from "./_shared";

'''


def add_export_to_funcs(block: str) -> str:
    """Prepend `export ` to top-level `function X(`, `interface X {`,
    `type X =` and `class X` declarations."""
    out = []
    for line in block.splitlines(keepends=True):
        m = re.match(r'^(function |interface |type |class )', line)
        if m:
            out.append("export " + line)
        else:
            out.append(line)
    return "".join(out)


# Write _shared.ts (with exports added)
for name, start, end in sections:
    # Python slicing: lines are 0-indexed; section start..end inclusive.
    block = "".join(lines[start - 1 : end])
    if name == "_shared":
        # _shared.ts already starts with imports — keep them.
        content = add_export_to_funcs(block)
        # Ensure header line is clean.
        (OUT_DIR / f"{name}.ts").write_text(content)
    else:
        # Strip the section-header comment ("// ─── AK-74 ───") — keep it,
        # it's harmless and informative. Add the import header.
        body = add_export_to_funcs(block)
        (OUT_DIR / f"{name}.ts").write_text(PER_CATEGORY_HEADER + body)


# Now rewrite WeaponBuilder.ts as the aggregator + dispatcher.
# Extract the dispatcher block (lines 1878..1994 inclusive).
dispatcher_block = "".join(lines[1877 : 1994])  # 0-indexed: lines[1877..1993] => file lines 1878..1994
# Add exports to its interface/function.
dispatcher_body = add_export_to_funcs(dispatcher_block)

barrel = '''// ============================================================================
//  WeaponBuilder.ts  —  re-export aggregator (Task 3 / item 51)
//  The original 3,062-line monolith was split into per-category modules under
//  ./WeaponBuilder/. This file remains as the public entry point so existing
//  imports (`from "$lib/game/WeaponBuilder"`) keep working.
//
//  Sub-modules:
//    _shared.ts     — materials, normal-map factories, reusable part builders
//    rifles.ts      — AK-74, M4 Carbine
//    smgs.ts        — MP-7, P90
//    pistols.ts     — USP-S, Desert Eagle
//    snipers.ts     — AWP-X, Scout
//    shotguns.ts    — Nova
//    lmg.ts         — M249 SAW + bipod / box-mag / heat-shield helpers
//    attachments.ts — muzzle / optic / foregrip application helpers
//
//  KNOWN LIMITATION (re-export aggregation): bundlers that follow `export *`
//  will still pull every category into the entry chunk. The split still pays
//  off for human navigation, IDE jump-to-def, and per-file test isolation; to
//  get true per-weapon code-splitting you'd need to dynamic-import the
//  category module inside buildDetailedWeapon based on loadout.weapon.
// ============================================================================

// Re-export the entire public surface of every sub-module so existing imports
// of named symbols (e.g. `buildSuppressor`, `WeaponMaterials`) still resolve.
export * from "./WeaponBuilder/_shared";
export * from "./WeaponBuilder/rifles";
export * from "./WeaponBuilder/smgs";
export * from "./WeaponBuilder/pistols";
export * from "./WeaponBuilder/snipers";
export * from "./WeaponBuilder/shotguns";
export * from "./WeaponBuilder/lmg";
export * from "./WeaponBuilder/attachments";

import * as THREE from "three";
import { SKINS } from "./store";
import type { LoadoutConfig, SkinSlug } from "./store";

import type { WeaponMaterials } from "./WeaponBuilder/_shared";
import { makeMaterials, pickReceiverMaterial } from "./WeaponBuilder/_shared";
import { buildAk74, buildM4 } from "./WeaponBuilder/rifles";
import { buildMp7, buildP90 } from "./WeaponBuilder/smgs";
import { buildUsp, buildDeagle } from "./WeaponBuilder/pistols";
import { buildAwp, buildScout } from "./WeaponBuilder/snipers";
import { buildNova } from "./WeaponBuilder/shotguns";
import { buildM249 } from "./WeaponBuilder/lmg";

'''

# Append the dispatcher body.
barrel += dispatcher_body

SRC.write_text(barrel)
print("OK: split WeaponBuilder.ts into 8 modules under WeaponBuilder/")
