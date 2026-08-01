import type { Module, ModuleFailure } from './module';
import type { ServiceInjector } from './service-injector';

function toFailure(mod: Module, err: unknown): ModuleFailure {
  return { moduleId: mod.id, error: err instanceof Error ? err.message : String(err) };
}

export class Scheduler {
  constructor(private injector: ServiceInjector) {}

  /**
   * Direct pipeline: modules without 'bus' run in sequence, output feeds the next input.
   * A throwing module is reported via onFailure and treated as a pass-through no-op (the
   * previous value flows to the next module) rather than aborting the whole pipeline —
   * this must hold for uploaded modules just as much as bundled ones (see docs/design.md
   * "graceful fail").
   */
  async runPipeline(modules: Module[], initialInput: unknown, onFailure?: (f: ModuleFailure) => void): Promise<unknown> {
    let value = initialInput;
    for (const mod of modules) {
      const ctx = this.injector.resolve(mod.needs, mod.id);
      try {
        value = await mod.run(value, ctx);
      } catch (err) {
        onFailure?.(toFailure(mod, err));
      }
    }
    return value;
  }

  /** Bus dispatch: modules declaring 'bus' get registered instead of called directly. */
  registerOnBus(mod: Module, bus: { on: Function }, onFailure?: (f: ModuleFailure) => void): void {
    const ctx = this.injector.resolve(mod.needs, mod.id);
    bus.on(mod.id, async (payload: unknown) => {
      try {
        return await mod.run(payload, ctx);
      } catch (err) {
        onFailure?.(toFailure(mod, err));
        // Re-thrown (not swallowed after reporting, as before) so a transport that awaits this
        // handler's returned Promise (chromeRuntimeBus, docs/ROADMAP.md §11.5) sees the rejection
        // and can relay it back to whoever sent the message — previously a Module's own thrown
        // validation error (e.g. shared/http-mock.ts's validateMockConfig) only ever reached this
        // function's console.error, never the caller that triggered it. A fire-and-forget bus.emit()
        // caller (network-sniffer's startup 'sync', etc.) is unaffected either way — it never awaits
        // this handler's return value to begin with.
        throw err;
      }
    });
  }
}
