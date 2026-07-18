/**
 * Wire system-to-system callbacks on the engine.
 * Extracted from engine.ts to keep that file under the P2.1 line cap.
 *
 * Accesses engine internals via `any` cast — the engine is a thin
 * orchestrator and these systems are logically public anyway.
 */
export function wireEngineCallbacks(engine: any) {
  const e = engine;
  e.input.onReload = () => e.weapon.startReload();
  e.input.onToggleView = () => e.toggleViewMode();
  e.input.onCycleWeapon = (dir: number) => e.weapon.cycleWeapon(dir);
  // Prompt 8: direct slot selection via Digit1-4.
  e.input.onSelectSlot = (slot: 0 | 1 | 2 | 3) => e.weapon.selectSlot(slot);
  e.input.onUseMedical = (slug: string) => e.useMedicalItem(slug);
  e.input.onRadioMacro = (type: string) => e.sendRadioMacro(type);
  e.input.onToggleWeatherCycle = () => e.weather.toggleWeatherCycle();
  e.input.onTryShoot = () => e.weapon.tryShoot();
  e.input.onResizeCb = () => e.renderer.onResize();
  // P4.6: melee inputs.
  e.input.onMeleeSlash = () => e.melee.trySlash();
  e.input.onGrenadeThrow = () => e.grenades?.startThrow();
  // V5.4: killstreak reward deploy.
  e.input.onDeployRecon = () => e.enemies.deployRecon();
  e.input.onDeployAirstrike = () => e.enemies.deployAirstrike();
  // G1.2: VIP damage hook — enemies can damage the VIP in VIP Escort mode.
  e.enemies.onDamageVip = (dmg: number) => e.missions.damageVip(dmg);
  e.weapon.onSpawnImpact = (p: any, n: any, st?: string) => e.particles.spawnBulletImpact(p, n, st);
  e.weapon.onSpawnTracer = (f: any, t: any, c?: number) => e.particles.spawnTracer(f, t, c);
  e.weapon.onDamageEnemy = (en: any, d: number, h: boolean, p: any) => e.enemies.damageEnemy(en, d, h, p);
  e.weapon.onDestroyProp = (prop: any) => e.enemies.destroyProp(prop);
  // Task-6: wire the new combat-feel hooks.
  e.weapon.onShatterGlass = (p: any, n: any) => e.particles.spawnGlassShatter(p, n);
  e.weapon.onSpawnMuzzleSmoke = (p: any, f: any, supp: boolean) => e.particles.spawnMuzzleSmoke(p, f, supp);
  e.weapon.onEjectShell = (wt: any) => e.particles.ejectShell(wt);
  // P4.5: wire malfunction hooks.
  e.weapon.isJammed = () => e.malfunctions.isJammed();
  e.weapon.onShotFired = () => e.malfunctions.onShotFired();
  e.weapon.onReloadStart = () => e.malfunctions.onReloadStart();
  e.weapon.onClearMalfunction = () => e.malfunctions.clearMalfunction();
  // P4.6: wire melee hooks.
  e.melee.onDamageEnemy = (en: any, d: number, h: boolean, p: any) => e.enemies.damageEnemy(en, d, h, p);
  e.melee.onSpawnBlood = (p: any) => e.particles.spawnBlood(p);
  e.enemies.onSpawnTracer = (f: any, t: any, c?: number) => e.particles.spawnTracer(f, t, c);
  e.enemies.onApplyDamageToPlayer = (d: number, loc: any, sourcePos?: any) => e.medical.applyDamageToPlayer(d, loc, sourcePos);
  e.enemies.onSpawnBlood = (p: any) => e.particles.spawnBlood(p);
  // Task-6: directional blood spray for bullet hits (cone of red particles
  // in the bullet travel direction + headshot-aware finer mist).
  e.enemies.onSpawnBloodSpray = (p: any, dir: any, amt: number, h: boolean) => e.particles.spawnBloodSpray(p, dir, amt, h);
  e.enemies.onSpawnDebris = (p: any, c: any, n: number) => e.particles.spawnDebris(p, c, n);
  e.weather.onUpdateVisuals = () => e.renderer.updateWeatherVisuals();

  // Prompt #53 — wire the per-enemy suppression hook. ProjectileSystem calls
  // this when a player projectile passes within ~2m of an enemy (a near-miss).
  // SuppressionSystem bumps that enemy's `e.suppression` scalar; the FSM tick
  // (EnemySystem) then transitions the enemy to SUPPRESSED when the scalar
  // crosses the per-class suppressionThreshold (default 0.6). tickSuppressed
  // in enemy-tactics.ts implements the duck/peek/cover behavior.
  e.ctx.addEnemySuppression = (enemy: any, amount: number) =>
    e.suppression.addEnemySuppression(enemy, amount);

  // REAL-BALLISTICS — wire ProjectileSystem's hooks to the same callbacks
  // the legacy WeaponSystem.fireRay used (impact VFX, damage, destructible
  // cleanup, glass shatter). The projectile system delegates to these hooks
  // so enemy damage + impact particles behave identically to the legacy
  // hitscan path.
  if (e.projectileSystem) {
    e.projectileSystem.__onDamageEnemy = (en: any, d: number, h: boolean, p: any, _slug: string) =>
      e.enemies.damageEnemy(en, d, h, p);
    e.projectileSystem.__onSpawnImpact = (p: any, n: any, st?: string) =>
      e.particles.spawnBulletImpact(p, n, st);
    // Prompt #35 — wire the penetration exit-hole decal hook to the
    // ParticleSystem's spawnExitHole method.
    e.projectileSystem.__onSpawnExitHole = (exitPoint: any, entryNormal: any, st?: string) =>
      e.particles.spawnExitHole(exitPoint, entryNormal, st);
    e.projectileSystem.__onShatterGlass = (p: any, n: any) =>
      e.particles.spawnGlassShatter(p, n);
    e.projectileSystem.__onDestroyProp = (prop: any) =>
      e.enemies.destroyProp(prop);
  }
}
