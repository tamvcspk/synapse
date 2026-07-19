import type { AiService, BusService, Capability, CacheService, ModuleContext } from './module';

export class ServiceInjector {
  private ai?: AiService;
  private cache?: CacheService;
  private bus?: BusService;

  constructor(private factories: {
    ai?: () => AiService;
    cache?: () => CacheService;
    bus?: () => BusService;
  }) {}

  resolve(needs: Capability[] = []): ModuleContext {
    const services: ModuleContext['services'] = {};

    if (needs.includes('ai')) {
      services.ai = this.ai ??= this.requireFactory('ai', this.factories.ai)();
    }
    if (needs.includes('cache')) {
      services.cache = this.cache ??= this.requireFactory('cache', this.factories.cache)();
    }
    if (needs.includes('bus')) {
      services.bus = this.bus ??= this.requireFactory('bus', this.factories.bus)();
    }

    return { services };
  }

  private requireFactory<T>(name: string, factory?: () => T): () => T {
    if (!factory) throw new Error(`No factory registered for capability "${name}"`);
    return factory;
  }
}
