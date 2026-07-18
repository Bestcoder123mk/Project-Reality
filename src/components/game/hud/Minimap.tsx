"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Minimap — circular top-down radar that plots enemies (red dots),
 * teammates (blue dots), objective (yellow diamond), and the player
 * (white arrow with FOV cone).
 *
 * Pulls live positions from the engine via a ref callback registered
 * on `window.__PR_MINIMAP_DATA__`. The engine writes enemy positions
 * there each frame (cheap, no React re-render).
 */
export interface MinimapBlip {
  x: number;
  z: number;
  /** Prompt J-4045 — added `teammate` + `ally` blip kinds. The previous
   *  type only allowed `enemy` | `objective`, so teammates never appeared
   *  on the radar even when the engine knew their positions. */
  kind: "enemy" | "objective" | "teammate" | "ally";
}

export interface MinimapData {
  playerX: number;
  playerZ: number;
  playerYaw: number;
  blips: MinimapBlip[];
}

// J-5000-retry — the `__PR_MINIMAP_DATA__` global is declared in
// `src/lib/game/systems/HudSystem.ts` (the engine side that writes
// the data each frame). That declaration uses a NARROWER blip kind
// (`"enemy" | "objective"`) than MinimapData (which adds `"teammate"
// | "ally"` per J-4045). TS merges global Window declarations and
// rejects subsequent declarations with a different type, so we
// DON'T re-declare it here — we cast at the read site instead. The
// wide MinimapData type stays so the renderer is ready for the day
// HudSystem widens its write-side type to include teammates/ allies
// (J-4046 is the prompt that wires the engine to actually emit them).

const MAP_RADIUS = 44; // matches the 43-unit spawn bounds + 1m padding
// Prompt J-4044 — minimap size now configurable. The previous 140px hardcode
// didn't scale on ultrawide displays (where 140px is tiny) or on small mobile
// screens (where 140px is huge). Callers can now pass a size; the default
// stays 140px for backward compat.
const DEFAULT_MINIMAP_PX = 140;

