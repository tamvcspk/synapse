import type { Module } from './module';
import type { ServiceInjector } from './service-injector';

export class Scheduler {
  constructor(private injector: ServiceInjector) {}

  /** Direct pipeline: modules without 'bus' run in sequence, output feeds the next input. */
  async runPipeline(modules: Module[], initialInput: unknown): Promise<unknown> {
    let value = initialInput;
    for (const mod of modules) {
      const ctx = this.injector.resolve(mod.needs);
      value = await mod.run(value, ctx);
    }
    return value;
  }

  /** Bus dispatch: modules declaring 'bus' get registered instead of called directly. */
  registerOnBus(mod: Module, bus: { on: Function }): void {
    const ctx = this.injector.resolve(mod.needs);
    bus.on(mod.id, (payload: unknown) => mod.run(payload, ctx));
  }
}
