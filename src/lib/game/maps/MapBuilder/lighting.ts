import * as THREE from "three";
import type { GameContext } from "../../systems/types";
import type { MapDefinition } from "../MapRegistry";

export function applyMapLighting(ctx: GameContext, map: MapDefinition): void {
  const { scene } = ctx;
  if (ctx.hemiLight) {
    ctx.hemiLight.color.setHex(map.lighting.hemi.sky);
    ctx.hemiLight.groundColor.setHex(map.lighting.hemi.ground);
    ctx.hemiLight.intensity = Math.max(0.5, map.lighting.hemi.intensity);
  }
  if (ctx.sunLight) {
    ctx.sunLight.color.setHex(map.lighting.sun.color);
    ctx.sunLight.intensity = Math.max(1.0, map.lighting.sun.intensity);
    ctx.sunLight.position.set(...map.lighting.sun.position);
  }
  if (scene.fog instanceof THREE.FogExp2) {
    scene.fog.color.setHex(map.lighting.fog.color);
    scene.fog.density = Math.min(0.015, map.lighting.fog.density);
  }
}
