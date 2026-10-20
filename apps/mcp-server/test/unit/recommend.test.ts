import { describe, expect, it } from 'vitest';
import { type Analysis, demandByItem, type ItemInfo } from '../../src/domain/cooking.ts';
import { type RankBatch, rankRecipe, suggestRecipe } from '../../src/domain/recommend.ts';
import type { Ingredient } from '../../src/domain/recipes.ts';

const TODAY = '2026-10-20';
const batch = (batch_id: string, item_id: string, quantity: number, priority_date: string): RankBatch => ({
  batch_id,
  item_id,
  item: item_id,
  quantity,
  version: 1,
  priority_date,
  date_label: `label ${batch_id}`,
});
const plan = (lines: Record<string, number>): Analysis => ({
  lines: Object.entries(lines).map(([item_id, quantity]) => ({ item_id, quantity, status: 'planned', origin: 'recipe' })),
  substitutions_needed: [],
  shortfall: [],
});

describe('rankRecipe (§6.3)', () => {
  // FEFO order: by priority date.
  const batches = [
    batch('spinach-old', 'spinach', 200, '2026-10-19'), // overdue
    batch('egg-soon', 'egg', 2, '2026-10-22'), // within 3 days
    batch('egg-later', 'egg', 12, '2026-11-10'),
    batch('rice-a', 'rice', 1000, '2027-06-01'), // oldest rice: priority by the oldest-batch rule
    batch('rice-b', 'rice', 1000, '2027-08-01'),
  ];

  it('counts each priority batch the plan would draw from, with its label as the reason', () => {
    expect(rankRecipe(plan({ spinach: 100, egg: 2 }), batches, TODAY)).toEqual({
      score: 2,
      reason: [
        { item: 'spinach', batch_id: 'spinach-old', date_label: 'label spinach-old' },
        { item: 'egg', batch_id: 'egg-soon', date_label: 'label egg-soon' },
      ],
      earliest: '2026-10-19',
    });
  });

  it('counts a later batch only when it is also due soon, not just because the plan spills into it', () => {
    // 4 eggs: 2 from egg-soon (priority), 2 from egg-later (not due, not the oldest).
    expect(rankRecipe(plan({ egg: 4 }), batches, TODAY).score).toBe(1);
  });

  it("treats each item's oldest batch as priority even when it is far from its date", () => {
    expect(rankRecipe(plan({ rice: 200 }), batches, TODAY)).toMatchObject({ score: 1, earliest: '2027-06-01' });
  });

  it('ignores lines stock cannot cover and items without stock', () => {
    expect(rankRecipe(plan({ spinach: 500, egg: 1, pasta: 300 }), batches, TODAY)).toMatchObject({
      score: 1,
      reason: [{ item: 'egg', batch_id: 'egg-soon', date_label: 'label egg-soon' }],
    });
  });

  it('scores an empty or unstocked plan as zero', () => {
    expect(rankRecipe(plan({}), batches, TODAY)).toEqual({ score: 0, reason: [], earliest: null });
    expect(rankRecipe(plan({ milk: 100 }), [], TODAY).score).toBe(0);
  });
});

describe('suggestRecipe', () => {
  const items = new Map<string, ItemInfo>(['leek', 'scallion', 'onion', 'pasta'].map((id) => [id, { name: id, base_unit: 'count' }]));
  const ing = (item_id: string, quantity: number, substitutes: Ingredient['substitutes'] = []): Ingredient => ({
    item_id, item: item_id, base_unit: 'count', quantity, optional: false, substitutes,
  });
  // Leek and scallion can each be replaced 1:1 by onion only.
  const ingredients = [ing('pasta', 1), ing('leek', 2, [{ item_id: 'onion', ratio: 1 }]), ing('scallion', 2, [{ item_id: 'onion', ratio: 1 }])];
  const suggest = (onions: number) =>
    suggestRecipe({ ingredients, recipeServings: 2, servings: 2, items, available: new Map([['pasta', 1], ['onion', onions]]) });

  it('is not makeable when single-option substitutes that each fit alone compete for the same stock', () => {
    const s = suggest(3);
    expect(s.substitutions.map((x) => x.options)).toEqual([[{ to_item_id: 'onion', quantity: 2 }], [{ to_item_id: 'onion', quantity: 2 }]]);
    expect(s.makeable).toBe(false);
    expect(s.plan.shortfall).toEqual([{ item_id: 'onion', need: 4, have: 3 }]);
  });

  it('is makeable, with both substitutes in the plan, when stock covers them together', () => {
    const s = suggest(4);
    expect(s.makeable).toBe(true);
    expect(Object.fromEntries(demandByItem(s.plan.lines))).toEqual({ pasta: 1, onion: 4 });
  });

  it('plans without substitutions when nothing is short', () => {
    const s = suggestRecipe({ ingredients, recipeServings: 2, servings: 2, items, available: new Map([['pasta', 1], ['leek', 2], ['scallion', 2]]) });
    expect(s).toMatchObject({ makeable: true, substitutions: [] });
  });
});
