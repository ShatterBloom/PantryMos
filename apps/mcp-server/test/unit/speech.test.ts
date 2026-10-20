import { describe, expect, it } from 'vitest';
import { formatNumber, listAnd, listOr, speakQuantity } from '../../src/domain/speech.ts';

describe('formatNumber', () => {
  it('drops float noise and trailing zeros', () => {
    expect(formatNumber(12)).toBe('12');
    expect(formatNumber(0.5)).toBe('0.5');
    expect(formatNumber(1.2000000000000002)).toBe('1.2');
    expect(formatNumber(1000)).toBe('1000');
  });
});

describe('speakQuantity', () => {
  it.each([
    ['egg', 12, 'count', 'count', '12 eggs'],
    ['egg', 1, 'count', 'count', '1 egg'],
    ['tomato', 2, 'count', 'count', '2 tomatoes'],
    ['egg', 2, 'dozen', 'count', '2 dozen eggs'],
    ['spinach', 500, 'g', 'g', '500 grams of spinach'],
    ['flour', 1, 'kg', 'g', '1 kilogram of flour'],
    ['milk', 1, 'l', 'ml', '1 liter of milk'],
    ['milk', 250, 'ml', 'ml', '250 milliliters of milk'],
    ['milk', 0.5, 'l', 'ml', '0.5 liters of milk'],
    ['egg', 1, 'carton', 'count', '1 carton of eggs'],
    ['egg', 2, 'carton', 'count', '2 cartons of eggs'],
    ['flour', 1, 'bag', 'g', '1 bag of flour'],
  ] as const)('%s %s %s → %s', (item, quantity, unit, base, expected) => {
    expect(speakQuantity(item, quantity, unit, base)).toBe(expected);
  });
});

describe('listAnd', () => {
  it('joins naturally', () => {
    expect(listAnd([])).toBe('');
    expect(listAnd(['a'])).toBe('a');
    expect(listAnd(['a', 'b'])).toBe('a and b');
    expect(listAnd(['a', 'b', 'c'])).toBe('a, b and c');
    expect(listOr(['a', 'b', 'c'])).toBe('a, b or c');
    expect(listOr([])).toBe('');
  });
});
