/**
 * SEC9-LEVEL — Maps API barrel.
 *
 * Single import surface for everything map-related: registry, builder,
 * validator (Prompt 71), design notes, and the new level/ subsystems
 * (set-pieces, env-storytelling, spawn-logic, lighting-pass).
 *
 * Section M — Maps & Environments barrel. Adds the 11 new modules:
 *   - biomes (desert, arctic, jungle, urban, coastal, mountain)
 *   - photogrammetry (procedural PBR texture pipeline)
 *   - destruction (per-biome destruction graph + battle damage decals)
 *   - dynamic-time (real-time sun position + day/night variants)
 *   - weather-maps (per-map weather presets + gameplay impact)
 *   - verticality (multi-story buildings + underground tunnels)
 *   - underwater (submerged zones + swimming mechanics)
 *   - interactive-env (doors, switches, elevators, breachable walls)
 *   - vegetation-system (procedural vegetation with wind animation)
 *   - urban-kit (modular buildings + street props + vehicles + roads)
 *   - map-voting (between-match vote flow with recency-weighted sampling)
 *
 * SSR-safe — the modules under src/lib/game/level/ do NOT import THREE at
 * module load (only inside their apply/build functions), so importing this
 * barrel from a server component or unit test is safe.
 */

export type {
  MapPropType,
  MapProp,
  MapLightConfig,
  MapDefinition,
  DesignNotes,
} from "./MapRegistry";
export {
  MAP_REGISTRY,
  MAP_DESIGN_NOTES,
  getMap,
  // K-5000 #4214 — lazy/sync map-bundle API.
  getMapSync,
  loadMapBundle,
  preloadAllMapBundles,
  getMapList,
  getDesignNotes,
  getMapDesignSummary,
} from "./MapRegistry";

// Prompt 71 — formal level-design validator.
export type {
  SpawnSafetyResult,
  CoverZoneResult,
  SightlineResult,
  MapValidationResult,
  // K-5000 #4204–#4208 — extended audit result types.
  VerticalityResult,
  NavmeshResult,
  BoundaryResult,
  RespawnZoneResult,
  ObjectiveZoneResult,
  // K-5000 #4209–#4210 — static-audit comparison types.
  SightlineAuditDivergence,
  EnvStorytellingDivergence,
} from "./MapValidator";
export {
  validateMap,
  validateMapDefinition,
  validateAllMaps,
  // K-5000 #4209–#4210 — static-audit comparison functions.
  compareSightlineAudits,
  compareEnvStorytellingAudits,
} from "./MapValidator";

// ──────────────────────────────────────────────────────────────────────────
// Section M — Maps & Environments
// ──────────────────────────────────────────────────────────────────────────

// Biome system — biome definitions, resolver, lighting merge.
export type {
  BiomeId,
  BiomeGroundMaterial,
  BiomeAtmosphere,
  VegetationSlug,
  BiomeDefinition,
} from "./biomes";
export {
  BIOMES,
  getBiome,
  listBiomes,
  mergeBiomeLighting,
  resolveBiome,
} from "./biomes";

// Photogrammetry — procedural PBR texture pipeline.
export type {
  PbrTextureSet,
  PbrSurfaceClass,
} from "./photogrammetry";
export {
  generatePbrSet,
  buildPbrMaterial,
  disposePbrCache,
} from "./photogrammetry";

// Destruction — per-biome destruction graph + battle damage decals.
export type {
  DestructionClass,
  DestructionProfile,
  DestructionNode,
  DestructionEvent,
  BattleDamageDecal,
} from "./destruction";
export {
  DESTRUCTION_PROFILES,
  DESTRUCTION_GRAPH,
  DestructionGraph,
  BATTLE_DECALS,
  spawnBattleDamage,
  tickBattleDecals,
  clearBattleDecals,
} from "./destruction";

// Dynamic time-of-day — real-time sun position + day/night variants.
export type {
  TimeScalePreset,
  TimeOfDayControllerCtx,
  TimeOfDayController,
} from "./dynamic-time";
export {
  DYNAMIC_TIME_PRESETS,
  createTimeOfDayController,
  sunColorForHour,
  skyColorForHour,
  fogForHour,
  sunPositionForHour,
  dayNightVariant,
} from "./dynamic-time";

// Weather-maps — per-map weather presets + gameplay impact.
export type {
  WeatherPresetId,
  PrecipitationType,
  WeatherPreset,
  WeatherGameplayImpact,
  EngineWeatherState,
} from "./weather-maps";
export {
  WEATHER_PRESETS,
  getWeatherPreset,
  pickWeatherForBiome,
  applyWeatherPreset,
  getWeatherGameplayImpact,
  listWeatherPresets,
} from "./weather-maps";

// Verticality — multi-story buildings + underground tunnels.
export type {
  MultiStoryBuildingOptions,
  TunnelOptions,
  FloorRecord,
  Structure,
} from "./verticality";
export {
  registerStructure,
  getStructure,
  collapseFloor,
  clearStructures,
  buildMultiStoryBuilding,
  buildUndergroundTunnel,
  disposeVerticality,
} from "./verticality";

// Underwater — submerged zones + swimming mechanics.
export type {
  WaterType,
  UnderwaterZone,
  OxygenState,
} from "./underwater";
export {
  registerUnderwaterZone,
  getUnderwaterZonesForMap,
  clearUnderwaterZones,
  isCameraSubmerged,
  submergedDepth,
  getSwimMovementMultiplier,
  getSubmergedFog,
  tickOxygen,
  createWaterSurface,
  defaultCoastalZone,
  defaultJungleZone,
  disposeUnderwater,
} from "./underwater";

// Interactive env — doors, switches, elevators, breachable walls.
export type {
  InteractiveKind,
  InteractiveBase,
  DoorInteractive,
  SwitchInteractive,
  ElevatorInteractive,
  DestructibleWallInteractive,
  InteractiveProp,
  TriggerResult,
  TriggerEffect,
  InteractiveInViewResult,
} from "./interactive-env";
export {
  registerInteractive,
  getInteractive,
  getInteractivesForMap,
  clearInteractives,
  triggerInteractive,
  damageDestructibleWall,
  findInteractiveInView,
  buildDoor,
  buildSwitch,
  buildElevator,
  buildDestructibleWall,
  disposeInteractives,
} from "./interactive-env";

// Vegetation system — procedural vegetation with wind animation.
export type {
  VegetationProfile,
} from "./vegetation-system";
export {
  VEGETATION_PROFILES,
  getVegetationProfile,
  WIND_UNIFORMS,
  buildVegetation,
  disposeVegetation,
} from "./vegetation-system";

// Urban kit — modular buildings + street props + vehicles + roads.
export type {
  ModularBuildingOptions,
  StreetPropSlug,
  VehicleSlug,
  RoadSegmentOptions,
} from "./urban-kit";
export {
  URBAN_BUILDING_PRESETS,
  STREET_PROP_PRESETS,
  VEHICLE_PRESETS,
  buildModularBuilding,
  buildStreetProp,
  buildVehicle,
  buildRoadSegment,
} from "./urban-kit";

// Map voting — between-match vote flow.
export type {
  VoteSession,
  VoteTally,
} from "./map-voting";
export {
  createVoteSession,
  castVote,
  tallyVotes,
  resolveVote,
  cancelVoteSession,
  getVoteSession,
  clearVoteSessions,
  subscribe,
  getCandidateSet,
  buildCandidateSetFromRegistry,
  runDefaultVote,
} from "./map-voting";
