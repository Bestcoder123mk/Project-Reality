import * as THREE from "three";
import type { GameSystem, GameContext } from "./types";
import { isNight } from "../realism";
import { useGameStore } from "../store";

/**
 * WeatherSystem — owns time-of-day progression, cloud/wind/precipitation drift,
 * sky/sun/light updates (delegated to RendererSystem.updateWeatherVisuals),
 * and the rain particle field.
 *
 * Task-38 — Day/night cycle:
 *   - timeOfDay auto-advances at TIME_SCALE = 0.04 hours/sec so a full 24h
 *     day takes ~10 minutes of real time. Visible cycle without being fast.
 *   - Sky/sun/light refresh is throttled to every 2s (VISUALS_UPDATE_INTERVAL)
 *     so transitions stay smooth without paying the per-frame cost of
 *     recomputing sky colors + sun position + light intensities.
 */
const TIME_SCALE = 0.04; // 24h / 600s — full day cycle in ~10 minutes
const VISUALS_UPDATE_INTERVAL = 2; // seconds between sky/lighting refreshes

export class WeatherSystem implements GameSystem {
  /** Accumulator for the throttled visuals refresh. */
  private visualsAccum = 0;

  constructor(private ctx: GameContext) {}

  update(dt: number) {
    const { ctx } = this;
    // Task-38 — auto-advance time of day. TIME_SCALE = 0.04 → ~10 min / full day.
    ctx.weather.timeOfDay = (ctx.weather.timeOfDay + dt * TIME_SCALE) % 24;
    ctx.weatherTime += dt;
    ctx.weather.cloudCover = 0.3 + Math.sin(ctx.weatherTime * 0.02) * 0.25;
    ctx.weather.windSpeed = 3 + Math.sin(ctx.weatherTime * 0.03) * 4;
    ctx.weather.windDirection += dt * 0.02;
    if (ctx.weatherTime > 60 && ctx.weatherTime < 120) {
      ctx.weather.precipitation = Math.min(0.6, ctx.weather.precipitation + dt * 0.05);
    } else if (ctx.weatherTime > 180) {
      ctx.weather.precipitation = Math.max(0, ctx.weather.precipitation - dt * 0.05);
    }

    // Task-3 — surface wetness (Prompt #9). Ramps up while it's raining
    // (rate proportional to precipitation intensity), decays back to 0 when
    // the rain stops (slow evaporation). Drives RendererSystem's material-
    // roughness lerp so wet ground + horizontal surfaces read as glossy.
    //   - Ramp: precipitation * 0.15 per second → full wetness in ~7s of heavy rain.
    //   - Decay: 0.02 per second → fully dry in ~50s after rain stops.
    // The asymmetry (fast to wet, slow to dry) matches real-world behavior
    // (puddles persist long after the rain stops).
    if (ctx.weather.precipitation > 0.05) {
      ctx.weather.wetness = Math.min(1, ctx.weather.wetness + ctx.weather.precipitation * 0.15 * dt);
    } else {
      ctx.weather.wetness = Math.max(0, ctx.weather.wetness - 0.02 * dt);
    }

    // Task-38 — throttle sky/lighting refresh to every 2s. The time advances
    // ~2.4 min per real second, so a 2s gap = ~5 min of game time — small
    // enough that sky color + sun position transitions remain visually smooth,
    // but big enough to skip ~119 frames of recomputation per refresh on a
    // 60fps client.
    this.visualsAccum += dt;
    if (this.visualsAccum >= VISUALS_UPDATE_INTERVAL) {
      this.visualsAccum = 0;
      this.updateWeatherVisuals();
    }

    this.updateRain(dt);
    const night = isNight(ctx.weather.timeOfDay);
    const weatherLabel = night ? "NIGHT" : ctx.weather.precipitation > 0.3 ? "RAIN" : ctx.weather.cloudCover > 0.6 ? "CLOUDY" : ctx.weather.fogDensity > 0.03 ? "FOG" : "CLEAR";
    useGameStore.getState().setHud({ timeOfDay: ctx.weather.timeOfDay, weather: weatherLabel, windSpeed: Math.round(ctx.weather.windSpeed) });
  }

  private updateWeatherVisuals() {
    // Delegated to RendererSystem via engine — wired on construction
    // (engine-wiring.ts sets `weather.onUpdateVisuals = () => renderer.updateWeatherVisuals()`).
    this.onUpdateVisuals?.();
  }
  onUpdateVisuals?: () => void;

  /** Jump time forward by 6 hours (F1 demo toggle). */
  toggleWeatherCycle() {
    const { ctx } = this;
    ctx.weather.timeOfDay = (ctx.weather.timeOfDay + 6) % 24;
    this.onUpdateVisuals?.();
  }

  /** R6.1 — Spawn/despawn rain particle field based on precipitation. */
  updateRainParticles() {
    const { ctx } = this;
    if (ctx.weather.precipitation > 0.1 && !ctx.rainParticles) {
      const count = 3000;
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(count * 3);
      const velocities = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 80;
        positions[i * 3 + 1] = Math.random() * 40;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 80;
        velocities[i] = 20 + Math.random() * 15;
      }
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.userData.velocities = velocities;
      const mat = new THREE.PointsMaterial({ color: 0xaabbcc, size: 0.08, transparent: true, opacity: 0.5 });
      ctx.rainParticles = new THREE.Points(geo, mat);
      ctx.scene.add(ctx.rainParticles);
    } else if (ctx.weather.precipitation <= 0.1 && ctx.rainParticles) {
      ctx.scene.remove(ctx.rainParticles);
      ctx.rainParticles.geometry.dispose();
      (ctx.rainParticles.material as THREE.Material).dispose();
      ctx.rainParticles = null;
    }
  }

  private updateRain(dt: number) {
    const { ctx } = this;
    if (!ctx.rainParticles) {
      this.updateRainParticles();
      if (!ctx.rainParticles) return;
    }
    const geo = ctx.rainParticles.geometry;
    const pos = geo.attributes.position.array as Float32Array;
    const vel = geo.userData.velocities as Float32Array;
    const camPos = ctx.camera.position;
    for (let i = 0; i < pos.length / 3; i++) {
      pos[i * 3 + 1] -= vel[i] * dt;
      pos[i * 3] += ctx.weather.windSpeed * Math.cos(ctx.weather.windDirection) * dt * 2;
      pos[i * 3 + 2] += ctx.weather.windSpeed * Math.sin(ctx.weather.windDirection) * dt * 2;
      if (pos[i * 3 + 1] < 0) {
        pos[i * 3 + 1] = 35 + Math.random() * 5;
        pos[i * 3] = camPos.x + (Math.random() - 0.5) * 80;
        pos[i * 3 + 2] = camPos.z + (Math.random() - 0.5) * 80;
      }
    }
    geo.attributes.position.needsUpdate = true;
    ctx.rainParticles.position.set(0, 0, 0);
  }
}
