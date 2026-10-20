// Demo household catalog (IMPLEMENTATION_PLAN §1.1 db/seed). Covers the demo narrative (PRD §9):
// eggs, milk, tomato, spinach, scallion → onion substitution, pasta. No unit conversions are seeded:
// "a carton of eggs" is learned through the clarification flow (story B2).
import type { BaseUnit, Category } from '../../apps/mcp-server/src/domain/items.ts';

export interface SeedItem {
  name: string;
  aliases?: string[];
  base_unit: BaseUnit;
  category: Category;
  default_shelf_days: number | null;
}

export const CATALOG: readonly SeedItem[] = [
  { name: 'egg', base_unit: 'count', category: 'dairy', default_shelf_days: 21 },
  { name: 'milk', aliases: ['whole milk'], base_unit: 'ml', category: 'dairy', default_shelf_days: 7 },
  { name: 'butter', base_unit: 'g', category: 'dairy', default_shelf_days: 30 },
  { name: 'cheddar', aliases: ['cheddar cheese', 'cheese'], base_unit: 'g', category: 'dairy', default_shelf_days: 21 },
  { name: 'parmesan', aliases: ['parmesan cheese', 'parmigiano'], base_unit: 'g', category: 'dairy', default_shelf_days: 60 },
  { name: 'yogurt', aliases: ['yoghurt'], base_unit: 'g', category: 'dairy', default_shelf_days: 10 },
  { name: 'tomato', base_unit: 'count', category: 'produce', default_shelf_days: 7 },
  { name: 'spinach', aliases: ['baby spinach'], base_unit: 'g', category: 'produce', default_shelf_days: 5 },
  { name: 'scallion', aliases: ['green onion', 'spring onion'], base_unit: 'count', category: 'produce', default_shelf_days: 7 },
  { name: 'onion', aliases: ['yellow onion'], base_unit: 'count', category: 'produce', default_shelf_days: 30 },
  { name: 'garlic', aliases: ['garlic clove'], base_unit: 'count', category: 'produce', default_shelf_days: 30 },
  { name: 'potato', base_unit: 'count', category: 'produce', default_shelf_days: 21 },
  { name: 'carrot', base_unit: 'count', category: 'produce', default_shelf_days: 21 },
  { name: 'bell pepper', aliases: ['capsicum'], base_unit: 'count', category: 'produce', default_shelf_days: 7 },
  { name: 'mushroom', aliases: ['button mushroom'], base_unit: 'g', category: 'produce', default_shelf_days: 5 },
  { name: 'lemon', base_unit: 'count', category: 'produce', default_shelf_days: 14 },
  { name: 'chicken breast', aliases: ['chicken'], base_unit: 'g', category: 'meat', default_shelf_days: 2 },
  { name: 'bacon', base_unit: 'g', category: 'meat', default_shelf_days: 7 },
  { name: 'salmon fillet', aliases: ['salmon'], base_unit: 'g', category: 'seafood', default_shelf_days: 2 },
  { name: 'frozen peas', aliases: ['peas'], base_unit: 'g', category: 'frozen', default_shelf_days: 180 },
  { name: 'bread', base_unit: 'g', category: 'bakery', default_shelf_days: 5 },
  { name: 'pasta', aliases: ['spaghetti', 'penne'], base_unit: 'g', category: 'pantry', default_shelf_days: 365 },
  { name: 'rice', aliases: ['white rice'], base_unit: 'g', category: 'pantry', default_shelf_days: 365 },
  { name: 'flour', aliases: ['all-purpose flour'], base_unit: 'g', category: 'pantry', default_shelf_days: 180 },
  { name: 'olive oil', base_unit: 'ml', category: 'pantry', default_shelf_days: 365 },
  { name: 'soy sauce', base_unit: 'ml', category: 'pantry', default_shelf_days: 365 },
];
