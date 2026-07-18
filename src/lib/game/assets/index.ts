/**
 * SEC2-ART — barrel export for the art-pipeline modules.
 *
 * One import surface for the orchestrator + engine wiring:
 *   import {
 *     loadModel, hasModel, getArtManifest, WEAPON_ART_MANIFEST,
 *     buildRiggedHumanoid, playClip,
 *     attachHeadBlendshapes, setExpression,
 *     getPBRSet,
 *     addLOD, buildLODChain, pickLODTier, DEFAULT_LOD_DISTANCES,
 *     attachToSocket, attachLoadoutAttachments, buildAttachmentMesh,
 *     buildKitPiece, buildBunkerKitDressing,
 *     spawnGrassField, spawnTree, spawnBush, updateVegetation,
 *     attachCloth, updateCloth,
 *   } from "@/lib/game/assets";
 */

export * from "./ModelRegistry";
export * from "./CharacterRig";
export * from "./FacialAnim";
export * from "./AttachmentSockets";
export * from "./EnvArtKit";
export * from "./Vegetation";
export * from "./ClothSim";
