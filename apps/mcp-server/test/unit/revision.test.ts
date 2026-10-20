import { describe, expect, it } from 'vitest';
import { revisionLines } from '../../src/domain/revision.ts';

describe('revisionLines (§6.5)', () => {
  const current = new Map([['egg', 2], ['tomato', 2]]);

  it('changes only the listed items and keeps the others as unchanged (R15)', () => {
    expect(revisionLines(current, new Map([['egg', 3]]))).toEqual([
      { item_id: 'egg', current: 2, target: 3, diff: 1, status: 'changed' },
      { item_id: 'tomato', current: 2, target: 2, diff: 0, status: 'unchanged' },
    ]);
  });

  it('allows 0 and items the meal did not use, but drops an unused item set to 0', () => {
    expect(revisionLines(current, new Map([['tomato', 0], ['milk', 50], ['pasta', 0]]))).toEqual([
      { item_id: 'egg', current: 2, target: 2, diff: 0, status: 'unchanged' },
      { item_id: 'tomato', current: 2, target: 0, diff: -2, status: 'changed' },
      { item_id: 'milk', current: 0, target: 50, diff: 50, status: 'changed' },
    ]);
  });

  it('computes diffs without float drift', () => {
    expect(revisionLines(new Map([['flour', 0.3]]), new Map([['flour', 0.1]]))[0]!.diff).toBe(-0.2);
  });
});
