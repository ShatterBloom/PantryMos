import { describe, expect, it } from 'vitest';
import { canonicalUnit, CONVERSION_UNIT, isBuiltinUnit, resolveUnit } from '../../src/domain/units.ts';

const none = new Map<string, number>();

describe('canonicalUnit', () => {
  it.each([
    ['g', 'g'],
    ['Grams', 'g'],
    ['kg', 'kg'],
    ['kilos', 'kg'],
    ['ML', 'ml'],
    ['milliliters', 'ml'],
    ['Litres', 'l'],
    ['pieces', 'count'],
    ['pcs', 'count'],
    ['each', 'count'],
    ['dozen', 'dozen'],
    ['Cartons', 'carton'],
    ['  tin  ', 'tin'],
    ['bunches', 'bunch'],
  ])('%j → %s', (raw, expected) => {
    expect(canonicalUnit(raw)).toBe(expected);
  });

  it('does not treat Object.prototype keys as units', () => {
    expect(canonicalUnit('constructor')).toBe('constructor');
    expect(isBuiltinUnit('constructor')).toBe(false);
    expect(resolveUnit('toString', 'count', none)).toEqual({ kind: 'unknown', unit: 'tostring' });
  });
});

describe('resolveUnit (§6.1)', () => {
  it('accepts base units and kg / l / dozen with their factors', () => {
    expect(resolveUnit('count', 'count', none)).toEqual({ kind: 'ok', unit: 'count', factor: 1 });
    expect(resolveUnit('dozen', 'count', none)).toEqual({ kind: 'ok', unit: 'dozen', factor: 12 });
    expect(resolveUnit('g', 'g', none)).toEqual({ kind: 'ok', unit: 'g', factor: 1 });
    expect(resolveUnit('kilograms', 'g', none)).toEqual({ kind: 'ok', unit: 'kg', factor: 1000 });
    expect(resolveUnit('ml', 'ml', none)).toEqual({ kind: 'ok', unit: 'ml', factor: 1 });
    expect(resolveUnit('liter', 'ml', none)).toEqual({ kind: 'ok', unit: 'l', factor: 1000 });
  });

  it('flags a built-in unit of the wrong dimension as a mismatch', () => {
    expect(resolveUnit('g', 'count', none)).toEqual({ kind: 'mismatch', unit: 'g' });
    expect(resolveUnit('l', 'g', none)).toEqual({ kind: 'mismatch', unit: 'l' });
    expect(resolveUnit('dozen', 'ml', none)).toEqual({ kind: 'mismatch', unit: 'dozen' });
  });

  it('uses saved conversions, singular or plural', () => {
    const conversions = new Map([['carton', 12]]);
    expect(resolveUnit('carton', 'count', conversions)).toEqual({ kind: 'ok', unit: 'carton', factor: 12 });
    expect(resolveUnit('Cartons', 'count', conversions)).toEqual({ kind: 'ok', unit: 'carton', factor: 12 });
  });

  it('reports an unknown unit in canonical form, so the question and the saved conversion agree', () => {
    expect(resolveUnit('Cartons', 'count', none)).toEqual({ kind: 'unknown', unit: 'carton' });
  });

  it('never lets a conversion shadow a built-in unit', () => {
    expect(resolveUnit('g', 'count', new Map([['g', 5]]))).toEqual({ kind: 'mismatch', unit: 'g' });
  });
});

describe('CONVERSION_UNIT', () => {
  it('matches the database CHECK shape', () => {
    expect(CONVERSION_UNIT.test('carton')).toBe(true);
    expect(CONVERSION_UNIT.test('tin can')).toBe(true);
    expect(CONVERSION_UNIT.test('Carton')).toBe(false);
    expect(CONVERSION_UNIT.test('1carton')).toBe(false);
    expect(CONVERSION_UNIT.test('a'.repeat(21))).toBe(false);
  });
});
