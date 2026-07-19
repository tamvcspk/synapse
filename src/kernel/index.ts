import { ServiceInjector } from './service-injector';
import { Scheduler } from './scheduler';
import { assertEnvSupported } from './environment-guard';
import type { Module, RuntimeEnv } from './module';

export class Kernel {
  private scheduler: Scheduler;

  constructor(private injector: ServiceInjector, private currentEnv: RuntimeEnv = 'browser-extension') {
    this.scheduler = new Scheduler(injector);
  }

  async run(modules: Module[], input: unknown): Promise<unknown> {
    for (const mod of modules) assertEnvSupported(mod, this.currentEnv);

    const [pipelineModules, busModules] = partition(modules, (m) => !m.needs?.includes('bus'));
    for (const mod of busModules) {
      const ctx = this.injector.resolve(mod.needs);
      if (ctx.services.bus) this.scheduler.registerOnBus(mod, ctx.services.bus);
    }
    return this.scheduler.runPipeline(pipelineModules, input);
  }
}

function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const x of arr) (pred(x) ? yes : no).push(x);
  return [yes, no];
}
