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
