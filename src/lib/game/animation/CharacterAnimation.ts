/**
 * Phase 3: Character Animation System.
 *
 * C2-5000 prompt mapping (NEW animation states/transitions/variants added by this pass):
 *   C2-5000 #1358 [animateProneToStand]      prone→stand transition (smooth push-up over 0.8s)
 *   C2-5000 #1359 [animateStandToProne]      stand→prone transition (kneel + drop over 0.7s)
 *   C2-5000 #1360 [animateCrouchToProne]     crouch→prone transition (drop forward over 0.5s)
 *   C2-5000 #1361 [animateProneToCrouch]     prone→crouch transition (push up to knee over 0.6s)
 *   C2-5000 #1362 [animateSprintToProneDive] sprint→prone dive (feet-first baseball slide → prone)
 *   C2-5000 #1363 [animateProneCrawl]        prone-crawl cycle (arms reach + pull, legs drag)
 *   C2-5000 #1364 [animateProneFire]         prone-fire (legs spread, weapon shouldered, recoil)
 *   C2-5000 #1365 [animateProneReload]       prone-reload (side-lying, mag swap low)
 *   C2-5000 #1366 [animateProneMelee]        prone-melee (elbow strike)
 *   C2-5000 #1367 [animateProneGrenade]      prone-grenade (underhand toss from prone)
 *   C2-5000 #1368 [animateProneVaultBlock]   prone-vault BLOCKED (returns false; can't vault prone)
 *   C2-5000 #1369 [animateProneLadderBlock]  prone-ladder BLOCKED (returns false; can't climb prone)
 *   C2-5000 #1370 [animateProneSwim]         prone-swim (superman glide stroke)
 *   C2-5000 #1371 [animateSlideFeetFirst]    slide animation feet-first (legs extended, lean back)
 *   C2-5000 #1372 [animateSlideToProne]      slide→prone transition (continue sliding into prone)
 *   C2-5000 #1373 [animateSlideToCrouch]     slide→crouch transition (tuck legs under)
 *   C2-5000 #1374 [animateSlideToStand]      slide→stand transition (forward momentum up)
 *   C2-5000 #1375 [animateSlideFire]         slide-fire (one-hand aim from slide)
 *   C2-5000 #1376 [animateSlideReload]       slide-reload (mag swap while sliding)
 *   C2-5000 #1377 [animateSlideMelee]        slide-melee (boot kick while sliding)
 *   C2-5000 #1378 [animateWallRun]           wall-run animation (lean into wall, legs cycle)
 *   C2-5000 #1379 [animateWallRunToJump]     wall-run→jump transition (push off wall upward)
 *   C2-5000 #1380 [animateWallRunToFall]     wall-run→fall transition (lose wall contact)
 *   C2-5000 #1381 [animateWallJump]          wall-jump animation (push-off + tuck)
 *   C2-5000 #1382 [animateWallClimbMantle]   wall-climb mantle (hands-up pull over ledge)
 *   C2-5000 #1383 [animateZipline]           zip-line animation (hands grip + lean back)
 *   C2-5000 #1384 [animateGrapple]           grapple animation (arm extended toward hook)
 *   C2-5000 #1385 [animateParachute]         parachute animation (arms up + legs dangle)
 *   C2-5000 #1386 [animateGlider]            glider animation (arms spread, body prone-glide)
 *   C2-5000 #1387 [animateVehicleEnter]      vehicle-enter (open door + sit)
 *   C2-5000 #1388 [animateVehicleExit]       vehicle-exit (step out + stand)
 *   C2-5000 #1389 [animateVehicleDrive]      vehicle-drive (hands on wheel, look forward)
 *   C2-5000 #1390 [animateVehiclePassenger]  vehicle-passenger (relaxed, hands in lap)
 *   C2-5000 #1391 [animateVehicleGun]        vehicle-gun (hands on turret controls)
 *   C2-5000 #1392 [animateHorseRide]         horse-ride (post rhythm with horse gait)
 *   C2-5000 #1393 [animateBoatRow]           boat-row (alternate oar strokes)
 *   C2-5000 #1394 [animateBoatSail]          boat-sail (steering hands + lean)
 *   C2-5000 #1395 [animateSwimDive]          swim-dive (streamlined entry, arms together)
 *   C2-5000 #1396 [animateSwimSurface]       swim-surface (freestyle stroke)
 *   C2-5000 #1397 [animateSwimUnderwater]    swim-underwater (breaststroke, head down)
 *   C2-5000 #1398 [animateSwimBackstroke]    swim-backstroke (arms alternate overhead)
 *   C2-5000 #1399 [animateSwimTread]         swim-tread (vertical, hands sculling)
 *   C2-5000 #1400 [animateSwimExit]          swim-exit (pull-up onto ledge)
 *   C2-5000 #1401 [animateInjuryBleed]       injury-bleed (clutch wound + drip)
 *   C2-5000 #1402 [animateInjuryClutch]      injury-clutch (hold wound, sway)
 *   C2-5000 #1403 [animateInjuryStagger]     injury-stagger (unsteady step back)
 *   C2-5000 #1404 [animateInjuryFall]        injury-fall (collapse to knee then prone)
 *   C2-5000 #1405 [animateInjuryRecover]     injury-recover (shake it off + stand)
 *   C2-5000 #1406 [animateDownedCrawl]       downed-crawl — REUSES Prompt 444 (animateDownedCrawl)
 *   C2-5000 #1407 [animateDownedBleed]       downed-bleed (weep + hand reach for help)
 *   C2-5000 #1408 [animateDownedShoot]       downed-shoot (secondary weapon, side-aim)
 *   C2-5000 #1409 [animateDownedCallout]     downed-callout (wave for help)
 *   C2-5000 #1410 [animateDownedDrag]        downed-drag (limp body being dragged)
 *   C2-5000 #1411 [animateDownedCarry]       downed-carry (over-shoulder carry pose)
 *   C2-5000 #1412 [animateReviveKneel]       revive-kneel (kneel at downed player)
 *   C2-5000 #1413 [animateReviveCPR]         revive-CPR (chest compressions)
 *   C2-5000 #1414 [animateReviveBandage]     revive-bandage (wrap wound)
 *   C2-5000 #1415 [animateReviveInject]      revive-inject (stim pen to thigh)
 *   C2-5000 #1416 [animateReviveComplete]    revive-complete (help up to feet)
 *   C2-5000 #1417 [animateCaptureRestrain]   capture-restrain (zip-tie wrists)
 *   C2-5000 #1418 [animateCaptureEscort]     capture-escort (hands-on-shoulder walk)
 *   C2-5000 #1419 [animateCaptureRelease]    capture-release (cut ties + stand back)
 *   C2-5000 #1420 [animateHostageGrab]       hostage-grab (arm around neck)
 *   C2-5000 #1421 [animateHostageCarry]      hostage-carry — REUSES Prompt 449 (animateHostageCarry)
 *   C2-5000 #1422 [animateHostageDrop]       hostage-drop — REUSES Prompt 450 (animateHostageDrop)
 *   C2-5000 #1423 [animateHostageRescue]     hostage-rescue (free + signal clear)
 *   C2-5000 #1424 [animateBreachKick]        breach-kick — REUSES Prompt 451 (animateBreachKick)
 *   C2-5000 #1425 [animateBreachCharge]      breach-charge — REUSES Prompt 452 (animateBreachCharge)
 *   C2-5000 #1426 [animateBreachShotgun]     breach-shotgun (breaching shotgun to door)
 *   C2-5000 #1427 [animateBreachFlashbang]   breach-flashbang — REUSES Prompt 453 (animateFlashbangClear)
 *   C2-5000 #1428 [animateBreachStack]       breach-stack (line up on wall)
 *   C2-5000 #1429 [animateBreachEntry]       breach-entry (dynamic corner pie slice)
 *   C2-5000 #1430 [animateHandSignalStop]    handsignal-stop (fist up)
 *   C2-5000 #1431 [animateHandSignalForward] handsignal-forward (palm forward sweep)
 *   C2-5000 #1432 [animateHandSignalHalt]    handsignal-halt — REUSES "halt" (animateHandSignal)
 *   C2-5000 #1433 [animateHandSignalEnemy]   handsignal-enemy (point + weapon shape)
 *   C2-5000 #1434 [animateHandSignalCover]   handsignal-cover — REUSES "cover" (animateHandSignal)
 *   C2-5000 #1435 [animateHandSignalRally]   handsignal-rally — REUSES "rally" (animateHandSignal)
 *   C2-5000 #1436 [animatePingMove]          ping-move (sweep forward at ground)
 *   C2-5000 #1437 [animatePingEnemy]         ping-enemy (sharp point at threat)
 *   C2-5000 #1438 [animatePingDanger]        ping-danger (urgent double-point)
 *   C2-5000 #1439 [animatePingLoot]          ping-loot (downward point at item)
 *   C2-5000 #1440 [animatePingDefend]        ping-defend (shield gesture at ground)
 *   C2-5000 #1441 [animateCallout]           callout-radio — REUSES Prompt 456 (animateCallout)
 *
 * C1-5000 prompt mapping (each implemented by the prior-mission prompt noted):
 *   C1-5000 #1115 [Prompt 315]  wire `melee` state (animateMelee + switch case)
 *   C1-5000 #1241 [Prompt 441]  emote system (animateEmote)
 *   C1-5000 #1242 [Prompt 442]  victory pose (animateVictoryPose)
 *   C1-5000 #1243 [Prompt 443]  defeat pose (animateDefeatPose)
 *   C1-5000 #1244 [Prompt 444]  downed crawling DBNO (animateDownedCrawl)
 *   C1-5000 #1245 [Prompt 445]  revive animation (animateRevive)
 *   C1-5000 #1246 [Prompt 446]  self-revive (animateSelfRevive)
 *   C1-5000 #1247 [Prompt 447]  bleed-out timer + anim (animateBleedOut)
 *   C1-5000 #1248 [Prompt 448]  surrender/capture (animateSurrender)
 *   C1-5000 #1249 [Prompt 449]  hostage-carry (animateHostageCarry)
 *   C1-5000 #1250 [Prompt 450]  hostage-drop (animateHostageDrop)
 *   C1-5000 #1251 [Prompt 451]  breaching-kick (animateBreachKick)
 *   C1-5000 #1252 [Prompt 452]  breaching-charge (animateBreachCharge)
 *   C1-5000 #1253 [Prompt 453]  flashbang-clear stack+entry (animateFlashbangClear)
 *   C1-5000 #1254 [Prompt 454]  hand-signal emote (animateHandSignal)
 *   C1-5000 #1255 [Prompt 455]  pinging animation (animatePing)
 *   C1-5000 #1256 [Prompt 456]  callout animation (animateCallout)
 *   C1-5000 #1260 [Prompt 460]  death variety 5+ (animateDeathVariety)
 *   C1-5000 #1261 [Prompt 461]  directional death (animateDirectionalDeath)
 *   C1-5000 #1262 [Prompt 462]  killed by explosion (animateExplosionDeath)
 *   C1-5000 #1263 [Prompt 463]  killed by fire (animateFireDeath)
 *   C1-5000 #1264 [Prompt 464]  killed by headshot (animateHeadshotDeath)
 *   C1-5000 #1265 [Prompt 465]  killed by melee (animateMeleeDeath)
 *   C1-5000 #1266 [Prompt 466]  knockback animation (animateKnockback)
 *   C1-5000 #1267 [Prompt 467]  stunned animation (animateStunned)
 *   C1-5000 #1268 [Prompt 468]  suppressed animation (animateSuppressed)
 *   C1-5000 #1269 [Prompt 469]  panic animation (animatePanic)
 *   C1-5000 #1289 [Prompt A#16] destructive overwrites → additive accumulator
 *   C1-5000 #1290 [Prompt A#17] jump/fall by vertical velocity (isJumping)
 *   C1-5000 #1291 [Prompt A#18] crouchIdle state (animateCrouchIdle)
 *
 * C3-5000 prompt mapping (each "C3-5000 #NNNN" is addressed by the existing
 *  per-cause/per-direction/per-stage variety sampler noted in brackets —
 *  these prompts ask for "variety per X" and the underlying animators were
 *  added by the C2-anim mission. C3-5000 adds the named VARIETY pool exports
 *  at the bottom of this file so callers can request a specific variant):
 *   C3-5000 #1520 [animateMelee + MELEE_VARIETY]            melee variety per weapon (knife/bayonet/buttstock/pistol-whip)
 *   C3-5000 #1526 [animateDeathVariety + DEATH_VARIETY]     death variety per cause (bullet/explosion/fire/headshot/melee/fall)
 *   C3-5000 #1527 [animateKnockback + HIT_REACT_VARIETY]    hit-react variety per direction (front/back/left/right)
 *   C3-5000 #1528 [animateSuppressed + SUPPRESSION_VARIETY] suppression variety per level (light/medium/heavy/pinned)
 *   C3-5000 #1529 [animateStunned + STUN_VARIETY]           stun variety per cause (flashbang/concussion/melee/taser)
 *   C3-5000 #1530 [animateBleedOut + BLEED_VARIETY]         bleed variety per severity (minor/moderate/severe/critical)
 *   C3-5000 #1531 [animateRevive + REVIVE_VARIETY]          revive variety per stage (approach/cpr/assist/complete)
 *   C3-5000 #1532 [animateSurrender + CAPTURE_VARIETY]      capture variety per stage (submit/restrain/escort/kneel)
 *   C3-5000 #1533 [animateHostageCarry + HOSTAGE_VARIETY]   hostage variety per stage (grab/carry/drop/release)
 *   C3-5000 #1534 [animateBreachKick + BREACH_VARIETY]      breach variety per type (kick/charge/shotgun/breaching-charge)
 *   C3-5000 #1535 [animateEmote + EMOTE_VARIETY]            emote variety per type (wave/salute/taunt/cheer/point)
 *   C3-5000 #1536 [animateVictoryPose + VICTORY_VARIETY]    victory variety per type (fist-pump/flag/cluster/solo)
 *   C3-5000 #1537 [animateDefeatPose + DEFEAT_VARIETY]      defeat variety per type (kneel/faceplant/slump/walk-off)
 *   C3-5000 #1538 [CELEBRATION_VARIETY]                     celebration variety per type (clutch/ace/mvp/double/triple)
 *   C3-5000 #1547 [CLIP_SCALE_TABLE]                        animation scale tuning per clip
 *   C3-5000 #1548 [CLIP_OFFSET_TABLE]                       animation offset tuning per clip
 *
 * Upgrades the procedural gait animation with:
 *   - A 24-bone canonical humanoid rig definition.
 *   - An animation state machine (idle/walk/run/crouch/jump/fall/land/fire/reload/death).
 *   - Blend tree for smooth transitions between locomotion states.
 *   - Aim pitch/yaw additive layer (upper body tracks camera).
 *   - Head tracking (look-at player).
 *   - Improved gait with weight transfer + body lean.
 *
 * Preserves the existing animateGait() as a fallback for when the
 * animation state machine is not active.
 */

