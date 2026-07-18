"use client";

import { useEffect, useRef, useState } from "react";

/**
 * DamageNumbers — floating damage numbers that appear at the 3D hit point,
 * animate upward with slight jitter, and fade out over ~0.7s.
 *
 * Reads `window.__PR_DAMAGE_NUMBERS__` (published by EnemySystem.damageEnemy)
 * via rAF polling — same pattern as Minimap. Projects 3D world positions to
 * screen space using `window.__PR_CAMERA_BASIS__` (published by HudSystem).
 *
 * Headshots: bigger + gold. Kills: red "ELIMINATED" tag. Rapid multi-hit
 * (shotgun/LMG) offsets spawn position with jitter so numbers don't pile up.
 */
interface DamageNumberItem {
  id: number;
  x: number; y: number; z: number;
  damage: number;
  headshot: boolean;
  kill: boolean;
  time: number;
}

interface RenderedNumber {
  id: number;
  screenX: number;
  screenY: number;
  damage: number;
  headshot: boolean;
  kill: boolean;
  age: number;
  jitterX: number;
}

const DURATION = 700; // ms
const MAX_AGE = 800;

export function DamageNumbers() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [numbers, setNumbers] = useState<RenderedNumber[]>([]);
  const seenIds = useRef<Set<number>>(new Set());
  const jitterMap = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const data = window.__PR_DAMAGE_NUMBERS__;
      const cam = window.__PR_CAMERA_BASIS__;
      if (!data || !cam) return;

      const now = performance.now();
      const w = window.innerWidth;
      const h = window.innerHeight;
      const cx = w / 2;
      const cy = h / 2;

      // Camera basis (published by HudSystem.syncTactical).
      const camPos = cam.pos;
      const fwd = cam.forward;
      const right = cam.right;
      const fov = cam.fov;
      const aspect = cam.aspect;

      // Focal length from FOV (perspective projection).
      const focal = (h / 2) / Math.tan((fov * Math.PI) / 360);

      const next: RenderedNumber[] = [];

      for (const item of data.items) {
        const age = now - item.time;
        if (age > MAX_AGE) continue;

        // World-space offset from camera.
        const dx = item.x - camPos.x;
        const dy = item.y - camPos.y;
        const dz = item.z - camPos.z;

        // Project onto camera axes.
        const camRight = dx * right.x + dy * right.y + dz * right.z;
        const camUp = -(dx * 0 + dy * 1 + dz * 0); // world up is +y
        const camForward = dx * fwd.x + dy * fwd.y + dz * fwd.z;

        // Behind camera? skip.
        if (camForward < 0.3) continue;

        // Screen position.
        const sx = cx + (camRight / camForward) * focal;
        const sy = cy - (camUp / camForward) * focal * (aspect > 1 ? 1 : aspect);

        // Per-id jitter so stacked hits don't overlap.
        let jx = jitterMap.current.get(item.id);
        if (jx === undefined) {
          jx = (Math.random() - 0.5) * 60;
          jitterMap.current.set(item.id, jx);
        }

      // Prompt J-4041 — aggregate nearby hits into a stacked number.
      // Hits to the same enemy within 40px screen distance + 150ms time
      // window stack: the existing number's damage is summed + its age
      // is reset so the player sees "75" instead of three "25"s piling up.
      // We do this by reading the existing `next` array for a matching
      // entry + updating it in place.
      const STACK_DIST_PX = 40;
      const STACK_AGE_MS = 150;

      // Check if this item should stack onto an existing entry.
      let stacked = false;
      for (const existing of next) {
        if (existing.id === item.id) continue; // same id = same hit, skip
        const dx = existing.screenX - (sx + jx);
        const dy = existing.screenY - (sy - (age / DURATION) * 50);
        const distSq = dx * dx + dy * dy;
        if (distSq > STACK_DIST_PX * STACK_DIST_PX) continue;
        // The existing entry's age must be recent enough to stack.
        if (existing.age > STACK_AGE_MS) continue;
        // Stack: replace the existing entry with the aggregated one.
        // We mutate `next` in place — safe because we break immediately.
        const idx = next.indexOf(existing);
        if (idx >= 0) {
          next[idx] = {
            ...existing,
            // Sum damage (use the higher of the two values for kill items
            // since kills already show "ELIMINATED").
            damage: existing.kill || item.kill ? existing.damage : existing.damage + item.damage,
            age: 0, // reset age so the stacked number lives a full DURATION
            headshot: existing.headshot || item.headshot,
            kill: existing.kill || item.kill,
          };
          stacked = true;
        }
        break;
      }
      if (stacked) continue;

      next.push({
        id: item.id,
        screenX: sx + jx,
        screenY: sy - (age / DURATION) * 50, // float upward
        damage: item.damage,
        headshot: item.headshot,
        kill: item.kill,
        age,
        jitterX: jx,
      });
    }

      // Clean up old jitter entries.
      if (jitterMap.current.size > 200) {
        const liveIds = new Set(data.items.map((i) => i.id));
        for (const k of jitterMap.current.keys()) {
          if (!liveIds.has(k)) jitterMap.current.delete(k);
        }
      }

      setNumbers(next);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={containerRef}
      className="pointer-events-none fixed inset-0 z-[60]"
      style={{ overflow: "hidden" }}
    >
      {numbers.map((n) => {
        const t = n.age / DURATION;
        const opacity = t < 0.1 ? t * 10 : 1 - (t - 0.1) / 0.9;
        const scale = n.headshot ? 1.4 + (1 - t) * 0.3 : 1.0 + (1 - t) * 0.15;
        const color = n.kill
          ? "#ef4444"
          : n.headshot
          ? "#fbbf24"
          : "#ffffff";
        const text = n.kill ? "ELIMINATED" : `${n.damage}`;
        const size = n.kill ? 16 : n.headshot ? 26 : 20;
        return (
          <div
            key={n.id}
            className="absolute font-black select-none"
            style={{
              left: `${n.screenX}px`,
              top: `${n.screenY}px`,
              transform: `translate(-50%, -50%) scale(${scale})`,
              opacity: Math.max(0, opacity),
              color,
              fontSize: `${size}px`,
              textShadow: n.headshot
                ? "0 0 8px rgba(251,191,36,0.8), 0 2px 4px rgba(0,0,0,0.9)"
                : "0 2px 4px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9)",
              fontFamily: "ui-monospace, 'SF Mono', monospace",
              letterSpacing: n.kill ? "0.1em" : "0",
              transition: "none",
            }}
          >
            {text}
            {n.headshot && !n.kill && (
              <span style={{ fontSize: "10px", display: "block", lineHeight: 1 }}>
                CRIT
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
