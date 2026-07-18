"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useGameStore } from "@/lib/game/store";
import { Minimap } from "./hud/Minimap";
import { Crosshair, ScopeOverlay } from "./hud/Crosshair";
import { TopLeftCluster, TopCenterObjective } from "./hud/TopClusters";
import { KillFeed, RadioMessage } from "./hud/KillFeed";
import { BottomLeftCluster } from "./hud/BottomLeftCluster";
import { BottomRightCluster } from "./hud/BottomRightCluster";
import { BottomCenterCluster } from "./hud/BottomCenterCluster";
import { DamageIndicator } from "./hud/DamageIndicator";
import { KillstreakTracker } from "./hud/KillstreakTracker";
import { EnemyNameplate } from "./hud/EnemyNameplate";
import { DamageNumbers } from "./hud/DamageNumbers";
import { LoadoutStrip } from "./hud/LoadoutStrip";
import { Compass } from "./hud/Compass";
import { PingHud } from "./hud/PingHud";

/**
 * HUD — military-tactical glassmorphism, corner-clustered layout.
 *
 * Subscribes to the four sliced stores independently (P2.3 architecture):
 *   - hudCombat: every frame (health/ammo/armor/reload)
 *   - hudMeta:   ~5 Hz (score/kills/wave/fps)
 *   - hudRealism: ~5 Hz (suppression/medical/weather)
 *   - hudTransient: event-driven (hit marker / damage flash / killfeed / radio)
 *
 * Components live under src/components/game/hud/ and are composed here.
 */
/**
 * useFadeClock — interval-driven clock for time-since-event fades.
 *
 * Prompt J-4048 — previously this hook ran a setInterval(80ms)
 * unconditionally for the entire match, re-rendering HUD on every tick
 * even when nothing was fading (no hitmarker, no damage flash, no
 * multi-kill banner). The 80ms cadence meant ~12.5 re-renders/sec on a
 * quiet HUD — wasted React reconciliation work.
 *
 * The fix is ref-counting: the clock only runs while at least one
 * subscriber has called `subscribe()` and not `unsubscribe()`. The HUD
 * root subscribes when there's an active transient (hitmarker,
 * killmarker, damage flash, multi-kill, etc.) + unsubscribes once all
 * of them have expired. When no transients are active, the hook is a
 * pure useState (zero rAF/setInterval allocation).
 *
 * The fallback path (when `enabled` is true) still ticks every 80ms so
 * individual components that opt into the clock don't need to change
 * their consumer code — they read `now` from the hook + the hook itself
 * decides whether to actually allocate the interval.
 */
