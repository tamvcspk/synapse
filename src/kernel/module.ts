import type { UISchema } from './ui-schema';

export type Capability = 'net' | 'ai' | 'cache' | 'bus' | 'dom';
export const CAPABILITIES: Capability[] = ['net', 'ai', 'cache', 'bus', 'dom'];

/**
 * Runtime environments Synapse's Hexagonal Core can be deployed into (docs/design.md §1).
 * Only 'browser-extension' has an Adapter implementation today — 'vscode' | 'electron' | 'node'
 * are reserved enum values for future Adapters and must not be treated as usable.
 */
export type RuntimeEnv = 'browser-extension' | 'vscode' | 'electron' | 'node';
export const RUNTIME_ENVS: RuntimeEnv[] = ['browser-extension', 'vscode', 'electron', 'node'];

export interface ModuleContext {
  services: Partial<{
    ai: AiService;
    cache: CacheService;
    bus: BusService;
  }>;
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
  needs?: Capability[];
  /**
   * Environments this Module may run in. Defaults to ['browser-extension'] when omitted, since
   * that's the only Adapter Synapse currently ships — see environment-guard.ts.
   */
  supportedEnvs?: RuntimeEnv[];
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
  on(event: string, handler: (payload: unknown) => void): void;
}

/** Reported by the Scheduler when a Module's run() throws, instead of crashing the pipeline/bus. */
export interface ModuleFailure {
  moduleId: string;
  error: string;
}
