"use client";

import { useEffect, useRef, useState } from "react";

/**
 * V2.3 — Enemy-spotted nameplate.
 *
 * Renders an on-spot nameplate + segmented health bar above any enemy that is
 * either (a) currently near the crosshair or (b) was damaged in the last ~2s.
 * Fades ~2s after last contact.
 *
 * Reads `window.__PR_NAMEPLATES__` + `window.__PR_CAMERA_BASIS__` (published by
 * HudSystem each frame) and projects each enemy's world position to screen
 * using a manual perspective projection (no matrix overhead in React land).
 * Only renders the single best crosshair target + any recently-damaged enemies.
 */

interface ProjectedNameplate {
  id: number;
  screenX: number; // 0..1 (fraction of viewport width)
  screenY: number; // 0..1
  depth: number;   // meters
  health: number;
  maxHealth: number;
  className: string;
  opacity: number; // 0..1 fade
  isTarget: boolean;
}

export function EnemyNameplate() {
  const [plates, setPlates] = useState<ProjectedNameplate[]>([]);
  const rafRef = useRef<number>(0);
  const sizeRef = useRef({ w: 1, h: 1 });
  const hasPlatesRef = useRef(false);

  useEffect(() => {
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const np = window.__PR_NAMEPLATES__;
      const basis = window.__PR_CAMERA_BASIS__;
      if (!np || !basis) {
        if (hasPlatesRef.current) {
          setPlates([]);
          hasPlatesRef.current = false;
        }
        return;
      }
      const now = performance.now();
      const { w, h } = sizeRef.current;

      // Build the camera "up" from forward × right.
      const f = basis.forward;
      const r = basis.right;
      // up = forward × right (left-handed) — but for screen-space we want the
      // vertical axis. Compute up = normalize(cross(right, forward)).
      const upx = r.y * f.z - r.z * f.y;
      const upy = r.z * f.x - r.x * f.z;
      const upz = r.x * f.y - r.y * f.x;
      const upLen = Math.hypot(upx, upy, upz) || 1;
      const up = { x: upx / upLen, y: upy / upLen, z: upz / upLen };

      const fovRad = (basis.fov * Math.PI) / 180;
      const tanHalfFov = Math.tan(fovRad / 2);

      const projected: ProjectedNameplate[] = [];
      let bestTarget: ProjectedNameplate | null = null;
      let bestTargetScore = -Infinity;

      for (let i = 0; i < np.length; i++) {
        const e = np[i];
        // Vector from camera to enemy.
        const dx = e.x - basis.pos.x;
        const dy = e.y - basis.pos.y;
        const dz = e.z - basis.pos.z;
        // Depth along camera forward.
        const depth = dx * f.x + dy * f.y + dz * f.z;
        if (depth < 0.5 || depth > 80) continue; // behind camera or too far
        // Right + up components.
        const rx = dx * r.x + dy * r.y + dz * r.z;
        const uy = dx * up.x + dy * up.y + dz * up.z;
        // Normalized screen coords ([-1, 1] in x, [-1,1] in y but y inverted).
        const nx = rx / (depth * tanHalfFov * basis.aspect);
        const ny = uy / (depth * tanHalfFov);
        // Skip if well outside the screen.
        if (Math.abs(nx) > 1.4 || Math.abs(ny) > 1.4) continue;

        // Crosshair proximity: how close to center (0,0)?
        const distFromCenter = Math.hypot(nx, ny);
        const isTargetCandidate = distFromCenter < 0.08; // within ~8% of center

        // Fade: recently-damaged enemies stay visible 2s; crosshair target is full.
        const sinceDmg = now - e.lastDamaged;
        let opacity = 0;
        if (isTargetCandidate) opacity = 1;
        else if (e.recent) opacity = Math.max(0, 1 - sinceDmg / 2000);

        if (opacity <= 0.01) continue;

        const plate: ProjectedNameplate = {
          id: i,
          screenX: (nx + 1) / 2,
          screenY: (1 - ny) / 2, // invert y
          depth,
          health: e.health,
          maxHealth: e.maxHealth,
          className: e.className,
          opacity,
          isTarget: false,
        };

        if (isTargetCandidate && -distFromCenter > bestTargetScore) {
          bestTargetScore = -distFromCenter;
          bestTarget = plate;
        } else {
          projected.push(plate);
        }
      }

      if (bestTarget) {
        bestTarget.isTarget = true;
        bestTarget.opacity = 1;
        projected.unshift(bestTarget);
      }

      // Prompt J-4042 — priority sort instead of plain slice(0, 4).
      // The previous code took the first 4 plates in iteration order
      // (enemy index), which meant a recently-shot enemy at index 30
      // could be evicted by a never-shot enemy at index 0. Now we sort:
      //   1. crosshair target (always first)
      //   2. recently-damaged (most recent first)
      //   3. closest by depth (nearest first)
      // This way the 4 visible nameplates are always the 4 most relevant.
      const sorted = projected.sort((a, b) => {
        // Crosshair target always wins.
        if (a.isTarget !== b.isTarget) return a.isTarget ? -1 : 1;
        // Then most-recently-damaged (read from the original nameplate
        // list — the plate's `id` mirrors the enemy index).
        const aDamaged = np[a.id]?.lastDamaged ?? 0;
        const bDamaged = np[b.id]?.lastDamaged ?? 0;
        if (aDamaged !== bDamaged) return bDamaged - aDamaged;
        // Then closest by depth.
        return a.depth - b.depth;
      });
      const next = sorted.slice(0, 4);
      setPlates(next);
      hasPlatesRef.current = next.length > 0;
    };
    rafRef.current = requestAnimationFrame(tick);

    const onResize = () => {
      sizeRef.current = { w: window.innerWidth, h: window.innerHeight };
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  if (!plates.length) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 select-none">
      {plates.map((p) => {
        const hpPct = Math.max(0, Math.min(1, p.health / p.maxHealth));
        const segments = 4;
        const filled = Math.ceil(hpPct * segments);
        return (
          <div
            key={p.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150"
            style={{
              left: `${p.screenX * 100}%`,
              top: `${p.screenY * 100}%`,
              opacity: p.opacity,
            }}
          >
            <div className={`flex flex-col items-center gap-px ${p.isTarget ? "" : "scale-[0.72]"}`}>
              {/* Nameplate label — compact, single line */}
              <div
                className={`flex items-center gap-1 px-1 py-px ${p.isTarget ? "border border-amber-400/60" : "border border-white/10"}`}
                style={{ background: "rgba(12,14,10,0.78)", borderRadius: "2px" }}
              >
                <span
                  className={`font-mono font-bold leading-none ${p.isTarget ? "text-[8px] text-amber-300" : "text-[7px] text-white/65"}`}
                  style={{ letterSpacing: "0.04em" }}
                >
                  {p.className}
                </span>
                <span className="font-mono text-[6px] leading-none text-white/35">
                  {p.depth.toFixed(0)}m
                </span>
              </div>
              {/* Segmented health bar — thin pips */}
              <div className="flex gap-px">
                {Array.from({ length: segments }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-[2px] w-[5px] ${
                      i < filled
                        ? hpPct > 0.5
                          ? "bg-emerald-400"
                          : hpPct > 0.25
                            ? "bg-amber-400"
                            : "bg-rose-500"
                        : "bg-white/15"
                    } ${p.isTarget ? "shadow-[0_0_3px_currentColor]" : ""}`}
                  />
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
