import { describe, expect, it } from 'vitest';
import { ABSENT, bothChecks, checkArgs, checkClaims, checkDateWords, checkDb, checkTools, contains, sameItem, setToOf, stockDiff, toBase, type ToolCall } from '../../eval/checks.ts';

const call = (name: string, input: Record<string, unknown> = {}, status: ToolCall['status'] = 'success'): ToolCall => ({ name, input, status });

describe('checkTools', () => {
  const calls = [call('expiring_soon'), call('list_inventory'), call('suggest_recipes'), call('start_cooking')];

  it('passes an in-order subsequence with other calls in between', () => {
    expect(checkTools(calls, ['expiring_soon', 'suggest_recipes', 'start_cooking'])).toEqual({ verdict: 'pass', notes: [] });
  });

  it('fails a call out of order, a missing call, and a forbidden one', () => {
    expect(checkTools(calls, ['suggest_recipes', 'expiring_soon']).verdict).toBe('fail');
    expect(checkTools(calls, ['next_step']).notes[0]).toMatch(/missing next_step/);
    expect(checkTools(calls, [], ['start_cooking'])).toEqual({ verdict: 'fail', notes: ['start_cooking must not be called'] });
  });
});

describe('checkArgs', () => {
  it('needs one call of the tool containing the key fields', () => {
    const calls = [call('suggest_recipes', { servings: 2 }), call('suggest_recipes', { servings: 3, prefer_expiring: true })];
    expect(checkArgs(calls, [{ tool: 'suggest_recipes', args: { servings: 3 } }]).verdict).toBe('pass');
    expect(checkArgs(calls, [{ tool: 'suggest_recipes', args: { servings: 4 } }]).notes[0]).toMatch(/servings":4.*got/);
    expect(checkArgs([call('propose_intake', { items: [{ name: 'eggs', package_date: '2026-04-15' }] })], [
      { tool: 'propose_intake', args: { items: [{ name: /^eggs?$/i, package_date: ABSENT }] } },
    ]).notes).toEqual([
      'propose_intake with {"items":[{"name":"/^eggs?$/i","package_date":"<absent>"}]}; got {"items":[{"name":"eggs","package_date":"2026-04-15"}]}',
    ]);
  });

  it('counts only accepted calls when asked to', () => {
    const calls = [call('start_cooking', { substitutions: [{ missing: 'milk', use: 'cream' }] }, 'error')];
    const e = { tool: 'start_cooking', args: { substitutions: [{ missing: 'milk' }] } };
    expect(checkArgs(calls, [e]).verdict).toBe('pass');
    expect(checkArgs(calls, [{ ...e, accepted: true }]).verdict).toBe('fail');
  });

  it('matches objects by the expected keys and arrays element by element', () => {
    expect(contains({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(contains([{ a: 1, b: 2 }], [{ a: 1 }])).toBe(true);
    expect(contains([{ a: 1 }, { a: 2 }], [{ a: 1 }])).toBe(false);
    expect(contains({ a: [1] }, { a: 1 })).toBe(false);
    expect(contains(null, { a: 1 })).toBe(false);
    expect(contains({ name: 'eggs' }, { name: /^eggs?$/ })).toBe(true);
    expect(contains({ name: 3 }, { name: /3/ })).toBe(false);
    expect(contains({ quantity: 6 }, { package_date: ABSENT })).toBe(true);
    expect(contains({ package_date: null }, { package_date: ABSENT })).toBe(true);
    expect(contains({ package_date: '2026-04-15' }, { package_date: ABSENT })).toBe(false);
  });
});

describe('stockDiff and checkDb', () => {
  const before = [
    { item: 'egg', unit: 'count', quantity: 12 },
    { item: 'milk', unit: 'ml', quantity: 1000 },
  ];

  it('nets the change per item, including items that appear or run out', () => {
    const after = [
      { item: 'egg', unit: 'count', quantity: 9 },
      { item: 'milk', unit: 'ml', quantity: 1000 },
      { item: 'oat milk', unit: 'ml', quantity: 500 },
    ];
    expect([...stockDiff(before, after)]).toEqual([
      ['egg', { delta: -3, unit: 'count' }],
      ['oat milk', { delta: 500, unit: 'ml' }],
    ]);
    expect([...stockDiff(before, [])].map(([item, d]) => [item, d.delta])).toEqual([
      ['egg', -12],
      ['milk', -1000],
    ]);
  });

  it('wants exactly the expected changes and commits', () => {
    const diff = new Map([['egg', { delta: -3, unit: 'count' }]]);
    expect(checkDb(diff, ['consume'], { stock: { egg: -3 }, operations: ['consume'] }).verdict).toBe('pass');
    expect(checkDb(diff, ['consume'], { stock: {}, operations: ['consume'] }).notes).toEqual(['egg: changed by -3, expected 0']);
    expect(checkDb(diff, ['consume', 'consume'], { stock: { egg: -3 }, operations: ['consume'] }).notes).toEqual([
      'operations [consume, consume], expected [consume]',
    ]);
    expect(checkDb(new Map(), [], { stock: { milk: -500 }, operations: [] }).notes).toEqual(['milk: changed by 0, expected -500']);
  });
});

describe('checkClaims', () => {
  const net = new Map([
    ['egg', { delta: 3, unit: 'count' }],
    ['milk', { delta: -500, unit: 'ml' }],
  ]);
  const op = (kind: string, changes: Array<[string, number, string]>, setTo: Array<[string, number]> = []) => ({
    kind,
    changes: new Map(changes.map(([item, delta, unit]) => [item, { delta, unit }])),
    setTo: new Map(setTo),
  });
  const ops = [op('intake', [['egg', 3, 'count']]), op('adjust', [['milk', -500, 'ml']])];
  const claim = (item: string, change: 'added' | 'removed' | 'set_to', quantity: number | null, unit: string | null = null) => ({
    message: 1,
    item,
    change,
    quantity,
    unit,
  });

  it('passes claims that match the committed change, with or without an amount', () => {
    const claims = [claim('eggs', 'added', 3), claim('milk', 'removed', 0.5, 'liters'), claim('milk', 'removed', null)];
    expect(checkClaims(claims, ops, net)).toEqual({ verdict: 'pass', notes: [] });
    expect(checkClaims([], ops, net).verdict).toBe('pass');
  });

  it('fails a wrong amount, a wrong direction and a change that was never committed', () => {
    const r = checkClaims([claim('egg', 'added', 2), claim('milk', 'added', null), claim('butter', 'removed', 20, 'g')], ops, net);
    expect(r.verdict).toBe('fail');
    expect(r.notes).toEqual([
      'reply 1: added 2 egg, but egg +3 count was committed',
      'reply 1: added milk, but milk -500 ml was committed',
      'reply 1: removed 20 g butter, but no butter change was committed',
    ]);
  });

  it('matches one operation of several, even when the case nets to zero', () => {
    // A meal corrected from 3 to 4 eggs (−1), then the correction undone (+1).
    const fixed = [op('revise_consumption', [['egg', -1, 'count']], [['egg', 4]]), op('undo', [['egg', 1, 'count']])];
    const claims = [claim('egg', 'removed', 1), claim('egg', 'set_to', 4), claim('eggs', 'added', 1)];
    expect(checkClaims(claims, fixed, new Map()).verdict).toBe('pass');
    expect(checkClaims([claim('egg', 'set_to', 3)], fixed, new Map()).notes).toEqual(['reply 1: set to 3 egg, but egg set to 4 count was committed']);
    expect(checkClaims([claim('egg', 'set_to', 3)], [op('undo', [['egg', 1, 'count']])], new Map()).notes).toEqual([
      'reply 1: set to 3 egg, but no amount set for egg was committed',
    ]);
  });

  it('leaves an amount in a unit it cannot convert unverified, never passed', () => {
    expect(checkClaims([claim('milk', 'removed', 2, 'cups')], ops, net)).toEqual({
      verdict: 'unverified',
      notes: ['reply 1: removed 2 cups milk: cannot convert to ml'],
    });
    expect(checkClaims([claim('milk', 'removed', 2, 'cups'), claim('egg', 'added', 1)], ops, net).verdict).toBe('fail');
  });

  it('reads the amounts an operation set from its summary', () => {
    expect([...setToOf('adjust', { item: 'egg', set_quantity: 10 })]).toEqual([['egg', 10]]);
    expect([...setToOf('adjust', { item: 'egg', set_quantity: null })]).toEqual([]);
    expect([...setToOf('revise_consumption', { lines: [{ item: 'egg', from: 3, to: 4 }] })]).toEqual([['egg', 4]]);
    expect([...setToOf('intake', { lines: [{ item: 'egg', quantity: 6 }] })]).toEqual([]);
  });
});

describe('units and names', () => {
  it('converts said amounts to the base unit', () => {
    expect(toBase(3, null, 'egg', 'count')).toBe(3);
    expect(toBase(3, 'eggs', 'egg', 'count')).toBe(3);
    expect(toBase(1.5, 'kg', 'flour', 'g')).toBe(1500);
    expect(toBase(1, 'L', 'milk', 'ml')).toBe(1000);
    expect(toBase(2, 'pieces', 'tomato', 'count')).toBe(2);
    expect(toBase(2, 'cloves', 'garlic clove', 'count')).toBe(2);
    expect(toBase(200, 'g', 'milk', 'ml')).toBeNull();
    expect(toBase(1, 'carton', 'egg', 'count')).toBeNull();
  });

  it('matches item names regardless of case and plural', () => {
    expect(sameItem('Eggs', 'egg')).toBe(true);
    expect(sameItem('tomatoes', 'tomato')).toBe(true);
    expect(sameItem('garlic cloves', 'garlic clove')).toBe(true);
    expect(sameItem('olive oil', 'oil')).toBe(false);
  });
});

describe('checkDateWords', () => {
  it('fails a reply that calls an estimated date an expiry, and only that', () => {
    const replies = [
      'Your spinach expires tomorrow. The milk is best by Oct 24.',
      'The milk expires on Oct 24, and the garlic cloves are fine.',
      'The garlic cloves expire soon.',
    ];
    expect(checkDateWords(replies, ['spinach', 'garlic clove'])).toEqual({
      verdict: 'fail',
      notes: [
        'reply 0: calls the estimated date of spinach an expiry: "Your spinach expires tomorrow."',
        'reply 2: calls the estimated date of garlic clove an expiry: "The garlic cloves expire soon."',
      ],
    });
    expect(checkDateWords(['Spinach, stored for 4 days, should be used first.'], ['spinach']).verdict).toBe('pass');
  });

  it('combines with another check, keeping the worse verdict', () => {
    const fail = { verdict: 'fail' as const, notes: ['a'] };
    const unverified = { verdict: 'unverified' as const, notes: ['b'] };
    expect(bothChecks(unverified, fail)).toEqual({ verdict: 'fail', notes: ['b', 'a'] });
    expect(bothChecks({ verdict: 'pass', notes: [] }, unverified)).toEqual({ verdict: 'unverified', notes: ['b'] });
  });
});
