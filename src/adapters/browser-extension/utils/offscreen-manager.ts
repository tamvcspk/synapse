import { OFFSCREEN_PATH } from '../ui/offscreen/offscreen-path';

/**
 * docs/ROADMAP.md §8.1 — sole owner of chrome.offscreen.createDocument, called only from
 * background/index.ts's `synapse:download-engine-command` relay. MV3 allows exactly ONE offscreen
 * document per extension at a time (a second `createDocument` call while one already exists
 * throws) — `ensureOffscreenDocument` is idempotent, and the in-flight promise below also covers
 * the case where two commands arrive back-to-back before the first `createDocument` resolves
 * (e.g. two rapid Download clicks), which would otherwise race two concurrent create calls.
 */
let creating: Promise<void> | undefined;

export async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PATH),
      // WORKERS: ffmpeg.wasm spins its own Worker for remuxing. BLOBS: the engine creates a Blob
      // (the finished/concatenated file) and must call chrome.downloads.download with a blob: URL
      // from the SAME document that created it — this is exactly the case chrome.offscreen.Reason.
      // BLOBS documents.
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification: 'Runs ffmpeg.wasm (Worker + WebAssembly) and the OPFS/Blob-backed HLS download engine outside any visible tab.',
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}
