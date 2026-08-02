/**
 * Backs `synapseApi.page.eval` (docs/api-inventory.md §2/§6 item 7 — the `unsafeWindow` delta a
 * USER_SCRIPT-world script cannot close on its own). Runs `code` in the target tab's MAIN world via
 * `chrome.scripting.executeScript({world: 'MAIN'})` — the manifest already carries `scripting` +
 * `host_permissions: ['<all_urls>']`, so no new permission is needed to call it on any tab.
 *
 * Match-pattern enforcement (which tab this call may even reach) happens one layer up, in
 * `rpc-handler.ts`, using the REAL calling tab's url from `sender.tab` — never a url `code`'s caller
 * could supply — before this function is ever invoked (see `page.eval`'s `resourceUrl` extractor in
 * kernel/scopes.ts). By the time execution reaches here the call is already authorized; this file
 * only runs the code and bounds how long it may take.
 */

/** What `pageEvalRunner` resolves to inside the page, before this file unwraps it into a plain
 * return value or a thrown Error. Kept as data (never a bare throw across the injection boundary)
 * because `chrome.scripting.executeScript`'s own error-propagation shape is not something this
 * codebase has exercised before (docs/api-inventory.md §7) — an explicit `{ok, ...}` envelope is
 * authored here rather than trusted to survive however a given Chrome version forwards a rejection. */
export interface PageEvalOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Serialized by `chrome.scripting.executeScript` and re-evaluated inside the page's own MAIN world
 * — MUST NOT close over anything from this module or file (the whole point of `func`-based
 * injection: "any bound parameters and execution context will be lost", per `chrome.scripting`'s own
 * docs). `code` runs as the body of an async function, so `await` works inside it; whatever it
 * `return`s becomes this call's own result.
 *
 * A page whose `script-src` CSP excludes `unsafe-eval` rejects the `Function` construction itself —
 * caught here and reported as `{ok: false, error}` like any other failure inside `code`, rather than
 * a bypass attempt. There is no workaround for that in v1; see `SynapsePageApi`'s doc comment.
 */
export function pageEvalRunner(code: string, args: unknown[]): Promise<PageEvalOutcome> {
  return (async () => {
    try {
      // This IS page.eval: running script-authored code in the page's own world is the entire
      // point (docs/api-inventory.md §2, "unsafeWindow" delta) — not a stray dynamic-eval to avoid.
      const fn = new Function('args', `"use strict";\nreturn (async () => {\n${code}\n})(...args);`);
      const result = await fn(args);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
  })();
}

/** Isolates the one `chrome.scripting` call this file makes, so `performPageEval`'s own validation
 * and timeout logic are unit-testable in `environment: 'node'` without a `chrome.*` global — the
 * same DI pattern `net-mock-host.ts`'s `MockRuleStore` and `files-save-host.ts`'s `DownloadsBackend`
 * use for the same reason. */
export interface PageEvalBackend {
  /** Resolves to the frame's own `PageEvalOutcome`, or `undefined` when the tab produced no result
   * at all (closed, navigated away, or otherwise never actually ran the injection). */
  run(tabId: number, code: string, args: unknown[]): Promise<PageEvalOutcome | undefined>;
}

const realBackend: PageEvalBackend = {
  run: async (tabId, code, args) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: pageEvalRunner,
      args: [code, args],
    });
    return results[0]?.result;
  },
};

/** A hung `code` (a synchronous infinite loop, or a Promise that never settles) cannot be cancelled
 * once injected — `chrome.scripting.executeScript` has no abort signal, unlike `net.request`'s
 * `fetch`. This bounds how long THIS CALL waits, not how long `code` actually runs in the page; a
 * script that ends up racing that way learns about it via the timeout error, same as `net.request`. */
const PAGE_EVAL_TIMEOUT_MS = 30_000;

export async function performPageEval(
  tabId: number,
  code: string,
  // `unknown[] | null | undefined`, not just `unknown[] = []`: an omitted `args` at the call site
  // (`ctx.api.page.eval(code)`) is `undefined` in the shim, but real Chrome was observed turning
  // that into `null` somewhere on its way across `chrome.runtime.sendMessage`'s USER_SCRIPT-world →
  // background boundary (the same behavior `JSON.stringify` has for an `undefined` ARRAY element,
  // vs. dropping an `undefined` object property outright) — a JS default parameter only substitutes
  // for `undefined`, never `null`, so `args` arrived here as `null` and failed the array check below
  // even though the caller never passed anything invalid. `?? []` immediately after catches both.
  args: unknown[] | null | undefined,
  backend: PageEvalBackend = realBackend,
): Promise<unknown> {
  if (typeof code !== 'string' || code === '') {
    throw new Error('page.eval: "code" is required');
  }
  const normalizedArgs = args ?? [];
  if (!Array.isArray(normalizedArgs)) {
    throw new Error('page.eval: "args" must be an array');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`page.eval: timed out after ${PAGE_EVAL_TIMEOUT_MS}ms`)), PAGE_EVAL_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([backend.run(tabId, code, normalizedArgs), timeout]);
    if (!outcome) {
      throw new Error('page.eval: no result from the page (was the tab closed or navigated away?)');
    }
    if (!outcome.ok) {
      throw new Error(`page.eval: ${outcome.error}`);
    }
    return outcome.result;
  } finally {
    clearTimeout(timer);
  }
}