import * as THREE from "three";

/** Canonical 24-bone humanoid rig (Mixamo-compatible). */
export const CANONICAL_RIG_BONES = [
  "hips", "spine", "spine1", "spine2", "neck", "head",
  "leftShoulder", "leftArm", "leftForeArm", "leftHand",
  "rightShoulder", "rightArm", "rightForeArm", "rightHand",
  "leftUpLeg", "leftLeg", "leftFoot", "leftToeBase",
  "rightUpLeg", "rightLeg", "rightFoot", "rightToeBase",
  "weapon", "camera",
] as const;

export type AnimationState =
  | "idle" | "walk" | "run" | "crouch" | "crouchIdle" | "jump" | "fall" | "land"
  | "fire" | "reload" | "melee" | "death" | "hit";

export interface AnimationContext {
  speed: number;
  isCrouching: boolean;
  isAiming: boolean;
  isOnGround: boolean;
  pitch: number;
  yaw: number;
  timeSinceShot: number;
  isDead: boolean;
  timeSinceHit: number;
  /** Prompt A#17 — time since the player was last grounded (seconds).
   *  Replaces `speed > 2` as the jump-vs-fall discriminator. A player
   *  walking off a ledge at 0.5 m/s reads as "jump" under the old rule
   *  (their horizontal speed is low but they ARE airborne); the new rule
   *  uses vertical velocity / timeSinceGrounded: a deliberate jump has
   *  timeSinceGrounded < 0.3s (just left the ground) + upward velocity,
   *  while walking off a ledge has timeSinceGrounded > 0.3s with
   *  downward velocity. */
  timeSinceGrounded?: number;
  /** Prompt A#17 — vertical velocity (m/s, positive = up). Used by the
   *  jump-vs-fall discriminator. */
  verticalVelocity?: number;
  /** Prompt 315 — seconds since the melee swing started. 0..0.6 = active
   *  swing; >0.6 = swing complete (state returns to locomotion). The
   *  engine sets this on the context when the melee key is pressed + the
   *  `melee` state is selected. */
  timeSinceMelee?: number;
}

/** Prompt A#17 — jump-vs-fall discriminator. Was `speed > 2` which
 *  misclassified a slow walk-off-ledge as "jump." The new rule: if the
 *  player just left the ground (timeSinceGrounded < 0.3s) AND has
 *  upward velocity, it's a jump; otherwise it's a fall. Walking off a
 *  ledge at low speed has timeSinceGrounded > 0.3s (the player wasn't
 *  trying to jump) → "fall." Sprinting off a ledge has timeSinceGrounded
 *  < 0.3s + upward velocity (the sprint jump) → "jump." */
function isJumping(ctx: AnimationContext): boolean {
  const tsg = ctx.timeSinceGrounded ?? 0;
  const vy = ctx.verticalVelocity ?? 0;
  // Deliberate jump: just left the ground + moving up.
  if (tsg < 0.3 && vy > 0.5) return true;
  // Sprint-off-edge: high horizontal speed + just left the ground (the
  // sprint momentum carries them forward off the ledge — reads as a jump
  // because the player was sprinting, not walking).
  if (tsg < 0.2 && ctx.speed > 4) return true;
  return false;
}

export function determineAnimState(ctx: AnimationContext): AnimationState {
  if (ctx.isDead) return "death";
  if (ctx.timeSinceHit < 0.2) return "hit";
  if (!ctx.isOnGround) return isJumping(ctx) ? "jump" : "fall";
  if (ctx.timeSinceShot < 0.1) return "fire";
  if (ctx.speed > 5) return "run";
  if (ctx.speed > 0.5) return ctx.isCrouching ? "crouch" : "walk";
  // Prompt A#18 — stationary crouch gets its own state (was: "crouch"
  // which plays the moving-crouch gait; at speed=0 that just sets
  // body.y=1.1 with no knee-twitch breathing).
  if (ctx.isCrouching) return "crouchIdle";
  return "idle";
}

/** Prompt A#16 — per-frame body.rotation.X accumulator. The previous
 *  animateGaitV2 / animateHitReaction / animateFireReaction each directly
 *  assigned `parts.body.rotation.x = ...`, overwriting each other. The
 *  "additive on top of gait" promise was broken — a hit-react would snap
 *  the legs to neutral because animateHitReaction set body.rotation.x
 *  to the hit value, wiping the gait lean. The new model: each function
 *  contributes to a base + additive accumulator, and the sum is applied
 *  once at the end of updateCharacterAnimation. */
interface BodyRotationAccumulator {
  base: number;
  hitAdditive: number;
  fireAdditive: number;
}
const _bodyRotX: BodyRotationAccumulator = { base: 0, hitAdditive: 0, fireAdditive: 0 };

export function animateGaitV2(
  parts: Record<string, THREE.Mesh>,
  phase: number,
  speed: number,
  running: boolean,
  aimPitch: number = 0,
): void {
  const speedNorm = Math.min(speed / 6, 1.2);
  const swing = Math.sin(phase) * (running ? 0.9 : 0.5) * speedNorm;
  // Prompt A#19 (mirrored here) — right-leg phase = left-leg + π. Was
  // 0.15 rad (nearly in phase → "hop" instead of alternating walk).
  const swingR = Math.sin(phase + Math.PI) * (running ? 0.85 : 0.48) * speedNorm;
  parts.lleg.rotation.x = swing;
  parts.rleg.rotation.x = -swingR;
  parts.larm.rotation.x = -swingR * 0.7;
  parts.rarm.rotation.x = swing * 0.7;
  const dip = Math.abs(Math.sin(phase * 2)) * 0.04 * speedNorm;
  parts.body.position.y = 1.1 + dip;
  // Prompt A#16 — write to the accumulator's BASE, not directly to
  // body.rotation.x. updateCharacterAnimation sums base + additive at
  // the end so a hit-react / fire-react can layer on top without
  // overwriting the gait lean.
  _bodyRotX.base = running ? 0.15 * speedNorm : 0.03 * speedNorm;
  parts.head.position.y = 1.78 + dip * 0.8;
  parts.head.rotation.x = aimPitch * 0.4 + (running ? 0.05 : 0);
  if (parts.vest) {
    parts.vest.position.y = 1.15 + dip * 0.7;
    parts.vest.rotation.x = _bodyRotX.base * 0.5;
  }
  if (parts.egun) parts.egun.rotation.x = aimPitch * 0.3;
}

export function animateIdle(parts: Record<string, THREE.Mesh>, time: number, aimPitch: number = 0): void {
  const breathe = Math.sin(time * 1.5) * 0.01;
  const sway = Math.sin(time * 0.7) * 0.005;
  parts.body.position.y = 1.1 + breathe;
  // Prompt A#16 — write to the accumulator's BASE.
  _bodyRotX.base = sway;
  parts.head.position.y = 1.78 + breathe * 0.5;
  parts.head.rotation.x = aimPitch * 0.3;
  parts.larm.rotation.x = breathe * 0.5;
  parts.rarm.rotation.x = -breathe * 0.5;
}

/** Prompt A#18 — stationary crouch idle. Subtle knee-twitch breathing
 *  distinct from the moving-crouch gait. The body is held low (Hips
 *  dropped) + knees bent; the only motion is a tiny breathing oscillation
 *  in the spine + a micro knee-twitch every ~2s. */
export function animateCrouchIdle(parts: Record<string, THREE.Mesh>, time: number, aimPitch: number = 0): void {
  const breathe = Math.sin(time * 1.5) * 0.005; // smaller amplitude than standing idle
  const kneeTwitch = Math.sin(time * 0.5) * 0.02; // slow knee micro-adjustment
  parts.body.position.y = 0.85 + breathe; // crouch height
  _bodyRotX.base = 0.05 + breathe; // slight forward lean + breathing
  parts.head.position.y = 1.45 + breathe * 0.5;
  parts.head.rotation.x = aimPitch * 0.3;
  // Knee twitch — thighs hold the crouch bend, shins micro-adjust.
  if (parts.lleg) parts.lleg.rotation.x = 0.3 + kneeTwitch;
  if (parts.rleg) parts.rleg.rotation.x = -0.3 - kneeTwitch;
  parts.larm.rotation.x = 0.4 + breathe * 0.5;
  parts.rarm.rotation.x = -0.4 - breathe * 0.5;
}

export function animateDeath(parts: Record<string, THREE.Mesh>, time: number): void {
  const fallProgress = Math.min(1, time / 0.8);
  _bodyRotX.base = fallProgress * (Math.PI / 2 - 0.1);
  parts.body.position.y = 1.1 - fallProgress * 0.8;
  parts.head.rotation.x = fallProgress * 0.5;
  parts.larm.rotation.x = fallProgress * -0.3;
  parts.rarm.rotation.x = fallProgress * 0.3;
  parts.lleg.rotation.x = fallProgress * 0.2;
  parts.rleg.rotation.x = fallProgress * -0.2;
}

export function animateHitReaction(parts: Record<string, THREE.Mesh>, timeSinceHit: number): void {
  const intensity = Math.max(0, 1 - timeSinceHit / 0.2);
  // Prompt A#16 — write to the ADDITIVE accumulator, not directly to
  // body.rotation.x. updateCharacterAnimation sums base + additive so
  // the hit-react layers on top of the gait lean instead of overwriting it.
  _bodyRotX.hitAdditive = intensity * 0.2;
  parts.head.rotation.x = intensity * 0.3;
}

export function animateFireReaction(parts: Record<string, THREE.Mesh>, timeSinceShot: number): void {
  const intensity = Math.max(0, 1 - timeSinceShot / 0.1);
  // Prompt A#16 — additive, not overwrite.
  _bodyRotX.fireAdditive = intensity * 0.08;
  if (parts.egun) parts.egun.rotation.x = intensity * 0.15;
}

export function animateAirborne(parts: Record<string, THREE.Mesh>, isFalling: boolean): void {
  parts.lleg.rotation.x = isFalling ? 0.3 : 0.5;
  parts.rleg.rotation.x = isFalling ? -0.3 : -0.5;
  parts.larm.rotation.x = -0.4;
  parts.rarm.rotation.x = 0.4;
  _bodyRotX.base = isFalling ? 0.1 : -0.1;
}

/** Prompt 315 — melee (knife-swing) animation. The `melee` state was
 *  previously a fall-through to the default case (animateGaitV2) which
 *  produced no arm motion. This plays a 3-beat knife swing:
 *    0..0.2  windup (right arm raises back, body twists right)
 *    0.2..0.45 swing (right arm slashes forward + down)
 *    0.45..1.0 recover (return to neutral)
 *  The caller passes `timeSinceMelee` (seconds since the swing started);
 *  the function samples the curve at t = timeSinceMelee / 0.6. */
export function animateMelee(parts: Record<string, THREE.Mesh>, timeSinceMelee: number): void {
  const totalDur = 0.6;
  const t = Math.min(1, Math.max(0, timeSinceMelee / totalDur));
  let rArmX = 0, rArmY = 0, bodyY = 0;
  if (t < 0.2) {
    // Windup: arm raises back + body twists right (negative yaw).
    const u = t / 0.2;
    const k = Math.sin((u * Math.PI) / 2);
    rArmX = -1.0 * k;
    rArmY = -0.6 * k;
    bodyY = 0.1 * k;
  } else if (t < 0.45) {
    // Swing: arm slashes forward + down rapidly.
    const u = (t - 0.2) / 0.25;
    const k = Math.sin(u * Math.PI);
    rArmX = -1.0 + 2.0 * k;
    rArmY = -0.6 + 1.2 * k;
    bodyY = 0.1 - 0.2 * k;
  } else {
    // Recover: arm returns to neutral.
    const u = (t - 0.45) / 0.55;
    const k = 1 - Math.sin((u * Math.PI) / 2);
    rArmX = 1.0 * k;
    rArmY = 0.6 * k;
    bodyY = -0.1 * k;
  }
  parts.rarm.rotation.x = rArmX;
  parts.rarm.rotation.y = rArmY;
  // Left arm braces forward (counterbalance).
  parts.larm.rotation.x = 0.3;
  parts.larm.rotation.y = -0.2;
  _bodyRotX.base = bodyY;
  // Slight forward lean for the lunge.
  if (parts.body) parts.body.position.y = 1.1 + bodyY * 0.5;
}

