import { describe, expect, it } from 'vitest';
import type { CacheService } from '../../../../kernel/module';
import { addDetectedMedia, clearDetectedMediaForTab, listDetectedMedia, type DetectedMedia } from './store';

/** Same fake-CacheService DI pattern media-host.test.ts uses. */
function fakeCache(initial: DetectedMedia[] = []): CacheService {
  const store = new Map<string, unknown>([['synapse:network-sniffer:detected-media', initial]]);
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

function media(overrides: Partial<DetectedMedia> & { id: string }): DetectedMedia {
  return { url: `https://example.com/${overrides.id}.mp4`, kind: 'video', detectedAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('clearDetectedMediaForTab', () => {
  it('removes only entries tagged with the given tabId', async () => {
    const cache = fakeCache([media({ id: 'a', tabId: 1 }), media({ id: 'b', tabId: 2 }), media({ id: 'c', tabId: 1 })]);

    await clearDetectedMediaForTab(1, cache);

    const remaining = await listDetectedMedia(cache);
    expect(remaining.map((m) => m.id)).toEqual(['b']);
  });

  it('leaves entries with no tabId untouched (unattributed requests, e.g. tabId -1)', async () => {
    const cache = fakeCache([media({ id: 'a', tabId: 1 }), media({ id: 'b' })]);

    await clearDetectedMediaForTab(1, cache);

    const remaining = await listDetectedMedia(cache);
    expect(remaining.map((m) => m.id)).toEqual(['b']);
  });

  it('is a no-op when the tab has no entries', async () => {
    const cache = fakeCache([media({ id: 'a', tabId: 2 })]);

    await clearDetectedMediaForTab(1, cache);

    const remaining = await listDetectedMedia(cache);
    expect(remaining.map((m) => m.id)).toEqual(['a']);
  });
});

describe('addDetectedMedia', () => {
  it('stores the tabId a detection was attributed to', async () => {
    const cache = fakeCache();
    await addDetectedMedia(media({ id: 'a', tabId: 7 }), cache);

    const [entry] = await listDetectedMedia(cache);
    expect(entry?.tabId).toBe(7);
  });
});
