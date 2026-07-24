import type { CacheService, Module } from '../../../../../kernel/module';
import type { CollectionCommand } from '../../../../../kernel/ui-schema';
import {
  ACTIONS,
  HTTP_METHODS,
  MECHANISMS,
  buildFakeResponseInit,
  buildRewriteOverrides,
  endpointPatternToRegexSource,
  getAction,
  hasActiveMockConfig,
  matchMockConfig,
  validateMockConfig,
  type MockConfig,
} from '../../../../../shared/http-mock';
import type { InterceptRequest } from '../../../utils/main-world/network-interceptor';
import {
  ensureDebuggerInterceptor,
  teardownDebuggerInterceptor,
  type DebuggerInterceptDecision,
} from '../../../utils/debugger-network-interceptor';
import { clearDnrRules, syncDnrRules, type DnrRuleSpec } from '../../../utils/dnr-network-rules';
import { bytesToBase64, deleteBlob, getBlob } from '../../../utils/blob-store';
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
import { MOCK_FILES } from './mock-files';

const REWRITE_URL_SUGGESTIONS = MOCK_FILES.map((f) => ({ label: f.fileName, value: f.url }));

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
  label: 'HTTP Mock & Rewrite',
  description:
    'Fake, rewrite, or block HTTP requests matching a pattern — for testing error handling, mocking APIs, or serving canned/uploaded-file responses without a real backend.',
  needs: ['bus', 'cache'],
  uiSchema: {
    kind: 'collection',
    itemLabel: 'mock rule',
    idField: 'id',
    activeField: 'active',
    fields: [
      { key: 'endpointPattern', label: 'Endpoint pattern', hint: 'Use * as a wildcard', type: 'string', required: true },
      { key: 'method', label: 'Method', type: 'enum', options: HTTP_METHODS, required: true },
      // mechanism/action come first and control everything below via showWhen (docs/ROADMAP.md
      // #2.6.1's "mechanism lên đầu form, phần còn lại re-render theo lựa chọn") — item-form-view.ts
      // renders these two unconditionally and hides/shows the rest based on their live selection.
      {
        key: 'mechanism',
        label: 'Mechanism',
        hint: 'debugger/dnr = visible in Network tab + catch file/image requests; debugger shows a debugging banner, dnr does not but can\'t rewrite/match request bodies',
        type: 'enum',
        options: MECHANISMS,
        required: true,
      },
      {
        key: 'action',
        label: 'Action',
        hint: '"block" only works with mechanism: debugger or dnr — main-world can only reject a Promise in JS, not a real network failure',
        type: 'enum',
        options: ACTIONS,
        required: true,
      },
      {
        key: 'fakeStatus',
        label: 'Fake status',
        type: 'number',
        required: true,
        min: 100,
        max: 599,
        // mechanism: 'dnr' can only fake-response via a data: URL redirect (see fakeResponseFile's
        // doc comment), which has no HTTP status-code concept — always resolves as a successful
        // load no matter what's configured here, so hidden entirely for it rather than shown but
        // silently ignored.
        showWhen: [
          { field: 'action', equals: ['fake-response'] },
          { field: 'mechanism', equals: ['main-world', 'debugger'] },
        ],
      },
      {
        key: 'fakeResponse',
        label: 'Fake response',
        type: 'string',
        multiline: true,
        showWhen: { field: 'action', equals: ['fake-response'] },
      },
      {
        key: 'fakeResponseFile',
        label: 'Or upload a file',
        hint: 'Takes precedence over the text above; files over ~2MB only work with mechanism: debugger, not main-world',
        type: 'file',
        fileInlineKey: 'fakeResponseFileInline',
        fileNameKey: 'fakeResponseFileName',
        showWhen: { field: 'action', equals: ['fake-response'] },
      },
      { key: 'delayMs', label: 'Delay (ms)', type: 'number', showWhen: { field: 'action', equals: ['fake-response'] } },
      {
        key: 'responseHeaders',
        label: 'Custom response headers',
        hint: 'JSON object, merged into the fake response',
        type: 'string',
        multiline: true,
        advanced: true,
        showWhen: { field: 'action', equals: ['fake-response'] },
      },
      {
        key: 'rewriteUrl',
        label: 'Rewrite URL',
        hint: 'Absolute or relative; leave empty to keep the original. Suggestions are files bundled under mock-files/ — drop a file there and rebuild to add more',
        type: 'string',
        suggestions: REWRITE_URL_SUGGESTIONS,
        showWhen: { field: 'action', equals: ['rewrite-request'] },
      },
      {
        key: 'rewriteMethod',
        label: 'Rewrite method',
        hint: 'Leave empty to keep the original',
        type: 'string',
        // mechanism: 'dnr' has no action to change the request method — hidden entirely for it
        // rather than shown-but-rejected (validateMockConfig still hard-rejects it too, as a
        // backstop against any other caller of the write path, e.g. a future scripted import).
        showWhen: [
          { field: 'action', equals: ['rewrite-request'] },
          { field: 'mechanism', equals: ['main-world', 'debugger'] },
        ],
      },
      {
        key: 'rewriteHeaders',
        label: 'Rewrite headers',
        hint: 'JSON object, merged into the request',
        type: 'string',
        multiline: true,
        showWhen: { field: 'action', equals: ['rewrite-request'] },
      },
      {
        key: 'rewriteBody',
        label: 'Rewrite body',
        hint: 'Leave empty to keep the original',
        type: 'string',
        multiline: true,
        // Same reasoning as rewriteMethod above — mechanism: 'dnr' has no action to rewrite the
        // request body at all.
        showWhen: [
          { field: 'action', equals: ['rewrite-request'] },
          { field: 'mechanism', equals: ['main-world', 'debugger'] },
        ],
      },
      // Not tied to any single action via showWhen — matching is orthogonal to what a rule does
      // once matched, so this applies the same way to fake-response/rewrite-request/block alike.
      // mechanism: 'dnr' is excluded, though (unlike hitCountLimit below) — it can't inspect the
      // request content at all (see validateMockConfig), so shown-but-rejected would be more
      // confusing than just not offering it.
      {
        key: 'requestMatchContains',
        label: 'Only match if contains',
        hint: "Substring match against the URL/body; main-world's XHR path can only check the URL, not the body — see docs/ROADMAP.md #2.6.1",
        type: 'string',
        advanced: true,
        showWhen: { field: 'mechanism', equals: ['main-world', 'debugger'] },
      },
      {
        key: 'hitCountLimit',
        label: 'Auto-disable after N matches',
        hint: 'mechanism: debugger only — main-world and dnr do not persist a count',
        type: 'number',
        min: 1,
        advanced: true,
      },
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
      await clearDnrRules('http-error-mocker');
      return;
    }

    const cache = ctx.services.cache!;

    if (command?.op === 'upsert') {
      const result = validateMockConfig(command.item);
      if (!result.valid) throw new Error(`Invalid MockConfig: ${result.reason}`);
      const configs = await getMockConfigs(cache);
      const index = configs.findIndex((c) => c.id === result.config.id);
      // Replacing a rule's uploaded file (or clearing it/switching away from fake-response) leaves
      // the old blob orphaned in IndexedDB unless cleaned up here — the only place both the old and
      // new value are in hand at once.
      const previousBlobRef = index === -1 ? undefined : configs[index]?.fakeResponseFile;
      if (previousBlobRef && previousBlobRef !== result.config.fakeResponseFile) {
        await deleteBlob(previousBlobRef);
      }
      if (index === -1) configs.push(result.config);
      else configs[index] = result.config;
      await setMockConfigs(configs, cache);
    } else if (command?.op === 'delete') {
      const configs = await getMockConfigs(cache);
      const deleted = configs.find((c) => c.id === command.id);
      if (deleted?.fakeResponseFile) await deleteBlob(deleted.fakeResponseFile);
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
    await ensureDebuggerInterceptor((req) => evaluateDebuggerRequest(configs, req, cache));
  } else {
    await teardownDebuggerInterceptor();
  }

  // 'dnr' has no live callback to (re-)attach — just recompute the full desired rule set and hand
  // it to syncDnrRules every time, same re-sync-every-time policy as the two branches above.
  if (hasActiveMockConfig(configs, 'dnr')) {
    await syncDnrRules('http-error-mocker', await buildDnrRuleSpecs(configs));
  } else {
    await clearDnrRules('http-error-mocker');
  }
}

