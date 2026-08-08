import { describe, expect, it } from 'vitest';
import { orphanedCheckpointIds } from './checkpoints';
import type { DownloadJobCheckpoint } from '../../../../../shared/download-engine-protocol';

function checkpoint(jobId: string): DownloadJobCheckpoint {
  return { jobId, lastConfirmedSegmentIndex: 0, total: 10 } as DownloadJobCheckpoint;
}

describe('orphanedCheckpointIds', () => {
  it('flags a checkpoint whose jobId has no matching DetectedMedia id', () => {
    const orphaned = orphanedCheckpointIds([checkpoint('a'), checkpoint('b')], new Set(['a']));
    expect(orphaned).toEqual(['b']);
  });

  it('flags nothing when every checkpoint still has a matching DetectedMedia entry', () => {
    const orphaned = orphanedCheckpointIds([checkpoint('a'), checkpoint('b')], new Set(['a', 'b', 'c']));
    expect(orphaned).toEqual([]);
  });

  it('flags everything when the detected-media set is empty', () => {
    const orphaned = orphanedCheckpointIds([checkpoint('a'), checkpoint('b')], new Set());
    expect(orphaned).toEqual(['a', 'b']);
  });

  it('is a no-op on an empty checkpoint list', () => {
    expect(orphanedCheckpointIds([], new Set(['a']))).toEqual([]);
  });
});
