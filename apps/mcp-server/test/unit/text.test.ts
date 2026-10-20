import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { levenshtein, normalizeName, plural, singular } from '../../src/domain/text.ts';

describe('normalizeName', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeName('  Oat   Milk \t')).toBe('oat milk');
  });
});

describe('singular', () => {
  it.each([
    ['eggs', 'egg'],
    ['tomatoes', 'tomato'],
    ['potatoes', 'potato'],
    ['berries', 'berry'],
    ['peaches', 'peach'],
    ['dishes', 'dish'],
    ['boxes', 'box'],
    ['glasses', 'glass'],
    ['cheeses', 'cheese'],
    ['pies', 'pie'],
    ['cartons', 'carton'],
    ['scallions', 'scallion'],
  ])('%s → %s', (word, expected) => {
    expect(singular(word)).toBe(expected);
  });

  it.each(['egg', 'rice', 'glass', 'hummus', 'asparagus', 'couscous', 'milk', 'tofu'])('leaves %s alone', (word) => {
    expect(singular(word)).toBe(word);
  });

  it('only changes the last word', () => {
    expect(singular('green onions')).toBe('green onion');
  });
});

describe('plural', () => {
  it.each([
    ['egg', 'eggs'],
    ['tomato', 'tomatoes'],
    ['berry', 'berries'],
    ['peach', 'peaches'],
    ['box', 'boxes'],
    ['carton', 'cartons'],
    ['key', 'keys'],
  ])('%s → %s', (word, expected) => {
    expect(plural(word)).toBe(expected);
  });

  it('round-trips through singular for regular nouns', () => {
    for (const word of ['egg', 'tomato', 'berry', 'peach', 'box', 'carton', 'onion', 'dish', 'glass']) {
      expect(singular(plural(word))).toBe(word);
    }
  });
});

describe('levenshtein', () => {
  it('computes known distances', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('egg', 'egg')).toBe(0);
    expect(levenshtein('egg', 'eggs')).toBe(1);
    expect(levenshtein('tomato', 'tomatto')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('property: is a metric (identity, symmetry, triangle inequality)', () => {
    const word = fc.string({ maxLength: 8 });
    fc.assert(
      fc.property(word, word, word, (a, b, c) => {
        expect(levenshtein(a, a)).toBe(0);
        expect(levenshtein(a, b)).toBe(levenshtein(b, a));
        expect(levenshtein(a, c)).toBeLessThanOrEqual(levenshtein(a, b) + levenshtein(b, c));
      }),
    );
  });
});
