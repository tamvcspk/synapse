import type { DownloadEngineCommand, DownloadEngineRelayedCommand } from '../../../../../shared/download-engine-protocol';
import { ensureOffscreenDocument } from '../../../utils/offscreen-manager';

/**
 * docs/ROADMAP.md §8.1 — the ensure-offscreen-doc-then-relay step that used to live inline in
 * background/index.ts's `synapse:download-engine-command` listener, extracted so
 * `synapseApi.media.download`/`.control` (module-registry/media-host.ts) can start/act on a job the
 * exact same way the Side Panel/Dashboard do, without a second implementation of "ensure the
 * singleton Offscreen Document exists, then relay" or a risky self-`chrome.runtime.sendMessage` back
 * into this same service worker.
 *
 * Re-types to `DownloadEngineRelayedCommand` for the same reason the original inline version did:
 * `chrome.runtime.sendMessage` broadcasts to every listening context, so re-sending under the
 * client-facing `synapse:download-engine-command` type would let the singleton Offscreen Document
 * (once it already exists) receive both the original broadcast AND this relay's re-broadcast — see
 * `shared/download-engine-protocol.ts`'s `DownloadEngineRelayedCommand` doc comment for the full
 * incident this type exists to prevent.
 */
export async function relayDownloadEngineCommand(command: DownloadEngineCommand): Promise<void> {
  await ensureOffscreenDocument();
  const relayed: DownloadEngineRelayedCommand = { ...command, type: 'synapse:download-engine-command-relayed' };
  await chrome.runtime.sendMessage(relayed).catch(() => {});
}