export function Minimap({ sizePx = DEFAULT_MINIMAP_PX }: { sizePx?: number } = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<MinimapData>({
    playerX: 0,
    playerZ: 18,
    playerYaw: Math.PI,
    blips: [],
  });

  // Sample window data each frame via rAF — no React state, no re-renders.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      // J-5000-retry — cast the window global to MinimapData (wide type
      // with teammate/ally) even though HudSystem.ts declares it with a
      // narrower blip kind. The engine only writes enemy/objective
      // today; the cast lets the renderer stay ready for J-4046.
      const data = (window.__PR_MINIMAP_DATA__ as MinimapData | undefined) ?? dataRef.current;
      dataRef.current = data;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const r = w / 2 - 2;
      ctx.clearRect(0, 0, w, h);

      // Background — dark tactical green/black
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      bg.addColorStop(0, "rgba(20,30,28,0.85)");
      bg.addColorStop(1, "rgba(8,12,14,0.95)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Grid lines
      ctx.strokeStyle = "rgba(120,180,160,0.12)";
      ctx.lineWidth = 1;
      for (let i = -3; i <= 3; i++) {
        const off = (i / 3) * r;
        ctx.beginPath();
        ctx.moveTo(cx - r, cy + off);
        ctx.lineTo(cx + r, cy + off);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + off, cy - r);
        ctx.lineTo(cx + off, cy + r);
        ctx.stroke();
      }
      // Crosshair
      ctx.strokeStyle = "rgba(120,180,160,0.25)";
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r);
      ctx.moveTo(cx - r, cy);
      ctx.lineTo(cx + r, cy);
      ctx.stroke();

      // Range rings
      ctx.strokeStyle = "rgba(120,180,160,0.15)";
      for (let i = 1; i <= 3; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (r * i) / 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // World → minimap transform: rotate so player faces up.
      const yaw = data.playerYaw;
      const cos = Math.cos(-yaw);
      const sin = Math.sin(-yaw);
      const worldToMap = (wx: number, wz: number): [number, number] => {
        const dx = wx - data.playerX;
        const dz = wz - data.playerZ;
        const rx = dx * cos - dz * sin;
        const rz = dx * sin + dz * cos;
        const scale = r / MAP_RADIUS;
        return [cx + rx * scale, cy + rz * scale];
      };

      // Blips
      for (const b of data.blips) {
        const [bx, by] = worldToMap(b.x, b.z);
        // Skip blips outside the visible circle.
        if ((bx - cx) ** 2 + (by - cy) ** 2 > r * r) continue;
        if (b.kind === "enemy") {
          ctx.fillStyle = "#f87171";
          ctx.beginPath();
          ctx.arc(bx, by, 2.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(248,113,113,0.35)";
          ctx.beginPath();
          ctx.arc(bx, by, 4.5, 0, Math.PI * 2);
          ctx.stroke();
        } else if (b.kind === "objective") {
          ctx.fillStyle = "#fbbf24";
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(Math.PI / 4);
          ctx.fillRect(-3, -3, 6, 6);
          ctx.restore();
        } else if (b.kind === "teammate" || b.kind === "ally") {
          // Prompt J-4045 — teammates render as small blue squares with a
          // faint halo (distinct from enemies' red dots + objective's
          // yellow diamond). `teammate` is a same-squad mate; `ally` is a
          // broader friendly (different blue shade to disambiguate).
          const isMate = b.kind === "teammate";
          ctx.fillStyle = isMate ? "#60a5fa" : "#3b82f6";
          ctx.save();
          ctx.translate(bx, by);
          ctx.fillRect(-2.2, -2.2, 4.4, 4.4);
          ctx.restore();
          ctx.strokeStyle = isMate ? "rgba(96,165,250,0.35)" : "rgba(59,130,246,0.3)";
          ctx.beginPath();
          ctx.arc(bx, by, 4.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Player FOV cone
      const fovHalf = THREE.MathUtils.degToRad(38);
      const coneLen = r * 0.62;
      const coneGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coneLen);
      coneGrad.addColorStop(0, "rgba(220,255,240,0.28)");
      coneGrad.addColorStop(1, "rgba(220,255,240,0)");
      ctx.fillStyle = coneGrad;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, coneLen, -Math.PI / 2 - fovHalf, -Math.PI / 2 + fovHalf);
      ctx.closePath();
      ctx.fill();

      // Player arrow (always points up)
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx - 4, cy + 4);
      ctx.lineTo(cx, cy + 1);
      ctx.lineTo(cx + 4, cy + 4);
      ctx.closePath();
      ctx.fill();

      ctx.restore();

      // Outer ring
      ctx.strokeStyle = "rgba(120,180,160,0.55)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // Tick marks at N/E/S/W
      ctx.strokeStyle = "rgba(180,220,200,0.7)";
      ctx.lineWidth = 1.5;
      for (let a = 0; a < 4; a++) {
        const ang = (a * Math.PI) / 2 - Math.PI / 2;
        const x1 = cx + Math.cos(ang) * (r - 4);
        const y1 = cy + Math.sin(ang) * (r - 4);
        const x2 = cx + Math.cos(ang) * r;
        const y2 = cy + Math.sin(ang) * r;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className="hud-glass relative rounded-full"
      style={{ width: sizePx, height: sizePx }}
      aria-label="Tactical minimap"
    >
      <canvas
        ref={canvasRef}
        width={sizePx * 2}
        height={sizePx * 2}
        style={{ width: sizePx, height: sizePx, borderRadius: "50%" }}
      />
      {/* Cardinal letters */}
      <span className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 text-[8px] font-bold text-emerald-200/70">N</span>
      <span className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-[8px] font-bold text-emerald-200/40">E</span>
      <span className="pointer-events-none absolute left-1/2 bottom-1 -translate-x-1/2 text-[8px] font-bold text-emerald-200/40">S</span>
      <span className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-[8px] font-bold text-emerald-200/40">W</span>
    </div>
  );
}
