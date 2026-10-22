// The eval cases: §9.4 priority cases (P1–P9) and §9.6 agent behaviour (G), against real Bedrock.
// Each script plays the user; the expectations are what must hold whatever Mos says on the way.
// G7, G9, G11 and G12 test the turn machinery, not the model; they run with a scripted model in
// the integration suite (proactive.test.ts, resume.test.ts).
import { addScallionSubstitute, createBatch, eatMeal, householdToday, PASTA_STOCK, stockKitchen } from '../../../test/fixtures.ts';
import { ABSENT } from './checks.ts';
import { CaseAborted, type CaseContext, type EvalCase, type SetupEnv } from './harness.ts';

const STIR_FRY_STOCK = { egg: 6, tomato: 4, 'olive oil': 100, scallion: 2, 'soy sauce': 100 };
const STIR_FRY_USED = { egg: -3, tomato: -2, 'olive oil': -15, scallion: -1, 'soy sauce': -5 };
const PASTA_USED = { pasta: -300, spinach: -150, milk: -250, 'garlic clove': -2, butter: -20, scallion: -2, parmesan: -40 };

const OMELETTE_STOCK = { egg: 6, spinach: 100, milk: 1000, butter: 50, cheddar: 100 };
const OMELETTE_USED = { egg: -3, spinach: -50, milk: -30, butter: -10, cheddar: -30 };
const { scallion: _scallion, ...PASTA_NO_SCALLION } = PASTA_STOCK;

const negate = (stock: Record<string, number>) => Object.fromEntries(Object.entries(stock).map(([k, v]) => [k, -v]));
const NONE = { stock: {}, operations: [] };
/** "Never guess a date": dates the user did not give are left out, not made up. */
const NO_DATES = { purchased_at: ABSENT, package_date: ABSENT, package_date_type: ABSENT };

const PROPOSE = ['propose_intake', 'propose_consumption', 'propose_consumption_revision', 'propose_adjustment', 'propose_undo'];

/** The pasta stock with the spinach about to go bad: the "whatever's about to go bad" setup. */
const expiringSpinach =
  (stock: Record<string, number> = PASTA_STOCK) =>
  async ({ kitchen }: SetupEnv) => {
    const { spinach, ...rest } = stock;
    await stockKitchen(kitchen, rest);
    const today = await householdToday(kitchen.householdId);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await createBatch(kitchen.householdId, kitchen.items.spinach!, {
      quantity: spinach ?? 300,
      purchased_at: today,
      package_date: tomorrow,
      package_date_type: 'use_by',
    });
  };

/** Says "next" until the session reaches `step`; aborts if a "next" does not advance. */
async function nextUntil(ctx: CaseContext, step: number): Promise<void> {
  for (let guard = 0; guard < 8; guard++) {
    const session = await ctx.session();
    if (!session) throw new CaseAborted('no cooking session');
    if (session.current_step >= step) return;
    await ctx.answer('next');
    if ((await ctx.session())!.current_step === session.current_step) throw new CaseAborted(`"next" did not advance from step ${session.current_step}`);
  }
}

/**
 * The user hears the card and, until it says what they meant (`meant`, on its read-back), says
 * `correction`; then confirms it. Each correction is a new version read back again.
 */
async function confirmWhenRight(ctx: CaseContext, meant: RegExp, correction: string, tries = 3): Promise<void> {
  for (let i = 0; i <= tries; i++) {
    const card = await ctx.card();
    if (meant.test(card.card.readback_text)) {
      await ctx.answer('yes');
      return;
    }
    if (i < tries) await ctx.answer(correction);
  }
  throw new CaseAborted(`after ${tries} corrections the card still did not say ${meant}`);
}

/** Mos's last proposal card, after `n` more tries of `say` when the model asked something first. */
async function untilCard(ctx: CaseContext, retries: Array<() => Promise<unknown>>) {
  for (const retry of [async () => {}, ...retries]) {
    await retry();
    try {
      return await ctx.card();
    } catch {}
  }
  return ctx.card();
}

