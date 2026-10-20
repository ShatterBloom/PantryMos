import { describe, expect, it } from 'vitest';
import { describeOperation } from '../../src/domain/operations.ts';

describe('describeOperation', () => {
  it('labels the operation and lists signed net changes in spoken units', () => {
    expect(
      describeOperation('consume', 'creamy spinach pasta', [
        { item: 'egg', unit: 'count', delta: -2 },
        { item: 'milk', unit: 'ml', delta: -250 },
      ]),
    ).toBe('Cooked creamy spinach pasta: −2 eggs and −250 milliliters of milk');
    expect(describeOperation('intake', null, [{ item: 'egg', unit: 'count', delta: 12 }])).toBe('Groceries added: +12 eggs');
    expect(describeOperation('revise_consumption', 'omelette', [{ item: 'egg', unit: 'count', delta: 1 }])).toBe(
      'Corrected omelette: +1 egg',
    );
  });

  it('covers every kind, with or without a recipe, and operations that changed nothing', () => {
    expect(describeOperation('consume', null, [])).toBe('Cooked: no stock changed');
    expect(describeOperation('revise_consumption', null, [])).toBe('Corrected a meal: no stock changed');
    expect(describeOperation('adjust', null, [{ item: 'flour', unit: 'g', delta: -0.5 }])).toBe('Stock adjusted: −0.5 grams of flour');
    expect(describeOperation('undo', null, [{ item: 'egg', unit: 'count', delta: 2 }])).toBe('Undo: +2 eggs');
  });
});
