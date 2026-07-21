import type { CacheService, Module } from '../../../../../kernel/module';
import type { CollectionCommand } from '../../../../../kernel/ui-schema';
import {
  HTTP_METHODS,
  MECHANISMS,
  buildFakeResponseInit,
  hasActiveMockConfig,
  matchMockConfig,
  validateMockConfig,
  type MockConfig,
} from '../../../../../shared/http-mock';
import type { EvaluateRequest, InterceptDecision } from '../../../utils/main-world/network-interceptor';
import { ensureDebuggerInterceptor, teardownDebuggerInterceptor } from '../../../utils/debugger-network-interceptor';
import { isModuleActive } from '../../../module-registry/storage';
import {
  isMainWorldScriptRegistered,
  registerMainWorldScript,
  unregisterMainWorldScript,
} from '../../../utils/main-world-injector';
// `&iife`, not `&module` — `?script&module` leaves the file as a raw ES module chunk (real `import`
// statements to shared chunks like http-mock.ts/event-channel.ts), which chrome.scripting always
// injects as a classic script; a classic script containing `import` throws a SyntaxError before a
// single line runs. `&iife` routes through crxjs's dedicated IIFE bundler, which inlines every
// dependency into one self-contained file with zero `import` statements — the only variant that
// actually executes when injected via chrome.scripting.registerContentScripts.
import payloadPath from './main-world-payload?script&iife';
import { MAIN_WORLD_SCRIPT_ID } from './constants';
import { getMockConfigs, setMockConfigs } from './mock-config-store';

/**
 * Background Module (docs/design.md §3.B, "browser-specific non-dom Modules" — see
 * main-world-interceptor skill for why this lives under background/modules/, not src/modules/).
 * Sole business authority for MockConfig: validates, persists (via the 'cache' capability, see
 * mock-config-store.ts), and decides whether the MAIN-world interceptor should be registered.
 * Delivered via the real Bus (needs: ['bus']) — see background/index.ts for the wiring and the
 * startup 'sync' emit.
 */
export const HttpErrorMockerModule: Module<CollectionCommand<MockConfig> | undefined, void> = {
  id: 'http-error-mocker',
  needs: ['bus', 'cache'],
  uiSchema: {
    kind: 'collection',
    itemLabel: 'mock rule',
    idField: 'id',
    activeField: 'active',
    fields: [
      { key: 'endpointPattern', label: 'Endpoint pattern (use * as wildcard)', type: 'string', required: true },
      { key: 'method', label: 'Method', type: 'enum', options: HTTP_METHODS, required: true },
      {
        key: 'mechanism',
        label: 'Mechanism (debugger = visible in Network tab + catches file/image requests, shows a debugging banner)',
        type: 'enum',
        options: MECHANISMS,
        required: true,
      },
      { key: 'fakeStatus', label: 'Fake status', type: 'number', required: true, min: 100, max: 599 },
      { key: 'fakeResponse', label: 'Fake response', type: 'string', multiline: true },
      { key: 'delayMs', label: 'Delay (ms)', type: 'number' },
    ],
  },
  // Read-side counterpart to the CollectionCommand write path below — lets the Dashboard's generic
  // Management View (docs/ROADMAP.md #2.5) read this Module's data without importing
  // mock-config-store.ts directly (see kernel/module.ts's listCollection doc comment).
  listCollection: async () => (await getMockConfigs()) as unknown as Record<string, unknown>[],
  async run(command, ctx) {
    // Module-level Slide Toggle gate — mirrors relay.ts's dom-module active check. Inactive means
    // both "ignore CRUD commands" and "tear down the interceptor", not just a cosmetic toggle.
    if (!(await isModuleActive('http-error-mocker'))) {
      if (await isMainWorldScriptRegistered(MAIN_WORLD_SCRIPT_ID)) {
        await unregisterMainWorldScript(MAIN_WORLD_SCRIPT_ID);
      }
      await teardownDebuggerInterceptor();
      return;
    }

    const cache = ctx.services.cache!;

    if (command?.op === 'upsert') {
      const result = validateMockConfig(command.item);
      if (!result.valid) throw new Error(`Invalid MockConfig: ${result.reason}`);
      const configs = await getMockConfigs(cache);
      const index = configs.findIndex((c) => c.id === result.config.id);
      if (index === -1) configs.push(result.config);
      else configs[index] = result.config;
      await setMockConfigs(configs, cache);
    } else if (command?.op === 'delete') {
      const configs = await getMockConfigs(cache);
      await setMockConfigs(configs.filter((c) => c.id !== command.id), cache);
    }

    await syncRegistration(cache);
  },
};

async function syncRegistration(cache: CacheService): Promise<void> {
  const [configs, registered] = await Promise.all([getMockConfigs(cache), isMainWorldScriptRegistered(MAIN_WORLD_SCRIPT_ID)]);

  // Always (re-)register while active, not just when nothing is registered yet — registerMainWorldScript
  // now updates in place, so this keeps the registration pointing at the current build's jsPath
  // instead of trusting a stale one left over from a previous build's content-hashed filename.
  if (hasActiveMockConfig(configs, 'main-world')) {
    await registerMainWorldScript({
      id: MAIN_WORLD_SCRIPT_ID,
      matches: ['<all_urls>'],
      jsPath: payloadPath,
      runAt: 'document_start',
    });
  } else if (registered) {
    await unregisterMainWorldScript(MAIN_WORLD_SCRIPT_ID);
  }

  // Same (re-)attach-every-time policy as the MAIN-world branch above, so `evaluateDebuggerRequest`'s
  // closure always sees the current config list rather than one snapshotted at first attach.
  if (hasActiveMockConfig(configs, 'debugger')) {
    await ensureDebuggerInterceptor((req) => evaluateDebuggerRequest(configs, req));
  } else {
    await teardownDebuggerInterceptor();
  }
}

function evaluateDebuggerRequest(configs: MockConfig[], { method, url }: Parameters<EvaluateRequest>[0]): InterceptDecision {
  const match = matchMockConfig(configs, url, method, 'debugger');
  if (!match) return { intercept: false };

  const fake = buildFakeResponseInit(match);
  return {
    intercept: true,
    response: {
      status: fake.status,
      statusText: fake.statusText,
      bodyText: fake.bodyText,
      ...(match.delayMs !== undefined ? { delayMs: match.delayMs } : {}),
    },
  };
}
