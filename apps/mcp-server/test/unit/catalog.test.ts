// Consistency of the seeded demo catalog with the database constraints and item resolution.
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../../../db/seed/catalog.ts';
import { type CatalogItem, resolveItem } from '../../src/domain/items.ts';
import { normalizeName, plural, singular } from '../../src/domain/text.ts';

const catalog: CatalogItem[] = CATALOG.map((item) => ({
  id: item.name,
  name: item.name,
  aliases: item.aliases ?? [],
  base_unit: item.base_unit,
  category: item.category,
  default_shelf_days: item.default_shelf_days,
}));

describe('demo catalog', () => {
  it('has unique names, case-insensitively (items_name_ci)', () => {
    const names = CATALOG.map((i) => i.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('stores names already normalized and within the length limit', () => {
    for (const item of CATALOG) {
      expect(item.name).toBe(normalizeName(item.name));
      expect(item.name.length).toBeGreaterThanOrEqual(1);
      expect(item.name.length).toBeLessThanOrEqual(60);
    }
  });

  it('has positive shelf days where given', () => {
    for (const item of CATALOG) {
      if (item.default_shelf_days !== null) expect(item.default_shelf_days).toBeGreaterThan(0);
    }
  });

  it('resolves every name and alias, singular and plural, to its own item without ambiguity', () => {
    for (const item of catalog) {
      for (const spoken of [item.name, ...item.aliases]) {
        for (const form of [spoken, singular(spoken), plural(singular(spoken))]) {
          const r = resolveItem(form, catalog);
          expect({ form, resolved: r.kind === 'found' ? r.item.name : r.kind }).toEqual({ form, resolved: item.name });
        }
      }
    }
  });

  it('includes the items the demo narrative needs (PRD §9)', () => {
    for (const name of ['egg', 'milk', 'tomato', 'spinach', 'scallion', 'onion', 'pasta']) {
      expect(resolveItem(name, catalog).kind).toBe('found');
    }
  });
});
