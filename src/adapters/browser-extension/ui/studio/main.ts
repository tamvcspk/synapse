import './studio.css';
import * as monaco from 'monaco-editor';
// monaco-editor 0.53+ moved the TS/JS language service out of `monaco.languages.typescript`
// (now `{ deprecated: true }`) into a top-level `typescript` export with the same shape.
import { typescript } from 'monaco-editor';
// No `esm/vs/` prefix and a mandatory `.js` suffix — the package's `exports` map is
// `'./*.js': './esm/vs/*.js'`, so it already prepends `esm/vs/`; including it in the specifier
// resolves to a nonexistent doubled `esm/vs/esm/vs/...` path.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker';
import synapseUserscriptDts from '../../../../../docs/types/synapse-userscript.d.ts?raw';

/**
 * §12.2 spike (docs/ROADMAP.md §12.0/§12.2) — NOT the real Studio page. Only question this answers:
 * does Monaco's language-service worker actually start under MV3's default extension_pages CSP
 * (`script-src 'self' 'wasm-unsafe-eval'`, no `unsafe-eval`)? Green → build the real Studio on top of
 * this; red → switch to CodeMirror 6 and record why in docs/LESSONS.md next to the Alpine.js entry.
 * Nothing else in §12.2 (save/reload, "New script", steps-view code-jump) should be written until
 * this is confirmed on real Chrome, per the roadmap's explicit "don't write anything depending on
 * Monaco before knowing the result."
 */

// MV3 extension pages can't fetch cross-origin, so Monaco's default CDN-relative worker loader
// never resolves — must hand it real Worker instances built by Vite's own `?worker` bundler
// instead, which emits them as ordinary same-origin chrome-extension:// chunks (same-origin
// satisfies `script-src 'self'` with no CSP change needed).
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// Deliberate typo (`.gett`) alongside a valid call (`.get`) — the worker is confirmed alive only if
// diagnostics single out the typo and leave the valid call clean.
//
// Bare identifier, not `globalThis.__synapseModule` — the .d.ts declares it as `declare let
// __synapseModule: ...`, and per real JS semantics (which TS mirrors) a top-level `let` does NOT
// become a `globalThis` property, only `var` does. Assigning through `globalThis.` silently loses
// the contextual type from the extra lib — checkJs falls back to implicit-`any` for `run`'s
// params instead of `SynapseUserScriptManifest`'s `(input: unknown, ctx: { api: SynapseApi })`.
const SPIKE_CODE = `__synapseModule = {
  id: 'monaco-spike',
  scopes: ['storage.rw'],
  async run(input, ctx) {
    await ctx.api.storage.gett('key'); // typo on purpose — must be flagged red
    await ctx.api.storage.get('key'); // valid — must stay clean
  },
};
`;

// `javascriptDefaults` ships with `noSemanticValidation: true` baked into its own constructor
// default (unlike `typescriptDefaults`, which defaults it to `false`) — confirmed by reading
// register.js's `new LanguageServiceDefaultsImpl(..., { noSemanticValidation: true, ... })` for
// the 'javascript' mode. Monaco's built-in marker adapter honors this literally: it never even
// asks the worker for semantic diagnostics on a .js model unless told otherwise, so `.gett()`
// went unflagged not from any timing race but because the adapter was deliberately configured
// not to ask — checkJs alone does NOT imply this gets turned back on.
typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: false,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: false,
});
typescript.javascriptDefaults.addExtraLib(synapseUserscriptDts, 'file:///synapse-userscript.d.ts');
typescript.javascriptDefaults.setCompilerOptions({
  target: typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
  checkJs: true,
});

const editorEl = document.getElementById('editor')!;
const statusEl = document.getElementById('status')!;

const model = monaco.editor.createModel(SPIKE_CODE, 'javascript', monaco.Uri.parse('file:///spike.js'));
monaco.editor.create(editorEl, { model, automaticLayout: true, theme: 'vs-dark' });

function flattenMessage(text: string | { messageText: string; next?: unknown[] }): string {
  return typeof text === 'string' ? text : text.messageText;
}

function reportMarkers(): void {
  const markers = monaco.editor.getModelMarkers({ resource: model.uri });
  const flaggedTypo = markers.some((m) => m.message.includes('gett'));
  const line = markers.length > 0
    ? `Markers: ${markers.length} — ${flaggedTypo ? 'flagged .gett()' : 'did NOT flag .gett()'}. ${markers.map((m) => m.message).join(' | ')}`
    : 'Markers: none yet.';
  const el = document.getElementById('markers-status')!;
  el.textContent = line;
}

// Bypasses monaco's marker adapter (the UI layer that turns diagnostics into red squigglies) and
// asks the TS worker directly — ground truth for "does the language-service worker actually run
// semantic analysis under this CSP", independent of any race/bug in the marker adapter itself.
async function reportWorkerDirectly(): Promise<void> {
  try {
    const getWorker = await typescript.getJavaScriptWorker();
    const proxy = await getWorker(model.uri);
    const fileName = model.uri.toString();
    const [syntactic, semantic, suggestion] = await Promise.all([
      proxy.getSyntacticDiagnostics(fileName),
      proxy.getSemanticDiagnostics(fileName),
      proxy.getSuggestionDiagnostics(fileName),
    ]);
    const semanticMsgs = semantic.map((d) => flattenMessage(d.messageText));
    const flaggedTypo = semanticMsgs.some((m) => m.includes('gett'));
    statusEl.textContent =
      `Worker direct — syntactic:${syntactic.length} semantic:${semantic.length} suggestion:${suggestion.length}. ` +
      `${flaggedTypo ? 'CORRECTLY flagged .gett()' : 'did NOT flag .gett()'}. ` +
      `semantic: ${semanticMsgs.join(' | ') || '(none)'} | suggestion: ${suggestion.map((d) => flattenMessage(d.messageText)).join(' | ') || '(none)'}`;
  } catch (err) {
    statusEl.textContent = `Worker direct query FAILED: ${String(err)} (check console for stack)`;
    console.error('Synapse Studio spike: worker query failed', err);
  }
}

monaco.editor.onDidChangeMarkers(() => reportMarkers());
// Diagnostics land async after the worker's first analysis pass; poll once as a fallback in case
// onDidChangeMarkers never fires at all — that silence would itself be the "red" signal.
setTimeout(reportMarkers, 4000);
setTimeout(() => void reportWorkerDirectly(), 4000);
