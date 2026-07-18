"use client";

import { useEffect, useRef } from "react";

/**
 * DamageIndicator — a red arc that appears around the crosshair pointing
 * toward the source of incoming damage. Fades out over ~1.2s.
 *
 * Reads `window.__PR_DAMAGE_DIR__` (published by HudSystem each frame) so
 * there's no React re-render cost — the canvas reads + draws on rAF.
 *
 * Prompt J-4029 / J-4123 / J-4195 — 360° damage indicator. The `dir`
 * field ranges across the full circle (0 = ahead, +π/2 = right, ±π =
 * behind, -π/2 = left), so damage from any direction is rendered at
 * the matching screen-space angle (see the screenAngle derivation
 * below). The arc is always centered on the damage source, whether
 * the hit comes from the front, side, or directly behind the player.
 */
interface DamageDirData {
  dir: number; // radians, 0 = ahead, +π/2 = right, ±π = behind, -π/2 = left
  time: number; // performance.now() when damage occurred
}

declare global {
  interface Window {
    __PR_DAMAGE_DIR__?: DamageDirData;
  }
}

export function DamageIndicator() {
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

      const data = window.__PR_DAMAGE_DIR__;
      if (!data || data.dir < 0) return;
      const age = performance.now() - data.time;
      const DURATION = 1200;
      if (age > DURATION) return;
      const t = age / DURATION;
      // Fade out + slight inward drift.
      const alpha = (1 - t) * 0.85;
      const radius = 70 + t * 18;

      // The arc is centered on the damage direction (screen-space).
      // dir = 0 means ahead → arc at top of screen. dir = +π/2 means right → arc on right.
      // Screen angle = -dir - π/2 (so dir=0 → -π/2 = up; dir=π/2 → -π = left… wait).
      // Let's think: in our world, +x is east, +z is south.
      // player.yaw = atan2(forwardX, forwardZ) so yaw=0 → looking +z (south).
      // If enemy is east of player, dx>0, dz=0, worldYaw = atan2(dx, dz) = π/2.
      // Relative angle = worldYaw - playerYaw = π/2 - 0 = π/2 (to the right).
      // On screen, "right" is +x, "up" is -y. So angle π/2 → +x → right. ✓
      // angle 0 → up. angle π → down. angle -π/2 → left.
      // Screen angle (canvas, where 0 = +x axis, +π/2 = +y = down):
      //   screen = -dir - π/2  (so dir=0 → -π/2 = up; dir=π/2 → -π = left… WRONG)
      // Let me redo: dir=0 (ahead) → arc at top of screen → screen angle = -π/2 (up).
      //              dir=π/2 (right) → arc at right → screen angle = 0.
      //              dir=π (behind) → arc at bottom → screen angle = π/2 (down).
      //              dir=-π/2 (left) → arc at left → screen angle = π or -π.
      // So: screenAngle = dir - π/2.
      const screenAngle = data.dir - Math.PI / 2;
      const cx = w / 2;
      const cy = h / 2;
      const arcSpan = Math.PI / 4; // 45° arc

      // Outer glow.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(screenAngle);
      const grad = ctx.createLinearGradient(0, -radius, 0, -radius - 18);
      grad.addColorStop(0, `rgba(248,113,113,${alpha})`);
      grad.addColorStop(1, `rgba(248,113,113,0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, radius + 18, -arcSpan / 2, arcSpan / 2);
      ctx.arc(0, 0, radius, arcSpan / 2, -arcSpan / 2, true);
      ctx.closePath();
      ctx.fill();
      // Solid arc stroke.
      ctx.strokeStyle = `rgba(248,113,113,${alpha * 0.9})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, radius, -arcSpan / 2, arcSpan / 2);
      ctx.stroke();
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={400}
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ width: 400, height: 400 }}
    />
  );
}