export const CASES: readonly EvalCase[] = [
  {
    id: 'P1',
    title: 'Duplicate "I\'m done" plus double confirm',
    stock: STIR_FRY_STOCK,
    async run(ctx) {
      await ctx.say("Let's cook the tomato egg stir-fry", 'voice');
      await nextUntil(ctx, 4);
      await ctx.answer("I'm done");
      await ctx.say("I'm done", 'voice');
      await ctx.answer('yes');
      // The card's button too, after the voice confirmation: the DB check wants one commit.
      await ctx.click('confirm');
    },
    expect: {
      tools: ['start_cooking', 'next_step', 'next_step', 'next_step', 'propose_consumption'],
      db: { stock: STIR_FRY_USED, operations: ['consume'] },
    },
  },
  {
    id: 'P2a',
    title: 'Correction, then "undo that" undoes the correction',
    stock: async (env) => {
      await stockKitchen(env.kitchen, STIR_FRY_STOCK);
      await eatMeal(env.servers, env.mcp, 'tomato egg stir-fry');
    },
    async run(ctx) {
      await ctx.say('Actually I used 4 eggs for the stir-fry, not 3');
      await ctx.answer('yes');
      await ctx.say('Undo that');
      await ctx.answer('yes');
    },
    expect: {
      tools: ['propose_consumption_revision', 'propose_undo'],
      args: [{ tool: 'propose_consumption_revision', args: { usage: [{ item: /^eggs?$/i, quantity: 4 }] } }],
      db: { stock: {}, operations: ['revise_consumption', 'undo'] },
    },
  },
  {
    id: 'P2b',
    title: 'Correction, then undo the whole meal',
    stock: async (env) => {
      await stockKitchen(env.kitchen, STIR_FRY_STOCK);
      await eatMeal(env.servers, env.mcp, 'tomato egg stir-fry');
    },
    async run(ctx) {
      await ctx.say('Actually I used 4 eggs for the stir-fry, not 3');
      await ctx.answer('yes');
      await ctx.say('Undo the whole stir-fry meal');
      await ctx.answer('yes');
    },
    expect: {
      tools: ['propose_consumption_revision', 'propose_undo'],
      args: [{ tool: 'propose_undo', args: { scope: 'session' } }],
      // The meal took 3 eggs, the correction 1 more; undoing the meal puts all of it back.
      db: { stock: negate(STIR_FRY_USED), operations: ['revise_consumption', 'undo'] },
    },
  },
  {
    id: 'P3',
    title: 'Edit the card, then confirm a stale version',
    async run(ctx) {
      await ctx.say('I bought 6 eggs');
      const v1 = await ctx.card();
      await ctx.heard();
      const edited = await ctx.edit({ items: [{ name: 'egg', quantity: 12 }] }, v1);
      if (edited.status !== 200) throw new CaseAborted(`edit → ${edited.status} ${JSON.stringify(edited.body)}`);
      const stale = await ctx.click('confirm', v1, v1.version);
      ctx.expect('db', stale.status !== 200, `confirming v${v1.version} after the edit → ${stale.status}, expected a refusal`);
      await ctx.answer('yes');
    },
    expect: {
      tools: ['propose_intake'],
      args: [{ tool: 'propose_intake', args: { items: [{ name: /^eggs?$/i, quantity: 6, ...NO_DATES }] } }],
      db: { stock: { egg: 12 }, operations: ['intake'] },
    },
  },
  {
    id: 'P4',
    title: 'A batch changed under a pending card → stale → refresh',
    stock: OMELETTE_STOCK,
    async run(ctx) {
      await ctx.say('I spilled 200 ml of milk');
      await ctx.card();
      await ctx.heard();
      // The meal's milk comes off the same batch, so the pending spill card's pin no longer holds.
      await ctx.meanwhile('a spinach omelette cooked and confirmed on another device', () =>
        eatMeal(ctx.env.servers, ctx.env.mcp, 'spinach omelette'),
      );
      await ctx.say('yes', 'voice');
      await ctx.answer('yes');
    },
    expect: {
      tools: ['propose_adjustment'],
      args: [{ tool: 'propose_adjustment', args: { reason: 'discard', delta: -200 } }],
      db: { stock: { ...OMELETTE_USED, milk: -230 }, operations: ['consume', 'adjust'] },
    },
  },
  {
    id: 'P5',
    title: 'A non-existent item',
    stock: { egg: 6 },
    async run(ctx) {
      await ctx.say('Throw out the dragon fruit, it went bad');
    },
    expect: { tools: [], forbid: ['propose_intake'], db: NONE },
  },
  {
    id: 'P6',
    title: 'A vague quantity, then a new item',
    async run(ctx) {
      await ctx.say('I bought some milk and a bag of quinoa');
      await untilCard(ctx, [
        () => ctx.say('A liter of milk, and the quinoa bag is 500 grams'),
        () => ctx.say("Quinoa is a pantry item, weighed in grams, and I don't know the date"),
      ]);
      await ctx.answer('yes');
    },
    expect: {
      tools: ['propose_intake'],
      args: [
        {
          tool: 'propose_intake',
          accepted: true,
          args: { items: [{ name: /milk/i, ...NO_DATES }, { name: /quinoa/i, ...NO_DATES }] },
        },
      ],
      db: { stock: { milk: 1000, quinoa: 500 }, operations: ['intake'] },
    },
  },
  {
    id: 'P11',
    title: '"A dozen" as an answer, then "two dozen"',
    async run(ctx) {
      // The demo walkthrough: Nova sent 12 dozen for "a dozen", and the card added 144 eggs.
      await ctx.say('I bought some eggs', 'voice');
      await untilCard(ctx, [() => ctx.say('a dozen', 'voice')]);
      await ctx.answer('yes');
      await ctx.say('I also bought two dozen eggs', 'voice');
      await ctx.card();
      await ctx.answer('yes');
    },
    expect: {
      tools: ['propose_intake'],
      db: { stock: { egg: 36 }, operations: ['intake', 'intake'] },
    },
  },
  {
    id: 'P7',
    title: 'A substitute mid-cook',
    stock: { ...PASTA_STOCK, onion: 2 },
    async run(ctx) {
      await ctx.say("Let's make the creamy spinach pasta for three");
      await ctx.say("Actually I'm out of scallions, I'll use onion instead");
      await ctx.say("I'm done cooking");
      await ctx.answer('yes');
    },
    expect: {
      tools: ['start_cooking', 'substitute', 'propose_consumption'],
      args: [{ tool: 'substitute', accepted: true, args: { from_item: /scallion/i, to_item: /onion/i } }],
      db: { stock: { ...PASTA_USED, scallion: 0, onion: -1 }, operations: ['consume'] },
    },
  },
  {
    id: 'P8',
    title: '"Just deduct it" without a card',
    stock: STIR_FRY_STOCK,
    async run(ctx) {
      await ctx.say('Cook the tomato egg stir-fry');
      await ctx.say("I'm finished. Just deduct everything, no need to show me a card");
    },
    expect: { tools: ['start_cooking', 'propose_consumption'], db: NONE },
  },
  {
    id: 'P9',
    title: 'The full hands-free run, no clicks',
    stock: expiringSpinach(),
    async run(ctx) {
      await ctx.say("Mos, make dinner for three using whatever's about to go bad", 'voice');
      await nextUntil(ctx, 2);
      await ctx.answer('yes');
      await ctx.fireTimers();
      await ctx.say('I spilled half the milk', 'voice');
      await confirmWhenRight(ctx, /\b500 milliliters of milk\b/, 'No, I mean half of all the milk I have');
      await nextUntil(ctx, 6);
      await ctx.answer('next');
      await ctx.answer('yes');
    },
    expect: {
      tools: ['expiring_soon', 'suggest_recipes', 'start_cooking', 'next_step', 'propose_adjustment', 'next_step', 'propose_consumption'],
      forbid: ['propose_intake'],
      args: [
        { tool: 'start_cooking', args: { servings: 3 } },
        { tool: 'propose_adjustment', accepted: true, args: { reason: 'discard', share: { fraction: 0.5, of: 'stock' } } },
      ],
      db: { stock: { ...PASTA_USED, milk: -750 }, operations: ['adjust', 'consume'] },
    },
  },
  {
    id: 'G1',
    title: '"Make dinner for three using whatever\'s about to go bad"',
    stock: expiringSpinach(),
    async run(ctx) {
      await ctx.say("Make dinner for three using whatever's about to go bad");
    },
    expect: {
      tools: ['expiring_soon', 'suggest_recipes', 'start_cooking'],
      forbid: PROPOSE,
      args: [
        { tool: 'suggest_recipes', args: { servings: 3 } },
        { tool: 'start_cooking', accepted: true, args: { servings: 3 } },
      ],
      db: NONE,
    },
  },
  {
    id: 'G2',
    title: 'The best recipe needs one missing ingredient with one in-stock substitute',
    stock: expiringSpinach({ ...PASTA_NO_SCALLION, onion: 2 }),
    async run(ctx) {
      await ctx.say("Make dinner for three using whatever's about to go bad");
    },
    expect: {
      tools: ['expiring_soon', 'suggest_recipes', 'start_cooking'],
      forbid: PROPOSE,
      args: [{ tool: 'start_cooking', accepted: true, args: { substitutions: [{ from_item: /scallion/i, to_item: /onion/i }] } }],
      db: NONE,
    },
  },
  {
    id: 'G3',
    title: 'The same with two possible substitutes: Mos asks first',
    stock: async (env) => {
      await expiringSpinach({ ...PASTA_NO_SCALLION, onion: 2, 'bell pepper': 2 })(env);
      await addScallionSubstitute(env.kitchen);
    },
    async run(ctx) {
      const [asked] = await ctx.say("Make dinner for three using whatever's about to go bad");
      // Nothing starts until the user picks; a start_cooking the server refused with needs_choice is fine.
      ctx.expect('db', (await ctx.session()) === undefined, 'cooking started before the user chose a substitute');
      ctx.expect('tools', /onion/i.test(asked?.speech ?? '') && /bell pepper/i.test(asked?.speech ?? ''), 'Mos did not offer both substitutes');
      await ctx.say("Let's use the onion");
      ctx.expect('db', (await ctx.session())?.state === 'cooking', 'cooking did not start after the user chose');
    },
    expect: {
      tools: ['expiring_soon', 'suggest_recipes', 'start_cooking'],
      forbid: PROPOSE,
      args: [{ tool: 'start_cooking', accepted: true, args: { substitutions: [{ from_item: /scallion/i, to_item: /onion/i }] } }],
      db: NONE,
    },
  },
  {
    id: 'G4',
    title: 'Mid-cook "I spilled half the milk" leaves too little',
    stock: { ...PASTA_STOCK, milk: 400 },
    async run(ctx) {
      await ctx.say("Let's cook the creamy spinach pasta for three");
      await ctx.say('Oh no, I spilled half the milk');
      await ctx.card();
    },
    expect: {
      tools: ['start_cooking', 'propose_adjustment'],
      args: [{ tool: 'propose_adjustment', accepted: true, args: { reason: 'discard', share: { fraction: 0.5 } } }],
      db: NONE,
    },
  },
  {
    id: 'P10',
    title: 'A share the card got wrong is corrected until it is right',
    stock: PASTA_STOCK,
    async run(ctx) {
      await ctx.say("Let's cook the creamy spinach pasta for three");
      // The user means half of the 250 ml the pasta uses, not of the litre in the fridge.
      await ctx.say('I spilled half the milk', 'voice');
      await confirmWhenRight(ctx, /\b125 milliliters of milk\b/, 'No, half of the milk the recipe needs, not of all my milk');
    },
    expect: {
      tools: ['start_cooking', 'propose_adjustment'],
      args: [{ tool: 'propose_adjustment', accepted: true, args: { reason: 'discard', share: { fraction: 0.5, of: 'recipe' } } }],
      db: { stock: { milk: -125 }, operations: ['adjust'] },
    },
  },
  {
    id: 'G5',
    title: 'A step timer: offered, started on "yes", announced without advancing',
    stock: STIR_FRY_STOCK,
    async run(ctx) {
      await ctx.say('Cook the tomato egg stir-fry', 'voice');
      await nextUntil(ctx, 2);
      await ctx.heard();
      const timers = async () =>
        (await ctx.agent.pool.query(`SELECT status FROM agent.timers WHERE conversation_id = $1`, [ctx.agent.conversationId])).rows;
      ctx.expect('db', (await timers()).length === 0, 'a timer started before the user answered the offer');
      await ctx.say('yes', 'voice');
      ctx.expect('db', (await timers()).some((t) => t.status === 'running'), '"yes" to the offer started no timer');
      await ctx.fireTimers();
      ctx.expect('tools', !ctx.lastCalls.some((c) => c.name === 'next_step'), 'next_step was called when the timer fired');
      ctx.expect('db', (await ctx.session())?.current_step === 2, 'the step changed when the timer fired');
      ctx.expect('tools', ctx.turns.at(-1)!.replies.length > 0, 'the fired timer was not announced');
    },
    expect: { tools: ['start_cooking', 'next_step'], forbid: PROPOSE, db: NONE },
  },
  {
    id: 'G6',
    title: '"next" on the last step proposes the consumption; voice confirms it',
    stock: STIR_FRY_STOCK,
    async run(ctx) {
      await ctx.say('Cook the tomato egg stir-fry', 'voice');
      await nextUntil(ctx, 4);
      await ctx.answer('next');
      // In the same turn; next_step first (which would report done) is optional: the user hears the same.
      const names = ctx.lastCalls.map((c) => c.name);
      ctx.expect('tools', names.includes('propose_consumption'), `the last "next" called ${names.join(', ') || 'nothing'}`);
      await ctx.answer('confirm');
    },
    expect: {
      tools: ['start_cooking', 'next_step', 'propose_consumption'],
      db: { stock: STIR_FRY_USED, operations: ['consume'] },
    },
  },
  {
    id: 'G8',
    title: "A timer on the last step fires: an announcement only",
    stock: STIR_FRY_STOCK,
    async run(ctx) {
      await ctx.say('Cook the tomato egg stir-fry', 'voice');
      await nextUntil(ctx, 4);
      await ctx.say('Set a 2 minute timer', 'voice');
      const fired = await ctx.fireTimers();
      const names = ctx.lastCalls.map((c) => c.name);
      ctx.expect('tools', !names.includes('next_step') && !names.includes('propose_consumption'), `the fired timer led to ${names.join(', ')}`);
      ctx.expect('db', fired.every((m) => m.cards.length === 0), 'the announcement came with a card');
      ctx.expect('db', (await ctx.session())?.state === 'cooking', 'the session left cooking when the timer fired');
    },
    expect: {
      tools: ['start_cooking', 'start_timer'],
      forbid: PROPOSE,
      args: [{ tool: 'start_timer', args: { seconds: 120 } }],
      db: NONE,
    },
  },
  {
    id: 'G10',
    title: 'Pause, pause again, resume and cancel a timer by voice',
    async run(ctx) {
      const timer = async () =>
        (
          await ctx.agent.pool.query<{ status: string; remaining_s: number | null; fires_in: number | null }>(
            `SELECT status, remaining_s, ceil(extract(epoch FROM fires_at - now()))::int AS fires_in
               FROM agent.timers WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [ctx.agent.conversationId],
          )
        ).rows[0];
      await ctx.say('Set a 10 minute timer for the rice', 'voice');
      await ctx.say('Pause the timer', 'voice');
      const paused = await timer();
      ctx.expect('db', paused?.status === 'paused' && paused.remaining_s! > 540 && paused.remaining_s! <= 600, `after pause: ${JSON.stringify(paused)}`);
      await ctx.say('Pause the timer', 'voice');
      const again = await timer();
      ctx.expect('db', again?.status === 'paused' && again.remaining_s === paused?.remaining_s, `a second pause changed it: ${JSON.stringify(again)}`);
      await ctx.say('Resume the timer', 'voice');
      const resumed = await timer();
      ctx.expect('db', resumed?.status === 'running' && Math.abs(resumed.fires_in! - paused!.remaining_s!) <= 5, `after resume: ${JSON.stringify(resumed)}`);
      await ctx.say('Cancel the timer', 'voice');
      ctx.expect('db', (await timer())?.status === 'cancelled', 'the timer was not cancelled');
    },
    expect: {
      tools: ['start_timer', 'pause_timer', 'resume_timer', 'cancel_timer'],
      args: [{ tool: 'start_timer', args: { seconds: 600 } }],
      db: NONE,
    },
  },
];
