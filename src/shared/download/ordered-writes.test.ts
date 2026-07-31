import { describe, expect, it } from 'vitest';
import { createOrderedBuffer } from './ordered-writes';

/** Feeds arrivals in the given order and returns the indices released, in release order — i.e. the
 * order the bytes would actually hit the OPFS file. */
function releaseOrder(arrivals: number[], startIndex = 0): number[] {
  const buffer = createOrderedBuffer<string>(startIndex);
  const released: number[] = [];
  for (const index of arrivals) {
    for (const item of buffer.add(index, `segment-${index}`)) released.push(item.index);
  }
  return released;
}

describe('createOrderedBuffer', () => {
  it('releases immediately when segments arrive in order', () => {
    expect(releaseOrder([0, 1, 2, 3])).toEqual([0, 1, 2, 3]);
  });

  it('holds an out-of-order arrival until its predecessors land', () => {
    const buffer = createOrderedBuffer<string>();
    expect(buffer.add(2, 'c')).toEqual([]);
    expect(buffer.add(1, 'b')).toEqual([]);
    expect(buffer.pendingCount()).toBe(2);
    // Segment 0 was the gap everything behind it was waiting on — all three release at once, in
    // original order, which is the whole reason a concurrent pool is safe.
    expect(buffer.add(0, 'a')).toEqual([
      { index: 0, value: 'a' },
      { index: 1, value: 'b' },
      { index: 2, value: 'c' },
    ]);
    expect(buffer.pendingCount()).toBe(0);
    expect(buffer.nextIndex()).toBe(3);
  });

  it('never releases out of original order, whatever order the network hands segments over', () => {
    expect(releaseOrder([4, 2, 0, 3, 1, 5])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(releaseOrder([5, 4, 3, 2, 1, 0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('starts from a resume offset — earlier indices are already durably on disk', () => {
    const buffer = createOrderedBuffer<string>(10);
    expect(buffer.nextIndex()).toBe(10);
    expect(buffer.add(11, 'later')).toEqual([]);
    expect(buffer.add(10, 'first')).toEqual([
      { index: 10, value: 'first' },
      { index: 11, value: 'later' },
    ]);
  });

  it('drops an index at or before the cursor instead of rewriting bytes already on disk', () => {
    const buffer = createOrderedBuffer<string>();
    buffer.add(0, 'a');
    expect(buffer.add(0, 'a-again')).toEqual([]);
    expect(buffer.pendingCount()).toBe(0);
    expect(buffer.nextIndex()).toBe(1);
  });

  it('bounds buffering by how many arrivals are actually ahead of the cursor', () => {
    const buffer = createOrderedBuffer<string>();
    for (const index of [3, 4, 5]) buffer.add(index, `s${index}`);
    expect(buffer.pendingCount()).toBe(3);
    buffer.add(1, 's1');
    expect(buffer.pendingCount()).toBe(4);
    buffer.add(0, 's0');
    expect(buffer.pendingCount()).toBe(3); // 0 and 1 flushed; 3,4,5 still waiting on 2
    buffer.add(2, 's2');
    expect(buffer.pendingCount()).toBe(0);
  });
});
