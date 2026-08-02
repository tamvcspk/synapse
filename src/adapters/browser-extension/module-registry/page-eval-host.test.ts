import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageEvalRunner, performPageEval, type PageEvalBackend, type PageEvalOutcome } from './page-eval-host';

/**
 * `pageEvalRunner` is the function actually serialized into the page's MAIN world by
 * `chrome.scripting.executeScript` (real-backend wiring only, never exercised here) — it has no
 * `chrome.*` dependency of its own, so its `new Function`/try-catch logic is directly testable in
 * plain Node, independent of the executeScript plumbing `performPageEval`'s own tests fake out.
 */
describe('pageEvalRunner', () => {
  it('runs code as an async function body and returns its return value', async () => {
    await expect(pageEvalRunner('return 1 + 1;', [])).resolves.toEqual({ ok: true, result: 2 });
  });

  it('passes args through as the args parameter', async () => {
    await expect(pageEvalRunner('return args[0] + args[1];', [2, 3])).resolves.toEqual({ ok: true, result: 5 });
  });

  it('supports await inside code', async () => {
    await expect(
      pageEvalRunner('const x = await Promise.resolve(41); return x + 1;', []),
    ).resolves.toEqual({ ok: true, result: 42 });
  });

  it('resolves to ok:true with no result field when code returns nothing', async () => {
    const outcome = await pageEvalRunner('const x = 1;', []);
    expect(outcome).toEqual({ ok: true, result: undefined });
  });

  it('catches a synchronous throw inside code and reports it as {ok:false, error}', async () => {
    await expect(pageEvalRunner('throw new Error("boom");', [])).resolves.toEqual({
      ok: false,
      error: 'Error: boom',
    });
  });

  it('catches a rejected await inside code the same way', async () => {
    await expect(
      pageEvalRunner('await Promise.reject(new Error("async boom"));', []),
    ).resolves.toEqual({ ok: false, error: 'Error: async boom' });
  });

  it('catches a ReferenceError from code touching an undeclared name', async () => {
    const outcome = await pageEvalRunner('return undeclaredThing;', []);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/ReferenceError/);
  });
});

/**
 * `chrome.scripting.executeScript` is never touched here — a `PageEvalBackend` fake stands in (same
 * DI pattern `net-mock-host.test.ts`'s `MockRuleStore` fake and `files-save-host.test.ts`'s
 * `DownloadsBackend` fake use), so these tests pin what `performPageEval` itself does: input
 * validation, unwrapping the frame's own `{ok, result, error}` envelope, and the timeout race. Match
 * enforcement (which tab a script may even reach) is `rpc-handler.ts`'s job, covered in
 * scopes.test.ts, not this file's.
 */
function fakeBackend(run: PageEvalBackend['run']): PageEvalBackend {
  return { run };
}

describe('performPageEval', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a missing/empty code before ever calling the backend', async () => {
    const runSpy = vi.fn();
    await expect(performPageEval(1, '', [], fakeBackend(runSpy))).rejects.toThrow(/"code" is required/);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-array args before ever calling the backend', async () => {
    const runSpy = vi.fn();
    await expect(
      performPageEval(1, 'return 1;', 'not-an-array' as unknown as unknown[], fakeBackend(runSpy)),
    ).rejects.toThrow(/"args" must be an array/);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('treats null the same as undefined/omitted — real Chrome observed turning an omitted args into null across the RPC boundary, not undefined', async () => {
    const runSpy = vi.fn(async (): Promise<PageEvalOutcome> => ({ ok: true, result: 1 }));
    await performPageEval(1, 'return 1;', null, fakeBackend(runSpy));
    expect(runSpy).toHaveBeenCalledWith(1, 'return 1;', []);
  });

  it('defaults args to [] and passes tabId/code/args straight to the backend', async () => {
    const runSpy = vi.fn(async (): Promise<PageEvalOutcome> => ({ ok: true, result: 42 }));

    await performPageEval(7, 'return 1 + 1;', undefined, fakeBackend(runSpy));

    expect(runSpy).toHaveBeenCalledWith(7, 'return 1 + 1;', []);
  });

  it('resolves to the frame\'s own result when the outcome is ok', async () => {
    const backend = fakeBackend(async () => ({ ok: true, result: { hello: 'from the page' } }));

    await expect(performPageEval(1, 'return {hello: "from the page"};', [], backend)).resolves.toEqual({
      hello: 'from the page',
    });
  });

  it('resolves to undefined when the frame ok-returns nothing', async () => {
    const backend = fakeBackend(async () => ({ ok: true }));
    await expect(performPageEval(1, '/* no return */', [], backend)).resolves.toBeUndefined();
  });

  it('rejects with the frame\'s own error when code inside the page threw', async () => {
    const backend = fakeBackend(async () => ({ ok: false, error: 'ReferenceError: nope is not defined' }));
    await expect(performPageEval(1, 'return nope;', [], backend)).rejects.toThrow(
      /page\.eval: ReferenceError: nope is not defined/,
    );
  });

  it('rejects when the tab produced no result at all (closed / navigated away)', async () => {
    const backend = fakeBackend(async () => undefined);
    await expect(performPageEval(1, 'return 1;', [], backend)).rejects.toThrow(
      /no result from the page/,
    );
  });

  it('times out rather than hanging forever when the backend never resolves', async () => {
    vi.useFakeTimers();
    const backend = fakeBackend(() => new Promise<PageEvalOutcome | undefined>(() => {}));

    const pending = performPageEval(1, 'while (true) {}', [], backend);
    const assertion = expect(pending).rejects.toThrow(/timed out after 30000ms/);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
