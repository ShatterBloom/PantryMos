// Demo recipes: self-authored (PRD FR-10), in the catalog's base units (g, ml, count).
// "Creamy spinach pasta" carries the demo narrative (PRD §9): dinner for three, scallion → onion,
// an 8-minute pasta timer, and milk to spill.
export interface SeedRecipe {
  name: string;
  aliases?: string[];
  servings: number;
  ingredients: Array<{
    item: string;
    quantity: number;
    optional?: boolean;
    substitutes?: Array<{ item: string; ratio: number }>;
  }>;
  steps: Array<{ text: string; timer_seconds?: number; timer_label?: string }>;
}

export const RECIPES: readonly SeedRecipe[] = [
  {
    name: 'creamy spinach pasta',
    aliases: ['spinach pasta'],
    servings: 3,
    ingredients: [
      { item: 'pasta', quantity: 300 },
      { item: 'spinach', quantity: 150 },
      { item: 'milk', quantity: 250 },
      { item: 'garlic clove', quantity: 2 },
      { item: 'butter', quantity: 20 },
      { item: 'scallion', quantity: 2, substitutes: [{ item: 'onion', ratio: 0.5 }] },
      { item: 'parmesan', quantity: 40, optional: true, substitutes: [{ item: 'cheddar', ratio: 1 }] },
    ],
    steps: [
      { text: 'Bring a large pot of salted water to a boil.' },
      { text: 'Add the pasta and boil it until al dente, about 8 minutes.', timer_seconds: 480, timer_label: 'pasta' },
      { text: 'Meanwhile, melt the butter in a pan and soften the garlic and scallions.', timer_seconds: 120, timer_label: 'garlic' },
      { text: 'Add the spinach and stir until it wilts.' },
      { text: 'Pour in the milk and simmer for 3 minutes.', timer_seconds: 180, timer_label: 'sauce' },
      { text: 'Drain the pasta, toss it in the sauce, and top with the parmesan.' },
    ],
  },
  {
    name: 'tomato egg stir-fry',
    aliases: ['tomato and egg stir-fry', 'tomato egg stir fry'],
    servings: 2,
    ingredients: [
      { item: 'egg', quantity: 3 },
      { item: 'tomato', quantity: 2 },
      { item: 'olive oil', quantity: 15 },
      { item: 'scallion', quantity: 1, substitutes: [{ item: 'onion', ratio: 0.5 }] },
      { item: 'soy sauce', quantity: 5, optional: true },
    ],
    steps: [
      { text: 'Beat the eggs with a pinch of salt and cut the tomatoes into wedges.' },
      { text: 'Scramble the eggs in half the oil until just set, then take them out.', timer_seconds: 60, timer_label: 'eggs' },
      { text: 'Cook the tomatoes in the rest of the oil until they soften.', timer_seconds: 180, timer_label: 'tomatoes' },
      { text: 'Return the eggs, add the scallions and soy sauce, and toss.' },
    ],
  },
  {
    name: 'spinach omelette',
    aliases: ['spinach omelet'],
    servings: 1,
    ingredients: [
      { item: 'egg', quantity: 3 },
      { item: 'spinach', quantity: 50 },
      { item: 'milk', quantity: 30 },
      { item: 'butter', quantity: 10 },
      { item: 'cheddar', quantity: 30, optional: true },
    ],
    steps: [
      { text: 'Whisk the eggs with the milk and a pinch of salt.' },
      { text: 'Melt the butter in a pan and wilt the spinach.', timer_seconds: 60, timer_label: 'spinach' },
      { text: 'Pour in the eggs and cook on low heat until almost set.', timer_seconds: 180, timer_label: 'omelette' },
      { text: 'Sprinkle on the cheese, fold the omelette, and slide it onto a plate.' },
    ],
  },
  {
    name: 'vegetable fried rice',
    aliases: ['fried rice'],
    servings: 2,
    ingredients: [
      { item: 'rice', quantity: 200 },
      { item: 'egg', quantity: 2 },
      { item: 'frozen peas', quantity: 100 },
      { item: 'carrot', quantity: 1 },
      { item: 'soy sauce', quantity: 30 },
      { item: 'olive oil', quantity: 15 },
      { item: 'scallion', quantity: 2, substitutes: [{ item: 'onion', ratio: 0.5 }] },
    ],
    steps: [
      { text: 'Cook the rice and spread it out to cool.', timer_seconds: 900, timer_label: 'rice' },
      { text: 'Scramble the eggs in a little oil and set them aside.' },
      { text: 'Stir-fry the diced carrot and the peas in the rest of the oil.', timer_seconds: 240, timer_label: 'vegetables' },
      { text: 'Add the rice, eggs, soy sauce and scallions, and stir-fry until hot.' },
    ],
  },
  {
    name: 'potato soup',
    aliases: ['creamy potato soup'],
    servings: 4,
    ingredients: [
      { item: 'potato', quantity: 4 },
      { item: 'onion', quantity: 1 },
      { item: 'carrot', quantity: 2 },
      { item: 'milk', quantity: 300 },
      { item: 'butter', quantity: 20 },
    ],
    steps: [
      { text: 'Peel and dice the potatoes, onion and carrots.' },
      { text: 'Soften the onion in the butter.', timer_seconds: 300, timer_label: 'onion' },
      { text: 'Add the potatoes, carrots and enough water to cover, and simmer until tender.', timer_seconds: 1200, timer_label: 'soup' },
      { text: 'Stir in the milk, blend until smooth, and season to taste.' },
    ],
  },
];
