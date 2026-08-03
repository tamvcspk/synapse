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
import { icon, ICONS } from '../icon';
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
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let currentEntry: RegistryEntry | undefined;
/** Steps sidebar open/closed (docs/ROADMAP.md §12.3) — session-only, defaults open. Independent of
 * whether there's anything to show (`renderStepsSidebar` still hides the panel entirely while this
 * is `false`, same as `#toggle-steps-btn` being absent for "New script"). */
let sidebarOpen = true;

const titleEl = document.getElementById('title')!;
const messageEl = document.getElementById('message')!;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
const toggleStepsBtn = document.getElementById('toggle-steps-btn') as HTMLButtonElement;
const editorEl = document.getElementById('editor')!;
const sidebarEl = document.getElementById('steps-sidebar')!;

saveBtn.replaceChildren(icon(ICONS.save));
saveBtn.title = 'Save';
saveBtn.setAttribute('aria-label', 'Save');
toggleStepsBtn.addEventListener('click', () => {
  sidebarOpen = !sidebarOpen;
  renderStepsSidebar();
});

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
    currentEntry = entry;
  } else {
    source = NEW_SCRIPT_TEMPLATE;
    label = 'New script';
  }

  setLabel(label);

  model = monaco.editor.createModel(source, 'javascript', monaco.Uri.parse(`file:///${moduleId ?? 'new-script'}.js`));
  editor = monaco.editor.create(editorEl, { model, automaticLayout: true, theme: 'vs-dark', minimap: { enabled: false } });
  // eslint-disable-next-line no-bitwise -- Monaco's own documented way to combine KeyMod/KeyCode.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());

  setMessage(
    moduleId
      ? 'Changes take effect on the next page load — not hot-reload.'
      : 'New script — Save to upload it. Changes take effect on the next page load.',
  );

  renderStepsSidebar();
  // Keeps the PREVIEW half of the sidebar (see its doc comment) in sync while typing — a no-op
  // once a real ManifestReport exists, since renderStepsSidebar prefers that over re-parsing.
  model.onDidChangeContent(() => renderStepsSidebar());
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

/**
 * Steps sidebar (docs/ROADMAP.md §12.3). Two sources, preferred in this order:
 *
 * 1. **`currentEntry.subModules`** — a real ManifestReport, confirmed by an actual run. Per-step
 *    last-run status (`renderStepStatus`) is ONLY ever available from this source.
 * 2. **A static, best-effort parse of the CURRENTLY TYPED source** (`parseStepsFromSource`) — used
 *    only as a fallback while (1) doesn't exist yet. Requiring a real page load just to preview a
 *    structure that's already sitting in the editor is an unnecessary round trip for something
 *    code already fully determines (§12.0's own "code is the single source of truth for
 *    structure") — this reads it directly instead of making the user go run the script first just
 *    to see it. Re-parsed on every keystroke (`init()`'s `onDidChangeContent`) while in this mode,
 *    which is exactly the point: it's a preview of what you're writing, not of what last ran.
 *
 * Once (1) exists it's used unconditionally — matching every other "changes take effect on next
 * load" rule in Studio, live edits stop moving the sidebar the moment there's a confirmed run to
 * show instead.
 *
 * `#toggle-steps-btn` (`sidebarOpen`) is a separate, purely cosmetic axis from either of the above
 * — collapsing it just reclaims editor width, it never affects what data would be shown if reopened.
 */
function renderStepsSidebar(): void {
  if (!currentEntry) {
    // "New script" (no moduleId yet) — nothing to toggle, same as before §12.3 existed at all.
    toggleStepsBtn.style.display = 'none';
    sidebarEl.replaceChildren();
    sidebarEl.classList.remove('visible');
    return;
  }

  toggleStepsBtn.style.display = '';
  toggleStepsBtn.replaceChildren(icon(sidebarOpen ? ICONS.panelRightOpen : ICONS.panelRightClose));
  toggleStepsBtn.title = sidebarOpen ? 'Hide steps sidebar' : 'Show steps sidebar';
  toggleStepsBtn.setAttribute('aria-label', toggleStepsBtn.title);

  if (!sidebarOpen) {
    sidebarEl.replaceChildren();
    sidebarEl.classList.remove('visible');
    return;
  }

  const confirmedSteps = currentEntry.subModules ?? [];
  const confirmed = confirmedSteps.length > 0;
  const steps = confirmed ? confirmedSteps : parseStepsFromSource(model?.getValue() ?? '');

  sidebarEl.replaceChildren();
  sidebarEl.classList.add('visible');

  const heading = document.createElement('h2');
  heading.textContent = 'Steps';
  sidebarEl.append(heading);

  if (!confirmed) {
    const note = document.createElement('p');
    note.className = 'step-status pending';
    note.textContent =
      steps.length > 0
        ? 'Preview from the current source — hasn’t run on a page yet, so per-step status isn’t available.'
        : 'No steps found in the current source, and it hasn’t run on a page yet either.';
    sidebarEl.append(note);
    if (steps.length === 0) return;
  }

  const list = document.createElement('ul');
  for (const step of steps) list.append(renderStepRow(step));
  sidebarEl.append(list);
}