function useFadeClock(intervalMs = 80, enabled = true) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!enabled) return; // no active transient — skip the interval
    const id = setInterval(() => setNow(performance.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** J-4037 — parse a #RRGGBB hex string into {r,g,b}. Falls back to
 *  the default red (#dc2626) on invalid input so a malformed settings
 *  blob never breaks the vignette render. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 220, g: 38, b: 38 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function HUD() {
  const combat = useGameStore((s) => s.hudCombat);
  const meta = useGameStore((s) => s.hudMeta);
  const realism = useGameStore((s) => s.hudRealism);
  const transient = useGameStore((s) => s.hudTransient);
  // Prompt J-4037 / J-4131 — low-health vignette color is now
  // customizable via ExtendedSettings.lowHealthVignetteColor (hex).
  // The previous code hardcoded red rgba(220,38,38,...) which is
  // indistinguishable from the damage-flash red for protanopia/
  // deuteranopia players. Colorblind players can swap to amber/
  // yellow so the "I'm hurt" cue reads distinctly from the "I'm
  // taking damage" cue. We parse the hex here once per render +
  // build the rgba strings the vignette layers use below.
  const vignetteHex = useGameStore((s) => s.settings.extended.lowHealthVignetteColor) ?? "#dc2626";
  const vignetteRgb = hexToRgb(vignetteHex);
  const vignette = (alpha: number) => `rgba(${vignetteRgb.r},${vignetteRgb.g},${vignetteRgb.b},${alpha})`;
  // Prompt J-4048 — compute "is anything fading right now?" so we can
  // skip the 80ms interval when the HUD is quiet. Each branch mirrors
  // a `show*` flag below; computing it once here avoids re-running the
  // interval when there's nothing to fade.
  const now0 = performance.now();
  const hasActiveFade =
    (!!transient.hitMarker && now0 - transient.hitMarker < 180) ||
    (!!transient.killMarker && now0 - transient.killMarker < 400) ||
    (!!transient.headshotMarker && now0 - transient.headshotMarker < 400) ||
    (!!transient.killMarker && now0 - transient.killMarker < 250) || // killFlash
    (!!transient.multiKill && now0 - transient.multiKill.time < 1600) ||
    (!!transient.damageFlash && now0 - transient.damageFlash < 350) ||
    // KillFeed entries (4.5s) + radio message (4s) also need the clock.
    (transient.killFeed?.some((k) => now0 - k.time < 4500) ?? false) ||
    (!!transient.radioMessage && now0 - transient.radioMessage.time < 4000);
  const now = useFadeClock(80, hasActiveFade);

  const sinceShot = now - transient.hitMarker;
  const crosshairSpread = sinceShot < 150 ? 12 : 5;
  const showHit = !!transient.hitMarker && now - transient.hitMarker < 180;
  // Task-6: kill + headshot-kill markers — distinct from the hit marker.
  // Kill marker lingers 400ms (vs hit marker 180ms) so the kill beat reads.
  const showKill = !!transient.killMarker && now - transient.killMarker < 400;
  const showHeadshot = !!transient.headshotMarker && now - transient.headshotMarker < 400;
  // Task-6: brief screen edge flash on kill — a subtle white-gold vignette
  // that decays in 250ms. Distinct from the red damage flash.
  const showKillFlash = !!transient.killMarker && now - transient.killMarker < 250;
  // Task-6: multi-kill banner — visible 1.6s after the most recent kill in
  // the chain. Renders big text ("DOUBLE KILL", "TRIPLE KILL", …) dead-center.
  const multiKill = transient.multiKill;
  const showMultiKill = !!multiKill && now - multiKill.time < 1600;
  const showDamage = !!transient.damageFlash && now - transient.damageFlash < 350;
  // Prompt #48 — HP-tier damage feedback. Four tiers drive the screen
  // vignette + blood overlay intensity (the heartbeat audio is driven
  // from HudSystem.tickHeartbeat so it runs at the engine's fixed rate):
  //   HP > 70:  clean (no overlay).
  //   HP 40-70: faint static red vignette (you've taken a hit).
  //   HP 15-40: strong pulsing red vignette (you're badly hurt — heart beats).
  //   HP < 15:  heavy blood overlay + faster pulse (you're dying — heart races).
  const hp = combat.health;
  const hpFaint = hp > 0 && hp <= 70 && hp > 40;     // tier 2 — faint
  const hpStrong = hp > 0 && hp <= 40 && hp > 15;    // tier 3 — strong
  const hpCritical = hp > 0 && hp <= 15;             // tier 4 — critical

  return (
    <div className="pointer-events-none absolute inset-0 z-30 select-none">
      {/* ---------- Full-screen effects ---------- */}
      <AnimatePresence>
        {showDamage && (
          <motion.div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 30%, rgba(220,38,38,0.55) 100%)",
            }}
            initial={{ opacity: 0.95 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
          />
        )}
      </AnimatePresence>

      {/* Task-6 — Kill flash: brief white-gold screen edge pulse on kill.
          Distinct from the red damage flash so the player reads it as a
          positive confirmation, not a hit taken. */}
      <AnimatePresence>
        {showKillFlash && (
          <motion.div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 55%, rgba(255,210,120,0.32) 100%)",
            }}
            initial={{ opacity: 0.85 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          />
        )}
      </AnimatePresence>

      {/* Task-6 — Multi-kill banner: big bold text dead-center for ~1.6s. */}
      <AnimatePresence>
        {showMultiKill && multiKill && (
          <motion.div
            key={`${multiKill.text}-${multiKill.time}`}
            className="absolute left-1/2 top-[28%] -translate-x-1/2 -translate-y-1/2 text-center"
            initial={{ scale: 0.6, opacity: 0, y: 10 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 1.15, opacity: 0, y: -10 }}
            transition={{ duration: 0.32, ease: "easeOut" }}
          >
            <div
              className="text-4xl font-black tracking-widest"
              style={{
                color: "#ffe7a8",
                textShadow:
                  "0 0 12px rgba(255,180,40,0.7), 0 2px 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.95)",
                letterSpacing: "0.18em",
              }}
            >
              {multiKill.text}
            </div>
            <div
              className="mt-1 text-xs font-semibold uppercase tracking-[0.4em]"
              style={{ color: "rgba(255,231,168,0.7)" }}
            >
              x{multiKill.count}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Prompt #48 — HP-tier vignette + blood overlay.
          Tier 2 (HP 40-70): faint static red vignette. Sells "you've been
          nicked" without obscuring the screen.
          Tier 3 (HP 15-40): strong pulsing red vignette. The pulse rate
          matches the heartbeat (1.4s period = ~43 BPM, the lower bound
          of a tense-but-conscious heart rate).
          Tier 4 (HP < 15): heavy blood overlay — a darker, wider vignette
          with a faster 0.7s pulse (the heart is racing). A full-screen
          dark-red gradient simulates blood pooling at the edges of vision. */}
      {hpFaint && (
        <div
          className="absolute inset-0"
          style={{ boxShadow: `inset 0 0 120px 20px ${vignette(0.18)}` }}
        />
      )}
      {hpStrong && (
        <motion.div
          className="absolute inset-0"
          style={{ boxShadow: `inset 0 0 180px 40px ${vignette(0.42)}` }}
          animate={{ opacity: [0.45, 0.78, 0.45] }}
          transition={{ duration: 1.4, repeat: Infinity }}
        />
      )}
      {hpCritical && (
        <>
          {/* Heavy blood overlay — full-screen dark-red gradient that pulses
              faster than tier 3. Sits on top of the strong vignette so the
              combined effect reads as "vision closing in". The critical
              tier keeps the darker blood-pool hues (not the player's
              custom color) so the "you're dying" cue is universally
              readable as blood regardless of the colorblind override. */}
          <motion.div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at center, transparent 12%, rgba(120,8,8,0.55) 75%, rgba(60,0,0,0.78) 100%)",
            }}
            animate={{ opacity: [0.65, 0.92, 0.65] }}
            transition={{ duration: 0.7, repeat: Infinity }}
          />
          {/* Inner dark vignette on top — the tunnel-vision effect as the
              player nears death. Uses the player's custom color so the
              tier-3 → tier-4 escalation still reads as "same hue, more
              intense" rather than a hue switch. */}
          <motion.div
            className="absolute inset-0"
            style={{ boxShadow: `inset 0 0 240px 80px ${vignette(0.62)}` }}
            animate={{ opacity: [0.55, 0.85, 0.55] }}
            transition={{ duration: 0.7, repeat: Infinity }}
          />
        </>
      )}

      {realism.suppression > 0.4 && (
        <motion.div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 22%, rgba(70,72,84,0.55) 92%)",
            filter: "grayscale(0.35)",
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: Math.min(1, realism.suppression) }}
        />
      )}

      {/* ---------- Scope overlay (sniper) ---------- */}
      {combat.scoped && <ScopeOverlay />}

      {/* ---------- Crosshair ---------- */}
      {!combat.scoped && (
        <Crosshair spread={crosshairSpread} showHit={showHit} showKill={showKill} showHeadshot={showHeadshot} />
      )}

      {/* ---------- Directional damage indicator (realism) ---------- */}
      {!combat.scoped && <DamageIndicator />}

      {/* ---------- Prompt J-4030 — Top-center compass strip ---------- */}
      {!combat.scoped && <Compass />}

      {/* ---------- Prompt J-4032 — Ping system (HUD markers) ---------- */}
      {!combat.scoped && <PingHud />}

      {/* ---------- V2.3 — Enemy-spotted nameplate (on-spot) ---------- */}
      {!combat.scoped && <EnemyNameplate />}

      {/* ---------- Top-left: minimap + score + wave + fps ---------- */}
      <TopLeftCluster
        score={meta.score}
        kills={meta.kills}
        wave={meta.wave}
        maxWaves={6}
        enemiesRemaining={meta.enemiesRemaining}
        totalEnemies={meta.totalEnemies}
        fps={meta.fps}
        minimap={<Minimap />}
      />

      {/* ---------- Top-center: wave pill + objective ---------- */}
      <TopCenterObjective
        wave={meta.wave}
        maxWaves={6}
        objective={meta.objective}
      />

      {/* ---------- Top-right: kill feed ---------- */}
      <KillFeed entries={transient.killFeed} now={now} />

      {/* ---------- Radio message (top-center, below objective) ---------- */}
      <RadioMessage radio={transient.radioMessage} now={now} />

      {/* ---------- Bottom-left: health + armor + casualty ---------- */}
      <BottomLeftCluster
        health={combat.health}
        maxHealth={combat.maxHealth}
        armor={combat.armor}
        casualtyState={realism.casualtyState}
        bleedRate={realism.bleedRate}
      />

      {/* ---------- V2.2 — Killstreak tracker (above the ammo cluster) ---------- */}
      <div className="absolute bottom-[7.5rem] right-4 z-30">
        <KillstreakTracker />
      </div>

      {/* ---------- Bottom-right: ammo + weapon + reload ---------- */}
      <BottomRightCluster
        ammo={combat.ammo}
        magSize={combat.magSize}
        reserveAmmo={combat.reserveAmmo}
        weaponName={combat.weaponName}
        reloading={combat.reloading}
        reloadProgress={combat.reloadProgress}
        viewMode={combat.viewMode}
      />

      {/* ---------- Bottom-center: medical + weather + suppression ---------- */}
      <BottomCenterCluster
        suppression={realism.suppression}
        medicalInventory={realism.medicalInventory}
        medicalChannel={realism.medicalChannel}
        weather={realism.weather}
        timeOfDay={realism.timeOfDay}
        windSpeed={realism.windSpeed}
      />

      {/* ---------- Prompt 9: Floating damage numbers ---------- */}
      <DamageNumbers />

      {/* ---------- Prompt 8: Persistent 4-slot loadout strip ---------- */}
      <LoadoutStrip />

      {/* ---------- Prompt J-4034 — Spectator HUD state ----------.
          When the player is dead + spectating (phase === "dead" with a
          spectator target, OR a `spectatorMode` transient flag is set),
          show a top-center "SPECTATING <target>" banner so the player
          knows they're not in their own POV. The banner is read-only —
          no buttons — because the controls (next/prev spectator target)
          are keyboard-only (default: Q/E). */}
      <SpectatorHudBanner />
    </div>
  );
}

