import './studio.css';
import * as monaco from 'monaco-editor';
// monaco-editor 0.53+ moved the TS/JS language service out of `monaco.languages.typescript`
// (now `{ deprecated: true }`) into a top-level `typescript` export with the same shape — see
// docs/LESSONS.md's "Monaco trong extension page" for the full spike write-up.
import { typescript } from 'monaco-editor';
// No `esm/vs/` prefix and a mandatory `.js` suffix — the package's `exports` map is
// `'./*.js': './esm/vs/*.js'`, so it already prepends `esm/vs/`; including it in the specifier
// resolves to a nonexistent doubled `esm/vs/esm/vs/...` path.
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker';
import synapseUserscriptDts from '../../../../../docs/types/synapse-userscript.d.ts?raw';
import type { RegistryEntry } from '../../../../kernel/module-registry';
import { ChromeModuleRegistryService } from '../../module-registry/chrome-module-registry';
import { NEW_SCRIPT_TEMPLATE } from './studio-template';

/**
 * Studio (docs/ROADMAP.md §12.2) — edit an uploaded script's source in the extension itself.
 * `?moduleId=<id>` edits that script; no `moduleId` opens "New script" (a template, replacing the
 * old requirement of having a file ready to upload first).
 */

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

// `javascriptDefaults` ships with `noSemanticValidation: true` by default (unlike
// `typescriptDefaults`) — without this, `checkJs` alone does NOT surface type errors as editor
// diagnostics (see docs/LESSONS.md).
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

const registry = new ChromeModuleRegistryService();

let moduleId = new URLSearchParams(location.search).get('moduleId') ?? undefined;
let model: monaco.editor.ITextModel | undefined;

const titleEl = document.getElementById('title')!;
const messageEl = document.getElementById('message')!;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const editorEl = document.getElementById('editor')!;

function setMessage(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  messageEl.textContent = text;
  messageEl.className = kind === 'info' ? '' : kind;
}

function setLabel(label: string): void {
  document.title = `Synapse — Studio — ${label}`;
  titleEl.textContent = label;
}

async function init(): Promise<void> {
  let source: string;
  let label: string;

  if (moduleId) {
    const entries = await registry.list();
    const entry: RegistryEntry | undefined = entries.find((e) => e.id === moduleId);
    if (!entry || entry.source !== 'uploaded') {
      setLabel('Script not found');
      setMessage(`No uploaded script with id "${moduleId}" — open Studio from a script's Edit icon in the popup.`, 'error');
      saveBtn.disabled = true;
      return;
    }
    const stored = await registry.getUploadedSource(entry.id);
    if (stored === undefined) {
      setLabel('Script not found');
      setMessage('This script has no stored source.', 'error');
      saveBtn.disabled = true;
      return;
    }
    source = stored;
    label = entry.label ?? entry.id;
  } else {
    source = NEW_SCRIPT_TEMPLATE;
    label = 'New script';
  }

  setLabel(label);

  model = monaco.editor.createModel(source, 'javascript', monaco.Uri.parse(`file:///${moduleId ?? 'new-script'}.js`));
  const editor = monaco.editor.create(editorEl, { model, automaticLayout: true, theme: 'vs-dark', minimap: { enabled: false } });
  // eslint-disable-next-line no-bitwise -- Monaco's own documented way to combine KeyMod/KeyCode.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());

  setMessage(
    moduleId
      ? 'Changes take effect on the next page load — not hot-reload.'
      : 'New script — Save to upload it. Changes take effect on the next page load.',
  );
}

async function save(): Promise<void> {
  if (!model) return;
  saveBtn.disabled = true;
  setMessage('Saving…');

  const source = model.getValue();
  const result = moduleId ? await registry.updateScriptSource(moduleId, source) : await registry.uploadModule(source);

  saveBtn.disabled = false;

  if (!result.ok) {
    // The raw `chrome.userScripts.register` rejection reason (a real syntax error) — shown
    // verbatim, same "don't swallow the reason" posture as popup/main.ts's upload-failure path.
    setMessage(result.reason ?? 'Save failed.', 'error');
    return;
  }

  if (!moduleId && result.entry) {
    // Was "New script" — the save just minted a real id. Switch this same tab into edit mode for
    // it rather than leaving the URL (and a subsequent Save) pointed at nothing.
    moduleId = result.entry.id;
    history.replaceState(null, '', `${location.pathname}?moduleId=${encodeURIComponent(moduleId)}`);
    setLabel(result.entry.label ?? result.entry.id);
  }

  setMessage('Saved — takes effect on the next page load, not immediately.', 'success');
}

saveBtn.addEventListener('click', () => void save());

void init();
