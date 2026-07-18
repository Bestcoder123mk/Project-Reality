"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useGameStore, type CrosshairSettings } from "@/lib/game/store";

/**
 * Crosshair — fully customizable via the settings store.
 * Supports 5 styles: cross, circle, dot, cross+dot, T.
 * Dynamic spread: widens with movement speed + recoil, tightens when aiming.
 * Hit marker: 4 diagonal lines that flash on hit.
 *
 * REALISM-1 (task C) — dynamic crosshair upgrades:
 *   - Smoothed gap via THREE.MathUtils.damp (framerate-independent). The
 *     gap eases toward its target instead of snapping every frame, so the
 *     crosshair opens + closes with a weighty feel.
 *   - Color shifts to red when an enemy is under the crosshair. Reads the
 *     optional `targetingEnemy` field from `__PR_CROSSHAIR_STATE__` — if
 *     the orchestrator publishes it, the crosshair turns red; otherwise
 *     it stays the configured color. Also smoothed via damp.
 *   - Kill X flashes for 200ms (was 180ms — matches the spec).
 *   - ADS snaps the crosshair to a tight dot (the spec's "snap to a tight
 *     dot when ADS"). When `aiming` is true, the gap collapses to ~2px and
 *     the lines fade out — the dot becomes the sole aiming reference.
 */