/**
 * Best-effort static extraction of `steps`/`run` from raw source text — no AST, a bracket-depth
 * scan, same "cheap and durable rather than exact" posture `jumpToStepDefinition` already uses.
 * Good enough for the array-literal shape docs/user-scripts.md's examples use; not guaranteed for
 * a `steps` value built any other way (e.g. `steps: buildSteps()`), which this simply won't find —
 * that's a known limitation of a preview, not a correctness requirement (the REAL structure, once
 * confirmed by a run, always wins over this — see `renderStepsSidebar`).
 */
function parseStepsFromSource(source: string): { id: string; label?: string }[] {
  const stepsMatch = /\bsteps\s*:\s*\[/.exec(source);
  if (!stepsMatch) {
    // No `steps` array found — mirror the shim's own normalization (§12.3: a bare `run` becomes
    // one `'main'` step) only when something that looks like a `run` declaration is actually
    // present, so an empty/unrelated file doesn't get a fabricated step.
    return /\brun\s*[:(]/.test(source) ? [{ id: 'main' }] : [];
  }

  const arrayStart = stepsMatch.index + stepsMatch[0].length; // just past the '['
  let depth = 1;
  let i = arrayStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') depth--;
  }
  const body = source.slice(arrayStart, i - 1);

  const steps: { id: string; label?: string }[] = [];
  let objDepth = 0;
  let objStart = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '{') {
      if (objDepth === 0) objStart = j;
      objDepth++;
    } else if (body[j] === '}') {
      objDepth--;
      if (objDepth === 0 && objStart !== -1) {
        steps.push(parseStepObjectLiteral(body.slice(objStart, j + 1)));
        objStart = -1;
      }
    }
  }
  return steps;
}

function parseStepObjectLiteral(objectText: string): { id: string; label?: string } {
  const idMatch = /\bid\s*:\s*(['"`])((?:(?!\1).)*?)\1/.exec(objectText);
  const labelMatch = /\blabel\s*:\s*(['"`])((?:(?!\1).)*?)\1/.exec(objectText);
  const id = idMatch?.[2] ?? '(id not found)';
  return labelMatch?.[2] !== undefined ? { id, label: labelMatch[2] } : { id };
}

function renderStepRow(step: { id: string; label?: string }): HTMLElement {
  const entry = currentEntry!;
  const row = document.createElement('li');
  row.className = 'step-row';
  row.title = 'Click to jump to this step’s definition in the editor';
  row.addEventListener('click', () => jumpToStepDefinition(step.id));

  const top = document.createElement('div');
  top.className = 'step-row-top';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = entry.subState?.[step.id] ?? true;
  checkbox.title = 'Bypass this step — its input passes through to the next step unchanged';
  // The row itself also jumps to the definition (bigger click target) — the checkbox must not
  // trigger that too, or toggling it would also scroll the editor out from under the click.
  checkbox.addEventListener('click', (e) => e.stopPropagation());
  checkbox.addEventListener('change', () => {
    const active = checkbox.checked;
    entry.subState = { ...entry.subState, [step.id]: active };
    void registry.setSubModuleActive(entry.id, step.id, active);
  });

  const labelEl = document.createElement('label');
  labelEl.textContent = step.label ?? step.id;

  top.append(checkbox, labelEl);
  row.append(top, renderStepStatus(step.id));
  return row;
}

/** Last-run outcome (docs/ROADMAP.md §12.3's Observability) — `undefined` until the FIRST run
 * since this script was saved reports in, which is a legitimately different state from `skipped`
 * (bypassed on a run that did happen) and worth telling apart in the sidebar. */
function renderStepStatus(stepId: string): HTMLElement {
  const status = currentEntry?.subStepStatus?.[stepId];
  const p = document.createElement('p');
  if (!status) {
    p.className = 'step-status pending';
    p.textContent = 'Not run yet';
  } else if (status.skipped) {
    p.className = 'step-status skipped';
    p.textContent = 'Skipped (bypassed)';
  } else if (status.ok) {
    p.className = 'step-status ok';
    p.textContent = `✓ ${status.durationMs}ms`;
  } else {
    p.className = 'step-status error';
    p.textContent = `✗ ${status.error ?? 'failed'}`;
  }
  return p;
}

/**
 * Cheap and durable rather than exact (docs/ROADMAP.md §12.3): finds the step id's own literal
 * quoted form in the CURRENTLY SAVED source text and reveals that line — no AST, no source map. A
 * dynamically-computed id (never a literal in the source) legitimately cannot be found this way;
 * that's a known limitation, not a bug, which is why it falls back to a message instead of
 * guessing a line.
 */
function jumpToStepDefinition(stepId: string): void {
  if (!model || !editor) return;
  const offsets = [`'${stepId}'`, `"${stepId}"`]
    .map((needle) => model!.getValue().indexOf(needle))
    .filter((i) => i !== -1);

  if (offsets.length === 0) {
    editor.revealLineInCenter(1);
    editor.setPosition({ lineNumber: 1, column: 1 });
    setMessage(`Could not find step "${stepId}" in the current source — its id may be computed at runtime.`, 'error');
    return;
  }

  const position = model.getPositionAt(Math.min(...offsets));
  editor.revealLineInCenter(position.lineNumber);
  editor.setPosition(position);
  editor.focus();
}

saveBtn.addEventListener('click', () => void save());

void init();
