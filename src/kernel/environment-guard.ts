import type { Module, RuntimeEnv } from './module';

export class EnvironmentMismatchError extends Error {
  constructor(public moduleId: string, public currentEnv: RuntimeEnv, public supportedEnvs: RuntimeEnv[]) {
    super(`Module "${moduleId}" does not support runtime "${currentEnv}" (supports: ${supportedEnvs.join(', ')})`);
  }
}

/**
 * Environment Guard (docs/design.md §3.A): rejects a Module before the Scheduler ever touches it
 * if the current Adapter isn't one it declared support for. A Module without `supportedEnvs`
 * implicitly targets ['browser-extension'] — the only Adapter implemented today.
 */
export function assertEnvSupported(mod: Module, currentEnv: RuntimeEnv): void {
  const supported = mod.supportedEnvs ?? ['browser-extension'];
  if (!supported.includes(currentEnv)) {
    throw new EnvironmentMismatchError(mod.id, currentEnv, supported);
  }
}
