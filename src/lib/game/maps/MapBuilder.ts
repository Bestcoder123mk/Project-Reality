// ============================================================================
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
