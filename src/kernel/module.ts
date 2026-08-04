import type { SynapseApi, SynapseScopeGrant } from './synapse-api';
import type { UISchema } from './ui-schema';

/**
 * Which Kernel Services get injected into a bundled Module's `ctx.services`. This is **dependency
 * injection for build-time code, not a permission model** — the two used to be the same field
 * (`needs`) and conflating them is what made the old model unusable (docs/ROADMAP.md §11.3):
 * `bus` can never be a user-facing permission (`bus.emit(moduleId, …)` reaches every bundled
 * Module's listener), while `'net'`/`'dom'` resolved to no service at all, so declaring them was a
 * silent no-op. Permission for anything a *script* can ask for is `Module.scopes`
 * (`kernel/scopes.ts`); this list is now only the three names that resolve to a real service.
 */
export type Capability = 'ai' | 'cache' | 'bus';
export const CAPABILITIES: Capability[] = ['ai', 'cache', 'bus'];

/**
 * There is no `RuntimeEnv` type here anymore, and no `supportedEnvs` on `Module` (docs/ROADMAP.md
 * §11.1, docs/design.md §8): the browser extension is the only runtime Synapse targets, by
 * decision, not by "not yet". Every feature the project actually has depends on `webRequest`/DNR/
 * CDP/`userScripts`/offscreen documents/real web pages — the browser IS the domain. The Hexagonal
 * boundary survives for testability and dependency discipline (`kernel/` + `shared/` stay free of
 * `chrome.*`), which is a claim this repo's tests can check; portability was a claim nothing could.
 */

export interface ModuleContext {
  services: Partial<{
    ai: AiService;
    cache: CacheService;
    bus: BusService;
  }>;
  /**
   * The public contract (docs/ROADMAP.md §11.3) — the same `synapseApi` an uploaded user script
   * gets as a global, handed to bundled Modules here so all three transports (in-process, content
   * script RPC, user script shim) are one interface. A Module reached through a context with no
   * API host wired gets a stub whose methods reject with a real error rather than silently
   * resolving `undefined` (see `service-injector.ts`).
   */
  api: SynapseApi;
}

export interface Module<In = unknown, Out = unknown> {
  id: string;
  /** Human-friendly display name — shown by the Registry UI (popup list, Dashboard Management View
   * header) instead of the raw `id`. Optional: falls back to `id` when a Module (bundled or
   * uploaded) doesn't declare one. Uploaded modules get this from their self-declared
   * `__synapseModule.id` via a ManifestReport instead (see chrome-module-registry.ts) — bundled
   * modules set it directly here. */
  label?: string;
  /** One-sentence explanation of what the Module does, for a reader browsing the Registry list —
   * distinct from `label` (a short name) and from any in-form field `hint` (explains one input,
   * not the whole Module). */
  description?: string;
  /** Kernel Services to inject — build-time dependency injection, NOT permission. See `Capability`. */
  needs?: Capability[];
  /**
   * Permissions this Module asks for on the `synapseApi` surface (docs/ROADMAP.md §11.3). For a
   * bundled Module this is trusted build-time code and the grant is derived from this declaration,
   * never persisted; for an uploaded script the equivalent declaration is only a *request* and the
   * stored grant record is the authority (`module-registry/storage.ts`).
   */
  scopes?: SynapseScopeGrant[];
  /** Declarative UI Schema (docs/ROADMAP.md #2) — presence of this field is what makes the
   * popup show a Gear/Arrow icon for this Module; its `kind` decides the icon's behavior. */
  uiSchema?: UISchema;
  /**
   * Composite Module (docs/ROADMAP.md #3) — the ordered list of sub-modules this Module runs
   * sequentially inside its own `run()` (see `kernel/composite-module.ts`'s `createCompositeModule`).
   * Purely declarative metadata for the Registry UI to render a per-step bypass toggle
   * (`RegistryEntry.subState`) — the Kernel/Registry never invokes these sub-modules directly,
   * only this Module's own `run()` does.
   */
  subModules?: { id: string; label?: string }[];
  /**
   * Points at a template under `ui/studio/templates/` (docs/ROADMAP.md §12.4) — presence is what
   * makes the Registry UI show a "Clone" button for this (necessarily read-only, build-time)
   * Module. Cloning never copies this Module's own source (its TS is not something a user script
   * can run or edit); it opens Studio's "New script" flow pre-filled with the named template
   * instead, same mechanism either way.
   */
  templateId?: string;
  /**
   * On-page UI paradigm this Module opts into, beyond the default "no on-page UI, everything
   * lives in the Dashboard/popup" (docs/ROADMAP.md §4.2). `'float-widget'` is the only paradigm
   * with a real implementation today (utils/ui-compositor.ts + network-sniffer's push) —
   * `'action-button'` is a reserved value for a still-deferred paradigm, not yet usable. Absent
   * (or `'none'`) means the Module has no on-page presence, only Registry-driven UI.
   */
  uiParadigm?: 'none' | 'dedicated-page' | 'float-widget' | 'action-button';
  /**
   * Read-side counterpart to a `'collection'` uiSchema's write path (CollectionCommand, handled
   * inside `run()`) — the Module's own storage read, self-registered here instead of the
   * Management View (docs/ROADMAP.md #2/#2.5) importing a specific module's storage file by name.
   * The Module owns its storage shape, so it's the only place allowed to cast it down to
   * `Record<string, unknown>[]` for the generic renderer.
   */
  listCollection?(): Promise<Record<string, unknown>[]>;
  run(input: In, ctx: ModuleContext): Promise<Out>;
}

export interface AiService {
  ask(input: unknown): Promise<unknown>;
}

export interface CacheService {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface BusService {
  emit(event: string, payload: unknown): void;
  /** A handler MAY return a Promise — the transport (e.g. chromeRuntimeBus) awaits it and threads
   * the outcome back to `chrome.runtime.sendMessage`'s own caller (`sendResponse`/its returned
   * Promise), so a caller that cares whether its message actually succeeded (docs/ROADMAP.md
   * §11.5's `CollectionCommand` write path, previously fire-and-forget with no way to see a
   * `validateMockConfig` rejection) can `await` it. A handler that returns `void` keeps today's
   * fire-and-forget behavior — nothing about existing bus.on(id, (payload) => {...}) callers
   * changes. */
  on(event: string, handler: (payload: unknown) => void | Promise<unknown>): void;
}

/** Reported by the Scheduler when a Module's run() throws, instead of crashing the pipeline/bus. */
export interface ModuleFailure {
  moduleId: string;
  error: string;
}
