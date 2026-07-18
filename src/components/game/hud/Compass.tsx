"use client";

import { useEffect, useRef } from "react";

/**
 * Prompt J-4030 / J-4124 / J-4196 — top-center compass strip.
 *
 * A horizontal tape that scrolls left/right as the player turns,
 * showing cardinal (N/E/S/W) + intercardinal (NE/SE/SW/NW) ticks +
 * degree markings. The player's current heading is fixed at the
 * center reticle; the tape moves under it.
 *
 * Reads `window.__PR_MINIMAP_DATA__.playerYaw` (already published
 * each frame by HudSystem for the minimap) so there's no extra
 * engine wiring + no React re-render cost — the canvas redraws on
 * rAF. The yaw convention matches the minimap: 0 = facing +z
 * (south on the map), +π/2 = facing +x (east). We convert to a
 * compass bearing (0° = N, 90° = E) for the tick labels.
 *
 * The strip is 360° wide; we render ±90° around the current heading
 * (180° total) so the player sees what's ahead + a bit to each side.
 */

// Compass bearings for the 8 cardinal/intercardinal directions, in degrees.
const CARDINALS: { deg: number; label: string }[] = [
  { deg: 0, label: "N" },
  { deg: 45, label: "NE" },
  { deg: 90, label: "E" },
  { deg: 135, label: "SE" },
  { deg: 180, label: "S" },
  { deg: 225, label: "SW" },
  { deg: 270, label: "W" },
  { deg: 315, label: "NW" },
];

const STRIP_WIDTH_PX = 360; // visible strip width
const PX_PER_DEG = STRIP_WIDTH_PX / 180; // 180° visible → 2px/deg

export function Compass() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // Read the player's yaw from the minimap data global (cast
      // per J-5000-retry: HudSystem declares a narrower blip kind
      // than MinimapData, but the playerYaw field is identical).
      const data = (
        window as unknown as {
          __PR_MINIMAP_DATA__?: { playerYaw?: number };
        }
      ).__PR_MINIMAP_DATA__;
      const yaw = data?.playerYaw ?? Math.PI;

      // Convert yaw (radians, 0 = +z/south, +π/2 = +x/east) to a
      // compass bearing (0° = N, 90° = E, 180° = S, 270° = W).
      // World: +z = south (180°), +x = east (90°).
      // bearing = (90° * sin(yaw) ... actually let's derive:
      //   yaw=0 → facing +z → south → bearing 180°.
      //   yaw=π/2 → facing +x → east → bearing 90°.
      //   yaw=π → facing -z → north → bearing 0°.
      //   yaw=-π/2 → facing -x → west → bearing 270°.
      // So bearing = (180 - yawInDeg) mod 360 where yawInDeg = yaw*180/π.
      const yawDeg = (yaw * 180) / Math.PI;
      let bearing = (180 - yawDeg) % 360;
      if (bearing < 0) bearing += 360;

      const cx = w / 2;
      // Draw the tape: ticks every 15°, labels every 45°.
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Render ±90° around the current bearing.
      const range = 90;
      for (let off = -range; off <= range; off += 5) {
        const tickDeg = (((bearing + off) % 360) + 360) % 360;
        const x = cx + off * PX_PER_DEG;
        if (x < 0 || x > w) continue;
        const isCardinal = CARDINALS.some((c) => c.deg === tickDeg);
        const isMajor = tickDeg % 45 === 0;
        const isMinor = tickDeg % 15 === 0;
        if (isCardinal) {
          ctx.strokeStyle = "rgba(255,231,168,0.85)";
          ctx.fillStyle = "rgba(255,231,168,0.95)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, 4);
          ctx.lineTo(x, h - 4);
          ctx.stroke();
          const label = CARDINALS.find((c) => c.deg === tickDeg)!.label;
          ctx.fillText(label, x, h / 2);
        } else if (isMajor) {
          ctx.strokeStyle = "rgba(255,231,168,0.5)";
          ctx.fillStyle = "rgba(255,231,168,0.65)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, 6);
          ctx.lineTo(x, h - 6);
          ctx.stroke();
        } else if (isMinor) {
          ctx.strokeStyle = "rgba(255,231,168,0.25)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, 10);
          ctx.lineTo(x, h - 10);
          ctx.stroke();
        }
      }

      // Center reticle (fixed — the tape scrolls under it).
      ctx.strokeStyle = "rgba(255,180,40,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, h);
      ctx.stroke();
      // Bearing readout below the reticle.
      ctx.fillStyle = "rgba(255,231,168,0.9)";
      ctx.font = "bold 9px ui-monospace, monospace";
      ctx.fillText(`${Math.round(bearing)}°`, cx, h - 3);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className="hud-glass pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-md"
      style={{ width: STRIP_WIDTH_PX, height: 24 }}
      aria-label={`Heading compass`}
      role="img"
    >
      <canvas
        ref={canvasRef}
        width={STRIP_WIDTH_PX * 2}
        height={48}
        style={{ width: STRIP_WIDTH_PX, height: 24 }}
      />
    </div>
  );
}
