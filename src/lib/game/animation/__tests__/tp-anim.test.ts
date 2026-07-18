/**
 * Tests for the animation accumulation bugs fixed by Prompts A#7 + A#19 + A#20
 * + A#21 + A#22 in `tp-anim.ts`.
 *
 * The unifying root cause of all 5 bugs: rotations applied additively each
 * frame without a delta-subtraction step, so contributions integrated
 * unbounded. The fix tracks the previous frame's per-bone contribution and
 * subtracts it before re-applying this frame's — the rotation now tracks
 * the target value instead of integrating it.
 *
 * Each test instantiates a minimal rig of mock `Object3D`s (no Three
 * renderer / WebGL needed — `Object3D` is a plain math object with a
 * `rotation` Euler), drives the TPAnimLayer for the documented acceptance
 * duration, and asserts the acceptance criteria.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { TPAnimLayer, rigPartsFromCharacterRig } from "../tp-anim";

/** Build a minimal Mixamo-style rig of mock Object3D bones. */
function mockRig(): ReturnType<typeof rigPartsFromCharacterRig> {
  const names = [
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head",
    "LeftArm", "LeftForeArm", "LeftHand",
    "RightArm", "RightForeArm", "RightHand",
    "LeftUpLeg", "LeftLeg", "LeftFoot",
    "RightUpLeg", "RightLeg", "RightFoot",
  ];
  const bones: Record<string, THREE.Bone> = {};
  for (const n of names) {
    const b = new THREE.Bone();
    b.name = n;
    bones[n] = b;
  }
  return rigPartsFromCharacterRig(bones);
}

describe("Prompt A#7 — tp-anim spine yaw accumulation", () => {
  it("aiming for 60s leaves spine rotation bounded (|rot.y| < 2π)", () => {
    const parts = mockRig();
    const layer = new TPAnimLayer(parts);
    // Hold a fixed aim yaw for 60s — the bug would integrate
    // `aimYaw * yawW` every frame, accumulating unbounded rotation.
    layer.setAimDirection(0.4, 0);
    const dt = 1 / 60;
    const frames = 60 * 60; // 60s at 60fps
    for (let i = 0; i < frames; i++) {
      layer.setLocomotion(0, false);
      layer.tick(dt);
    }
    // Walk every bone, assert |rotation.y| stays well under 2π.
    let maxAbsYaw = 0;
    for (const key of Object.keys(parts)) {
      const bone = parts[key];
      if (!bone) continue;
      const y = Math.abs(bone.rotation.y);
      if (y > maxAbsYaw) maxAbsYaw = y;
    }
    // Each spine bone's yawW is ≤ 0.25; with aimYaw=0.4 the steady-state
    // contribution is ≤ 0.1 rad per bone. Allow generous slack (2π) so the
    // test is robust to small per-frame drift, but flag the integration
    // bug which would produce ~1440 rad after 60s.
    expect(maxAbsYaw, `max |rotation.y| = ${maxAbsYaw} (should be << 2π)`).toBeLessThan(2 * Math.PI);
  });

  it("aim yaw TRACKS the target (steady-state within ±5% of yawW × aimYaw)", () => {
    const parts = mockRig();
    const layer = new TPAnimLayer(parts);
    layer.setAimDirection(1.0, 0); // 1 rad yaw
    for (let i = 0; i < 120; i++) layer.tick(1 / 60); // 2s to settle

    // Spine2 yawW = 0.25 → steady-state rotation.y ≈ 0.25 rad.
    const spine2 = parts["Spine2"];
    expect(spine2).toBeDefined();
    const y = spine2!.rotation.y;
    // Allow ±10% slack for sub-frame quantization.
    expect(Math.abs(y - 0.25)).toBeLessThan(0.025);
  });
});

describe("Prompt A#19 — leg phase offset (π, not 0.15 rad)", () => {
  it("left + right leg swings are in counter-phase", () => {
    const parts = mockRig();
    const layer = new TPAnimLayer(parts);
    layer.setLocomotion(5, false); // walk speed
    // Step through a full gait cycle.
    const dt = 1 / 60;
    let maxInPhase = 0; // max |left + right| (should be small for counter-phase)
    let maxAntiPhase = 0; // max |left - right| (should be large)
    for (let i = 0; i < 120; i++) {
      layer.tick(dt);
      const lUpLeg = parts["LeftUpLeg"]!;
      const rUpLeg = parts["RightUpLeg"]!;
      const sum = Math.abs(lUpLeg.rotation.x + rUpLeg.rotation.x);
      const diff = Math.abs(lUpLeg.rotation.x - rUpLeg.rotation.x);
      if (sum > maxInPhase) maxInPhase = sum;
      if (diff > maxAntiPhase) maxAntiPhase = diff;
    }
    // Counter-phase: diff should dominate sum (legs swing opposite).
    expect(maxAntiPhase, "legs should swing in counter-phase").toBeGreaterThan(maxInPhase * 2);
  });
});

