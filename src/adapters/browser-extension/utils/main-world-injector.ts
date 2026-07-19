/**
 * Generic background-only wrapper around chrome.scripting's dynamic content-script registration
 * (Environment SDK — see the sdk-layers skill's mechanism-vs-policy rule). No domain knowledge:
 * callers decide *when* to register/unregister (that's business policy — see
 * background/modules/http-error-mocker/index.ts) and *what* script to register (a built path,
 * typically obtained via a `?script&module` resource import — see the main-world-interceptor
 * skill). chrome.scripting is only available in the background/service-worker context, never in a
 * content script.
 */
export interface MainWorldScriptSpec {
  id: string;
  matches: string[];
  jsPath: string;
  runAt?: 'document_start' | 'document_end' | 'document_idle';
}

export async function isMainWorldScriptRegistered(id: string): Promise<boolean> {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  return scripts.length > 0;
}

export async function registerMainWorldScript(spec: MainWorldScriptSpec): Promise<void> {
  await chrome.scripting.registerContentScripts([
    {
      id: spec.id,
      matches: spec.matches,
      js: [spec.jsPath],
      world: 'MAIN',
      runAt: spec.runAt ?? 'document_start',
    },
  ]);
}

export async function unregisterMainWorldScript(id: string): Promise<void> {
  await chrome.scripting.unregisterContentScripts({ ids: [id] });
}
