import type { GameSystem, GameContext } from "./types";
import type { CasualtyState } from "../realism";
import { useGameStore } from "../store";
import * as THREE from "three";

/**
 * MedicalSystem — owns the four-state casualty model (ACTIVE/BLEEDING/FRACTURED/UNCONSCIOUS),
 * bleed damage tick, channelled medical item use, and damage application to the player
 * (armor absorption + casualty state transitions on hit).
 */
export class MedicalSystem implements GameSystem {
  constructor(private ctx: GameContext) {}

  /** Apply damage to the player. Triggers casualty state transitions.
   *  `sourcePos` is the world-space position of the attacker (for the
   *  HUD directional damage indicator). */
  applyDamageToPlayer(dmg: number, hitLocation: "torso" | "limb" | "head" = "torso", sourcePos?: THREE.Vector3) {
    const { ctx } = this;
    if (ctx.match.matchOver) return;
    if (ctx.player.armor > 0) {
      // Armor absorbs 60% of damage (was 50% — more forgiving for new players).
      const absorbed = Math.min(ctx.player.armor, dmg * 0.6);
      ctx.player.armor -= absorbed;
      dmg -= absorbed;
    }
    ctx.player.health -= dmg;
    ctx.audio.damage();
    // Realism: record the direction the damage came from (relative to the
    // player's facing yaw) so the HUD can render a directional indicator.
    if (sourcePos) {
      const dx = sourcePos.x - ctx.player.pos.x;
      const dz = sourcePos.z - ctx.player.pos.z;
      // Angle in the same frame as player.yaw (atan2(x, z)).
      const worldYaw = Math.atan2(dx, dz);
      // Convert to "angle relative to where the player is looking":
      // 0 = directly ahead, +π = behind, +π/2 = right, -π/2 = left.
      ctx.player.lastDamageDir = worldYaw - ctx.player.yaw;
      ctx.player.lastDamageTime = performance.now();
    }
    if (hitLocation === "head") {
      if (ctx.player.health > 0) this.setCasualtyState("UNCONSCIOUS");
    } else if (hitLocation === "limb") {
      if (ctx.medical.casualtyState === "ACTIVE") this.setCasualtyState(Math.random() < 0.5 ? "BLEEDING" : "FRACTURED");
      else if (ctx.medical.casualtyState === "BLEEDING" && Math.random() < 0.3) this.setCasualtyState("FRACTURED");
    } else {
      if (ctx.medical.casualtyState === "ACTIVE" && dmg > 15) this.setCasualtyState("BLEEDING");
    }
    ctx.pushHud({
      health: Math.max(0, Math.round(ctx.player.health)),
      armor: Math.max(0, Math.round(ctx.player.armor)),
      damageFlash: performance.now(),
    });
    // Camera juice: trigger screen shake on taking damage (scaled by dmg).
    const shakeIntensity = Math.min(0.6, dmg * 0.02);
    ctx.triggerShake(shakeIntensity);
    if (ctx.player.health <= 0) ctx.onGameOver();
  }

  setCasualtyState(state: CasualtyState) {
    const { ctx } = this;
    ctx.medical.casualtyState = state;
    if (state === "BLEEDING") ctx.medical.bleedRate = 1 + Math.random() * 2;
    else if (state === "FRACTURED") { ctx.medical.fractureLimb = Math.random() < 0.5 ? "leg" : "arm"; ctx.medical.bleedRate = 0; }
    else if (state === "UNCONSCIOUS") ctx.medical.bleedRate = 0;
    else { ctx.medical.bleedRate = 0; ctx.medical.fractureLimb = ""; }
    ctx.pushHud({ casualtyState: state, bleedRate: ctx.medical.bleedRate });
  }

  /** Begin channelled use of a medical item. */
  useMedicalItem(slug: string) {
    const { ctx } = this;
    if (ctx.medical.channel) return;
    if (!(slug in ctx.medical.inventory) || ctx.medical.inventory[slug as keyof typeof ctx.medical.inventory] <= 0) return;
    const useTimes: Record<string, number> = { bandage: 4000, splint: 6000, epi: 3000, medkit: 8000 };
    ctx.medical.channel = { slug, progress: 0, duration: useTimes[slug] ?? 3000 };
    ctx.audio.medicalAction(slug as "bandage" | "splint" | "epi" | "medkit");
    ctx.pushHud({ medicalChannel: { slug, progress: 0 } });
  }

  update(dt: number) {
    const { ctx } = this;
    if (ctx.medical.bleedRate > 0 && ctx.player.health > 0 && !ctx.match.matchOver) {
      ctx.player.health -= ctx.medical.bleedRate * dt;
      if (Math.floor(ctx.player.health) !== Math.floor(ctx.player.health + ctx.medical.bleedRate * dt)) {
        ctx.pushHud({ health: Math.max(0, Math.round(ctx.player.health)) });
      }
      if (ctx.player.health <= 0) { ctx.onGameOver(); return; }
    }
    if (ctx.medical.channel) {
      ctx.medical.channel.progress += dt * 1000;
      const prog = Math.min(1, ctx.medical.channel.progress / ctx.medical.channel.duration);
      ctx.pushHud({ medicalChannel: { slug: ctx.medical.channel.slug, progress: prog } });
      if (prog >= 1) {
        const slug = ctx.medical.channel.slug;
        ctx.medical.inventory[slug as keyof typeof ctx.medical.inventory]--;
        if (slug === "bandage" && ctx.medical.casualtyState === "BLEEDING") this.setCasualtyState("ACTIVE");
        else if (slug === "splint" && ctx.medical.casualtyState === "FRACTURED") this.setCasualtyState("ACTIVE");
        else if (slug === "epi" && ctx.medical.casualtyState === "UNCONSCIOUS") this.setCasualtyState("ACTIVE");
        else if (slug === "medkit") {
          ctx.player.health = Math.min(100, ctx.player.health + 50);
          ctx.pushHud({ health: Math.round(ctx.player.health) });
        }
        ctx.medical.channel = null;
        ctx.pushHud({ medicalChannel: null, medicalInventory: { ...ctx.medical.inventory } });
        fetch("/api/medical/use", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        }).catch(() => {});
      }
    }
  }
}

export { useGameStore };
