import { describe, expect, it } from 'vitest';
import { isKnownPipelineSlot, resolveHookWinner, type PipelineHookRecord } from './pipeline-hook-bridge';

describe('isKnownPipelineSlot', () => {
  it('accepts the one v1 slot', () => {
    expect(isKnownPipelineSlot('media.correlate-url')).toBe(true);
  });

  it('rejects anything not in the fixed allowlist', () => {
    expect(isKnownPipelineSlot('media.preprocess-dom')).toBe(false);
    expect(isKnownPipelineSlot('')).toBe(false);
  });
});

describe('resolveHookWinner', () => {
  const labelFor = (id: string): string => ({ a: 'Alpha', b: 'Beta' })[id] ?? id;

  it('returns undefined when no candidate matches the url', () => {
    const candidates: PipelineHookRecord[] = [{ ownerModuleId: 'a', slotName: 'media.correlate-url', match: ['*://other.com/*'] }];
    expect(resolveHookWinner(candidates, 'https://example.com/watch', labelFor)).toBeUndefined();
  });

  it('picks the only matching candidate', () => {
    const candidates: PipelineHookRecord[] = [{ ownerModuleId: 'a', slotName: 'media.correlate-url', match: ['*://example.com/*'] }];
    expect(resolveHookWinner(candidates, 'https://example.com/watch', labelFor)).toBe(candidates[0]);
  });

  it('picks the more specific match pattern over a broader one', () => {
    const broad: PipelineHookRecord = { ownerModuleId: 'a', slotName: 'media.correlate-url', match: ['*://*/*'] };
    const specific: PipelineHookRecord = { ownerModuleId: 'b', slotName: 'media.correlate-url', match: ['*://videos.example.com/watch/*'] };
    expect(resolveHookWinner([broad, specific], 'https://videos.example.com/watch/123', labelFor)).toBe(specific);
    expect(resolveHookWinner([specific, broad], 'https://videos.example.com/watch/123', labelFor)).toBe(specific);
  });

  it('scores a candidate by its own best-matching pattern, not its worst', () => {
    const candidate: PipelineHookRecord = {
      ownerModuleId: 'a',
      slotName: 'media.correlate-url',
      match: ['*://*/*', '*://videos.example.com/watch/*'],
    };
    const other: PipelineHookRecord = { ownerModuleId: 'b', slotName: 'media.correlate-url', match: ['*://*.example.com/*'] };
    expect(resolveHookWinner([candidate, other], 'https://videos.example.com/watch/123', labelFor)).toBe(candidate);
  });

  it('breaks a specificity tie alphabetically by label, never by registration order', () => {
    const first: PipelineHookRecord = { ownerModuleId: 'b', slotName: 'media.correlate-url', match: ['*://example.com/*'] };
    const second: PipelineHookRecord = { ownerModuleId: 'a', slotName: 'media.correlate-url', match: ['*://example.com/*'] };
    // registered in [b, a] order — winner must be 'a' (Alpha < Beta), not the first-registered 'b'
    expect(resolveHookWinner([first, second], 'https://example.com/watch', labelFor)?.ownerModuleId).toBe('a');
    // reversed registration order — same winner, proving order-independence
    expect(resolveHookWinner([second, first], 'https://example.com/watch', labelFor)?.ownerModuleId).toBe('a');
  });
});
