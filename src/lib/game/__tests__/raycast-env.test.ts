/**
 * Prompt A#3 — unit test for the env-raycast-target cache.
 *
 * Acceptance criterion: "a unit test fires 1000 rays into an empty scene
 * and asserts 0 intersections." Plus positive cases for the exclusion
 * rules (camera, weaponGroup, avatar, sprite, HUD-tag, viewmodel-tag,
 * enemy-tag).
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import {
  getEnvRaycastTargets,
  isRaycastExcluded,
  invalidateEnvRaycastTargets,
} from "../systems/raycast-env";
import type { GameContext } from "../systems/types";

/** Build a minimal GameContext stub with a scene + camera + weaponGroup +
 *  avatar group — enough for the raycast-env helpers. */
function makeCtx(): GameContext {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const weaponGroup = new THREE.Group();
  weaponGroup.name = "weaponGroup";
  const avatarGroup = new THREE.Group();
  avatarGroup.name = "avatar";
  scene.add(camera);
  scene.add(weaponGroup);
  scene.add(avatarGroup);
  // A "world" mesh — a wall.
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(10, 4, 0.2),
    new THREE.MeshStandardMaterial(),
  );
  wall.position.set(0, 2, -5);
  scene.add(wall);
  return {
    scene,
    camera,
    weaponGroup,
    avatar: { group: avatarGroup } as GameContext["avatar"],
  } as unknown as GameContext;
}

describe("raycast-env — getEnvRaycastTargets", () => {
  it("1000 rays into an empty scene produce 0 intersections (Prompt A#3 acceptance)", () => {
    const ctx = makeCtx();
    // Strip the wall — empty scene.
    while (ctx.scene.children.length > 0) {
      ctx.scene.remove(ctx.scene.children[0]);
    }
    // Add ONLY a camera + a HUD sprite + a viewmodel quad — none should
    // be raycastable.
    const camera = new THREE.PerspectiveCamera();
    ctx.scene.add(camera);
    const hudSprite = new THREE.Sprite(new THREE.SpriteMaterial());
    ctx.scene.add(hudSprite);
    const hudQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial(),
    );
    hudQuad.userData.isHUDSprite = true;
    ctx.scene.add(hudQuad);
    const viewmodelQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.5),
      new THREE.MeshBasicMaterial(),
    );
    viewmodelQuad.userData.isViewmodel = true;
    ctx.scene.add(viewmodelQuad);

    invalidateEnvRaycastTargets(ctx);
    const targets = getEnvRaycastTargets(ctx);
    expect(targets.length).toBe(0);

    const raycaster = new THREE.Raycaster();
    let totalHits = 0;
    for (let i = 0; i < 1000; i++) {
      const angle = (i / 1000) * Math.PI * 2;
      raycaster.set(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(Math.cos(angle), Math.sin(angle) * 0.3, -1).normalize(),
      );
      raycaster.far = 100;
      totalHits += raycaster.intersectObjects(targets, false).length;
    }
    expect(totalHits, "1000 rays into empty scene must produce 0 hits").toBe(0);
  });

  it("excludes camera, weaponGroup, avatar, sprites, HUD quads, viewmodel quads, enemy parts", () => {
    const ctx = makeCtx();
    // Camera is in scene.
    expect(isRaycastExcluded(ctx.camera, ctx)).toBe(true);
    // Weapon group is in scene.
    expect(isRaycastExcluded(ctx.weaponGroup, ctx)).toBe(true);
    // Avatar group.
    expect(isRaycastExcluded(ctx.avatar!.group, ctx)).toBe(true);
    // Sprite.
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
    expect(isRaycastExcluded(sprite, ctx)).toBe(true);
    // HUD-tagged mesh.
    const hud = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    hud.userData.isHUDSprite = true;
    expect(isRaycastExcluded(hud, ctx)).toBe(true);
    // Viewmodel-tagged mesh.
    const vm = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    vm.userData.isViewmodel = true;
    expect(isRaycastExcluded(vm, ctx)).toBe(true);
    // Enemy-tagged mesh.
    const enemy = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    enemy.userData.enemy = true;
    expect(isRaycastExcluded(enemy, ctx)).toBe(true);
  });

  it("returns the world wall as a raycast target", () => {
    const ctx = makeCtx();
    invalidateEnvRaycastTargets(ctx);
    const targets = getEnvRaycastTargets(ctx);
    // One world wall mesh — the camera + weaponGroup + avatarGroup are
    // excluded, the wall is included.
    expect(targets.length).toBe(1);
    expect(targets[0].type).toBe("Mesh");

    // Raycast forward — should hit the wall.
    const raycaster = new THREE.Raycaster();
    raycaster.set(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
    raycaster.far = 100;
    const hits = raycaster.intersectObjects(targets, false);
    expect(hits.length).toBe(1);
    expect(hits[0].point.z).toBeLessThan(-4);
  });

  it("cache invalidates when scene.children.length changes", () => {
    const ctx = makeCtx();
    invalidateEnvRaycastTargets(ctx);
    const first = getEnvRaycastTargets(ctx);
    expect(first.length).toBe(1);
    // Add another wall — child count changes → cache rebuilds.
    const wall2 = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 0.2),
      new THREE.MeshStandardMaterial(),
    );
    wall2.position.set(3, 1, -3);
    ctx.scene.add(wall2);
    const second = getEnvRaycastTargets(ctx);
    expect(second.length).toBe(2);
  });
});