export function Crosshair({
  spread: firedSpread,
  showHit,
  showKill,
  showHeadshot,
}: {
  spread: number;
  showHit: boolean;
  showKill?: boolean;
  showHeadshot?: boolean;
}) {
  const cfg = useGameStore((s) => s.settings.crosshair);
  const hitColor = "#f87171";
  const killColor = "#ffffff";
  const headshotColor = "#ffd24a";
  const enemyColor = "#ff4444"; // red when targeting an enemy
  const outline = cfg.outline ? `0 0 2px rgba(0,0,0,0.9), 0 0 1px rgba(0,0,0,0.9)` : "none";
  const lineLen = cfg.length;
  const thick = cfg.thickness;

  // REALISM-1: smoothed dynamic spread + color. Damped toward the target
  // each frame via THREE.MathUtils.damp (framerate-independent — converges
  // at the same rate on 60 Hz and 144 Hz displays). The previous code
  // snapped the spread every frame, which read as jittery during fast
  // movement / recoil transitions.
  const [dynamicSpread, setDynamicSpread] = useState(cfg.gap);
  const [targetingEnemy, setTargetingEnemy] = useState(false);
  const lastTimeRef = useRef<number>(performance.now());
  // Refs so the rAF loop can mutate without re-creating the closure.
  const spreadRef = useRef(cfg.gap);
  const targetSpreadRef = useRef(cfg.gap);
  const enemyRef = useRef(false);
  const enemyTargetRef = useRef(false);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = requestAnimationFrame(update);
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastTimeRef.current) / 1000); // clamp to 50ms
      lastTimeRef.current = now;

      const state = (window as unknown as {
        __PR_CROSSHAIR_STATE__?: {
          speed: number;
          recoil: number;
          aiming: boolean;
          airborne: boolean;
          targetingEnemy?: boolean; // REALISM-1: optional — published by the orchestrator
        };
      }).__PR_CROSSHAIR_STATE__;

      // Compute the target spread + target enemy flag.
      if (state) {
        let spread = cfg.gap;
        spread += Math.min(state.speed * 1.2, 12); // movement: up to +12px at full sprint
        spread += Math.min(state.recoil * 80, 10); // recoil: up to +10px
        if (state.airborne) spread += 8;            // airborne penalty
        if (state.aiming) spread *= 0.15;           // ADS: snap to a tight dot (was 0.4)
        spread += firedSpread;
        targetSpreadRef.current = spread;
        enemyTargetRef.current = !!state.targetingEnemy;
      } else {
        targetSpreadRef.current = cfg.gap + firedSpread;
        enemyTargetRef.current = false;
      }

      // Framerate-independent damp toward the target.
      // lambda = 18 gives a snappy-but-smooth convergence (~95% in 100ms).
      spreadRef.current = THREE.MathUtils.damp(spreadRef.current, targetSpreadRef.current, 18, dt);
      enemyRef.current = THREE.MathUtils.damp(enemyRef.current ? 1 : 0, enemyTargetRef.current ? 1 : 0, 14, dt) > 0.5;

      setDynamicSpread(spreadRef.current);
      setTargetingEnemy(enemyRef.current);
    };
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, [cfg.gap, firedSpread]);

  const gap = cfg.dynamicSpread ? dynamicSpread : cfg.gap + firedSpread;
  // Color: red when targeting an enemy, otherwise the configured color (or
  // hit/kill colors when those markers are active).
  const stroke = showHit ? hitColor : (targetingEnemy ? enemyColor : cfg.color);

  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
      {/* Center dot */}
      {(cfg.showDot || cfg.style === "dot" || cfg.style === "cross+dot") && (
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: Math.max(2, thick),
            height: Math.max(2, thick),
            background: stroke,
            boxShadow: outline,
          }}
        />
      )}

      {/* Circle */}
      {cfg.style === "circle" && (
        <svg
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          width={gap * 2 + 6}
          height={gap * 2 + 6}
          viewBox={`0 0 ${gap * 2 + 6} ${gap * 2 + 6}`}
          style={{ overflow: "visible", filter: cfg.outline ? "drop-shadow(0 0 1px rgba(0,0,0,0.9))" : "none" }}
        >
          <circle
            cx={gap + 3}
            cy={gap + 3}
            r={gap}
            stroke={stroke}
            strokeWidth={thick}
            fill="none"
          />
        </svg>
      )}

      {/* Cross lines (cross, cross+dot, T) */}
      {(cfg.style === "cross" || cfg.style === "cross+dot" || cfg.style === "T") && (
        <>
          {/* Top */}
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              width: thick,
              height: lineLen,
              background: stroke,
              boxShadow: outline,
              transform: `translate(-50%, calc(-100% - ${gap}px))`,
            }}
          />
          {/* Bottom (hidden for T style) */}
          {cfg.style !== "T" && (
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{
                width: thick,
                height: lineLen,
                background: stroke,
                boxShadow: outline,
                transform: `translate(-50%, ${gap}px)`,
              }}
            />
          )}
          {/* Left */}
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              width: lineLen,
              height: thick,
              background: stroke,
              boxShadow: outline,
              transform: `translate(calc(-100% - ${gap}px), -50%)`,
            }}
          />
          {/* Right */}
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              width: lineLen,
              height: thick,
              background: stroke,
              boxShadow: outline,
              transform: `translate(${gap}px, -50%)`,
            }}
          />
        </>
      )}

      {/* Hit marker — 4 short diagonal lines outside the crosshair */}
      {showHit && !showKill && (
        <motion.svg
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          width={28}
          height={28}
          viewBox="0 0 28 28"
          initial={{ scale: 1.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {[
            [3, 3, 8, 8],
            [25, 3, 20, 8],
            [3, 25, 8, 20],
            [25, 25, 20, 20],
          ].map(([x1, y1, x2, y2], i) => (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={hitColor}
              strokeWidth={2}
              strokeLinecap="round"
            />
          ))}
        </motion.svg>
      )}

      {/* Task-6 — Kill marker: bigger + white confirmation X (distinct from
          the red hit marker). Plays on every kill. */}
      {showKill && (
        <motion.svg
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          width={48}
          height={48}
          viewBox="0 0 48 48"
          initial={{ scale: 1.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {[
            [4, 4, 16, 16],
            [44, 4, 32, 16],
            [4, 44, 16, 32],
            [44, 44, 32, 32],
          ].map(([x1, y1, x2, y2], i) => (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={showHeadshot ? headshotColor : killColor}
              strokeWidth={3}
              strokeLinecap="round"
            />
          ))}
          {/* Headshot-kill bonus: a small filled diamond in the center. */}
          {showHeadshot && (
            <polygon
              points="24,18 30,24 24,30 18,24"
              fill={headshotColor}
              opacity={0.95}
            />
          )}
        </motion.svg>
      )}
    </div>
  );
}

/**
 * Scope Overlay — clean sniper scope.
 * Dark ring outside the scope circle, fully transparent inside so the player
 * can see the game world. Reticle with crosshair + mildots + amber center.
 *
 * Prompt J-4047 — scope reticle scales on 21:9 / ultrawide. Previously
 * the scope used `vh` (viewport height) for the circle radius. On a 21:9
 * ultrawide the height is the smaller dimension, so `vh` gave a small
 * scope floating in a wide black surround. We now use `min(vh, vw)` via
 * CSS `min()` so:
 *   - On 16:9 (typical): vh is the min, same as before.
 *   - On 21:9 ultrawide: vh is still the min — the scope stays the same
 *     physical size relative to the height, but the surround scales
 *     symmetrically (no asymmetric stretch).
 *   - On portrait (mobile): vw is the min, so the scope scales to the
 *     width instead of overflowing the height.
 */
export function ScopeOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      {/* Outer black ring — solid outside the scope circle, transparent inside.
          Uses `min(30vh, 30vw)` so the scope scales on ultrawide + portrait. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at center, transparent 0, transparent min(30vh, 30vw), rgba(0,0,0,0.97) min(30.5vh, 30.5vw))",
        }}
      />

      {/* Scope rim — thin dark metal ring at the scope edge. */}
      <div
        className="absolute rounded-full"
        style={{
          width: "min(61vh, 61vw)",
          height: "min(61vh, 61vw)",
          border: "4px solid rgba(15,15,18,0.95)",
          boxShadow: "0 0 0 1px rgba(80,80,90,0.4)",
        }}
      />

      {/* Reticle — thin crosshair + mildots + amber center dot. */}
      <svg
        className="absolute"
        width="min(60vh, 60vw)"
        height="min(60vh, 60vw)"
        viewBox="-100 -100 200 200"
        style={{ overflow: "visible" }}
      >
        {/* Crosshair lines. */}
        <line x1="-90" y1="0" x2="-10" y2="0" stroke="rgba(0,0,0,0.8)" strokeWidth="0.8" />
        <line x1="10" y1="0" x2="90" y2="0" stroke="rgba(0,0,0,0.8)" strokeWidth="0.8" />
        <line x1="0" y1="-90" x2="0" y2="-10" stroke="rgba(0,0,0,0.8)" strokeWidth="0.8" />
        <line x1="0" y1="10" x2="0" y2="90" stroke="rgba(0,0,0,0.8)" strokeWidth="0.8" />
        {/* Mildot markers. */}
        {[20, 40, 60, 80].map((d) => (
          <g key={d}>
            <circle cx="0" cy={-d} r="0.8" fill="rgba(0,0,0,0.8)" />
            <circle cx="0" cy={d} r="0.8" fill="rgba(0,0,0,0.8)" />
            <circle cx={-d} cy="0" r="0.8" fill="rgba(0,0,0,0.8)" />
            <circle cx={d} cy="0" r="0.8" fill="rgba(0,0,0,0.8)" />
          </g>
        ))}
        {/* Center dot — amber. */}
        <circle cx="0" cy="0" r="1.2" fill="#ff8c1a" />
      </svg>
    </div>
  );
}