/** Builds the declarative rule set for every active `mechanism: 'dnr'` config — unlike
 * `evaluateDebuggerRequest`, this runs once per sync (not per request; DNR has no per-request
 * callback), producing the *entire* desired rule set up front. */
async function buildDnrRuleSpecs(configs: MockConfig[]): Promise<DnrRuleSpec[]> {
  const specs: DnrRuleSpec[] = [];

  for (const config of configs) {
    if (!config.active || config.mechanism !== 'dnr') continue;
    const urlRegex = endpointPatternToRegexSource(config.endpointPattern);
    const action = getAction(config);

    if (action === 'block') {
      specs.push({ id: config.id, urlRegex, method: config.method, action: { kind: 'block' } });
      continue;
    }

    if (action === 'rewrite-request') {
      // validateMockConfig already rejects rewriteMethod/rewriteBody for mechanism: 'dnr' — only
      // url/headers ever reach here, which is all a DNR redirect+modifyHeaders pair can express.
      const overrides = buildRewriteOverrides(config);
      if (!overrides.url) continue; // nothing to redirect to — dnr's rewrite is redirect-only
      specs.push({
        id: config.id,
        urlRegex,
        method: config.method,
        action: { kind: 'redirect', url: overrides.url, ...(overrides.headers ? { requestHeaders: overrides.headers } : {}) },
      });
      continue;
    }

    // fake-response: dnr has no way to synthesize a response body directly — the only way to
    // "answer" a request without touching its real destination is to redirect to a data: URL that
    // already contains the desired bytes. This always resolves as a plain, successful load — a
    // data: URL has no HTTP status-code concept, so `fakeStatus` cannot be honored here (a
    // documented reduced-fidelity trade-off of this mechanism, not a bug to fix).
    const fake = buildFakeResponseInit(config);
    let mimeType = 'application/json';
    let base64: string;
    if (config.fakeResponseFile) {
      const blob = await getBlob(config.fakeResponseFile);
      if (!blob) continue;
      mimeType = blob.mimeType;
      base64 = bytesToBase64(blob.bytes);
    } else if (config.fakeResponseFileInline) {
      mimeType = config.fakeResponseFileInline.mimeType;
      base64 = config.fakeResponseFileInline.base64;
    } else {
      base64 = bytesToBase64(new TextEncoder().encode(fake.bodyText).buffer);
    }

    specs.push({
      id: config.id,
      urlRegex,
      method: config.method,
      action: {
        kind: 'redirect',
        url: `data:${mimeType};base64,${base64}`,
        ...(fake.headers ? { responseHeaders: fake.headers } : {}),
      },
    });
  }

  return specs;
}

