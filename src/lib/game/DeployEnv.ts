/**
 * Phase 0: Staging environment configuration.
 *
 * A3-5000 #439: previously named `Environment.ts` — confusing because the
 * engine also has a world-environment concept (sky, weather, time-of-day)
 * which lives in `level/lighting-pass.ts` + `rendering2/daynight.ts`. The
 * prior name caused two unrelated modules to be imported under the same
 * identifier. This module remains the deploy-env config; the file has been
 * renamed to `DeployEnv.ts` (this file is kept as a re-export shim so
 * existing imports don't break). New code should import from `DeployEnv.ts`.
 */

export type Environment = "development" | "staging" | "production";

export interface EnvironmentConfig {
  env: Environment;
  /** Telemetry sampling rate (0..1). Dev=1, staging=0.5, prod=0.1. */
  telemetrySampleRate: number;
  /** Error tracking enabled. */
  errorTrackingEnabled: boolean;
  /** LLM provider: "cloud" (z-ai-web-dev-sdk), "browser" (WebLLM), "mock". */
  llmProvider: "cloud" | "browser" | "mock";
  /** WebGPU required (staging/prod) or optional (dev). */
  webgpuRequired: boolean;
  /** Quest 3 WebXR validation mode. */
  webxrValidation: boolean;
  /** Cloud LLM model slug for hero NPCs. */
  heroLlmModel: string;
  /** In-browser SLM model slug for secondary NPCs. */
  secondaryLlmModel: string;
}

export function getEnvironment(): Environment {
  const env = process.env.NODE_ENV as string;
  if (env === "production") return "production";
  if (env === "staging") return "staging";
  return "development";
}

export function getEnvironmentConfig(): EnvironmentConfig {
  const env = getEnvironment();
  switch (env) {
    case "production":
      return {
        env,
        telemetrySampleRate: 0.1,
        errorTrackingEnabled: true,
        llmProvider: "cloud",
        webgpuRequired: false, // graceful fallback in prod
        webxrValidation: false,
        heroLlmModel: "glm-4.5",
        secondaryLlmModel: "llama-3.2-1b",
      };
    case "staging":
      return {
        env,
        telemetrySampleRate: 0.5,
        errorTrackingEnabled: true,
        llmProvider: "cloud",
        webgpuRequired: true,
        webxrValidation: true,
        heroLlmModel: "glm-4.5",
        secondaryLlmModel: "llama-3.2-1b",
      };
    case "development":
    default:
      return {
        env,
        telemetrySampleRate: 1.0,
        errorTrackingEnabled: true,
        llmProvider: "mock", // avoid burning API tokens in dev
        webgpuRequired: false,
        webxrValidation: false,
        heroLlmModel: "glm-4.5",
        secondaryLlmModel: "llama-3.2-1b",
      };
  }
}
// A3-5000 #439: canonical home for deploy-env config. Environment.ts re-exports from here.
