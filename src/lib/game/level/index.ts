/**
 * SEC9-LEVEL — Level design & world subsystems.
 *
 * Barrel export for everything added in Section 9 (Level Design & World).
 * Subsystems:
 *   - Prompt 71: design notes + map validator (under maps/)
 *   - Prompt 72: ChunkManager streaming (under systems/)
 *   - Prompt 73: destructible set-pieces
 *   - Prompt 74: environmental storytelling
 *   - Prompt 75: spawn logic + anti-spawn-camping
 *   - Prompt 76: per-map lighting art pass
 *
 * Engine wiring (one-liners the orchestrator adds to engine.ts / engine-wiring.ts):
 *   - On map load, after `applyMapLighting`:
 *       const preset = getMapLighting(mapDef.slug);
 *       if (preset) applyLightingPreset(ctx, preset);
 *   - On map load, after `buildMap`:
 *       this.storyPropMeshes = buildStoryProps(mapDef.slug, ctx.scene);
 *   - Per frame, after enemy updates:
 *       const fired = tickSetPieces(ctx, dt, mapDef.slug);
 *       for (const sp of fired) ctx.pushHud({ radioMessage: { text: sp.toast, channel: "SYSTEM", time: performance.now() } });
 *       window.__PR_INSPECT__ = getInspectText(mapDef.slug, ctx.player.pos, ctx.player.yaw);
 *   - On enemy spawn (replacing fixed/round-robin spawn selection):
 *       const spawn = selectSpawn(mapDef.slug, ctx.player.pos, this.recentSpawns, ctx.player.yaw);
 *       if (spawn) { /* spawn enemy at `spawn` *​/ this.recentSpawns.push({ position: spawn, time: performance.now() }); }
 *       pruneRecentSpawns(this.recentSpawns);
 *   - For future large maps (streaming): register a chunk loader on match start:
 *       ctx.chunkManager?.setChunkLoader((cx, cz) => buildChunkForLargeMap(mapDef, cx, cz));
 *   - On map switch: clearAccentLights(ctx.scene); disposeStoryProps(this.storyPropMeshes);
 *                    ctx.chunkManager?.unloadAll(); resetSetPieces();
 */

// Prompt 73 — destructible set-pieces.
export type {
  SetPieceTrigger,
  SetPieceEffect,
  SetPiece,
  // K-5000 #4228 — set-piece trigger audit result type.
  SetPieceTriggerAudit,
} from "./set-pieces";
export {
  SET_PIECES,
  getSetPiecesForMap,
  getSetPiece,
  getAllSetPieces,
  resetSetPieces,
  tickSetPieces,
  triggerSetPiece,
  // K-5000 #4228 — set-piece trigger audit function.
  auditSetPieceTriggers,
} from "./set-pieces";

// Prompt 74 — environmental storytelling.
export type {
  StoryPropType,
  StoryProp,
  MapStoryScript,
} from "./env-storytelling";
export {
  MAP_STORY_SCRIPTS,
  getStoryScript,
  getStoryProps,
  getAllStoryScripts,
  findHoveredStoryProp,
  getInspectText,
  // K-5000 #4229 — formatted inspect HUD prompt.
  getInspectHudPrompt,
  setInspectHudKey,
  buildStoryProps,
  disposeStoryProps,
  INSPECT_RANGE,
  INSPECT_CONE_HALF_ANGLE,
} from "./env-storytelling";

// Prompt 75 — spawn logic.
export type {
  Vec3,
  RecentSpawn,
  SpawnSelectionOptions,
  ScoredSpawn,
  SpawnSafetyInfo,
} from "./spawn-logic";
export {
  DEFAULT_SPAWN_OPTIONS,
  selectSpawn,
  selectSpawns,
  scoreSpawn,
  getSpawnCandidates,
  getSafeSpawns,
  clearSafeSpawnCache,
  pruneRecentSpawns,
} from "./spawn-logic";

// Prompt 76 — per-map lighting.
export type {
  AccentLight,
  LightingPreset,
  // K-5000 #4230 — mood drift audit result type.
  LightingMoodDrift,
} from "./lighting-pass";
export {
  LIGHTING_PRESETS,
  getMapLighting,
  getAllLightingPresets,
  sunPositionFromPreset,
  applyLightingPreset,
  clearAccentLights,
  // K-5000 #4230 — mood drift audit function.
  validateLightingMoodDrift,
} from "./lighting-pass";