export function updateCharacterAnimation(
  parts: Record<string, THREE.Mesh>,
  state: AnimationState,
  phase: number,
  time: number,
  ctx: AnimationContext,
): void {
  // Prompt A#16 — reset the accumulator each frame so stale additive
  // contributions don't linger. Each animate* function writes to base
  // or an additive slot; we sum at the end + apply once.
  _bodyRotX.base = 0;
  _bodyRotX.hitAdditive = 0;
  _bodyRotX.fireAdditive = 0;

  switch (state) {
    case "death": animateDeath(parts, time); break;
    case "hit": animateHitReaction(parts, ctx.timeSinceHit); animateIdle(parts, time, ctx.pitch); break;
    case "fire": animateFireReaction(parts, ctx.timeSinceShot); animateGaitV2(parts, phase, ctx.speed, false, ctx.pitch); break;
    case "jump":
    case "fall": animateAirborne(parts, state === "fall"); break;
    case "melee":
      // Prompt 315 — wire the melee state (was a fall-through to default →
      // no arm motion). Plays the 600ms knife-swing clip on top of the
      // gait so the legs keep moving while the right arm slashes.
      animateMelee(parts, ctx.timeSinceMelee ?? 0);
      animateGaitV2(parts, phase, Math.max(ctx.speed, 0), false, ctx.pitch);
      break;
    case "idle": animateIdle(parts, time, ctx.pitch); break;
    case "crouchIdle": animateCrouchIdle(parts, time, ctx.pitch); break;
    case "walk":
    case "run":
    case "crouch": animateGaitV2(parts, phase, ctx.speed, state === "run", ctx.pitch); break;
    default: animateGaitV2(parts, phase, ctx.speed, false, ctx.pitch);
  }

  // Prompt A#16 — apply the summed body.rotation.x ONCE at the end.
  // This makes the hit-react + fire-react layer on top of the gait lean
  // (base + hitAdditive + fireAdditive) instead of overwriting it.
  parts.body.rotation.x = _bodyRotX.base + _bodyRotX.hitAdditive + _bodyRotX.fireAdditive;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompts 441–470 — emote system, victory/defeat/draw poses, downed-state
// animations (crawl/revive/bleed-out), surrender + hostage carry/drop,
// breach (kick + charge), flashbang-clear stack, hand-signal emotes, ping +
// callout gestures, death variety (5+ variants + directional + killed-by-X
// variations), knockback, stunned, suppressed, panic. Each is a small driver
// the engine calls when the corresponding state is entered; the function
// samples the animation curve at the given time + writes bone rotations
// into a `parts` record (the same shape used by `animateGaitV2`).
// ─────────────────────────────────────────────────────────────────────────────

/** Prompt 441 — emote system (wave, salute, etc.). Returns the per-frame
 *  bone offsets for the named emote at the given time-since-start.
 *  Emotes are 2-3s one-shots that override the gait (the player can't
 *  move while emoting). */
export function animateEmote(
  parts: Record<string, THREE.Mesh>,
  emote: "wave" | "salute" | "thumbs_up" | "taunt" | "surrender_wave",
  timeSinceStart: number,
): void {
  const T = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
  // Common: face forward, idle stance.
  parts.body.rotation.y = 0;
  switch (emote) {
    case "wave": {
      // Right arm raises up + waves side-to-side (3 Hz).
      const phase = timeSinceStart;
      const wave = Math.sin(phase * 6 * Math.PI);
      parts.rarm.rotation.x = -1.8 + 0.1 * wave;
      parts.rarm.rotation.z = 0.3 * wave;
      break;
    }
    case "salute": {
      // Right arm snaps to forehead (2s hold), then drops.
      const t = Math.min(1, timeSinceStart / 0.4);
      const hold = timeSinceStart > 0.4 && timeSinceStart < 2.4 ? 1 : 0;
      const drop = Math.max(0, Math.min(1, (timeSinceStart - 2.4) / 0.4));
      const k = t - drop;
      parts.rarm.rotation.x = -1.6 * k;
      parts.rarm.rotation.z = -0.8 * k * hold;
      break;
    }
    case "thumbs_up": {
      // Right fist up, thumb extended.
      const t = Math.min(1, timeSinceStart / 0.3);
      parts.rarm.rotation.x = -1.4 * t;
      parts.rarm.rotation.z = 0.5 * t;
      break;
    }
    case "taunt": {
      // Both arms out, pelvic thrust.
      const phase = timeSinceStart;
      const thrust = Math.sin(phase * 4 * Math.PI);
      parts.larm.rotation.z = 0.8;
      parts.rarm.rotation.z = -0.8;
      parts.larm.rotation.x = -0.8;
      parts.rarm.rotation.x = -0.8;
      if (parts.body) parts.body.position.z = 0.05 * thrust;
      break;
    }
    case "surrender_wave": {
      // Both hands up, swaying.
      const phase = timeSinceStart;
      const sway = Math.sin(phase * 2 * Math.PI);
      parts.larm.rotation.x = -2.4;
      parts.rarm.rotation.x = -2.4;
      parts.larm.rotation.z = 0.4 + 0.2 * sway;
      parts.rarm.rotation.z = -0.4 - 0.2 * sway;
      break;
    }
  }
  // Suppress unused-warning for T.
  void T;
}

/** Prompt 442 — victory pose at match end. The winner raises both arms
 *  (V-for-victory) + holds for 4s. */
export function animateVictoryPose(
  parts: Record<string, THREE.Mesh>,
  timeSinceStart: number,
): void {
  const t = Math.min(1, timeSinceStart / 0.5);
  // Both arms raise up + out in a V.
  parts.larm.rotation.x = -2.6 * t;
  parts.rarm.rotation.x = -2.6 * t;
  parts.larm.rotation.z = 0.6 * t;
  parts.rarm.rotation.z = -0.6 * t;
  // Subtle celebration sway after 1s.
  if (timeSinceStart > 1) {
    const sway = Math.sin((timeSinceStart - 1) * 3);
    parts.body.rotation.y = 0.1 * sway;
  }
}

/** Prompt 443 — defeat pose at match end. The loser slumps forward +
 *  drops to one knee. */
export function animateDefeatPose(
  parts: Record<string, THREE.Mesh>,
  timeSinceStart: number,
): void {
  const t = Math.min(1, timeSinceStart / 1.2);
  // Spine curls forward, head drops.
  _bodyRotX.base = 0.6 * t;
  parts.head.rotation.x = 0.4 * t;
  // Right knee drops (the rig's right leg = rleg).
  parts.rleg.rotation.x = 1.2 * t;
  if (parts.body) parts.body.position.y = 1.1 - 0.35 * t;
}

/** Prompt 444 — "downed" crawling animation (DBNO state). The player is
 *  prone + crawls forward using their arms.
 *  `phase` is the crawl cycle phase (0..1). */
export function animateDownedCrawl(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Body flat on the ground.
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Arms alternate reaching forward + pulling back.
  const lReach = Math.sin(phase * Math.PI * 2);
  const rReach = Math.sin(phase * Math.PI * 2 + Math.PI);
  parts.larm.rotation.x = -0.5 + 0.6 * lReach;
  parts.rarm.rotation.x = -0.5 + 0.6 * rReach;
  // Legs drag (slight bend).
  parts.lleg.rotation.x = 0.2;
  parts.rleg.rotation.x = 0.2;
}

/** Prompt 445 — revive animation (teammate revives downed player). The
 *  reviver crouches + presses both hands to the downed player's chest.
 *  `phase` is 0..1 over the 3s revive duration. */
export function animateRevive(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Crouch + lean forward.
  _bodyRotX.base = 0.4;
  if (parts.body) parts.body.position.y = 0.6;
  // Both arms extend forward (pressing chest).
  const reach = phase < 0.2 ? phase / 0.2 : 1;
  parts.larm.rotation.x = -1.4 * reach;
  parts.rarm.rotation.x = -1.4 * reach;
  // Small compressions at 1 Hz during the revive.
  if (phase > 0.3) {
    const compress = Math.sin((phase - 0.3) * 8 * Math.PI) * 0.05;
    parts.larm.rotation.x += compress;
    parts.rarm.rotation.x += compress;
  }
}

/** Prompt 446 — self-revive animation (with a perk). The player sits up,
 *  injects themselves with a stim, then collapses back to prone.
 *  `phase` is 0..1 over the 5s self-revive. */
export function animateSelfRevive(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Phase 1 (0..0.3): sit up from prone.
  // Phase 2 (0.3..0.6): inject stim into thigh.
  // Phase 3 (0.6..1.0): collapse back to prone.
  if (phase < 0.3) {
    const u = phase / 0.3;
    _bodyRotX.base = 1.4 * (1 - u);
    if (parts.body) parts.body.position.y = 0.2 + 0.4 * u;
  } else if (phase < 0.6) {
    _bodyRotX.base = 0;
    if (parts.body) parts.body.position.y = 0.6;
    // Right arm reaches down to thigh.
    const u = (phase - 0.3) / 0.3;
    parts.rarm.rotation.x = -0.5 + 0.8 * u;
    parts.rarm.rotation.z = -0.6 * u;
  } else {
    const u = (phase - 0.6) / 0.4;
    _bodyRotX.base = 1.4 * u;
    if (parts.body) parts.body.position.y = 0.6 - 0.4 * u;
  }
}

/** Prompt 447 — bleed-out timer + animation. Returns the bone offsets for
 *  the bleed-out state. The player writhes on the ground + slowly loses
 *  HP over 30s. `progress` is 0..1 (0 = just downed, 1 = bled out). */
export function animateBleedOut(
  parts: Record<string, THREE.Mesh>,
  progress: number,
  time: number,
): void {
  // Prone.
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Writhing: slow side-to-side rotation that gets weaker as bleed-out
  // progresses (the player is losing consciousness).
  const writhe = Math.sin(time * 1.5) * (1 - progress) * 0.3;
  parts.body.rotation.y = writhe;
  // One arm reaches toward the wound.
  parts.rarm.rotation.x = -0.4 + 0.2 * Math.sin(time * 2);
}

/** Prompt 448 — surrender/capture animation. The player drops their weapon
 *  + puts both hands behind their head. */
export function animateSurrender(
  parts: Record<string, THREE.Mesh>,
  timeSinceStart: number,
): void {
  const t = Math.min(1, timeSinceStart / 0.8);
  // Both arms raise + hands behind head.
  parts.larm.rotation.x = -2.4 * t;
  parts.rarm.rotation.x = -2.4 * t;
  parts.larm.rotation.z = 0.5 * t;
  parts.rarm.rotation.z = -0.5 * t;
  // Slight tremble (fear).
  const tremble = Math.sin(timeSinceStart * 12) * 0.02;
  parts.larm.rotation.x += tremble;
  parts.rarm.rotation.x += tremble;
}

/** Prompt 449 — hostage-carry animation. The player carries a hostage
 *  over their shoulder. Returns the carry pose (arms wrapped around the
 *  hostage, slight forward lean). */
export function animateHostageCarry(
  parts: Record<string, THREE.Mesh>,
  time: number,
): void {
  // Forward lean to balance the hostage's weight.
  _bodyRotX.base = 0.2;
  // Both arms wrap forward (holding the hostage).
  parts.larm.rotation.x = -1.2;
  parts.rarm.rotation.x = -1.2;
  parts.larm.rotation.z = 0.4;
  parts.rarm.rotation.z = -0.4;
  // Slight stumble while walking.
  parts.body.rotation.z = Math.sin(time * 4) * 0.02;
}

/** Prompt 450 — hostage-drop animation. The player drops the hostage to
 *  the ground. `phase` is 0..1 over the 0.6s drop. */
export function animateHostageDrop(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Arms lower + body straightens.
  const u = 1 - phase;
  parts.larm.rotation.x = -1.2 * u;
  parts.rarm.rotation.x = -1.2 * u;
  parts.larm.rotation.z = 0.4 * u;
  parts.rarm.rotation.z = -0.4 * u;
  _bodyRotX.base = 0.2 * u;
}

/** Prompt 451 — breaching-kick animation (door kick). The player plants
 *  + kicks forward with the right leg. `phase` is 0..1 over 0.5s. */
export function animateBreachKick(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Windup (0..0.3): pull right leg back.
  // Kick (0.3..0.6): snap forward.
  // Recover (0.6..1.0): return to neutral.
  if (phase < 0.3) {
    const u = phase / 0.3;
    parts.rleg.rotation.x = -0.6 * u;
    _bodyRotX.base = -0.1 * u;
  } else if (phase < 0.6) {
    const u = (phase - 0.3) / 0.3;
    parts.rleg.rotation.x = -0.6 + 2.0 * u;
    _bodyRotX.base = -0.1 + 0.2 * u;
  } else {
    const u = (phase - 0.6) / 0.4;
    parts.rleg.rotation.x = 1.4 * (1 - u);
    _bodyRotX.base = 0.1 * (1 - u);
  }
}

/** Prompt 452 — breaching-charge animation (place + detonate). The player
 *  places a charge on the door + steps back. `phase` is 0..1 over 2.5s. */
export function animateBreachCharge(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Phase 1 (0..0.5): place the charge (arms forward).
  // Phase 2 (0.5..0.7): step back (arms retract).
  // Phase 3 (0.7..1.0): detonate button press.
  if (phase < 0.5) {
    const u = phase / 0.5;
    parts.rarm.rotation.x = -1.2 * u;
    parts.larm.rotation.x = -1.2 * u;
  } else if (phase < 0.7) {
    const u = (phase - 0.5) / 0.2;
    parts.rarm.rotation.x = -1.2 * (1 - u);
    parts.larm.rotation.x = -1.2 * (1 - u);
  } else {
    const u = (phase - 0.7) / 0.3;
    // Right arm snaps to chest (detonator press).
    parts.rarm.rotation.x = -0.4 + 0.4 * u;
    parts.rarm.rotation.z = -0.6 * u;
  }
}

/** Prompt 453 — flashbang-clear animation (stack + entry). The player
 *  stacks against a wall, breaches, then enters. `phase` is 0..1 over 3s. */
export function animateFlashbangClear(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Phase 1 (0..0.4): stack against wall (lean right, gun up).
  // Phase 2 (0.4..0.5): breach (snap forward).
  // Phase 3 (0.5..1.0): pie the corner (slow rotation).
  if (phase < 0.4) {
    const u = phase / 0.4;
    parts.body.rotation.z = 0.1 * u;
    parts.rarm.rotation.x = -1.0 * u;
    parts.larm.rotation.x = -0.8 * u;
  } else if (phase < 0.5) {
    parts.body.rotation.z = 0;
    parts.rarm.rotation.x = -1.0;
    parts.larm.rotation.x = -0.8;
  } else {
    const u = (phase - 0.5) / 0.5;
    parts.body.rotation.y = -0.6 * u;
    parts.rarm.rotation.x = -1.0;
    parts.larm.rotation.x = -0.8;
  }
}

/** Prompt 454 — hand-signal emote system (silent comms). The player makes
 *  a hand signal: fist (freeze), open palm (halt), point (direction), etc. */
export function animateHandSignal(
  parts: Record<string, THREE.Mesh>,
  signal: "fist" | "halt" | "point" | "rally" | "cover",
  timeSinceStart: number,
): void {
  const t = Math.min(1, timeSinceStart / 0.3);
  switch (signal) {
    case "fist":
      // Right fist up.
      parts.rarm.rotation.x = -1.8 * t;
      parts.rarm.rotation.z = 0;
      break;
    case "halt":
      // Right palm forward.
      parts.rarm.rotation.x = -1.4 * t;
      parts.rarm.rotation.z = 0.3 * t;
      break;
    case "point":
      // Right arm extended, pointing forward.
      parts.rarm.rotation.x = -1.5 * t;
      parts.rarm.rotation.y = 0.3 * t;
      break;
    case "rally":
      // Right arm circles overhead.
      const circle = timeSinceStart * 6;
      parts.rarm.rotation.x = -2.4;
      parts.rarm.rotation.z = 0.4 * Math.sin(circle);
      parts.rarm.rotation.y = 0.4 * Math.cos(circle);
      break;
    case "cover":
      // Both arms forward, hands flat.
      parts.larm.rotation.x = -1.2 * t;
      parts.rarm.rotation.x = -1.2 * t;
      break;
  }
}

/** Prompt 455 — pinging animation (pointing at a target). The player
 *  extends their right arm toward the pinged location. `phase` is 0..1
 *  over 1.2s. */
export function animatePing(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Extend (0..0.3), hold (0.3..0.9), retract (0.9..1.0).
  let k: number;
  if (phase < 0.3) k = phase / 0.3;
  else if (phase < 0.9) k = 1;
  else k = 1 - (phase - 0.9) / 0.1;
  parts.rarm.rotation.x = -1.5 * k;
  parts.rarm.rotation.z = -0.2 * k;
}

/** Prompt 456 — "callout" animation (radio hand to ear). The player
 *  presses their left hand to their ear (radio call). `phase` is 0..1
 *  over 1.5s. */
export function animateCallout(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Hand to ear (0..0.3), hold (0.3..1.2), retract (1.2..1.5).
  let k: number;
  if (phase < 0.3) k = phase / 0.3;
  else if (phase < 1.2) k = 1;
  else k = 1 - (phase - 1.2) / 0.3;
  parts.larm.rotation.x = -2.0 * k;
  parts.larm.rotation.z = 0.6 * k;
}

/** Prompt 460 — death animation variety (5+ variants). Returns the
 *  per-frame bone offsets for the given death variant. Variants:
 *  forward-fall, backward-fall, side-collapse, spin-fall, knees-buckle. */
export function animateDeathVariety(
  parts: Record<string, THREE.Mesh>,
  variant: 0 | 1 | 2 | 3 | 4,
  timeSinceDeath: number,
): void {
  const t = Math.min(1, timeSinceDeath / 1.2);
  // Common: drop Hips to the ground.
  if (parts.body) parts.body.position.y = 0.95 - 0.85 * t;
  switch (variant) {
    case 0: // Forward fall.
      _bodyRotX.base = 1.4 * t;
      parts.head.rotation.x = 0.3 * t;
      break;
    case 1: // Backward fall.
      _bodyRotX.base = -1.4 * t;
      parts.head.rotation.x = -0.3 * t;
      break;
    case 2: // Side collapse (right).
      parts.body.rotation.z = -1.2 * t;
      _bodyRotX.base = 0.3 * t;
      break;
    case 3: // Spin fall (rotate 180° while falling).
      parts.body.rotation.y = Math.PI * t;
      _bodyRotX.base = 0.6 * t;
      break;
    case 4: // Knees buckle (drop straight down).
      parts.lleg.rotation.x = 1.4 * t;
      parts.rleg.rotation.x = 1.4 * t;
      _bodyRotX.base = 0.4 * t;
      break;
  }
}

/** Prompt 461 — directional death animations. Picks the death variant
 *  based on the damage source direction (forward/back/left/right fall).
 *  `damageDirLocalYaw` is the yaw from the player's facing to the damage
 *  source (radians). */
export function animateDirectionalDeath(
  parts: Record<string, THREE.Mesh>,
  damageDirLocalYaw: number,
  timeSinceDeath: number,
): void {
  // Forward (damage from front) → fall backward (variant 1).
  // Back (damage from behind) → fall forward (variant 0).
  // Left (damage from left) → collapse right (variant 2 mirrored).
  // Right (damage from right) → collapse right (variant 2).
  const absYaw = Math.abs(damageDirLocalYaw);
  let variant: 0 | 1 | 2 | 3 | 4;
  if (absYaw < Math.PI / 4) variant = 1;       // front → fall back
  else if (absYaw > 3 * Math.PI / 4) variant = 0; // back → fall forward
  else variant = 2;                              // side → collapse
  animateDeathVariety(parts, variant, timeSinceDeath);
}

/** Prompt 462 — "killed by explosion" death (ragdoll launched). The body
 *  is launched upward + forward (the explosion's shockwave imparts an
 *  upward velocity). The RagdollSystem handles the actual ragdoll; this
 *  animation plays for the first 0.3s before the ragdoll takes over. */
export function animateExplosionDeath(
  parts: Record<string, THREE.Mesh>,
  timeSinceDeath: number,
): void {
  const t = Math.min(1, timeSinceDeath / 0.3);
  // Body launches up + back.
  if (parts.body) {
    parts.body.position.y = 0.95 + 1.5 * t * (1 - t * 0.5); // arc up.
    parts.body.position.z = -0.5 * t; // back.
  }
  _bodyRotX.base = -0.8 * t; // flip backward.
  // Limbs splay outward.
  parts.larm.rotation.z = 0.8 * t;
  parts.rarm.rotation.z = -0.8 * t;
  parts.lleg.rotation.x = -0.4 * t;
  parts.rleg.rotation.x = -0.4 * t;
}

/** Prompt 463 — "killed by fire" death (writhing). The player writhes on
 *  the ground as they burn. */
export function animateFireDeath(
  parts: Record<string, THREE.Mesh>,
  timeSinceDeath: number,
): void {
  // Drop to ground quickly.
  const dropT = Math.min(1, timeSinceDeath / 0.4);
  if (parts.body) parts.body.position.y = 0.95 - 0.75 * dropT;
  _bodyRotX.base = 1.0 * dropT;
  // Then writhe (after 0.4s).
  if (timeSinceDeath > 0.4) {
    const writhe = Math.sin((timeSinceDeath - 0.4) * 6);
    parts.body.rotation.y = 0.3 * writhe;
    parts.larm.rotation.x = -0.5 + 0.4 * writhe;
    parts.rarm.rotation.x = -0.5 - 0.4 * writhe;
    parts.lleg.rotation.x = 0.3 + 0.2 * writhe;
    parts.rleg.rotation.x = 0.3 - 0.2 * writhe;
  }
}

/** Prompt 464 — "killed by headshot" death (instant drop, no twitch). */
export function animateHeadshotDeath(
  parts: Record<string, THREE.Mesh>,
  timeSinceDeath: number,
): void {
  // Instant drop — no windup, no twitch.
  const t = Math.min(1, timeSinceDeath / 0.5);
  if (parts.body) parts.body.position.y = 0.95 - 0.85 * t;
  _bodyRotX.base = 1.4 * t;
  // Head snaps back.
  parts.head.rotation.x = -0.5 * t;
  // Limbs stay loose (no twitch).
}

/** Prompt 465 — "killed by melee" death (stabbed + collapse). The body
 *  folds around the wound + collapses. */
export function animateMeleeDeath(
  parts: Record<string, THREE.Mesh>,
  timeSinceDeath: number,
): void {
  // Phase 1 (0..0.4): fold around the wound (spine curls).
  // Phase 2 (0.4..1.2): collapse to the ground.
  if (timeSinceDeath < 0.4) {
    const u = timeSinceDeath / 0.4;
    _bodyRotX.base = 0.8 * u;
    parts.larm.rotation.x = -0.6 * u;
    parts.rarm.rotation.x = -0.6 * u;
  } else {
    const u = (timeSinceDeath - 0.4) / 0.8;
    if (parts.body) parts.body.position.y = 0.95 - 0.85 * u;
    _bodyRotX.base = 0.8 + 0.6 * u;
  }
}

/** Prompt 466 — "killed by vehicle" death (ragdoll launched dramatically).
 *  The body is launched high + far — the RagdollSystem takes over after
 *  0.5s. */
export function animateVehicleDeath(
  parts: Record<string, THREE.Mesh>,
  timeSinceDeath: number,
): void {
  const t = Math.min(1, timeSinceDeath / 0.5);
  // Big launch up + forward.
  if (parts.body) {
    parts.body.position.y = 0.95 + 3.0 * t * (1 - t * 0.3);
    parts.body.position.z = 1.0 * t;
  }
  // Spin wildly.
  parts.body.rotation.y = Math.PI * 2 * t;
  parts.body.rotation.x = Math.PI * t;
  // Limbs splay.
  parts.larm.rotation.z = 1.2 * t;
  parts.rarm.rotation.z = -1.2 * t;
  parts.lleg.rotation.x = -0.8 * t;
  parts.rleg.rotation.x = -0.8 * t;
}

/** Prompt 467 — knockback animation (explosion shockwave). The player is
 *  pushed back by a nearby explosion. `phase` is 0..1 over 0.6s. */
export function animateKnockback(
  parts: Record<string, THREE.Mesh>,
  phase: number,
): void {
  // Snap back (0..0.2), recover (0.2..0.6).
  let k: number;
  if (phase < 0.2) k = phase / 0.2;
  else k = 1 - (phase - 0.2) / 0.4;
  _bodyRotX.base = -0.5 * k;
  parts.larm.rotation.x = -0.6 * k;
  parts.rarm.rotation.x = -0.6 * k;
  parts.lleg.rotation.x = -0.3 * k;
  parts.rleg.rotation.x = -0.3 * k;
}

/** Prompt 468 — stunned animation (after flashbang). The player stumbles
 *  + covers their eyes. `time` is the elapsed stun time. */
export function animateStunned(
  parts: Record<string, THREE.Mesh>,
  time: number,
): void {
  // Stumble (slow side-to-side sway).
  parts.body.rotation.z = 0.1 * Math.sin(time * 1.5);
  parts.body.rotation.y = 0.15 * Math.sin(time * 0.8);
  // Hands cover eyes.
  parts.larm.rotation.x = -1.8;
  parts.rarm.rotation.x = -1.8;
  parts.larm.rotation.z = 0.5;
  parts.rarm.rotation.z = -0.5;
  // Head drops slightly.
  parts.head.rotation.x = 0.3;
}

/** Prompt 469 — suppressed animation (under heavy fire). The player
 *  crouches + flinches. `intensity` is 0..1 (how suppressed). */
export function animateSuppressed(
  parts: Record<string, THREE.Mesh>,
  time: number,
  intensity: number,
): void {
  // Crouch.
  if (parts.body) parts.body.position.y = 1.1 - 0.2 * intensity;
  _bodyRotX.base = 0.2 * intensity;
  // Flinch (random small twitches).
  const flinch = Math.sin(time * 20) * 0.05 * intensity;
  parts.body.rotation.z = flinch;
  parts.head.rotation.x = 0.1 * intensity + flinch;
  // Arms tucked in.
  parts.larm.rotation.x = -0.4 * intensity;
  parts.rarm.rotation.x = -0.4 * intensity;
}

/** Prompt 470 — "panic" animation (suppressed + low HP). The player
 *  visibly panics — wide-eyed, breathing hard, trembling. */
export function animatePanic(
  parts: Record<string, THREE.Mesh>,
  time: number,
): void {
  // Heavy breathing (chest heaves at 1 Hz).
  const breath = Math.sin(time * 2 * Math.PI);
  _bodyRotX.base = 0.1 + 0.05 * Math.max(0, breath);
  // Trembling (high-freq, low-amp).
  const tremble = Math.sin(time * 30) * 0.04;
  parts.body.rotation.z = tremble;
  parts.head.rotation.x = 0.15 + tremble;
  // Arms tense.
  parts.larm.rotation.x = -0.3 + tremble;
  parts.rarm.rotation.x = -0.3 - tremble;
  // Slight backward lean (cringing away from threats).
  _bodyRotX.base -= 0.05;
}

// ═══════════════════════════════════════════════════════════════════════════
// C2-5000 #1358–#1441 — new animation states/transitions/variants.
// All functions take the canonical `parts: Record<string, THREE.Mesh>` rig
// (body/head/larm/larmLower/rarm/rarmLower/lleg/lshin/rleg/rshin + accessory
// meshes). Time-based params are seconds; phase params are 0..1.
//
// Conventions:
//  * `_bodyRotX.base = X` sets the torso's forward-lean angle (radians).
//    Positive = forward; ~1.4 ≈ flat-prone; ~0.3 ≈ crouch-lean.
//  * `parts.body.position.y = Y` sets the torso's world height (1.15 = stand,
//    0.7 = crouch, 0.2 = prone).
//  * Limb rotations are applied to the upper-arm/upper-leg mesh; lower-arm /
//    shin rotations are best-effort when the mesh exists in `parts`.
//  * Block helpers (#1368, #1369) return `false` so the engine can refuse the
//    action; the function is still exported for telemetry + state-machine
//    introspection.
// ═══════════════════════════════════════════════════════════════════════════

/** C2-5000 #1358 — prone→stand transition. Push-up over `phase` 0..1 (≈0.8s). */
export function animateProneToStand(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  _bodyRotX.base = 1.4 * (1 - t);
  if (parts.body) parts.body.position.y = 0.2 + 0.95 * t;
  // Arms push down (extending).
  parts.larm.rotation.x = -0.6 * (1 - t);
  parts.rarm.rotation.x = -0.6 * (1 - t);
  // Legs straighten.
  parts.lleg.rotation.x = 0.2 * (1 - t);
  parts.rleg.rotation.x = 0.2 * (1 - t);
}

/** C2-5000 #1359 — stand→prone transition. Kneel + drop forward over 0..1 (≈0.7s). */
export function animateStandToProne(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 1.15 - 0.95 * t;
  _bodyRotX.base = 1.4 * t;
  // Knees bend then extend flat.
  parts.lleg.rotation.x = Math.sin(t * Math.PI) * 1.0;
  parts.rleg.rotation.x = Math.sin(t * Math.PI) * 1.0;
  // Arms reach forward to break the fall.
  parts.larm.rotation.x = -0.4 * t;
  parts.rarm.rotation.x = -0.4 * t;
}

/** C2-5000 #1360 — crouch→prone transition. Drop forward over 0..1 (≈0.5s). */
export function animateCrouchToProne(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 0.7 - 0.5 * t;
  _bodyRotX.base = 0.3 + 1.1 * t;
  // Legs extend backward.
  parts.lleg.rotation.x = 0.8 * (1 - t) + 0.2 * t;
  parts.rleg.rotation.x = 0.8 * (1 - t) + 0.2 * t;
  // Arms brace.
  parts.larm.rotation.x = -0.5 * t;
  parts.rarm.rotation.x = -0.5 * t;
}

/** C2-5000 #1361 — prone→crouch transition. Push-up to knee over 0..1 (≈0.6s). */
export function animateProneToCrouch(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 0.2 + 0.5 * t;
  _bodyRotX.base = 1.4 - 1.1 * t;
  // Knees bend under.
  parts.lleg.rotation.x = 0.2 + 0.6 * t;
  parts.rleg.rotation.x = 0.2 + 0.6 * t;
  // Arms pull in.
  parts.larm.rotation.x = -0.4 * (1 - t);
  parts.rarm.rotation.x = -0.4 * (1 - t);
}

/** C2-5000 #1362 — sprint→prone dive. Baseball-slide into prone over 0..1 (≈0.6s). */
export function animateSprintToProneDive(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 1.15 - 0.95 * t;
  _bodyRotX.base = 0.15 + 1.25 * t;
  // Legs extended forward (slide).
  parts.lleg.rotation.x = -1.0 * t;
  parts.rleg.rotation.x = -1.0 * t;
  // Arms tucked.
  parts.larm.rotation.x = -0.8 * t;
  parts.rarm.rotation.x = -0.8 * t;
}

/** C2-5000 #1363 — prone-crawl cycle. Arms reach + pull, legs drag. `phase` 0..1 loops. */
export function animateProneCrawl(parts: Record<string, THREE.Mesh>, phase: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  const cycle = phase * Math.PI * 2;
  // Alternating arm reach (left forward while right pulls back).
  parts.larm.rotation.x = -0.4 + 0.5 * Math.sin(cycle);
  parts.rarm.rotation.x = -0.4 + 0.5 * Math.sin(cycle + Math.PI);
  // Slight body bob (crawl rhythm).
  if (parts.body) parts.body.position.y = 0.2 + 0.03 * Math.sin(cycle * 2);
  // Legs drag — minimal motion.
  parts.lleg.rotation.x = 0.2 + 0.05 * Math.sin(cycle + Math.PI / 2);
  parts.rleg.rotation.x = 0.2 + 0.05 * Math.sin(cycle + Math.PI * 1.5);
}

/** C2-5000 #1364 — prone-fire. Legs spread, weapon shouldered, per-shot recoil. */
export function animateProneFire(parts: Record<string, THREE.Mesh>, timeSinceShot: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Legs splayed for stability.
  parts.lleg.rotation.x = 0.2;
  parts.lleg.rotation.z = -0.3;
  parts.rleg.rotation.x = 0.2;
  parts.rleg.rotation.z = 0.3;
  // Right arm shouldered; left arm supports bipod.
  parts.rarm.rotation.x = -1.2;
  parts.larm.rotation.x = -1.0;
  // Recoil impulse (sharp, decays in 0.1s).
  const recoil = Math.max(0, 1 - timeSinceShot * 10) * 0.08;
  _bodyRotX.base -= recoil;
  parts.head.rotation.x = 0.1 + recoil * 0.5;
}

/** C2-5000 #1365 — prone-reload. Side-lying, mag swap low. `phase` 0..1 over 2.5s. */
export function animateProneReload(parts: Record<string, THREE.Mesh>, phase: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Roll slightly to access the mag well.
  parts.body.rotation.z = 0.15 * Math.sin(phase * Math.PI);
  // Right arm reaches down for new mag, then up to the well.
  const reach = Math.sin(phase * Math.PI);
  parts.rarm.rotation.x = -0.5 - 0.7 * reach;
  parts.larm.rotation.x = -1.0;
}

/** C2-5000 #1366 — prone-melee. Elbow strike. `phase` 0..1 over 0.4s. */
export function animateProneMelee(parts: Record<string, THREE.Mesh>, phase: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Wind-up (0..0.3) then strike (0.3..1.0).
  const windup = phase < 0.3 ? phase / 0.3 : 0;
  const strike = phase >= 0.3 ? (phase - 0.3) / 0.7 : 0;
  parts.rarm.rotation.x = -0.3 + 0.8 * windup - 1.2 * strike;
  // Body twists with the strike.
  parts.body.rotation.y = 0.4 * strike;
}

/** C2-5000 #1367 — prone-grenade. Underhand toss from prone. `phase` 0..1 over 1.0s. */
export function animateProneGrenade(parts: Record<string, THREE.Mesh>, phase: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Lift right arm back, then sweep forward + release.
  if (phase < 0.4) {
    parts.rarm.rotation.x = -0.5 + (phase / 0.4) * -0.8;
  } else {
    const t = (phase - 0.4) / 0.6;
    parts.rarm.rotation.x = -1.3 + t * 1.5;
  }
  // Head lifts to track the throw.
  parts.head.rotation.x = phase < 0.5 ? -0.1 : 0.2 * ((phase - 0.5) / 0.5);
}

/** C2-5000 #1368 — prone-vault BLOCK. Returns false (engine refuses the action). */
export function animateProneVaultBlock(): boolean {
  // Prone operators cannot vault — they must stand or crouch first.
  // The function is exported so the state machine can introspect the block.
  return false;
}

/** C2-5000 #1369 — prone-ladder BLOCK. Returns false (engine refuses the action). */
export function animateProneLadderBlock(): boolean {
  // Prone operators cannot climb ladders — they must stand first.
  return false;
}

/** C2-5000 #1370 — prone-swim. Superman glide stroke. `phase` 0..1 loops. */
export function animateProneSwim(parts: Record<string, THREE.Mesh>, phase: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  const cycle = phase * Math.PI * 2;
  // Both arms sweep out then back (breaststroke-from-prone).
  const sweep = Math.sin(cycle);
  parts.larm.rotation.x = -0.4 + 0.5 * sweep;
  parts.rarm.rotation.x = -0.4 + 0.5 * sweep;
  parts.larm.rotation.z = -0.3 * sweep;
  parts.rarm.rotation.z = 0.3 * sweep;
  // Legs flutter lightly.
  parts.lleg.rotation.x = 0.2 + 0.1 * Math.sin(cycle * 2);
  parts.rleg.rotation.x = 0.2 + 0.1 * Math.sin(cycle * 2 + Math.PI);
}

/** C2-5000 #1371 — slide (feet-first). Legs extended, lean back. `phase` 0..1 over slide duration. */
export function animateSlideFeetFirst(parts: Record<string, THREE.Mesh>, phase: number): void {
  // Phase 0 = just landed in slide; phase 1 = slide ending. Body stays low.
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 0.4 - 0.15 * t;
  _bodyRotX.base = -0.3 + 0.4 * t; // lean back, then forward as slide ends.
  // Legs extended forward (feet-first slide).
  parts.lleg.rotation.x = -1.2 + 0.6 * t;
  parts.rleg.rotation.x = -1.2 + 0.6 * t;
  // Right hand braces on ground; left holds weapon low.
  parts.rarm.rotation.x = -1.4;
  parts.larm.rotation.x = -0.6;
}

/** C2-5000 #1372 — slide→prone transition. Continue sliding into prone. */
export function animateSlideToProne(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 0.4 - 0.2 * t;
  _bodyRotX.base = -0.3 + 1.7 * t; // lean back → flat forward.
  // Legs go from extended forward to flat behind.
  parts.lleg.rotation.x = -1.2 + 1.4 * t;
  parts.rleg.rotation.x = -1.2 + 1.4 * t;
}

/** C2-5000 #1373 — slide→crouch transition. Tuck legs under. */
export function animateSlideToCrouch(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 0.4 + 0.3 * t;
  _bodyRotX.base = -0.3 + 0.6 * t;
  // Legs tuck under (bend at knee, foot plants).
  parts.lleg.rotation.x = -1.2 + 2.0 * t;
  parts.rleg.rotation.x = -1.2 + 2.0 * t;
}

/** C2-5000 #1374 — slide→stand transition. Forward momentum carries up. */
export function animateSlideToStand(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 0.4 + 0.75 * t;
  _bodyRotX.base = -0.3 + 0.45 * t;
  // Legs plant + extend.
  parts.lleg.rotation.x = -1.2 + 1.2 * t;
  parts.rleg.rotation.x = -1.2 + 1.2 * t;
  // Arms swing up for momentum.
  parts.larm.rotation.x = -0.6 + 0.6 * t;
  parts.rarm.rotation.x = -1.4 + 1.4 * t;
}

/** C2-5000 #1375 — slide-fire. One-hand aim from slide. `timeSinceShot` in seconds. */
export function animateSlideFire(parts: Record<string, THREE.Mesh>, timeSinceShot: number): void {
  if (parts.body) parts.body.position.y = 0.4;
  _bodyRotX.base = -0.3;
  parts.lleg.rotation.x = -1.2;
  parts.rleg.rotation.x = -1.2;
  // Right arm extends for one-handed aim.
  parts.rarm.rotation.x = -1.5;
  parts.larm.rotation.x = -1.4;
  // Per-shot recoil kick.
  const recoil = Math.max(0, 1 - timeSinceShot * 10) * 0.06;
  _bodyRotX.base -= recoil;
}

/** C2-5000 #1376 — slide-reload. Mag swap while sliding. `phase` 0..1 over 2.0s. */
export function animateSlideReload(parts: Record<string, THREE.Mesh>, phase: number): void {
  if (parts.body) parts.body.position.y = 0.4;
  _bodyRotX.base = -0.3;
  parts.lleg.rotation.x = -1.2;
  parts.rleg.rotation.x = -1.2;
  // Right arm dips to swap mags.
  const dip = Math.sin(phase * Math.PI);
  parts.rarm.rotation.x = -1.5 - 0.4 * dip;
  parts.larm.rotation.x = -1.4;
}

/** C2-5000 #1377 — slide-melee. Boot kick while sliding. `phase` 0..1 over 0.4s. */
export function animateSlideMelee(parts: Record<string, THREE.Mesh>, phase: number): void {
  if (parts.body) parts.body.position.y = 0.4;
  _bodyRotX.base = -0.3 - 0.1 * phase;
  // Right leg kicks up + out.
  parts.rleg.rotation.x = -1.2 + 0.8 * Math.sin(phase * Math.PI);
  parts.rleg.rotation.z = 0.4 * Math.sin(phase * Math.PI);
}

/** C2-5000 #1378 — wall-run. Lean into wall, legs cycle. `phase` 0..1 loops, `wallSide` -1=left/+1=right. */
export function animateWallRun(parts: Record<string, THREE.Mesh>, phase: number, wallSide: -1 | 1 = 1): void {
  // Body tilts toward the wall.
  parts.body.rotation.z = 0.4 * wallSide;
  // Legs cycle as if running on the wall.
  const cycle = phase * Math.PI * 2;
  parts.lleg.rotation.x = Math.sin(cycle) * 0.8;
  parts.rleg.rotation.x = Math.sin(cycle + Math.PI) * 0.8;
  // Inside arm reaches toward wall for balance.
  const insideArm = wallSide === 1 ? parts.rarm : parts.larm;
  insideArm.rotation.x = -1.2;
  insideArm.rotation.z = 0.5 * wallSide;
}

/** C2-5000 #1379 — wall-run→jump. Push off wall upward. `phase` 0..1 over 0.3s. */
export function animateWallRunToJump(parts: Record<string, THREE.Mesh>, phase: number, wallSide: -1 | 1 = 1): void {
  const t = Math.min(1, Math.max(0, phase));
  // Body returns to upright.
  parts.body.rotation.z = 0.4 * wallSide * (1 - t);
  // Legs tuck for the jump.
  parts.lleg.rotation.x = -0.8 * t;
  parts.rleg.rotation.x = -0.8 * t;
  // Arms swing up.
  parts.larm.rotation.x = -0.5 - 1.0 * t;
  parts.rarm.rotation.x = -0.5 - 1.0 * t;
}

/** C2-5000 #1380 — wall-run→fall. Lose wall contact. `phase` 0..1 over 0.4s. */
export function animateWallRunToFall(parts: Record<string, THREE.Mesh>, phase: number, wallSide: -1 | 1 = 1): void {
  const t = Math.min(1, Math.max(0, phase));
  parts.body.rotation.z = 0.4 * wallSide * (1 - t);
  // Legs go limp.
  parts.lleg.rotation.x = 0.2 + 0.3 * t;
  parts.rleg.rotation.x = 0.2 + 0.3 * t;
  // Arms flail out.
  parts.larm.rotation.x = -0.3 + 0.4 * Math.sin(t * 8);
  parts.rarm.rotation.x = -0.3 + 0.4 * Math.sin(t * 8 + Math.PI);
}

/** C2-5000 #1381 — wall-jump. Push-off + tuck. `phase` 0..1 over 0.4s. */
export function animateWallJump(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 1.15 + 0.5 * t;
  _bodyRotX.base = -0.2 * t;
  // Legs tuck after push-off.
  parts.lleg.rotation.x = -0.6 * t;
  parts.rleg.rotation.x = -0.6 * t;
  // Arms in.
  parts.larm.rotation.x = -0.8 * t;
  parts.rarm.rotation.x = -0.8 * t;
}

/** C2-5000 #1382 — wall-climb mantle. Hands-up pull over ledge. `phase` 0..1 over 0.8s. */
export function animateWallClimbMantle(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 1.15 + 0.7 * t;
  _bodyRotX.base = 0.3 - 0.3 * t; // lean in then straighten.
  // Both arms reach up to the ledge, then pull.
  if (t < 0.5) {
    parts.larm.rotation.x = -1.8 * (t * 2);
    parts.rarm.rotation.x = -1.8 * (t * 2);
  } else {
    parts.larm.rotation.x = -1.8 + 1.0 * ((t - 0.5) * 2);
    parts.rarm.rotation.x = -1.8 + 1.0 * ((t - 0.5) * 2);
  }
  // Legs kick up to help.
  parts.lleg.rotation.x = -0.6 * t;
  parts.rleg.rotation.x = -0.6 * t;
}

/** C2-5000 #1383 — zip-line. Hands grip + lean back. `phase` 0..1 over ride. */
export function animateZipline(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  _bodyRotX.base = -0.4;
  // Both arms reach up to grip the line.
  parts.larm.rotation.x = -2.0;
  parts.rarm.rotation.x = -2.0;
  // Legs dangle forward.
  parts.lleg.rotation.x = -0.4 + 0.1 * Math.sin(t * 8);
  parts.rleg.rotation.x = -0.4 + 0.1 * Math.sin(t * 8 + Math.PI);
}

/** C2-5000 #1384 — grapple. Arm extended toward hook. `phase` 0..1 over pull. */
export function animateGrapple(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  _bodyRotX.base = -0.3 + 0.2 * t;
  // Right arm extended up toward the hook.
  parts.rarm.rotation.x = -2.4;
  parts.rarm.rotation.z = 0.3;
  // Left arm braces.
  parts.larm.rotation.x = -0.8;
  // Legs tuck as the body is pulled up.
  parts.lleg.rotation.x = -0.4 * t;
  parts.rleg.rotation.x = -0.4 * t;
}

/** C2-5000 #1385 — parachute. Arms up + legs dangle. `phase` 0..1 over descent. */
export function animateParachute(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  _bodyRotX.base = -0.2;
  // Both arms reach up to the chute risers.
  parts.larm.rotation.x = -2.2;
  parts.rarm.rotation.x = -2.2;
  // Legs dangle with slight sway.
  const sway = Math.sin(t * 6);
  parts.lleg.rotation.x = 0.1 + 0.05 * sway;
  parts.rleg.rotation.x = 0.1 + 0.05 * sway;
  parts.body.rotation.z = 0.03 * sway;
}

/** C2-5000 #1386 — glider. Arms spread, body prone-glide. `phase` 0..1 over glide. */
export function animateGlider(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  _bodyRotX.base = 0.8; // body prone.
  // Arms spread wide (T-pose-ish).
  parts.larm.rotation.z = 1.4;
  parts.rarm.rotation.z = -1.4;
  parts.larm.rotation.x = -0.3;
  parts.rarm.rotation.x = -0.3;
  // Legs straight back.
  parts.lleg.rotation.x = 0.4;
  parts.rleg.rotation.x = 0.4;
  // Slight bank in turns.
  parts.body.rotation.z = 0.1 * Math.sin(t * 4);
}

/** C2-5000 #1387 — vehicle-enter. Open door + sit. `phase` 0..1 over 1.5s. */
export function animateVehicleEnter(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (t < 0.4) {
    // Reach for the door handle.
    parts.rarm.rotation.x = -1.5 * (t / 0.4);
    parts.rarm.rotation.z = 0.4 * (t / 0.4);
  } else {
    // Drop into the seat.
    const sit = (t - 0.4) / 0.6;
    if (parts.body) parts.body.position.y = 1.15 - 0.45 * sit;
    _bodyRotX.base = 0.4 * sit;
    parts.lleg.rotation.x = 1.2 * sit;
    parts.rleg.rotation.x = 1.2 * sit;
  }
}

/** C2-5000 #1388 — vehicle-exit. Step out + stand. `phase` 0..1 over 1.2s. */
export function animateVehicleExit(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (t < 0.5) {
    // Stand up from seat.
    const stand = t / 0.5;
    if (parts.body) parts.body.position.y = 0.7 + 0.45 * stand;
    _bodyRotX.base = 0.4 * (1 - stand);
    parts.lleg.rotation.x = 1.2 * (1 - stand);
    parts.rleg.rotation.x = 1.2 * (1 - stand);
  } else {
    // Step out.
    const step = (t - 0.5) / 0.5;
    parts.lleg.rotation.x = -0.3 * Math.sin(step * Math.PI);
    parts.rleg.rotation.x = -0.3 * Math.sin(step * Math.PI + Math.PI);
  }
}

/** C2-5000 #1389 — vehicle-drive. Hands on wheel, look forward. `time` in seconds. */
export function animateVehicleDrive(parts: Record<string, THREE.Mesh>, time: number): void {
  if (parts.body) parts.body.position.y = 0.7;
  _bodyRotX.base = 0.3;
  // Both arms reach forward to the wheel.
  parts.larm.rotation.x = -1.4;
  parts.rarm.rotation.x = -1.4;
  // Slight steering corrections.
  const steer = Math.sin(time * 1.5) * 0.1;
  parts.larm.rotation.z = steer;
  parts.rarm.rotation.z = -steer;
  // Legs bent, feet on pedals.
  parts.lleg.rotation.x = 1.0;
  parts.rleg.rotation.x = 1.0;
  // Head looks forward (small bobs on terrain).
  parts.head.rotation.x = 0.05 * Math.sin(time * 4);
}

/** C2-5000 #1390 — vehicle-passenger. Relaxed, hands in lap. `time` in seconds. */
export function animateVehiclePassenger(parts: Record<string, THREE.Mesh>, time: number): void {
  if (parts.body) parts.body.position.y = 0.7;
  _bodyRotX.base = 0.35;
  // Arms relaxed in lap.
  parts.larm.rotation.x = -0.8;
  parts.rarm.rotation.x = -0.8;
  parts.larm.rotation.z = 0.3;
  parts.rarm.rotation.z = -0.3;
  parts.lleg.rotation.x = 1.0;
  parts.rleg.rotation.x = 1.0;
  // Head lolls slightly with motion.
  parts.head.rotation.z = 0.04 * Math.sin(time * 2);
}

/** C2-5000 #1391 — vehicle-gun. Hands on turret controls. `time` in seconds, `traverse` radians. */
export function animateVehicleGun(parts: Record<string, THREE.Mesh>, time: number, traverse: number = 0): void {
  if (parts.body) parts.body.position.y = 1.0;
  _bodyRotX.base = 0.1;
  // Arms raised to the turret spade-grips.
  parts.larm.rotation.x = -1.6;
  parts.rarm.rotation.x = -1.6;
  // Body rotates with the turret.
  parts.body.rotation.y = traverse;
  // Head scans.
  parts.head.rotation.y = Math.sin(time * 1.2) * 0.3;
}

/** C2-5000 #1392 — horse-ride. Post rhythm with horse gait. `phase` 0..1 loops. */
export function animateHorseRide(parts: Record<string, THREE.Mesh>, phase: number): void {
  const cycle = phase * Math.PI * 2;
  // Posting: rise + fall with the trot.
  if (parts.body) parts.body.position.y = 1.1 + 0.1 * Math.sin(cycle * 2);
  _bodyRotX.base = 0.15 + 0.05 * Math.sin(cycle * 2);
  // Arms hold reins (forward + down).
  parts.larm.rotation.x = -1.0;
  parts.rarm.rotation.x = -1.0;
  // Legs grip the horse's flanks.
  parts.lleg.rotation.x = 0.8;
  parts.rleg.rotation.x = 0.8;
  parts.lleg.rotation.z = -0.3;
  parts.rleg.rotation.z = 0.3;
}

/** C2-5000 #1393 — boat-row. Alternate oar strokes. `phase` 0..1 loops. */
export function animateBoatRow(parts: Record<string, THREE.Mesh>, phase: number): void {
  const cycle = phase * Math.PI * 2;
  // Stroke arc: reach forward, dip, pull back, lift.
  const stroke = Math.sin(cycle);
  // Both arms reach + pull together (two-oar rowing).
  parts.larm.rotation.x = -0.8 - 0.8 * stroke;
  parts.rarm.rotation.x = -0.8 - 0.8 * stroke;
  // Lean into the pull.
  _bodyRotX.base = 0.2 + 0.15 * (1 - stroke) / 2;
  // Legs brace.
  parts.lleg.rotation.x = 0.6;
  parts.rleg.rotation.x = 0.6;
}

/** C2-5000 #1394 — boat-sail. Steering hands + lean. `time` in seconds. */
export function animateBoatSail(parts: Record<string, THREE.Mesh>, time: number): void {
  // Hands on the tiller (right) + mainsheet (left).
  parts.rarm.rotation.x = -1.0;
  parts.rarm.rotation.z = 0.3;
  parts.larm.rotation.x = -1.0;
  parts.larm.rotation.z = -0.3;
  // Body leans with the heel of the boat.
  const heel = Math.sin(time * 0.8) * 0.15;
  parts.body.rotation.z = heel;
  _bodyRotX.base = 0.1;
  // Legs brace wide.
  parts.lleg.rotation.z = -0.2;
  parts.rleg.rotation.z = 0.2;
}

/** C2-5000 #1395 — swim-dive. Streamlined entry, arms together. `phase` 0..1 over 0.6s. */
export function animateSwimDive(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 1.15 - 0.8 * t;
  _bodyRotX.base = 0.3 + 1.0 * t; // body goes horizontal.
  // Arms streamline overhead.
  parts.larm.rotation.x = -2.5 * t;
  parts.rarm.rotation.x = -2.5 * t;
  // Legs straight + together.
  parts.lleg.rotation.x = 0.1 + 0.2 * t;
  parts.rleg.rotation.x = 0.1 + 0.2 * t;
}

/** C2-5000 #1396 — swim-surface. Freestyle stroke. `phase` 0..1 loops. */
export function animateSwimSurface(parts: Record<string, THREE.Mesh>, phase: number): void {
  const cycle = phase * Math.PI * 2;
  _bodyRotX.base = 1.2; // horizontal.
  // Alternating arm strokes.
  parts.larm.rotation.x = -1.5 + 0.8 * Math.sin(cycle);
  parts.rarm.rotation.x = -1.5 + 0.8 * Math.sin(cycle + Math.PI);
  // Flutter kick.
  parts.lleg.rotation.x = 0.2 + 0.15 * Math.sin(cycle * 4);
  parts.rleg.rotation.x = 0.2 + 0.15 * Math.sin(cycle * 4 + Math.PI);
  // Head turns to breathe every other stroke.
  parts.head.rotation.y = Math.max(0, Math.sin(cycle + Math.PI / 2)) * 0.6;
}

/** C2-5000 #1397 — swim-underwater. Breaststroke, head down. `phase` 0..1 loops. */
export function animateSwimUnderwater(parts: Record<string, THREE.Mesh>, phase: number): void {
  const cycle = phase * Math.PI * 2;
  _bodyRotX.base = 1.4;
  // Both arms sweep out then in together.
  const sweep = Math.sin(cycle);
  parts.larm.rotation.x = -1.0 + 0.6 * sweep;
  parts.rarm.rotation.x = -1.0 + 0.6 * sweep;
  parts.larm.rotation.z = -0.6 * sweep;
  parts.rarm.rotation.z = 0.6 * sweep;
  // Frog kick.
  parts.lleg.rotation.x = 0.3 + 0.3 * (1 - sweep) / 2;
  parts.rleg.rotation.x = 0.3 + 0.3 * (1 - sweep) / 2;
  parts.lleg.rotation.z = -0.4 * (1 - sweep) / 2;
  parts.rleg.rotation.z = 0.4 * (1 - sweep) / 2;
  // Head tucked down.
  parts.head.rotation.x = 0.3;
}

/** C2-5000 #1398 — swim-backstroke. Arms alternate overhead. `phase` 0..1 loops. */
export function animateSwimBackstroke(parts: Record<string, THREE.Mesh>, phase: number): void {
  const cycle = phase * Math.PI * 2;
  _bodyRotX.base = -1.2; // face up.
  // Arms sweep overhead alternately.
  parts.larm.rotation.x = 1.5 + 1.0 * Math.sin(cycle);
  parts.rarm.rotation.x = 1.5 + 1.0 * Math.sin(cycle + Math.PI);
  // Flutter kick.
  parts.lleg.rotation.x = -0.1 + 0.1 * Math.sin(cycle * 4);
  parts.rleg.rotation.x = -0.1 + 0.1 * Math.sin(cycle * 4 + Math.PI);
  // Head back.
  parts.head.rotation.x = -0.3;
}

/** C2-5000 #1399 — swim-tread. Vertical, hands sculling. `time` in seconds. */
export function animateSwimTread(parts: Record<string, THREE.Mesh>, time: number): void {
  if (parts.body) parts.body.position.y = 1.0 + 0.04 * Math.sin(time * 4);
  _bodyRotX.base = 0.05;
  // Hands scull at the surface.
  parts.larm.rotation.x = -0.6 + 0.1 * Math.sin(time * 6);
  parts.rarm.rotation.x = -0.6 + 0.1 * Math.sin(time * 6 + Math.PI);
  // Eggbeater kick (alternating circles).
  parts.lleg.rotation.x = 0.3 + 0.1 * Math.sin(time * 4);
  parts.rleg.rotation.x = 0.3 + 0.1 * Math.sin(time * 4 + Math.PI);
  parts.lleg.rotation.z = 0.1 * Math.sin(time * 4 + Math.PI / 2);
  parts.rleg.rotation.z = -0.1 * Math.sin(time * 4 + Math.PI / 2);
  // Head above water.
  parts.head.rotation.x = -0.05;
}

/** C2-5000 #1400 — swim-exit. Pull-up onto ledge. `phase` 0..1 over 1.0s. */
export function animateSwimExit(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 0.4 + 0.75 * t;
  _bodyRotX.base = 1.2 - 1.05 * t;
  // Arms reach up + pull.
  parts.larm.rotation.x = -2.0 + 1.5 * t;
  parts.rarm.rotation.x = -2.0 + 1.5 * t;
  // Legs kick then plant.
  parts.lleg.rotation.x = 0.3 - 0.3 * t;
  parts.rleg.rotation.x = 0.3 - 0.3 * t;
}

/** C2-5000 #1401 — injury-bleed. Clutch wound + drip. `time` seconds, `intensity` 0..1. */
export function animateInjuryBleed(parts: Record<string, THREE.Mesh>, time: number, intensity: number = 0.5): void {
  // Right hand clutches the wound (left side of torso).
  parts.rarm.rotation.x = -0.8;
  parts.rarm.rotation.z = 0.6;
  // Slight sway.
  parts.body.rotation.z = 0.05 * Math.sin(time * 2);
  _bodyRotX.base = 0.15 + 0.1 * intensity;
  // Head drops (weakness).
  parts.head.rotation.x = 0.2 * intensity;
  // Trembling.
  const tremble = Math.sin(time * 25) * 0.02 * intensity;
  parts.larm.rotation.x = -0.3 + tremble;
}

/** C2-5000 #1402 — injury-clutch. Hold wound, sway. `time` seconds. */
export function animateInjuryClutch(parts: Record<string, THREE.Mesh>, time: number): void {
  // Both hands over the wound.
  parts.larm.rotation.x = -0.6;
  parts.larm.rotation.z = -0.5;
  parts.rarm.rotation.x = -0.6;
  parts.rarm.rotation.z = 0.5;
  // Pained sway.
  parts.body.rotation.z = 0.08 * Math.sin(time * 1.5);
  _bodyRotX.base = 0.25;
  parts.head.rotation.x = 0.15;
}

/** C2-5000 #1403 — injury-stagger. Unsteady step back. `phase` 0..1 over 0.6s. */
export function animateInjuryStagger(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Body recoils backward + twists.
  _bodyRotX.base = -0.2 - 0.3 * Math.sin(t * Math.PI);
  parts.body.rotation.y = 0.4 * Math.sin(t * Math.PI);
  // Arms flail out for balance.
  parts.larm.rotation.x = -0.8 + 0.6 * Math.sin(t * Math.PI);
  parts.rarm.rotation.x = -0.8 + 0.6 * Math.sin(t * Math.PI + Math.PI / 2);
  // Stagger-step back.
  parts.lleg.rotation.x = 0.5 * Math.sin(t * Math.PI * 2);
  parts.rleg.rotation.x = 0.5 * Math.sin(t * Math.PI * 2 + Math.PI);
}

/** C2-5000 #1404 — injury-fall. Collapse to knee then prone. `phase` 0..1 over 1.2s. */
export function animateInjuryFall(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (t < 0.5) {
    // Drop to one knee.
    const knee = t / 0.5;
    if (parts.body) parts.body.position.y = 1.15 - 0.45 * knee;
    _bodyRotX.base = 0.3 * knee;
    parts.rleg.rotation.x = 1.2 * knee;
  } else {
    // Collapse forward to prone.
    const collapse = (t - 0.5) / 0.5;
    if (parts.body) parts.body.position.y = 0.7 - 0.5 * collapse;
    _bodyRotX.base = 0.3 + 1.1 * collapse;
    parts.lleg.rotation.x = 0.2 * collapse;
    parts.rleg.rotation.x = 1.2 - 1.0 * collapse;
  }
  // Arms reach out to break the fall in the second half.
  if (t > 0.4) {
    parts.larm.rotation.x = -0.6 * (t - 0.4) / 0.6;
    parts.rarm.rotation.x = -0.6 * (t - 0.4) / 0.6;
  }
}

/** C2-5000 #1405 — injury-recover. Shake it off + stand. `phase` 0..1 over 1.5s. */
export function animateInjuryRecover(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 0.7 + 0.45 * t;
  _bodyRotX.base = 0.3 - 0.3 * t;
  // Head shake (clearing the daze) early in recovery.
  if (t < 0.3) {
    parts.head.rotation.y = 0.2 * Math.sin(t * 30);
  }
  // Arms relax down.
  parts.larm.rotation.x = -0.4 * (1 - t);
  parts.rarm.rotation.x = -0.4 * (1 - t);
  // Legs straighten.
  parts.lleg.rotation.x = 0.8 * (1 - t);
  parts.rleg.rotation.x = 0.8 * (1 - t);
}

/** C2-5000 #1407 — downed-bleed. Weep + hand reach for help. `time` seconds. */
export function animateDownedBleed(parts: Record<string, THREE.Mesh>, time: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Right arm reaches out for help (weak wave).
  parts.rarm.rotation.x = -0.6 + 0.2 * Math.sin(time * 2);
  parts.rarm.rotation.z = 0.4;
  // Left arm clutches wound.
  parts.larm.rotation.x = -0.5;
  parts.larm.rotation.z = -0.4;
  // Heavy breathing.
  parts.body.position.y = 0.2 + 0.02 * Math.sin(time * 3);
}

/** C2-5000 #1408 — downed-shoot. Secondary weapon, side-aim. `timeSinceShot` seconds. */
export function animateDownedShoot(parts: Record<string, THREE.Mesh>, timeSinceShot: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Body rolls slightly onto side to aim.
  parts.body.rotation.z = 0.4;
  // Right arm extends pistol.
  parts.rarm.rotation.x = -1.4;
  parts.rarm.rotation.z = 0.3;
  // Left arm props up.
  parts.larm.rotation.x = -1.0;
  parts.larm.rotation.z = -0.5;
  // Per-shot recoil.
  const recoil = Math.max(0, 1 - timeSinceShot * 10) * 0.05;
  parts.rarm.rotation.x -= recoil;
}

/** C2-5000 #1409 — downed-callout. Wave for help. `time` seconds. */
export function animateDownedCallout(parts: Record<string, THREE.Mesh>, time: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Right arm waves weakly overhead.
  parts.rarm.rotation.x = -2.0 + 0.3 * Math.sin(time * 4);
  parts.rarm.rotation.z = 0.2;
  // Left arm clutches.
  parts.larm.rotation.x = -0.5;
  parts.larm.rotation.z = -0.4;
  // Head lifts to call out.
  parts.head.rotation.x = -0.2;
}

/** C2-5000 #1410 — downed-drag. Limp body being dragged by teammate. `time` seconds. */
export function animateDownedDrag(parts: Record<string, THREE.Mesh>, time: number): void {
  _bodyRotX.base = 1.4;
  if (parts.body) parts.body.position.y = 0.2;
  // Arms trail behind (dragged from shoulders).
  parts.larm.rotation.x = -0.2 + 0.05 * Math.sin(time * 6);
  parts.rarm.rotation.x = -0.2 + 0.05 * Math.sin(time * 6 + 0.5);
  // Legs limp, dragging.
  parts.lleg.rotation.x = 0.1 + 0.05 * Math.sin(time * 6 + Math.PI);
  parts.rleg.rotation.x = 0.1 + 0.05 * Math.sin(time * 6 + Math.PI + 0.5);
  // Head lolls back.
  parts.head.rotation.x = -0.3;
}

/** C2-5000 #1411 — downed-carry. Over-shoulder carry pose (carrier side). */
export function animateDownedCarry(parts: Record<string, THREE.Mesh>): void {
  // Carrier stoops under the load.
  _bodyRotX.base = 0.4;
  if (parts.body) parts.body.position.y = 1.0;
  // Both arms hold the downed player's legs over the right shoulder.
  parts.rarm.rotation.x = -1.4;
  parts.rarm.rotation.z = 0.5;
  parts.larm.rotation.x = -1.2;
  parts.larm.rotation.z = 0.3;
  // Staggered stance.
  parts.lleg.rotation.x = 0.3;
  parts.rleg.rotation.x = 0.1;
}

/** C2-5000 #1412 — revive-kneel. Kneel at downed player. `phase` 0..1 over 0.5s. */
export function animateReviveKneel(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (parts.body) parts.body.position.y = 1.15 - 0.45 * t;
  _bodyRotX.base = 0.3 * t;
  // Right knee down.
  parts.rleg.rotation.x = 1.4 * t;
  // Left foot planted.
  parts.lleg.rotation.x = 0.3 * t;
  // Arms reach forward toward the patient.
  parts.larm.rotation.x = -0.8 * t;
  parts.rarm.rotation.x = -0.8 * t;
}

/** C2-5000 #1413 — revive-CPR. Chest compressions. `phase` 0..1 loops (≈1Hz). */
export function animateReviveCPR(parts: Record<string, THREE.Mesh>, phase: number): void {
  const cycle = phase * Math.PI * 2;
  // Both arms locked straight, pressing down rhythmically.
  const press = (Math.sin(cycle) + 1) / 2; // 0..1
  parts.larm.rotation.x = -1.6;
  parts.rarm.rotation.x = -1.6;
  _bodyRotX.base = 0.5 + 0.15 * press;
  if (parts.body) parts.body.position.y = 0.7 - 0.05 * press;
  // Right knee down; left foot up.
  parts.rleg.rotation.x = 1.4;
  parts.lleg.rotation.x = 0.4;
}

/** C2-5000 #1414 — revive-bandage. Wrap wound. `phase` 0..1 over 4s. */
export function animateReviveBandage(parts: Record<string, THREE.Mesh>, phase: number): void {
  const cycle = phase * Math.PI * 4;
  // Both arms work on the wound (circular wrap motion).
  parts.larm.rotation.x = -0.8;
  parts.rarm.rotation.x = -0.8 + 0.3 * Math.sin(cycle);
  parts.rarm.rotation.z = 0.4 + 0.2 * Math.sin(cycle);
  _bodyRotX.base = 0.4;
  if (parts.body) parts.body.position.y = 0.7;
  parts.rleg.rotation.x = 1.4;
  parts.lleg.rotation.x = 0.4;
}

/** C2-5000 #1415 — revive-inject. Stim pen to thigh. `phase` 0..1 over 1.0s. */
export function animateReviveInject(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Right arm jabs downward toward the patient's thigh.
  if (t < 0.3) {
    parts.rarm.rotation.x = -0.5 + (t / 0.3) * -1.0;
  } else if (t < 0.5) {
    parts.rarm.rotation.x = -1.5; // hold injection.
  } else {
    parts.rarm.rotation.x = -1.5 + ((t - 0.5) / 0.5) * 1.0; // withdraw.
  }
  parts.larm.rotation.x = -0.6;
  _bodyRotX.base = 0.4;
  if (parts.body) parts.body.position.y = 0.7;
  parts.rleg.rotation.x = 1.4;
  parts.lleg.rotation.x = 0.4;
}

/** C2-5000 #1416 — revive-complete. Help up to feet. `phase` 0..1 over 1.5s. */
export function animateReviveComplete(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Both rise together.
  if (parts.body) parts.body.position.y = 0.7 + 0.45 * t;
  _bodyRotX.base = 0.4 - 0.4 * t;
  // Arms lift the patient up.
  parts.larm.rotation.x = -0.8 + 0.5 * t;
  parts.rarm.rotation.x = -0.8 + 0.5 * t;
  // Legs straighten.
  parts.rleg.rotation.x = 1.4 - 1.4 * t;
  parts.lleg.rotation.x = 0.4 - 0.4 * t;
}

/** C2-5000 #1417 — capture-restrain. Zip-tie wrists. `phase` 0..1 over 1.5s. */
export function animateCaptureRestrain(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Crouch behind the captive.
  if (parts.body) parts.body.position.y = 0.7;
  _bodyRotX.base = 0.4;
  // Both arms pull the captive's wrists together behind their back.
  parts.larm.rotation.x = -0.6 - 0.3 * t;
  parts.larm.rotation.z = -0.4 * t;
  parts.rarm.rotation.x = -0.6 - 0.3 * t;
  parts.rarm.rotation.z = 0.4 * t;
  parts.rleg.rotation.x = 1.2;
  parts.lleg.rotation.x = 0.4;
}

/** C2-5000 #1418 — capture-escort. Hands-on-shoulder walk. `phase` 0..1 loops. */
export function animateCaptureEscort(parts: Record<string, THREE.Mesh>, phase: number): void {
  const cycle = phase * Math.PI * 2;
  // Left hand on captive's shoulder (forward + slightly out).
  parts.larm.rotation.x = -1.2;
  parts.larm.rotation.z = -0.3;
  // Right hand holds weapon at low ready.
  parts.rarm.rotation.x = -0.6;
  // Walk cycle on legs.
  parts.lleg.rotation.x = 0.3 * Math.sin(cycle);
  parts.rleg.rotation.x = 0.3 * Math.sin(cycle + Math.PI);
  if (parts.body) parts.body.position.y = 1.15 + 0.02 * Math.sin(cycle * 2);
  _bodyRotX.base = 0.1;
}

/** C2-5000 #1419 — capture-release. Cut ties + stand back. `phase` 0..1 over 1.0s. */
export function animateCaptureRelease(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (t < 0.5) {
    // Right arm reaches to cut the zip-tie.
    parts.rarm.rotation.x = -0.8 - 0.4 * (t / 0.5);
    parts.rarm.rotation.z = -0.3;
    _bodyRotX.base = 0.3;
  } else {
    // Step back + stand up.
    const back = (t - 0.5) / 0.5;
    parts.rarm.rotation.x = -1.2 + 0.6 * back;
    _bodyRotX.base = 0.3 - 0.3 * back;
  }
  parts.larm.rotation.x = -0.6;
}

/** C2-5000 #1420 — hostage-grab. Arm around neck. `phase` 0..1 over 0.4s. */
export function animateHostageGrab(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Right arm wraps around hostage's neck (forward + across).
  parts.rarm.rotation.x = -1.2 * t;
  parts.rarm.rotation.z = -0.6 * t;
  // Left arm holds weapon against their back.
  parts.larm.rotation.x = -0.8 * t;
  // Body closes in.
  _bodyRotX.base = 0.2 * t;
}

/** C2-5000 #1423 — hostage-rescue. Free + signal clear. `phase` 0..1 over 1.5s. */
export function animateHostageRescue(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  if (t < 0.4) {
    // Cut the hostage's bonds.
    parts.rarm.rotation.x = -0.8 - 0.4 * (t / 0.4);
  } else if (t < 0.7) {
    // Help them up.
    const up = (t - 0.4) / 0.3;
    parts.rarm.rotation.x = -1.2 + 0.6 * up;
    parts.larm.rotation.x = -1.2 + 0.6 * up;
  } else {
    // Signal "all clear" with a thumbs-up.
    const signal = (t - 0.7) / 0.3;
    parts.rarm.rotation.x = -1.8 * signal;
    parts.rarm.rotation.z = 0.3 * signal;
  }
}

/** C2-5000 #1426 — breach-shotgun. Breaching shotgun to door. `phase` 0..1 over 0.8s. */
export function animateBreachShotgun(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Approach + raise the shotgun to the door hinge line.
  if (t < 0.5) {
    parts.rarm.rotation.x = -0.6 - 0.8 * (t / 0.5);
    parts.larm.rotation.x = -0.4 - 0.6 * (t / 0.5);
  } else {
    // Fire + recoil.
    const fire = (t - 0.5) / 0.5;
    parts.rarm.rotation.x = -1.4 + 0.4 * fire;
    parts.larm.rotation.x = -1.0 + 0.3 * fire;
    _bodyRotX.base = 0.2 + 0.15 * (1 - fire);
  }
  _bodyRotX.base = 0.2;
}

/** C2-5000 #1428 — breach-stack. Line up on wall. `phase` 0..1 over 1.0s. */
export function animateBreachStack(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Crouch against the wall, weapon tucked.
  if (parts.body) parts.body.position.y = 1.15 - 0.45 * t;
  _bodyRotX.base = 0.3 * t;
  // Weapon held high-ready across the chest.
  parts.rarm.rotation.x = -1.2 * t;
  parts.rarm.rotation.z = -0.4 * t;
  parts.larm.rotation.x = -1.0 * t;
  parts.larm.rotation.z = 0.4 * t;
  // Legs in a wide stance.
  parts.lleg.rotation.x = 0.4 * t;
  parts.rleg.rotation.x = 0.4 * t;
}

/** C2-5000 #1429 — breach-entry. Dynamic corner pie slice. `phase` 0..1 over 0.6s. */
export function animateBreachEntry(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Body sweeps around the corner (yaw).
  parts.body.rotation.y = -1.0 * t;
  // Weapon out, sweeping with the body.
  parts.rarm.rotation.x = -1.4;
  parts.larm.rotation.x = -1.0;
  // Pivot on the inside foot.
  parts.lleg.rotation.x = 0.4;
  parts.rleg.rotation.x = 0.2;
  _bodyRotX.base = 0.2;
}

/** C2-5000 #1430 — handsignal-stop. Fist up. `phase` 0..1 over 0.5s. */
export function animateHandSignalStop(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  parts.rarm.rotation.x = -2.0 * t; // fist straight up.
  parts.rarm.rotation.z = 0;
  parts.larm.rotation.x = -0.4 * t;
}

/** C2-5000 #1431 — handsignal-forward. Palm forward sweep. `phase` 0..1 over 0.6s. */
export function animateHandSignalForward(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Right arm extended forward, palm out, sweeping from low to high.
  parts.rarm.rotation.x = -1.4 + 0.2 * Math.sin(t * Math.PI * 2);
  parts.rarm.rotation.z = 0.2 * t;
  parts.larm.rotation.x = -0.6 * t;
}

/** C2-5000 #1433 — handsignal-enemy. Point + weapon shape. `phase` 0..1 over 0.6s. */
export function animateHandSignalEnemy(parts: Record<string, THREE.Mesh>, phase: number): void {
  const t = Math.min(1, Math.max(0, phase));
  // Sharp point with the right hand.
  parts.rarm.rotation.x = -1.5 * t;
  parts.rarm.rotation.y = 0.3 * t;
  // Left hand mimics a weapon shape (flat, thumb up).
  parts.larm.rotation.x = -0.8 * t;
  parts.larm.rotation.z = -0.4 * t;
}

/** C2-5000 #1436 — ping-move. Sweep forward at ground. `phase` 0..1 over 1.2s. */
export function animatePingMove(parts: Record<string, THREE.Mesh>, phase: number): void {
  // Extend (0..0.3), sweep (0.3..0.9), retract (0.9..1.0).
  let k: number;
  if (phase < 0.3) k = phase / 0.3;
  else if (phase < 0.9) k = 1;
  else k = 1 - (phase - 0.9) / 0.1;
  // Sweep forward + down (toward the ground ahead).
  parts.rarm.rotation.x = -1.0 * k;
  parts.rarm.rotation.z = 0.4 * Math.sin(phase * Math.PI) * k;
}

/** C2-5000 #1437 — ping-enemy. Sharp point at threat. `phase` 0..1 over 0.8s. */
export function animatePingEnemy(parts: Record<string, THREE.Mesh>, phase: number): void {
  // Quick point (0..0.2), hold (0.2..0.7), retract (0.7..1.0).
  let k: number;
  if (phase < 0.2) k = phase / 0.2;
  else if (phase < 0.7) k = 1;
  else k = 1 - (phase - 0.7) / 0.3;
  parts.rarm.rotation.x = -1.6 * k; // higher, sharper than ping-move.
  parts.rarm.rotation.z = -0.2 * k;
}

/** C2-5000 #1438 — ping-danger. Urgent double-point. `phase` 0..1 over 1.2s. */
export function animatePingDanger(parts: Record<string, THREE.Mesh>, phase: number): void {
  // Two quick points (jab-jab) at the threat.
  const jab1 = phase < 0.25 ? Math.sin(phase * 4 * Math.PI) : 0;
  const jab2 = phase >= 0.4 && phase < 0.65 ? Math.sin((phase - 0.4) * 4 * Math.PI) : 0;
  const jab = Math.max(jab1, jab2);
  let k: number;
  if (phase < 0.7) k = 1;
  else k = 1 - (phase - 0.7) / 0.3;
  parts.rarm.rotation.x = -1.6 * k - 0.2 * jab;
  parts.rarm.rotation.z = -0.2 * k;
}

/** C2-5000 #1439 — ping-loot. Downward point at item. `phase` 0..1 over 1.0s. */
export function animatePingLoot(parts: Record<string, THREE.Mesh>, phase: number): void {
  let k: number;
  if (phase < 0.3) k = phase / 0.3;
  else if (phase < 0.8) k = 1;
  else k = 1 - (phase - 0.8) / 0.2;
  // Point down + forward.
  parts.rarm.rotation.x = -0.6 * k;
  parts.rarm.rotation.z = 0.3 * k;
  parts.larm.rotation.x = -0.3 * k;
}

/** C2-5000 #1440 — ping-defend. Shield gesture at ground. `phase` 0..1 over 1.2s. */
export function animatePingDefend(parts: Record<string, THREE.Mesh>, phase: number): void {
  let k: number;
  if (phase < 0.3) k = phase / 0.3;
  else if (phase < 0.9) k = 1;
  else k = 1 - (phase - 0.9) / 0.1;
  // Both arms forward + palms down (defensive shield).
  parts.larm.rotation.x = -1.0 * k;
  parts.rarm.rotation.x = -1.0 * k;
  parts.larm.rotation.z = 0.4 * k;
  parts.rarm.rotation.z = -0.4 * k;
}

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1520 / #1526-1538 — action variety pools (per weapon/cause/
// direction/level/stage/type). Each pool is a named catalog the engine
// samples from when triggering the corresponding animation; the underlying
// animators (animateMelee, animateDeathVariety, etc.) apply the per-variant
// tuning to the rig.
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1520 — melee variety per weapon. */
export const MELEE_VARIETY: Record<string, { swingArc: number; reach: number; durationMs: number; recoveryMs: number }> = {
  knife:          { swingArc: 1.20, reach: 0.90, durationMs: 320, recoveryMs: 280 },
  bayonet:        { swingArc: 0.80, reach: 1.10, durationMs: 380, recoveryMs: 320 },
  buttstock:      { swingArc: 0.60, reach: 0.80, durationMs: 420, recoveryMs: 360 },
  pistol_whip:    { swingArc: 0.90, reach: 0.75, durationMs: 360, recoveryMs: 300 },
};

/** C3-5000 #1526 — death variety per cause. */
export const DEATH_VARIETY: Record<string, { bodyRotation: number; fallDirection: number; limbSplay: number; durationMs: number }> = {
  bullet:      { bodyRotation: 0.30, fallDirection: 0.50, limbSplay: 0.40, durationMs: 850 },
  explosion:   { bodyRotation: 0.90, fallDirection: 0.80, limbSplay: 0.90, durationMs: 1100 },
  fire:        { bodyRotation: 0.50, fallDirection: 0.30, limbSplay: 0.70, durationMs: 1200 },
  headshot:    { bodyRotation: 0.10, fallDirection: 0.90, limbSplay: 0.20, durationMs: 600 },
  melee:       { bodyRotation: 0.70, fallDirection: 0.60, limbSplay: 0.50, durationMs: 900 },
  fall:        { bodyRotation: 0.40, fallDirection: 0.40, limbSplay: 0.80, durationMs: 950 },
};

/** C3-5000 #1527 — hit-react variety per damage direction. */
export const HIT_REACT_VARIETY: Record<string, { spineLean: number; headSnap: number; armFlail: number }> = {
  front:  { spineLean: -0.20, headSnap:  0.10, armFlail: 0.30 },
  back:   { spineLean:  0.25, headSnap: -0.15, armFlail: 0.50 },
  left:   { spineLean:  0.15, headSnap:  0.20, armFlail: 0.40 },
  right:  { spineLean: -0.15, headSnap: -0.20, armFlail: 0.40 },
};

/** C3-5000 #1528 — suppression variety per level. */
export const SUPPRESSION_VARIETY: Record<string, { crouchDip: number; weaponShake: number; breathRate: number }> = {
  light:  { crouchDip: 0.05, weaponShake: 0.10, breathRate: 1.2 },
  medium: { crouchDip: 0.12, weaponShake: 0.25, breathRate: 1.5 },
  heavy:  { crouchDip: 0.22, weaponShake: 0.45, breathRate: 1.9 },
  pinned: { crouchDip: 0.40, weaponShake: 0.70, breathRate: 2.4 },
};

/** C3-5000 #1529 — stun variety per cause. */
export const STUN_VARIETY: Record<string, { bodySway: number; armDrop: number; recoveryMs: number }> = {
  flashbang:  { bodySway: 0.50, armDrop: 0.80, recoveryMs: 4000 },
  concussion: { bodySway: 0.70, armDrop: 0.95, recoveryMs: 6000 },
  melee:      { bodySway: 0.40, armDrop: 0.60, recoveryMs: 2500 },
  taser:      { bodySway: 0.30, armDrop: 1.00, recoveryMs: 3000 },
};

/** C3-5000 #1530 — bleed variety per severity. */
export const BLEED_VARIETY: Record<string, { bodySlump: number; handClutch: number; breathGasp: number }> = {
  minor:    { bodySlump: 0.05, handClutch: 0.10, breathGasp: 0.05 },
  moderate: { bodySlump: 0.15, handClutch: 0.40, breathGasp: 0.20 },
  severe:   { bodySlump: 0.30, handClutch: 0.70, breathGasp: 0.45 },
  critical: { bodySlump: 0.55, handClutch: 0.90, breathGasp: 0.80 },
};

/** C3-5000 #1531 — revive variety per stage. */
export const REVIVE_VARIETY: Record<string, { handReach: number; bodyLean: number; durationMs: number }> = {
  approach: { handReach: 0.20, bodyLean: 0.10, durationMs: 600 },
  cpr:      { handReach: 0.50, bodyLean: 0.40, durationMs: 1500 },
  assist:   { handReach: 0.70, bodyLean: 0.25, durationMs: 900 },
  complete: { handReach: 0.40, bodyLean: 0.05, durationMs: 400 },
};

/** C3-5000 #1532 — capture variety per stage. */
export const CAPTURE_VARIETY: Record<string, { armRaise: number; kneeDrop: number; headTilt: number }> = {
  submit:   { armRaise: 0.95, kneeDrop: 0.00, headTilt: 0.10 },
  restrain: { armRaise: 0.70, kneeDrop: 0.00, headTilt: 0.20 },
  escort:   { armRaise: 0.40, kneeDrop: 0.00, headTilt: 0.05 },
  kneel:    { armRaise: 0.30, kneeDrop: 0.85, headTilt: 0.30 },
};

/** C3-5000 #1533 — hostage variety per stage. */
export const HOSTAGE_VARIETY: Record<string, { armGrip: number; bodyDrag: number; durationMs: number }> = {
  grab:    { armGrip: 0.80, bodyDrag: 0.20, durationMs: 500 },
  carry:   { armGrip: 1.00, bodyDrag: 0.40, durationMs: 0 },
  drop:    { armGrip: 0.40, bodyDrag: 0.80, durationMs: 400 },
  release: { armGrip: 0.10, bodyDrag: 0.00, durationMs: 300 },
};

/** C3-5000 #1534 — breach variety per type. */
export const BREACH_VARIETY: Record<string, { kickArc: number; bodyLunge: number; durationMs: number }> = {
  kick:        { kickArc: 0.80, bodyLunge: 0.40, durationMs: 500 },
  charge:      { kickArc: 0.20, bodyLunge: 0.90, durationMs: 350 },
  shotgun:     { kickArc: 0.10, bodyLunge: 0.30, durationMs: 400 },
  charge_blow: { kickArc: 0.00, bodyLunge: 0.50, durationMs: 600 },
};

/** C3-5000 #1535 — emote variety per type. */
export const EMOTE_VARIETY: Record<string, { armRaise: number; bodyTwist: number; durationMs: number }> = {
  wave:   { armRaise: 0.85, bodyTwist: 0.05, durationMs: 1200 },
  salute: { armRaise: 0.95, bodyTwist: 0.00, durationMs: 1000 },
  taunt:  { armRaise: 0.50, bodyTwist: 0.30, durationMs: 1500 },
  cheer:  { armRaise: 1.00, bodyTwist: 0.20, durationMs: 1800 },
  point:  { armRaise: 0.80, bodyTwist: 0.10, durationMs: 900 },
};

/** C3-5000 #1536 — victory variety per type. */
export const VICTORY_VARIETY: Record<string, { armRaise: number; jumpHeight: number; durationMs: number }> = {
  fist_pump: { armRaise: 0.95, jumpHeight: 0.00, durationMs: 1500 },
  flag:      { armRaise: 1.00, jumpHeight: 0.00, durationMs: 2500 },
  cluster:   { armRaise: 0.90, jumpHeight: 0.10, durationMs: 2200 },
  solo:      { armRaise: 0.70, jumpHeight: 0.05, durationMs: 1800 },
};

/** C3-5000 #1537 — defeat variety per type. */
export const DEFEAT_VARIETY: Record<string, { bodySlump: number; kneeDrop: number; durationMs: number }> = {
  kneel:     { bodySlump: 0.30, kneeDrop: 0.80, durationMs: 1800 },
  faceplant: { bodySlump: 0.95, kneeDrop: 0.50, durationMs: 1500 },
  slump:     { bodySlump: 0.60, kneeDrop: 0.20, durationMs: 2000 },
  walk_off:  { bodySlump: 0.20, kneeDrop: 0.00, durationMs: 3000 },
};

/** C3-5000 #1538 — celebration variety per type (multi-kill tiers + clutch). */
export const CELEBRATION_VARIETY: Record<string, { intensity: number; armRaise: number; durationMs: number }> = {
  double:  { intensity: 0.40, armRaise: 0.70, durationMs: 1200 },
  triple:  { intensity: 0.60, armRaise: 0.85, durationMs: 1600 },
  mvp:     { intensity: 0.80, armRaise: 1.00, durationMs: 2200 },
  ace:     { intensity: 1.00, armRaise: 1.00, durationMs: 2800 },
  clutch:  { intensity: 0.90, armRaise: 0.95, durationMs: 2500 },
};

// ═══════════════════════════════════════════════════════════════════════════
// C3-5000 #1547 / #1548 — per-clip scale + offset tuning
// ═══════════════════════════════════════════════════════════════════════════

/** C3-5000 #1547 — per-clip global scale multiplier (1.0 = native). */
export const CLIP_SCALE_TABLE: Record<string, number> = {
  idle: 1.0, walk: 1.0, run: 1.0, sprint: 1.0,
  crouch: 0.95, prone: 0.85, jump: 1.0, land: 1.0,
  melee: 1.05, death: 1.0, emote: 1.0,
};

/** C3-5000 #1548 — per-clip time offset (seconds to advance/delay clip start). */
export const CLIP_OFFSET_TABLE: Record<string, number> = {
  idle: 0.0, walk: 0.0, run: 0.0, sprint: 0.0,
  crouch: 0.02, prone: 0.05, jump: 0.0, land: 0.0,
  melee: 0.04, death: 0.0, emote: 0.0,
};
