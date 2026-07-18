// Explosion kind + debris pool sizing — split out from ParticleSystem.ts
// so destruction-physics / VoronoiFracture can import them without pulling
// the entire particle system.

/** Task-25: explosion debris pool — 64 chunks per burst. */
export const EXPLOSION_DEBRIS_POOL_SIZE = 64;
/** Task-25: explosion kind — drives scale, fireball count, debris, chain reaction. */
export type ExplosionKind = "grenade" | "barrel" | "c4";
