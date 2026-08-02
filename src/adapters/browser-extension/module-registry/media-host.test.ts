import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CacheService } from '../../../kernel/module';
import type { DetectedMedia } from '../features/media/store';
import type { DownloadEngineTransport, MediaJobSnapshotStore } from './media-host';
import { performMediaControl, performMediaDownload, performMediaInspect, performMediaJob, performMediaList, recordMediaJobSnapshot } from './media-host';

/**
 * `cache`/`transport`/`store` are all injected — same DI pattern `net-mock-host.test.ts`'s
 * `MockRuleStore` fake and `files-save-host.test.ts`'s `DownloadsBackend` fake use — so these tests
 * exercise media-host.ts's own logic (projection, kind→op branching, snapshot mapping) without
 * `chrome.storage`/`chrome.offscreen`.
 */
function fakeCache(initial: DetectedMedia[] = []): CacheService {
  const store = new Map<string, unknown>([['synapse:network-sniffer:detected-media', initial]]);
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

function fakeTransport(): DownloadEngineTransport & { sent: Parameters<DownloadEngineTransport['send']>[0][] } {
  const sent: Parameters<DownloadEngineTransport['send']>[0][] = [];
  return {
    sent,
    send: async (command) => {
      sent.push(command);
    },
  };
}

function fakeSnapshotStore(): MediaJobSnapshotStore {
  const map = new Map<string, ReturnType<MediaJobSnapshotStore['get']>>();
  return {
    get: (jobId) => map.get(jobId),
    set: (jobId, status) => {
      map.set(jobId, status);
    },
  };
}

describe('performMediaList', () => {
  it('projects DetectedMedia to the public shape, omitting internal/absent fields', async () => {
    const entry: DetectedMedia = {
      id: 'm1',
      url: 'https://cdn.example.com/video.mp4',
      kind: 'video',
      detectedAt: '2026-01-01T00:00:00.000Z',
      requestHeaders: { referer: 'https://example.com' },
    };
    const cache = fakeCache([entry]);

    const result = await performMediaList(cache);

    expect(result).toEqual([{ id: 'm1', url: 'https://cdn.example.com/video.mp4', kind: 'video', detectedAt: '2026-01-01T00:00:00.000Z' }]);
    expect(result[0]).not.toHaveProperty('requestHeaders');
  });

  it('carries through optional fields when present', async () => {
    const entry: DetectedMedia = {
      id: 'm1',
      url: 'https://cdn.example.com/master.m3u8',
      kind: 'stream',
      detectedAt: '2026-01-01T00:00:00.000Z',
      pageUrl: 'https://example.com/watch',
      tabUrl: 'https://example.com/watch',
      thirdParty: false,
      expiring: true,
      segmentCount: 42,
      encrypted: false,
      variants: [{ url: 'https://cdn.example.com/1080p.m3u8', resolution: '1920x1080' }],
    };
    const cache = fakeCache([entry]);

    const result = await performMediaList(cache);

    expect(result).toEqual([expect.objectContaining({ segmentCount: 42, encrypted: false, variants: entry.variants, expiring: true })]);
  });

  it('collapses variant-shadowed entries, same as the Side Panel/Dashboard read path', async () => {
    const master: DetectedMedia = {
      id: 'master',
      url: 'https://cdn.example.com/master.m3u8',
      kind: 'stream',
      detectedAt: '2026-01-01T00:00:00.000Z',
      variants: [{ url: 'https://cdn.example.com/1080p.m3u8', resolution: '1920x1080' }],
    };
    const shadowed: DetectedMedia = {
      id: 'variant',
      url: 'https://cdn.example.com/1080p.m3u8',
      kind: 'stream',
      detectedAt: '2026-01-01T00:00:01.000Z',
    };
    const cache = fakeCache([master, shadowed]);

    const result = await performMediaList(cache);

    expect(result.map((r) => r.id)).toEqual(['master']);
  });
});

describe('performMediaInspect', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects a missing/empty url before ever fetching', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(performMediaInspect('')).rejects.toThrow(/"url" is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns variants for a master playlist', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', '360p.m3u8'].join('\n')),
    ) as unknown as typeof fetch;

    const result = await performMediaInspect('https://cdn.example.com/hls/master.m3u8');

    expect(result).toEqual({ variants: [{ url: 'https://cdn.example.com/hls/360p.m3u8', resolution: '640x360' }] });
  });

  it('returns segments/encrypted/live for a media (variant) playlist', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(['#EXTM3U', '#EXTINF:6.0,', 'seg0.ts', '#EXTINF:6.0,', 'seg1.ts', '#EXT-X-ENDLIST'].join('\n')),
    ) as unknown as typeof fetch;

    const result = await performMediaInspect('https://cdn.example.com/hls/index.m3u8');

    expect(result).toEqual({ segments: 2, encrypted: false, live: false });
  });

  it('reports live:true for a media playlist with no #EXT-X-ENDLIST', async () => {
    globalThis.fetch = vi.fn(async () => new Response(['#EXTM3U', '#EXTINF:6.0,', 'seg0.ts'].join('\n'))) as unknown as typeof fetch;

    const result = await performMediaInspect('https://cdn.example.com/hls/index.m3u8');

    expect(result.live).toBe(true);
  });

  it('resolves to {} for text that is neither a master nor a media playlist', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>404</html>')) as unknown as typeof fetch;

    await expect(performMediaInspect('https://cdn.example.com/not-hls.m3u8')).resolves.toEqual({});
  });

  it('wraps a fetch failure in a media.inspect-prefixed error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(performMediaInspect('https://cdn.example.com/x.m3u8')).rejects.toThrow(/media.inspect:.*network down/);
  });
});

