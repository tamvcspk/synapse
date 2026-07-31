import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
// `?url` (plain Vite feature, not crx's `?script&iife`) — fetched by the ffmpeg.wasm worker itself
// only once `ffmpeg.load()` actually runs, not eagerly at module load.
import ffmpegCoreUrl from '@ffmpeg/core?url';
import ffmpegWasmUrl from '@ffmpeg/core/wasm?url';
import { outputFileName, type OutputContainer } from '../../../../../shared/download/output-naming';
import { emit } from './engine-events.offscreen';

/**
 * docs/ROADMAP.md §8.5/§11.2 — what happens to the finished OPFS file: remux it, or save the
 * concatenated bytes as-is, then hand the result to `chrome.downloads` via background. Split out of
 * utils/download-engine.ts (Phase 1: "runJob → SegmentPipeline + JobControl + output") — this is the
 * ONE thing all three job kinds converge on, and the only part of the engine that touches ffmpeg.
 */

const REMUX_SIZE_CAP_BYTES = 2 * 1024 * 1024 * 1024;

export type { OutputContainer };

/**
 * Triggers the download from a context that can. Bugfix: this used to call
 * `chrome.downloads.download()` directly — throws "Cannot read properties of undefined (reading
 * 'download')" every time, since `chrome.downloads` is one of the APIs unavailable to Offscreen
 * Documents (see background-relay.offscreen.ts). The blob: URL itself is still created HERE — it
 * only resolves within the document that created it, which is exactly what
 * `chrome.offscreen.Reason.BLOBS` exists for — but the actual `chrome.downloads.download()` call is
 * relayed to background, which Chrome's own docs confirm as the supported pattern.
 */
export function downloadFile(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  chrome.runtime.sendMessage({ type: 'synapse:trigger-download', url: blobUrl, filename: fileName }).catch(() => {});
  // The blob: URL must stay valid until the download manager has actually read it — background's
  // chrome.downloads.download() only confirms the download was ACCEPTED, not that reading finished,
  // and that confirmation doesn't even round-trip back here. A flat delay is the best available
  // signal from this side.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

/** docs/ROADMAP.md §8.5 — the "no ffmpeg" fast path: concatenated MPEG-TS is playable because TS is
 * self-syncing per 188-byte packet; concatenated fMP4 is playable because `init + moof/mdat + ...`
 * is precisely how a fragmented MP4 is laid out (the CMAF wire format), provided the init segment
 * was written first. Either way: no wasm, no memory ceiling, works at any size. */
function saveConcatenated(file: File, sourceUrl: string, container: OutputContainer): void {
  downloadFile(file, outputFileName(sourceUrl, container));
}

/** docs/ROADMAP.md §8.5 — `ffmpeg.mount('WORKERFS', ...)` hands the already-concatenated OPFS file
 * to ffmpeg WITHOUT copying it into MEMFS first, halving the memory peak on the input side; reads it
 * directly as one stream so no concat demuxer/file list is needed. */
async function remuxToMp4(file: File, sourceUrl: string, jobId: string): Promise<void> {
  emit(jobId, 'remux');
  const ffmpeg = new FFmpeg();
  // Without this subscription @ffmpeg/ffmpeg prints NOTHING — its worker forwards ffmpeg's stderr
  // as 'log' events and drops them when nobody is listening.
  ffmpeg.on('log', ({ message }) => console.log(`ffmpeg (${jobId}): ${message}`));
  await ffmpeg.load({
    // Bundled with the extension (manifest.config.ts's `wasm-unsafe-eval` CSP, which also covers
    // this offscreen document — both fall under `extension_pages`), not fetched from a CDN.
    coreURL: chrome.runtime.getURL(ffmpegCoreUrl.replace(/^\//, '')),
    wasmURL: chrome.runtime.getURL(ffmpegWasmUrl.replace(/^\//, '')),
  });

  // Emscripten's FS.mount() requires the mount point to already exist — a fresh `ffmpeg` instance
  // is created per attempt, so '/input' never already exists here.
  await ffmpeg.createDir('/input');
  await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, '/input');

  try {
    const exitCode = await ffmpeg.exec(['-i', `/input/${file.name}`, '-c', 'copy', 'output.mp4']);
    if (exitCode !== 0) throw new Error(`ffmpeg exited with code ${exitCode} — see the offscreen document's console (chrome://extensions' "Inspect views") for its log.`);

    const output = await ffmpeg.readFile('output.mp4');
    if (typeof output === 'string') throw new Error('ffmpeg returned text instead of the expected binary output.');

    // `output.buffer` can type as `ArrayBufferLike` (possibly SharedArrayBuffer) — copy into a
    // plain ArrayBuffer-backed Uint8Array, which is all `Blob`'s constructor accepts.
    downloadFile(new Blob([output.slice()], { type: 'video/mp4' }), outputFileName(sourceUrl, 'mp4'));
    emit(jobId, 'done');
  } finally {
    await ffmpeg.unmount('/input');
  }
}

/** docs/ROADMAP.md §8.5/§8.1 — auto-picks ONE output path (remux under the size cap, otherwise the
 * always-safe direct save) with no manual retry buttons — there's no UI to click them from in a
 * headless engine, unlike the old Merge Tab's "Save (.ts, fast)"/"Remux → .mp4" pair. A remux
 * failure now falls back to the direct save automatically instead of leaving the job with nothing
 * downloadable — a deliberate improvement over the old page's behavior (which just reported the
 * error), since there is no interactive retry button left for the user to recover with. */
export async function produceOutput(jobId: string, file: File, sourceUrl: string, container: OutputContainer): Promise<void> {
  if (file.size > REMUX_SIZE_CAP_BYTES) {
    saveConcatenated(file, sourceUrl, container);
    emit(jobId, 'done');
    return;
  }
  try {
    await remuxToMp4(file, sourceUrl, jobId);
  } catch (err) {
    console.warn(`Synapse: remux failed for job ${jobId}, falling back to direct .${container} save`, err);
    saveConcatenated(file, sourceUrl, container);
    emit(jobId, 'done');
  }
}
