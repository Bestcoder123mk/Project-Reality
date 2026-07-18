/**
 * Tests for Prompts A#8 (aim-ik accumulation) + A#9 (weight renormalization).
 *
 * Bug A#8: `bone.rotation.y += clampedYaw * yawWeight * weight` every frame
 *  accumulates unbounded head yaw while aiming. Fix: track the per-bone
 *  prev-frame delta + subtract before re-applying → rotation TRACKS the
 *  target instead of integrating it.
 *
 * Bug A#9: When only 3 of 5 spine bones exist, `normalizeWeights`
 *  redistributed the missing 20% onto present bones, over-rotating the
 *  head to 37.5% of yaw. Fix: cap each bone's effective contribution at
 *  its authored `yawWeight` and clamp the TOTAL applied yaw to
 *  `yawSum × clampedYaw` instead of renormalizing.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { applyAimIK, clearAimIKDeltas } from "../aim-ik";

/** Build a full 5-bone Mixamo-style spine chain as mock Object3Ds. */
function mockFullChain(): Record<string, THREE.Object3D> {
  const rig: Record<string, THREE.Object3D> = {};
  for (const n of ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"]) {
    const b = new THREE.Bone();
    b.name = n;
    rig[n] = b;
  }
  // Parent the chain so getWorldQuaternion/getWorldPosition return
  // identity-ish values (each bone is at origin, identity rotation).
  rig.Spine.parent = rig.Hips;
  rig.Spine1.parent = rig.Spine;
  rig.Spine2.parent = rig.Spine1;
  rig.Neck.parent = rig.Spine2;
  rig.Head.parent = rig.Neck;
  return rig;
}

/** Build a partial 3-bone rig (Head + Neck + Spine2 only) for A#9. */
function mockPartialChain(): Record<string, THREE.Object3D> {
  const rig: Record<string, THREE.Object3D> = {};
  for (const n of ["Hips", "Spine2", "Neck", "Head"]) {
    const b = new THREE.Bone();
    b.name = n;
    rig[n] = b;
  }
  rig.Spine2.parent = rig.Hips;
  rig.Neck.parent = rig.Spine2;
  rig.Head.parent = rig.Neck;
  return rig;
}

describe("Prompt A#8 — aim-ik head yaw accumulation", () => {
  it("head yaw stays bounded (within ±π/4) after 60s of sustained aim", () => {
    const rig = mockFullChain();
    // Put the target at a fixed point that produces ~0.3 rad of yaw.
    // Anchor (Spine2) is at origin; place target forward-right.
    const target = new THREE.Vector3(2, 0, 5);
    const dt = 1 / 60;
    const frames = 60 * 60; // 60s
    for (let i = 0; i < frames; i++) {
      applyAimIK(rig, target, 1.0);
      // dt isn't used by applyAimIK (it's frameless) but we still iterate.
      void dt;
    }
    // Head yaw should be the steady-state contribution, not the
    // integrated value (which would be ~3600 × 0.30 × 0.30 = 324 rad).
    const headYaw = rig.Head.rotation.y;
    expect(
      Math.abs(headYaw),
      `|head yaw| = ${Math.abs(headYaw)} (should be << π/4)`,
    ).toBeLessThan(Math.PI / 4);
  });

  it("head yaw TRACKS the target (steady-state, not integrating)", () => {
    const rig = mockFullChain();
    const target = new THREE.Vector3(2, 0, 5);
    // Drive for 2s (120 frames) to settle.
    for (let i = 0; i < 120; i++) applyAimIK(rig, target, 1.0);
    const yaw2s = rig.Head.rotation.y;
    // Drive another 2s. If tracking (fixed point), yaw should be unchanged.
    for (let i = 0; i < 120; i++) applyAimIK(rig, target, 1.0);
    const yaw4s = rig.Head.rotation.y;
    expect(Math.abs(yaw4s - yaw2s), "yaw should be at steady-state").toBeLessThan(0.001);
  });
});

describe("Prompt A#9 — partial-chain head never exceeds 30° yaw", () => {
  it("3-bone rig: head yaw ≤ π/6 (30°) regardless of target", () => {
    const rig = mockPartialChain();
    // Target at extreme yaw (90° right) — the clamp is ±π × 0.6 ≈ 108°,
    // so clampedYaw = ~108°. With chain weights [Spine2=0.25, Neck=0.20,
    // Head=0.30] → yawSum = 0.75 → total applied yaw = 0.75 × 108° = 81°
    // distributed as: Spine2=20°, Neck=16°, Head=24°. Head < 30°. ✓
    // Without A#9, renormalization would give Head 30/75 × 108° = 43°. ✗
    const target = new THREE.Vector3(10, 0, 0.1); // ~90° to the right
    for (let i = 0; i < 60; i++) applyAimIK(rig, target, 1.0);
    const headYawDeg = Math.abs(rig.Head.rotation.y) * (180 / Math.PI);
    expect(
      headYawDeg,
      `head yaw = ${headYawDeg.toFixed(1)}° (must be ≤ 30°)`,
    ).toBeLessThanOrEqual(30);
  });

  it("full-chain rig: head yaw ≤ its authored weight × clampedYaw", () => {
    const rig = mockFullChain();
    // Target at moderate yaw. Authored Head weight = 0.30; MAX_YAW ≈ 108°.
    // So head yaw ≤ 0.30 × 108° = 32.4°.
    const target = new THREE.Vector3(5, 0, 1);
    for (let i = 0; i < 60; i++) applyAimIK(rig, target, 1.0);
    const headYaw = Math.abs(rig.Head.rotation.y);
    const maxExpected = 0.30 * (Math.PI * 0.6) * 1.10; // 10% slack for clamp rounding
    expect(headYaw, "head yaw must respect authored weight cap").toBeLessThanOrEqual(maxExpected);
  });
});

describe("clearAimIKDeltas — reset on rig respawn", () => {
  it("clearing deltas lets the next applyAimIK recompute from rest pose", () => {
    const rig = mockFullChain();
    const target = new THREE.Vector3(2, 0, 5);
    for (let i = 0; i < 60; i++) applyAimIK(rig, target, 1.0);
    const yawBefore = rig.Head.rotation.y;
    // Reset bones to rest + clear deltas.
    for (const k of Object.keys(rig)) rig[k].rotation.set(0, 0, 0);
    clearAimIKDeltas(rig);
    // Apply again — should produce the same yaw (steady-state).
    for (let i = 0; i < 60; i++) applyAimIK(rig, target, 1.0);
    const yawAfter = rig.Head.rotation.y;
    expect(Math.abs(yawAfter - yawBefore), "post-reset yaw should match pre-reset").toBeLessThan(0.01);
  });
});
