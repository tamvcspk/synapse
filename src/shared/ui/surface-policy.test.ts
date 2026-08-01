import { describe, expect, it } from 'vitest';
import {
  TOAST_BURST,
  TOAST_REFILL_MS,
  admitToast,
  createToastBudget,
  insertionIndexFor,
  isKeyOf,
  surfaceKey,
  withinQuota,
} from './surface-policy';

describe('insertionIndexFor', () => {
  it('keeps the list sorted regardless of arrival order', () => {
    // The property that matters: two worlds inserting the same owners in OPPOSITE orders must end
    // up with the same list. Creation order is exactly what must not leak into the result.
    const insert = (owners: string[]): string[] => {
      const list: string[] = [];
      for (const owner of owners) list.splice(insertionIndexFor(list, owner), 0, owner);
      return list;
    };
    const forwards = insert(['network-sniffer', 'reader-mode-converter', 'a-user-script']);
    const backwards = insert(['a-user-script', 'reader-mode-converter', 'network-sniffer']);
    const shuffled = insert(['reader-mode-converter', 'a-user-script', 'network-sniffer']);

    expect(forwards).toEqual(['a-user-script', 'network-sniffer', 'reader-mode-converter']);
    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
  });

  it('appends at the end and inserts at the front', () => {
    expect(insertionIndexFor([], 'b')).toBe(0);
    expect(insertionIndexFor(['b', 'd'], 'a')).toBe(0);
    expect(insertionIndexFor(['b', 'd'], 'c')).toBe(1);
    expect(insertionIndexFor(['b', 'd'], 'z')).toBe(2);
  });

  it('places a duplicate id next to its twin rather than dropping it', () => {
    // Not expected in practice (one container per owner per zone), but the index must stay in range.
    expect(insertionIndexFor(['b', 'b'], 'b')).toBe(2);
  });
});

describe('surfaceKey', () => {
  it('cannot be forged: the same local id under two owners is two keys', () => {
    expect(surfaceKey('script-a', 'panel')).not.toBe(surfaceKey('script-b', 'panel'));
  });

  it('does not let a crafted local id claim another owner', () => {
    // The attack this mirrors is script-storage.test.ts's: caller-controlled text must never be
    // able to climb out of the prefix it was given. Only `localId` is caller-supplied, so a script
    // stuffing a separator into it must still be recognised as its own.
    const forged = surfaceKey('attacker', 'victim:panel');
    expect(isKeyOf('attacker', forged)).toBe(true);
    expect(isKeyOf('victim', forged)).toBe(false);
  });

  it('matches ownership only through isKeyOf, for every kind of key', () => {
    expect(isKeyOf('a', surfaceKey('a', 'x'))).toBe(true);
    expect(isKeyOf('a', surfaceKey('ab', 'x'))).toBe(false);
    expect(isKeyOf('ab', surfaceKey('a', 'b:x'))).toBe(false);
  });
});

describe('withinQuota', () => {
  it('allows exactly the documented number of icons', () => {
    expect(withinQuota('icon', 0)).toBe(true);
    expect(withinQuota('icon', 1)).toBe(true);
    // 2 is the cap because reader-mode-converter really does need Convert + Crawl.
    expect(withinQuota('icon', 2)).toBe(false);
  });

  it('caps toasts and badges independently', () => {
    expect(withinQuota('toast', 3)).toBe(false);
    expect(withinQuota('badge', 3)).toBe(true);
  });
});

describe('admitToast', () => {
  it('admits a burst, then refuses until refilled', () => {
    let budget = createToastBudget(0);
    for (let i = 0; i < TOAST_BURST; i++) {
      const result = admitToast(budget, 0);
      expect(result.admitted).toBe(true);
      budget = result.next;
    }
    expect(admitToast(budget, 0).admitted).toBe(false);
  });

  it('refills at the documented rate', () => {
    let budget = createToastBudget(0);
    for (let i = 0; i < TOAST_BURST; i++) budget = admitToast(budget, 0).next;

    expect(admitToast(budget, TOAST_REFILL_MS - 1).admitted).toBe(false);
    expect(admitToast(budget, TOAST_REFILL_MS).admitted).toBe(true);
  });

  it('never accumulates more than one burst while idle', () => {
    let budget = createToastBudget(0);
    budget = admitToast(budget, TOAST_REFILL_MS * 1000).next;
    let admitted = 0;
    for (let i = 0; i < 10; i++) {
      const result = admitToast(budget, TOAST_REFILL_MS * 1000);
      if (result.admitted) admitted++;
      budget = result.next;
    }
    expect(admitted).toBe(TOAST_BURST - 1);
  });

  it('is not fooled by a clock that goes backwards', () => {
    let budget = createToastBudget(0);
    for (let i = 0; i < TOAST_BURST; i++) budget = admitToast(budget, 1000).next;
    expect(admitToast(budget, 0).admitted).toBe(false);
  });
});
