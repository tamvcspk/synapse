import { describe, expect, it } from 'vitest';
import {
  performHookRegister,
  performHookUnregister,
  resolveHookWinnerForSlot,
  type PipelineHookStore,
} from './pipeline-hook-store';
import type { PipelineHookRecord } from '../../../shared/pipeline-hook-bridge';

function fakeStore(initial: PipelineHookRecord[] = []): PipelineHookStore & { records: PipelineHookRecord[] } {
  const state = { records: [...initial] };
  return {
    get records() {
      return state.records;
    },
    list: async () => state.records,
    save: async (records: PipelineHookRecord[]) => {
      state.records = records;
    },
  } as unknown as PipelineHookStore & { records: PipelineHookRecord[] };
}

describe('performHookRegister', () => {
  it('rejects an unknown slot name before touching the store', async () => {
    const store = fakeStore();
    await expect(performHookRegister('script-a', 'media.preprocess-dom', { match: ['*://example.com/*'] }, store)).rejects.toThrow(
      /unknown slot/,
    );
    expect(store.records).toEqual([]);
  });

  it('rejects an empty or invalid match array', async () => {
    const store = fakeStore();
    await expect(performHookRegister('script-a', 'media.correlate-url', { match: [] }, store)).rejects.toThrow(/"match"/);
    await expect(performHookRegister('script-a', 'media.correlate-url', { match: ['not-a-pattern'] }, store)).rejects.toThrow(/"match"/);
    expect(store.records).toEqual([]);
  });

  it('persists a valid registration owned by the calling module', async () => {
    const store = fakeStore();
    await performHookRegister('script-a', 'media.correlate-url', { match: ['*://example.com/*'] }, store);
    expect(store.records).toEqual([{ ownerModuleId: 'script-a', slotName: 'media.correlate-url', match: ['*://example.com/*'] }]);
  });

  it('upserts by (ownerModuleId, slotName) instead of accumulating', async () => {
    const store = fakeStore();
    await performHookRegister('script-a', 'media.correlate-url', { match: ['*://a.com/*'] }, store);
    await performHookRegister('script-a', 'media.correlate-url', { match: ['*://b.com/*'] }, store);
    expect(store.records).toEqual([{ ownerModuleId: 'script-a', slotName: 'media.correlate-url', match: ['*://b.com/*'] }]);
  });

  it('leaves another script\'s registration for the same slot untouched', async () => {
    const store = fakeStore([{ ownerModuleId: 'script-b', slotName: 'media.correlate-url', match: ['*://b.com/*'] }]);
    await performHookRegister('script-a', 'media.correlate-url', { match: ['*://a.com/*'] }, store);
    expect(store.records).toHaveLength(2);
  });
});

describe('performHookUnregister', () => {
  it('removes only the calling module\'s own record for that slot', async () => {
    const store = fakeStore([
      { ownerModuleId: 'script-a', slotName: 'media.correlate-url', match: ['*://a.com/*'] },
      { ownerModuleId: 'script-b', slotName: 'media.correlate-url', match: ['*://b.com/*'] },
    ]);
    await performHookUnregister('script-a', 'media.correlate-url', store);
    expect(store.records).toEqual([{ ownerModuleId: 'script-b', slotName: 'media.correlate-url', match: ['*://b.com/*'] }]);
  });
});

describe('resolveHookWinnerForSlot', () => {
  const labelFor = (id: string): string => id;

  it('returns undefined when nothing is registered for that slot', async () => {
    const store = fakeStore();
    await expect(resolveHookWinnerForSlot('media.correlate-url', 'https://example.com', labelFor, store)).resolves.toBeUndefined();
  });

  it('ignores records for a different slot entirely', async () => {
    const store = fakeStore([{ ownerModuleId: 'script-a', slotName: 'some-other-slot', match: ['*://example.com/*'] }]);
    await expect(resolveHookWinnerForSlot('media.correlate-url', 'https://example.com', labelFor, store)).resolves.toBeUndefined();
  });

  it('resolves the winning ownerModuleId for a matching url', async () => {
    const store = fakeStore([{ ownerModuleId: 'script-a', slotName: 'media.correlate-url', match: ['*://example.com/*'] }]);
    await expect(resolveHookWinnerForSlot('media.correlate-url', 'https://example.com/watch', labelFor, store)).resolves.toEqual({
      moduleId: 'script-a',
    });
  });
});