async function evaluateDebuggerRequest(
  configs: MockConfig[],
  { method, url, body }: InterceptRequest,
  cache: CacheService,
): Promise<DebuggerInterceptDecision> {
  const match = matchMockConfig(configs, url, method, 'debugger', body);
  if (!match) return { intercept: false };

  // Fire-and-forget: persisting the incremented count must never delay the actual
  // continue/fulfill/fail decision below. Only `debugger` rules get here at all — `main-world`'s
  // evaluate() has no chrome.* access to persist a count with (see hitCountLimit's doc comment).
  if (match.hitCountLimit !== undefined) void recordHit(match.id, match.hitCountLimit, cache);

  const action = getAction(match);
  if (action === 'block') return { intercept: 'block' };
  if (action === 'rewrite-request') return { intercept: 'rewrite', overrides: buildRewriteOverrides(match) };

  const fake = buildFakeResponseInit(match);

  // fakeResponseFile takes precedence over fakeResponse text (see MockConfig's doc comment) —
  // only resolvable here (background has IndexedDB access; shared/http-mock.ts's
  // buildFakeResponseInit deliberately doesn't, per its own no-I/O Global SDK constraint).
  if (match.fakeResponseFile) {
    const blob = await getBlob(match.fakeResponseFile);
    if (blob) {
      return {
        intercept: true,
        response: {
          status: fake.status,
          statusText: fake.statusText,
          bodyText: bytesToBase64(blob.bytes),
          bodyEncoding: 'base64',
          headers: { 'Content-Type': blob.mimeType, ...fake.headers },
          ...(match.delayMs !== undefined ? { delayMs: match.delayMs } : {}),
        },
      };
    }
  }

  return {
    intercept: true,
    response: {
      status: fake.status,
      statusText: fake.statusText,
      bodyText: fake.bodyText,
      ...(match.delayMs !== undefined ? { delayMs: match.delayMs } : {}),
      ...(fake.headers ? { headers: fake.headers } : {}),
    },
  };
}

/** Increments `matchCount` for one rule and auto-disables it once `hitCountLimit` is reached —
 * re-reads/re-writes the full config list (same pattern as the upsert/delete branches in `run()`)
 * since chrome.storage.local has no atomic per-key increment. Re-runs `syncRegistration` afterward
 * so a rule that just disabled itself (e.g. the last active debugger rule) detaches promptly
 * instead of lingering until the next unrelated CRUD command. */
async function recordHit(id: string, hitCountLimit: number, cache: CacheService): Promise<void> {
  const configs = await getMockConfigs(cache);
  const index = configs.findIndex((c) => c.id === id);
  const existing = configs[index];
  if (!existing) return;

  const nextCount = (existing.matchCount ?? 0) + 1;
  configs[index] = { ...existing, matchCount: nextCount, ...(nextCount >= hitCountLimit ? { active: false } : {}) };
  await setMockConfigs(configs, cache);
  await syncRegistration(cache);
}