describe('performMediaDownload', () => {
  it('rejects a missing/empty url before touching the transport', async () => {
    const transport = fakeTransport();
    await expect(performMediaDownload({ url: '' }, transport)).rejects.toThrow(/"url" is required/);
    expect(transport.sent).toHaveLength(0);
  });

  it('rejects a url with no recognized media extension', async () => {
    const transport = fakeTransport();
    await expect(performMediaDownload({ url: 'https://example.com/page' }, transport)).rejects.toThrow(/not a recognized media file/);
    expect(transport.sent).toHaveLength(0);
  });

  it('sends op START for a stream (.m3u8) url and returns a fresh jobId', async () => {
    const transport = fakeTransport();
    const jobId = await performMediaDownload({ url: 'https://cdn.example.com/master.m3u8' }, transport);

    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(0);
    expect(transport.sent).toEqual([{ type: 'synapse:download-engine-command', op: 'START', jobId, url: 'https://cdn.example.com/master.m3u8' }]);
  });

  it('passes resolutionLabel through only when given', async () => {
    const transport = fakeTransport();
    const jobId = await performMediaDownload({ url: 'https://cdn.example.com/master.m3u8', resolutionLabel: '1080p' }, transport);

    expect(transport.sent[0]).toMatchObject({ resolutionLabel: '1080p', jobId });
  });

  it('sends op START_TURBO for a direct video/audio file url', async () => {
    const transport = fakeTransport();
    const jobId = await performMediaDownload({ url: 'https://cdn.example.com/movie.mp4' }, transport);

    expect(transport.sent).toEqual([{ type: 'synapse:download-engine-command', op: 'START_TURBO', jobId, url: 'https://cdn.example.com/movie.mp4' }]);
  });

  it('generates a distinct jobId per call', async () => {
    const transport = fakeTransport();
    const a = await performMediaDownload({ url: 'https://cdn.example.com/a.mp4' }, transport);
    const b = await performMediaDownload({ url: 'https://cdn.example.com/b.mp4' }, transport);
    expect(a).not.toBe(b);
  });
});

describe('recordMediaJobSnapshot / performMediaJob', () => {
  it('resolves undefined for a jobId with no recorded snapshot', async () => {
    const store = fakeSnapshotStore();
    await expect(performMediaJob('never-started', store)).resolves.toBeUndefined();
  });

  it('rejects a missing/empty jobId', async () => {
    const store = fakeSnapshotStore();
    await expect(performMediaJob('', store)).rejects.toThrow(/"jobId" is required/);
  });

  it('maps a progress event to {phase, done, total}', async () => {
    const store = fakeSnapshotStore();
    recordMediaJobSnapshot({ type: 'synapse:download-engine-event', jobId: 'j1', phase: 'segments', segmentsDone: 3, segmentsTotal: 10 }, store);

    await expect(performMediaJob('j1', store)).resolves.toEqual({ phase: 'segments', done: 3, total: 10 });
  });

  it('carries the error message only for phase "error"', async () => {
    const store = fakeSnapshotStore();
    recordMediaJobSnapshot({ type: 'synapse:download-engine-event', jobId: 'j1', phase: 'error', message: 'boom' }, store);

    await expect(performMediaJob('j1', store)).resolves.toEqual({ phase: 'error', error: 'boom' });
  });

  it('a later event overwrites the earlier snapshot for the same jobId', async () => {
    const store = fakeSnapshotStore();
    recordMediaJobSnapshot({ type: 'synapse:download-engine-event', jobId: 'j1', phase: 'segments', segmentsDone: 1, segmentsTotal: 10 }, store);
    recordMediaJobSnapshot({ type: 'synapse:download-engine-event', jobId: 'j1', phase: 'done' }, store);

    await expect(performMediaJob('j1', store)).resolves.toEqual({ phase: 'done' });
  });
});

describe('performMediaControl', () => {
  it('rejects a missing/empty jobId', async () => {
    const transport = fakeTransport();
    await expect(performMediaControl('', 'pause', transport)).rejects.toThrow(/"jobId" is required/);
    expect(transport.sent).toHaveLength(0);
  });

  it('rejects an unknown action', async () => {
    const transport = fakeTransport();
    await expect(performMediaControl('j1', 'nope', transport)).rejects.toThrow(/unknown action/);
    expect(transport.sent).toHaveLength(0);
  });

  it.each([
    ['pause', 'PAUSE'],
    ['resume', 'RESUME'],
    ['cancel', 'CANCEL'],
    ['stop-live', 'STOP_LIVE'],
  ] as const)('maps action %s to op %s', async (action, op) => {
    const transport = fakeTransport();
    await performMediaControl('j1', action, transport);
    expect(transport.sent).toEqual([{ type: 'synapse:download-engine-command', op, jobId: 'j1' }]);
  });
});
