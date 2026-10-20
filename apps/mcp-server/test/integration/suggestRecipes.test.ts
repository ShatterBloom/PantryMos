// suggest_recipes over MCP with the demo recipes (story C1, FR-9, I1).
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServers, startServers } from '../../src/app.ts';
import { parseErrorResult } from '../../src/mcp/toolkit.ts';
import {
  callWrite,
  connectMcpClient,
  createDemoKitchen,
  type DemoKitchen,
  mcpTestConfig,
  PASTA_STOCK,
  stockKitchen,
} from '../../../../test/fixtures.ts';

interface Suggestion {
  name: string;
  servings: number;
  makeable: boolean;
  score: number;
  reason: Array<{ item: string; date_label: string }>;
  shortfall: Array<{ item: string; need: number; have: number }>;
  substitutions_needed: Array<{ from_item: string; options: Array<{ to_item: string; quantity: number }> }>;
}

describe('suggest_recipes', () => {
  let servers: RunningServers;
  beforeAll(async () => {
    servers = await startServers(mcpTestConfig(), { log: false });
  });
  afterAll(async () => servers.close());

  let kitchen: DemoKitchen;
  let client: Client;
  beforeEach(async () => {
    kitchen = await createDemoKitchen();
    client = await connectMcpClient(servers, kitchen.token);
    await client.listTools();
    return () => client.close();
  });

  const suggest = async (args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name: 'suggest_recipes', arguments: args });
    expect(parseErrorResult(res)).toBeNull();
    return { out: res.structuredContent as { servings: number | null; recipes: Suggestion[] }, text: (res.content as Array<{ text: string }>)[0]!.text };
  };

  it('ranks the recipe that uses what should go first highest, and says why (C1)', async () => {
    await stockKitchen(kitchen, { ...PASTA_STOCK, spinach: 300 }, 5); // everything bought 5 days ago
    await stockKitchen(kitchen, { egg: 12, 'olive oil': 500, tomato: 4 }, 0);
    const { out, text } = await suggest({ max_results: 5 });
    const top = out.recipes[0]!;
    expect(top).toMatchObject({ name: 'creamy spinach pasta', makeable: true });
    expect(top.reason).toContainEqual(expect.objectContaining({ item: 'spinach', date_label: 'stored for 5 days, no package date' }));
    expect(text).toMatch(/^Best: creamy spinach pasta, using .*spinach \(stored for 5 days, no package date\)/);
  });

  it('lists recipes the stock cannot make after the makeable ones, with their shortfall (C1)', async () => {
    await stockKitchen(kitchen, { egg: 12, tomato: 4, 'olive oil': 100, scallion: 2 });
    const { out } = await suggest({ max_results: 5 });
    expect(out.recipes[0]).toMatchObject({ name: 'tomato egg stir-fry', makeable: true, shortfall: [] });
    const soup = out.recipes.find((r) => r.name === 'potato soup')!;
    expect(soup.makeable).toBe(false);
    expect(soup.shortfall.map((s) => s.item).sort()).toEqual(['butter', 'carrot', 'milk', 'onion', 'potato']);
    expect(out.recipes.findIndex((r) => !r.makeable)).toBeGreaterThan(0);
  });

  it('offers a substitute, and the recommended plan starts as promised (I1, G2)', async () => {
    const { scallion: _s, ...noScallions } = PASTA_STOCK;
    await stockKitchen(kitchen, { ...noScallions, onion: 3 });
    const { out } = await suggest({ servings: 3, must_use_item: 'spinach' });
    const pasta = out.recipes.find((r) => r.name === 'creamy spinach pasta')!;
    expect(pasta).toMatchObject({
      makeable: true,
      substitutions_needed: [{ from_item: 'scallion', options: [{ to_item: 'onion', quantity: 1, in_stock: true }] }],
    });

    const started = await callWrite(client, 'start_cooking', {
      recipe_name: pasta.name,
      servings: 3,
      substitutions: [{ from_item: 'scallion', to_item: 'onion' }],
    });
    expect(parseErrorResult(started)).toBeNull();
  });

  it('scales makeability to the requested servings', async () => {
    await stockKitchen(kitchen, PASTA_STOCK);
    expect((await suggest({ servings: 3, must_use_item: 'pasta' })).out.recipes[0]).toMatchObject({ servings: 3, makeable: true });
    const big = (await suggest({ servings: 12, must_use_item: 'pasta' })).out;
    expect(big.servings).toBe(12);
    expect(big.recipes[0]).toMatchObject({ makeable: false });
    expect(big.recipes[0]!.shortfall).toContainEqual({ item: 'pasta', need: 1200, have: 500, unit: 'g' });
  });

  it('filters by an item and caps the number of results', async () => {
    await stockKitchen(kitchen, { egg: 12 });
    const eggs = (await suggest({ must_use_item: 'eggs', max_results: 5 })).out.recipes.map((r) => r.name).sort();
    expect(eggs).toEqual(['spinach omelette', 'tomato egg stir-fry', 'vegetable fried rice']);
    expect((await suggest({ max_results: 1 })).out.recipes).toHaveLength(1);
    expect((await suggest({ must_use_item: 'unobtainium' })).out.recipes).toEqual([]);
  });

  it('says nothing is makeable when the pantry is empty', async () => {
    const { out, text } = await suggest();
    expect(out.recipes.every((r) => !r.makeable)).toBe(true);
    expect(text).toMatch(/^Nothing is makeable right now/);
  });
});
