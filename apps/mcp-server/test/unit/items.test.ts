import { describe, expect, it } from 'vitest';
import { canonicalItemName, type CatalogItem, resolveItem } from '../../src/domain/items.ts';

const item = (name: string, aliases: string[] = [], id = name): CatalogItem => ({
  id,
  name,
  aliases,
  base_unit: 'count',
  category: 'produce',
  default_shelf_days: null,
});

const catalog: CatalogItem[] = [
  item('egg'),
  item('tomato'),
  item('scallion', ['green onion', 'spring onion']),
  item('onion'),
  item('milk'),
  item('oat milk'),
  item('red pepper', ['pepper']),
  item('black pepper', ['pepper']),
];

const resolved = (name: string) => {
  const r = resolveItem(name, catalog);
  return r.kind === 'found' ? r.item.name : r.kind;
};

describe('resolveItem (§6.1)', () => {
  it('matches the exact name, case- and whitespace-insensitively', () => {
    expect(resolved('Egg')).toBe('egg');
    expect(resolved('  OAT   milk ')).toBe('oat milk');
  });

  it('matches an alias', () => {
    expect(resolved('green onion')).toBe('scallion');
    expect(resolved('Spring Onion')).toBe('scallion');
  });

  it('matches singular and plural forms of names and aliases', () => {
    expect(resolved('eggs')).toBe('egg');
    expect(resolved('tomatoes')).toBe('tomato');
    expect(resolved('green onions')).toBe('scallion');
  });

  it('prefers an exact name over an alias or plural match', () => {
    // "onion" is both an item name and a word inside scallion's aliases.
    expect(resolved('onion')).toBe('onion');
    expect(resolved('onions')).toBe('onion');
    expect(resolved('milk')).toBe('milk');
  });

  it('reports ambiguity with every matching option', () => {
    const r = resolveItem('pepper', catalog);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.options.map((o) => o.name).sort()).toEqual(['black pepper', 'red pepper']);
    expect(resolveItem('peppers', catalog).kind).toBe('ambiguous');
  });

  it('reports unknown items with close suggestions', () => {
    expect(resolveItem('salmon', catalog)).toEqual({ kind: 'unknown', suggestions: [] });
    expect(resolveItem('tomatto', catalog)).toEqual({ kind: 'unknown', suggestions: ['tomato'] });
    const almond = resolveItem('almond milk', catalog);
    expect(almond).toEqual({ kind: 'unknown', suggestions: ['milk', 'oat milk'] });
  });

  it('caps suggestions at five', () => {
    const many = Array.from({ length: 8 }, (_, i) => item(`milk ${i}`));
    const r = resolveItem('milk powder', many);
    expect(r.kind === 'unknown' && r.suggestions).toHaveLength(5);
  });

  it('returns unknown on an empty catalog', () => {
    expect(resolveItem('egg', [])).toEqual({ kind: 'unknown', suggestions: [] });
  });
});

describe('canonicalItemName', () => {
  it('normalizes and singularizes the last word, matching what resolveItem compares', () => {
    expect(canonicalItemName('  Apples ')).toBe('apple');
    expect(canonicalItemName('Frozen  Peas')).toBe('frozen pea');
    expect(canonicalItemName('Oat Milk')).toBe('oat milk');
    expect(canonicalItemName('hummus')).toBe('hummus');
  });
});
