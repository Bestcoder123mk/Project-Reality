/**
 * DEPRECATED — import from `./DeployEnv.ts` instead.
 *
 * A3-5000 #439 / E1-5000 #2365: this file was the original home of the
 * deploy-environment config (dev/staging/prod). The name `Environment.ts`
 * was confusing because the engine also has a world-environment concept
 * (sky, weather, time-of-day) in `level/lighting-pass.ts` +
 * `rendering2/daynight.ts`. The canonical module is now `DeployEnv.ts`;
 * this file remains as a re-export shim so existing imports don't break.
 */
export type { Environment, EnvironmentConfig } from "./DeployEnv";
export { getEnvironment, getEnvironmentConfig } from "./DeployEnv";
