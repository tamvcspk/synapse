import type { AiService, BusService, Capability, CacheService, ModuleContext } from './module';
import { htmlToMarkdown } from '../shared/html-to-markdown';
import { isValidMatchPattern, matchesAnyPattern, matchesUrlPattern } from '../shared/match-pattern';
import { parseM3u8 } from '../shared/media-manifest-parser';
import { buildZip } from '../shared/zip';
import type { SynapseApi } from './synapse-api';

/**
 * Builds a Module's `ModuleContext`: the Kernel Services it declared (`needs`, build-time
 * dependency injection) plus `api`, the in-process transport of the public `synapseApi` contract
 * (docs/ROADMAP.md §11.3). `api` is per-Module, not shared, because everything it exposes is
 * namespaced by the calling module's id — handing one instance to everybody would be the same
 * unnamespaced-shared-store mistake the Capability model was retired for.
 */
export class ServiceInjector {
  private ai?: AiService;
  private cache?: CacheService;
  private bus?: BusService;

  constructor(private factories: {
    ai?: () => AiService;
    cache?: () => CacheService;
    bus?: () => BusService;
    api?: (moduleId: string) => SynapseApi;
  }) {}

  resolve(needs: Capability[] = [], moduleId = ''): ModuleContext {
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

    return { services, api: this.factories.api?.(moduleId) ?? unavailableSynapseApi(moduleId) };
  }

  private requireFactory<T>(name: string, factory?: () => T): () => T {
    if (!factory) throw new Error(`No factory registered for capability "${name}"`);
    return factory;
  }
}

/**
 * Stand-in for contexts with no API host wired (Kernel unit tests, and any Adapter that forgets
 * the factory). Every method rejects with a real error instead of resolving `undefined` — a
 * silently no-op API is precisely the failure the old `needs: ['net'|'dom']` produced, and the
 * whole point of §11.3 is that permissions and capabilities fail loudly.
 */
function unavailableSynapseApi(moduleId: string): SynapseApi {
  const message = `synapseApi is not available in this context (module "${moduleId}")`;
  const fail = (): Promise<never> => Promise.reject(new Error(message));
  // `ui` is synchronous (it never crosses a transport — see synapse-api.ts), so its unavailable
  // form has to THROW rather than reject: returning a rejected promise from a method typed as
  // returning `boolean` would be a lie the caller could not act on.
  const failSync = (): never => {
    throw new Error(message);
  };
  return {
    storage: { get: fail, set: fail, remove: fail, keys: fail },
    ui: { toast: failSync, icon: failSync, badge: failSync, dismiss: failSync, clear: failSync },
    net: { request: fail, mock: { add: fail, remove: fail, list: fail } },
    files: { save: fail },
    // onProgress is synchronous like ui.* (see synapse-api.ts), so it needs failSync too, not fail.
    media: { list: fail, inspect: fail, download: fail, job: fail, control: fail, onProgress: failSync },
    page: { eval: fail },
    // hls.parse/toMarkdown/zip have no context dependency to be "unavailable" — pure computation
    // (docs/api-inventory.md §3.0) importable straight from shared/, so the real implementation is
    // always constructible here. `readable` is the one exception: its real implementation lives in
    // module-registry/lib-readable.ts (browser-extension Adapter layer), which kernel/ must not
    // depend on — so it gets the same throwing stub as everything else in this fallback.
    lib: {
      hls: { parse: parseM3u8 },
      readable: failSync,
      toMarkdown: htmlToMarkdown,
      zip: buildZip,
      matchPattern: { isValid: isValidMatchPattern, test: matchesUrlPattern, testAny: matchesAnyPattern },
    },
  };
}