/** Prompt J-4034 / J-4128 / J-4200 — spectator HUD banner. Renders a
 *  top-center label when the player is in spectator mode. Reads the
 *  `__PR_SPECTATOR_STATE__` global (published by the engine's spectator
 *  system) so there's no React re-render cost — the banner reads on rAF
 *  via a tiny useEffect. */
function SpectatorHudBanner() {
  const [spec, setSpec] = useState<{ active: boolean; target?: string; mode?: string } | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = (window as unknown as { __PR_SPECTATOR_STATE__?: { active: boolean; target?: string; mode?: string } }).__PR_SPECTATOR_STATE__;
      // Only update state on change to avoid the per-frame re-render trap.
      setSpec((prev) => {
        const next = s ?? null;
        if (prev?.active === next?.active && prev?.target === next?.target && prev?.mode === next?.mode) return prev;
        return next;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  if (!spec?.active) return null;
  return (
    <div className="absolute left-1/2 top-3 z-40 -translate-x-1/2">
      <div className="hud-glass flex items-center gap-2 rounded-md px-3 py-1.5">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
        <span className="text-[9px] font-bold uppercase tracking-[0.25em] text-sky-300">
          Spectating
        </span>
        {spec.target && (
          <span className="text-xs font-semibold text-white/85">{spec.target}</span>
        )}
        {spec.mode && (
          <span className="text-[9px] uppercase tracking-wider text-white/40">· {spec.mode}</span>
        )}
      </div>
    </div>
  );
}
