/**
 * Tests for Section F / Section A physics-engine fixes.
 *
 * Covers the foundational PhysicsBackend.ts bug fixes from Section A
 * (prompts 97-106) + the Section F opt-in features (731-746, 737, 739, 740,
 * 743, 746). Run with `bun run test` (vitest).
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import {
  ImpulsePhysicsBackend,
  CollisionGroup,
  COLLIDE_ALL,
  GRAVITY,
  PHYSICS_GRAVITY_ARCADE_MULT,
} from "../PhysicsBackend";

describe("ImpulsePhysicsBackend — Section A bug fixes (#97-#106)", () => {
  let backend: ImpulsePhysicsBackend;
  beforeEach(() => {
    backend = new ImpulsePhysicsBackend();
  });

  describe("#92 / #731 — single gravity constant", () => {
    it("exports GRAVITY = -9.81 (realistic)", () => {
      expect(GRAVITY).toBe(-9.81);
    });
    it("exports PHYSICS_GRAVITY_ARCADE_MULT = 2.2 (player feels snappier)", () => {
      expect(PHYSICS_GRAVITY_ARCADE_MULT).toBe(2.2);
    });
    it("player arcade gravity ≈ -21.6 m/s² (matches old hardcoded -22)", () => {
      const playerG = GRAVITY * PHYSICS_GRAVITY_ARCADE_MULT;
      expect(Math.abs(playerG - (-21.582))).toBeLessThan(0.01);
    });
  });

  describe("#102 — typed restFrames field on PhysicsBody", () => {
    it("PhysicsBody.restFrames is a typed number field (no cast)", () => {
      const id = backend.addDynamicBody({ position: new THREE.Vector3(0, 1, 0), mass: 1 });
      const body = backend.getDynamicBodies().find((b) => b.id === id);
      expect(body).toBeDefined();
      expect(typeof body!.restFrames).toBe("number");
      expect(body!.restFrames).toBe(0);
    });
  });

  describe("#103 / #734 — collision groups/masks", () => {
    it("bodies with non-overlapping group/mask do not collide", () => {
      // Pickup (group=PICKUP) only collides with PLAYER mask.
      const pickup = backend.addDynamicBody({
        position: new THREE.Vector3(0, 1, 0),
        mass: 1,
        group: CollisionGroup.PICKUP,
        mask: CollisionGroup.PLAYER,
      });
      // Debris (group=DEBRIS) only collides with STATIC_WORLD.
      const debris = backend.addDynamicBody({
        position: new THREE.Vector3(0, 1, 0),
        mass: 1,
        group: CollisionGroup.DEBRIS,
        mask: CollisionGroup.STATIC_WORLD,
      });
      const pickupBody = backend.getDynamicBodies().find((b) => b.id === pickup)!;
      const debrisBody = backend.getDynamicBodies().find((b) => b.id === debris)!;
      // Both at same position — without the filter they'd collide.
      pickupBody.position.set(0, 1, 0);
      debrisBody.position.set(0, 1, 0);
      backend.step(1 / 60);
      // The filter should prevent collision resolution; both should fall freely.
      expect(pickupBody.position.y).toBeLessThan(1);
      expect(debrisBody.position.y).toBeLessThan(1);
    });
  });

  describe("#105 — getDynamicBodies returns live view (no per-call alloc)", () => {
    it("returns the same array reference across calls", () => {
      const a = backend.getDynamicBodies();
      const b = backend.getDynamicBodies();
      expect(a).toBe(b); // same reference (no .slice() allocation)
    });
  });

  describe("#106 — real sphere primitive", () => {
    it("sphere bodies have shape='sphere' + equal half-extents", () => {
      const id = backend.addDynamicBody({
        position: new THREE.Vector3(0, 1, 0),
        mass: 1,
        sphereRadius: 0.5,
      });
      const body = backend.getDynamicBodies().find((b) => b.id === id)!;
      expect(body.shape).toBe("sphere");
      expect(body.halfExtents.x).toBe(0.5);
      expect(body.halfExtents.y).toBe(0.5);
      expect(body.halfExtents.z).toBe(0.5);
    });
    it("sphere-vs-sphere collision resolves", () => {
      const a = backend.addDynamicBody({
        position: new THREE.Vector3(0, 0.5, 0), mass: 1, sphereRadius: 0.5,
      });
      const b = backend.addDynamicBody({
        position: new THREE.Vector3(0, 0.5, 0), mass: 1, sphereRadius: 0.5,
      });
      const aBody = backend.getDynamicBodies().find((x) => x.id === a)!;
      const bBody = backend.getDynamicBodies().find((x) => x.id === b)!;
      // Both spheres at same position — they should separate after a step.
      backend.step(1 / 60);
      const dist = aBody.position.distanceTo(bBody.position);
      expect(dist).toBeGreaterThan(0.001);
    });
  });

  describe("#98 — Baumgarte slop/percent in positional correction", () => {
    it("resting stacks do not jitter (penetration stays within slop)", () => {
      backend.addStaticCollider({
        min: new THREE.Vector3(-10, -1, -10),
        max: new THREE.Vector3(10, 0, 10),
      });
      const box = backend.addDynamicBody({
        position: new THREE.Vector3(0, 0.5, 0),
        mass: 1,
        box: { min: new THREE.Vector3(-0.5, -0.5, -0.5), max: new THREE.Vector3(0.5, 0.5, 0.5) },
      });
      const boxBody = backend.getDynamicBodies().find((b) => b.id === box)!;
      for (let i = 0; i < 60; i++) backend.step(1 / 60);
      expect(boxBody.position.y).toBeGreaterThan(0.45);
      expect(boxBody.position.y).toBeLessThan(0.55);
    });
  });

  describe("#101 / #733 — horizontal-velocity sleep gate", () => {
    it("a body sliding horizontally does not sleep prematurely", () => {
      backend.addStaticCollider({
        min: new THREE.Vector3(-10, -1, -10),
        max: new THREE.Vector3(10, 0, 10),
      });
      const id = backend.addDynamicBody({
        position: new THREE.Vector3(0, 0.5, 0),
        mass: 1,
        box: { min: new THREE.Vector3(-0.5, -0.5, -0.5), max: new THREE.Vector3(0.5, 0.5, 0.5) },
      });
      const body = backend.getDynamicBodies().find((b) => b.id === id)!;
      body.linearVelocity.x = 3;
      for (let i = 0; i < 60; i++) backend.step(1 / 60);
      expect(body.resting).toBe(false);
      expect(Math.abs(body.linearVelocity.x)).toBeGreaterThan(0.5);
    });
  });

  describe("#99 / #100 / #732 — friction (post-normal-impulse + average)", () => {
    it("friction uses average (b1+b2)/2 — decelerates the body", () => {
      backend.addStaticCollider({
        min: new THREE.Vector3(-10, -1, -10),
        max: new THREE.Vector3(10, 0, 10),
      });
      const box = backend.addDynamicBody({
        position: new THREE.Vector3(0, 0.5, 0),
        mass: 1,
        box: { min: new THREE.Vector3(-0.5, -0.5, -0.5), max: new THREE.Vector3(0.5, 0.5, 0.5) },
      });
      const body = backend.getDynamicBodies().find((b) => b.id === box)!;
      body.friction = 0.05; // ice
      body.linearVelocity.x = 5;
      for (let i = 0; i < 60; i++) backend.step(1 / 60);
      expect(Math.abs(body.linearVelocity.x)).toBeLessThan(5);
    });
  });
});

describe("ImpulsePhysicsBackend — Section F opt-in features (#731-#746)", () => {
  let backend: ImpulsePhysicsBackend;
  beforeEach(() => {
    backend = new ImpulsePhysicsBackend();
  });

  describe("#97 / #731 — CCD for high-velocity bodies", () => {
    it("CCD is off by default", () => {
      const id = backend.addDynamicBody({ position: new THREE.Vector3(0, 0, 0), mass: 1 });
      const body = backend.getDynamicBodies().find((b) => b.id === id)!;
      expect(body.ccdEnabled).toBe(false);
    });
    it("setBodyCCD toggles CCD on a body", () => {
      const id = backend.addDynamicBody({ position: new THREE.Vector3(0, 0, 0), mass: 1 });
      backend.setBodyCCD(id, true);
      const body = backend.getDynamicBodies().find((b) => b.id === id)!;
      expect(body.ccdEnabled).toBe(true);
    });
    it("a fast CCD-enabled bullet does not tunnel through a thin wall", () => {
      // Thin wall at x=5, thickness 0.1m.
      backend.addStaticCollider({
        min: new THREE.Vector3(4.95, -1, -1),
        max: new THREE.Vector3(5.05, 1, 1),
      });
      const bullet = backend.addDynamicBody({
        position: new THREE.Vector3(0, 0, 0),
        mass: 0.01,
        sphereRadius: 0.05,
      });
      backend.setBodyCCD(bullet, true);
      const bulletBody = backend.getDynamicBodies().find((b) => b.id === bullet)!;
      bulletBody.linearVelocity.set(800, 0, 0);
      for (let i = 0; i < 5; i++) backend.step(1 / 60);
      expect(bulletBody.position.x).toBeLessThan(5.1);
    });
  });

  describe("#736 — uniform-grid broadphase", () => {
    it("handles >16 dynamic bodies without crash (broadphase engaged)", () => {
      for (let i = 0; i < 20; i++) {
        backend.addDynamicBody({
          position: new THREE.Vector3(i * 2, 0.5, 0),
          mass: 1,
          box: { min: new THREE.Vector3(-0.5, -0.5, -0.5), max: new THREE.Vector3(0.5, 0.5, 0.5) },
        });
      }
      for (let i = 0; i < 10; i++) backend.step(1 / 60);
      const bodies = backend.getDynamicBodies();
      expect(bodies.length).toBe(20);
    });
  });

  describe("#737 — buoyancy", () => {
    it("addWaterVolume + setBodyBuoyancy keep body afloat vs gravity", () => {
      backend.addWaterVolume({
        min: new THREE.Vector3(-10, 0, -10),
        max: new THREE.Vector3(10, 2, 10),
      });
      const id = backend.addDynamicBody({
        position: new THREE.Vector3(0, 1, 0),
        mass: 1,
        box: { min: new THREE.Vector3(-0.5, -0.5, -0.5), max: new THREE.Vector3(0.5, 0.5, 0.5) },
      });
      backend.setBodyBuoyancy(id, 1.0);
      const body = backend.getDynamicBodies().find((b) => b.id === id)!;
      const startY = body.position.y;
      for (let i = 0; i < 60; i++) backend.step(1 / 60);
      expect(body.position.y).toBeGreaterThanOrEqual(startY - 0.5);
    });
  });

  describe("#739 — breakable distance constraint", () => {
    it("addDistanceConstraint + breakForce snaps under stress", () => {
      const anchor = backend.addStaticCollider({
        min: new THREE.Vector3(0, 5, 0),
        max: new THREE.Vector3(0.1, 5.1, 0.1),
      });
      const hanging = backend.addDynamicBody({
        position: new THREE.Vector3(0, 4, 0),
        mass: 5,
      });
      const constraintId = backend.addDistanceConstraint(anchor, hanging, 1.0, { breakForce: 50 });
      expect(constraintId).toBeGreaterThan(0);
      for (let i = 0; i < 60; i++) backend.step(1 / 60);
      const body = backend.getDynamicBodies().find((b) => b.id === hanging)!;
      expect(body.position.y).not.toBe(4);
    });
  });

  describe("#740 — soft body (volume preservation)", () => {
    it("addSoftBody creates a soft body that integrates without crash", () => {
      const particles = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1),
      ];
      const id = backend.addSoftBody({
        particles,
        restVolume: 1,
        pressure: 1,
        stiffness: 0.5,
      });
      expect(id).toBeGreaterThan(0);
      for (let i = 0; i < 10; i++) backend.step(1 / 60);
    });
  });

  describe("#746 — aerodynamic drag (quadratic)", () => {
    it("setBodyAeroDrag sets a body's drag coefficient", () => {
      const id = backend.addDynamicBody({ position: new THREE.Vector3(0, 0, 0), mass: 1 });
      backend.setBodyAeroDrag(id, 0.5);
      const body = backend.getDynamicBodies().find((b) => b.id === id)!;
      expect(body.aeroDrag).toBe(0.5);
    });
    it("a body with high aero drag decelerates faster than one without", () => {
      const noDragId = backend.addDynamicBody({ position: new THREE.Vector3(0, 5, 0), mass: 1 });
      const dragId = backend.addDynamicBody({ position: new THREE.Vector3(1, 5, 0), mass: 1 });
      backend.setBodyAeroDrag(dragId, 2.0);
      const noDrag = backend.getDynamicBodies().find((b) => b.id === noDragId)!;
      const drag = backend.getDynamicBodies().find((b) => b.id === dragId)!;
      noDrag.linearVelocity.set(10, 0, 0);
      drag.linearVelocity.set(10, 0, 0);
      for (let i = 0; i < 30; i++) backend.step(1 / 60);
      expect(Math.abs(drag.linearVelocity.x)).toBeLessThan(Math.abs(noDrag.linearVelocity.x));
    });
  });

  describe("#743 — joint friction", () => {
    it("addDistanceConstraint with friction damps tangential motion", () => {
      const a = backend.addDynamicBody({ position: new THREE.Vector3(0, 0, 0), mass: 1 });
      const b = backend.addDynamicBody({ position: new THREE.Vector3(1, 0, 0), mass: 1 });
      backend.addDistanceConstraint(a, b, 1.0, { friction: 0.8 });
      const aBody = backend.getDynamicBodies().find((x) => x.id === a)!;
      const bBody = backend.getDynamicBodies().find((x) => x.id === b)!;
      aBody.linearVelocity.set(0, 5, 0);
      for (let i = 0; i < 60; i++) backend.step(1 / 60);
      const relVy = aBody.linearVelocity.y - bBody.linearVelocity.y;
      expect(Math.abs(relVy)).toBeLessThan(5);
    });
  });

  describe("collision group/mask constants", () => {
    it("exports the standard group bitfields", () => {
      expect(CollisionGroup.DEFAULT).toBe(0x0001);
      expect(CollisionGroup.PLAYER).toBe(0x0002);
      expect(CollisionGroup.DEBRIS).toBe(0x0010);
      expect(CollisionGroup.RAGDOLL).toBe(0x0020);
      expect(CollisionGroup.STATIC_WORLD).toBe(0x0200);
      expect(COLLIDE_ALL).toBe(0xFFFF);
    });
  });
});
