import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepoIndex, contextsForFiles, type RepoAreaDescription, type RepoIndexEntry } from './repo-index';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcRoot = join(repoRoot, 'src');

/**
 * The hand-written half of `docs/INDEX.md`. A machine can count files and read suffixes; it cannot
 * say what a directory is FOR.
 *
 * Adding a source directory without adding a line here makes the generated map say UNDESCRIBED and
 * turns this suite red. That is intentional — it is the forcing function that keeps the map honest.
 */
const AREA_DESCRIPTIONS: Record<string, RepoAreaDescription> = {
  'src/kernel': {
    role: 'Core contracts: `Module`, Services (Ports), Scheduler, scope catalog, `synapseApi` type, doc generators',
    owner: 'kernel-bootstrap',
  },
  'src/shared': {
    role: 'Global SDK — pure functions, zero side effects; the only layer a MAIN-world payload may import',
    owner: 'sdk-layers',
  },
  'src/shared/download': {
    role: 'Pure half of the download engine: ordering, byte ranges, retry policy, checkpoints, HLS crypto/segment math',
    owner: 'sdk-layers',
  },
  'src/shared/ui': {
    role: 'Pure surface-allocation policy for the in-page compositor (quota, ownership keys, insertion order)',
    owner: 'in-page-ui-engine',
  },
  'src/adapters/browser-extension/background': {
    role: 'Composition root for the service worker — constructs the Kernel and wires every background listener',
    owner: 'kernel-bootstrap',
  },
  'src/adapters/browser-extension/background/services': {
    role: 'Concrete `chrome.*`-backed implementations of the Kernel Ports (cache, bus)',
    owner: 'kernel-bootstrap',
  },
  'src/adapters/browser-extension/content-scripts': {
    role: 'Composition root for the content script + the RPC client that gives dom Modules `ctx.api`',
    owner: 'module-registry',
  },
  'src/adapters/browser-extension/features/media': {
    role: 'Media detection (webRequest, DOM, MSE/HLS hooks) and the network sniffer Module',
    owner: 'features/media/.domain.md',
  },
  'src/adapters/browser-extension/features/media/download': {
    role: 'Download engine: VOD/live/turbo jobs, segment pipeline, OPFS staging, ffmpeg remux',
    owner: 'features/media/.domain.md',
  },
  'src/adapters/browser-extension/features/http-mock': {
    role: 'Request interception across three mechanisms (main-world patch, CDP debugger, declarativeNetRequest)',
    owner: 'features/http-mock/.domain.md',
  },
  'src/adapters/browser-extension/features/reader-mode': {
    role: 'Page/site → Markdown converter, a 4-step Composite Module',
    owner: 'features/reader-mode/.domain.md',
  },
  'src/adapters/browser-extension/features/secrets': {
    role: 'Reference-only secret store; scripts never read a value, only name one',
    owner: 'features/secrets/.domain.md',
  },
  'src/adapters/browser-extension/module-registry': {
    role: 'Module discovery, uploaded-script lifecycle, the shim, and `rpc-handler.ts` — the sole permission enforcement point',
    owner: 'module-registry',
  },
  'src/adapters/browser-extension/utils': {
    role: 'Mechanism shared by ≥2 features only: DNR rules, OPFS, blob store, offscreen manager, UI compositor, injector',
    owner: 'sdk-layers',
  },
  'src/adapters/browser-extension/utils/main-world': {
    role: 'MAIN-world mechanism with zero `chrome.*`: event channel, fetch/XHR patch, storage relay',
    owner: 'main-world-interceptor',
  },
  'src/adapters/browser-extension/ui': {
    role: 'Shared glue across extension pages — collection data sources, icons, path constants',
    owner: 'ui-surface-placement',
  },
  'src/adapters/browser-extension/ui/popup': {
    role: 'Toolbar popup: module list, toggles, grant, script lifecycle actions',
    owner: 'ui-surface-placement',
  },
  'src/adapters/browser-extension/ui/popup/views': {
    role: 'One file per popup view — in-flow view swap, never `<dialog>`',
    owner: 'module-registry',
  },
  'src/adapters/browser-extension/ui/dashboard': {
    role: 'Standalone tab hosting a Collection-schema Module’s management UI, scoped by `?moduleId=`',
    owner: 'ui-surface-placement',
  },
  'src/adapters/browser-extension/ui/dashboard/views': {
    role: 'Generic management table, item form, and the bundled Composite Module steps view',
    owner: 'module-registry',
  },
  'src/adapters/browser-extension/ui/studio': {
    role: 'Monaco-based script editor: edit, save, rename, step sidebar, Dry Run, templates',
    owner: 'module-registry',
  },
  'src/adapters/browser-extension/ui/side-panel': {
    role: 'Side panel: detected media, download progress/resume, reader-mode results for the current tab',
    owner: 'ui-surface-placement',
  },
  'src/adapters/browser-extension/ui/offscreen': {
    role: 'Offscreen Document host — runs the download engine headlessly; only `chrome.runtime` exists here',
    owner: 'sdk-layers',
  },
  'src/adapters/browser-extension/ui/review': {
    role: 'Full-page review of a reader-mode result, with ZIP export',
    owner: 'ui-surface-placement',
  },
  'src/adapters/browser-extension/ui/help': {
    role: 'Offline in-extension docs, rendered from `docs/user-scripts.md`; downloads the AI context bundle',
    owner: 'userscript-api',
  },
};

const TEST_SUFFIX = '.test.ts';

function collectEntries(dir: string): RepoIndexEntry[] {
  const entries: RepoIndexEntry[] = [];

  const walk = (absolute: string): void => {
    const names = readdirSync(absolute);
    const fileNames = names.filter((n) => n.endsWith('.ts') && !n.endsWith(TEST_SUFFIX));
    const testNames = names.filter((n) => n.endsWith(TEST_SUFFIX));

    if (fileNames.length > 0) {
      entries.push({
        path: relative(repoRoot, absolute).split('\\').join('/'),
        fileCount: fileNames.length,
        testCount: testNames.length,
        contexts: contextsForFiles(fileNames),
      });
    }

    for (const name of names) {
      const child = join(absolute, name);
      if (statSync(child).isDirectory()) walk(child);
    }
  };

  walk(dir);
  return entries;
}

const entries = collectEntries(srcRoot);
const generated = buildRepoIndex({ entries, descriptions: AREA_DESCRIPTIONS });

describe('generated codebase index', () => {
  it('matches the checked-in docs/INDEX.md', async () => {
    await expect(generated).toMatchFileSnapshot('../../docs/INDEX.md');
  });

  it('describes every source directory it found', () => {
    const undescribed = entries.map((e) => e.path).filter((p) => !(p in AREA_DESCRIPTIONS));
    expect(undescribed, `add these to AREA_DESCRIPTIONS in ${relative(repoRoot, import.meta.url)}`).toEqual([]);
  });

  it('has no description for a directory that no longer exists', () => {
    const found = new Set(entries.map((e) => e.path));
    const orphaned = Object.keys(AREA_DESCRIPTIONS).filter((p) => !found.has(p));
    expect(orphaned, 'these directories were removed — drop their AREA_DESCRIPTIONS entries').toEqual([]);
  });

  it('derives execution contexts from filename suffixes', () => {
    expect(contextsForFiles(['a.background.ts', 'b.page.ts', 'c.ts'])).toEqual(['MAIN world', 'background']);
    expect(contextsForFiles(['plain.ts'])).toEqual([]);
  });
});
