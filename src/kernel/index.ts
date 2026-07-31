import { ServiceInjector } from './service-injector';
import { Scheduler } from './scheduler';
import type { Module, ModuleFailure } from './module';

export class Kernel {
  private scheduler: Scheduler;

  constructor(private injector: ServiceInjector) {
    this.scheduler = new Scheduler(injector);
  }

  /**
   * The per-run Environment Guard that used to head this method is gone (docs/ROADMAP.md §11.1):
   * with one runtime, it could only ever pass, so it was a check on every module of every run that
   * bought nothing.
   */
  async run(modules: Module[], input: unknown, onFailure?: (f: ModuleFailure) => void): Promise<unknown> {
    const [pipelineModules, busModules] = partition(modules, (m) => !m.needs?.includes('bus'));
    for (const mod of busModules) {
      const ctx = this.injector.resolve(mod.needs);
      if (ctx.services.bus) this.scheduler.registerOnBus(mod, ctx.services.bus, onFailure);
    }
    return this.scheduler.runPipeline(pipelineModules, input, onFailure);
  }
}

function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const x of arr) (pred(x) ? yes : no).push(x);
  return [yes, no];
}
