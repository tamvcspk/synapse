/**
 * Authoring-convenience types for writing a Synapse user script (uploaded via the extension
 * popup, Tampermonkey-style). Copy or reference this file in your own editor while writing your
 * script — it has no effect on the extension build (outside src/, excluded by tsconfig.json's
 * "include": ["src"]) and is never imported at runtime. At runtime `synapse` and
 * `__synapseModule` are plain globals injected by the extension; there is no `import` mechanism
 * available inside a registered user script. See docs/user-scripts.md for the full convention.
 */

type SynapseCapability = 'net' | 'ai' | 'cache' | 'bus' | 'dom';
type SynapseRuntimeEnv = 'browser-extension' | 'vscode' | 'electron' | 'node';

declare const synapse: {
  ai: {
    ask(input: unknown): Promise<unknown>;
  };
  cache: {
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  bus: {
    emit(event: string, payload: unknown): void;
    on(event: string, handler: (payload: unknown) => void): void;
  };
};

/**
 * Every user script must assign this before the extension can register it. `needs` determines
 * which `synapse.*` namespaces are populated at run time — declaring `needs: ['cache']` without
 * requesting the user's grant in the popup means `synapse.cache.*` calls will reject.
 */
declare let __synapseModule: {
  id: string;
  needs?: SynapseCapability[];
  supportedEnvs?: SynapseRuntimeEnv[];
  run(input: unknown, ctx: { services: Record<string, unknown> }): Promise<unknown>;
};