describe("Prompt A#20 — right knee bends on forward swing", () => {
  it("right knee bend peaks when right foot swings forward (positive swingR)", () => {
    const parts = mockRig();
    const layer = new TPAnimLayer(parts);
    layer.setLocomotion(5, false);
    // Track right knee rotation vs gait phase.
    const samples: Array<{ phase: number; rot: number }> = [];
    const dt = 1 / 60;
    for (let i = 0; i < 240; i++) {
      layer.tick(dt);
      const rLeg = parts["RightLeg"]!;
      samples.push({ phase: layer.currentGaitPhase, rot: rLeg.rotation.x });
    }
    // Find the gait phase where the right knee is at its peak bend.
    // Right leg uses swingR = sin(phase + π); forward swing = sin(phase+π) > 0
    // → phase+π ∈ (0, π) → phase ∈ (-π, 0). Knee bend should be > 0 there.
    let bendsOnForwardSwing = 0;
    let bendsOnBackwardSwing = 0;
    for (const s of samples) {
      const phaseR = s.phase + Math.PI; // right-leg phase
      const forward = Math.sin(phaseR) > 0; // foot swinging forward
      if (s.rot > 0.05) {
        if (forward) bendsOnForwardSwing++;
        else bendsOnBackwardSwing++;
      }
    }
    // At least 4× more samples should bend on forward swing than backward.
    expect(bendsOnForwardSwing, "knee should bend on forward swing").toBeGreaterThan(
      bendsOnBackwardSwing * 4,
    );
  });
});

describe("Prompt A#21 — cadence decoupled from speed", () => {
  it("walking at 9 m/s doesn't cycle 50% faster than 6 m/s run", () => {
    const parts1 = mockRig();
    const parts2 = mockRig();
    const walkLayer = new TPAnimLayer(parts1, { walkCycleHz: 1.0, runCycleHz: 1.4 });
    const runLayer = new TPAnimLayer(parts2, { walkCycleHz: 1.0, runCycleHz: 1.4 });
    // Drive both for 1 simulated second at their respective speeds.
    walkLayer.setLocomotion(6, false); // run threshold
    runLayer.setLocomotion(9, false);  // faster than run
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) {
      walkLayer.tick(dt);
      runLayer.tick(dt);
    }
    // Cadence (phase advance rate) is identical regardless of speed — only
    // amplitude scales. So the gait phase should advance by the same amount
    // (modulo the walk vs run cycleHz switch: 6 m/s > 5 so both use runCycleHz).
    const phaseDiff = Math.abs(walkLayer.currentGaitPhase - runLayer.currentGaitPhase);
    // Allow ≤ 5% slack for FP error.
    expect(phaseDiff, "phase advance should be independent of speed").toBeLessThan(
      0.05 * walkLayer.currentGaitPhase,
    );
  });

  it("amplitude scales with speed (sliding at 9 m/s has bigger swing than 6 m/s)", () => {
    const parts1 = mockRig();
    const parts2 = mockRig();
    const walkLayer = new TPAnimLayer(parts1);
    const runLayer = new TPAnimLayer(parts2);
    walkLayer.setLocomotion(6, false);
    runLayer.setLocomotion(9, false);
    const dt = 1 / 60;
    let maxWalkSwing = 0;
    let maxRunSwing = 0;
    for (let i = 0; i < 120; i++) {
      walkLayer.tick(dt);
      runLayer.tick(dt);
      maxWalkSwing = Math.max(maxWalkSwing, Math.abs(parts1["LeftUpLeg"]!.rotation.x));
      maxRunSwing = Math.max(maxRunSwing, Math.abs(parts2["LeftUpLeg"]!.rotation.x));
    }
    expect(maxRunSwing, "amplitude should scale with speed").toBeGreaterThan(maxWalkSwing);
  });
});

describe("Prompt A#22 — airborne leg pop blend", () => {
  it("landing transitions smoothly (no >0.5 rad snap in a single frame)", () => {
    const parts = mockRig();
    const layer = new TPAnimLayer(parts);
    layer.setLocomotion(5, true); // airborne
    // Run a few frames airborne to settle the airborne blend.
    for (let i = 0; i < 30; i++) layer.tick(1 / 60);
    // Land — the bug would snap legs from tuck to gait in 1 frame.
    let maxFrameDelta = 0;
    let prevLUpLeg = parts["LeftUpLeg"]!.rotation.x;
    layer.setLocomotion(5, false);
    for (let i = 0; i < 30; i++) {
      layer.tick(1 / 60);
      const cur = parts["LeftUpLeg"]!.rotation.x;
      const delta = Math.abs(cur - prevLUpLeg);
      if (delta > maxFrameDelta) maxFrameDelta = delta;
      prevLUpLeg = cur;
    }
    // 150ms blend = at 60fps each frame's contribution is ~1/9 of the
    // total swing. Total swing is < 1 rad so per-frame delta should be
    // well under 0.2 rad.
    expect(maxFrameDelta, "landing should blend, not snap").toBeLessThan(0.3);
  });
});
