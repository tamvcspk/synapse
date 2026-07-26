import type { DownloadEngineCommand } from '../../../../shared/download-engine-protocol';
import { handleEngineCommand } from '../../utils/download-engine';

/**
 * docs/ROADMAP.md §8.1 — thin wiring only, mirrors ui/dashboard/main.ts's "view wiring, logic lives
 * in utils/" split. background/index.ts is the sole caller of chrome.offscreen.createDocument
 * (utils/offscreen-manager.ts) and forwards every `synapse:download-engine-command` message here
 * once the document is confirmed to exist — this listener is what actually does the work.
 */
chrome.runtime.onMessage.addListener((message: DownloadEngineCommand | undefined) => {
  if (message?.type !== 'synapse:download-engine-command') return;
  handleEngineCommand(message);
});
