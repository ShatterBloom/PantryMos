import { describe, expect, it } from 'vitest';
import { ground, withoutRecital } from '../../src/turn/grounding.ts';

describe('ground', () => {
  it('leaves out a claim that the stock changed when no commit backs it', () => {
    // As Nova 2 Lite said after a card it never got confirmed (eval P8, P3).
    const said = ground(
      "I’ve recorded that you used 3 eggs and 2 tomatoes. All ingredients have been deducted. Let me know if you need anything else!",
      { committed: false },
    );
    expect(said).toEqual({
      text: 'Let me know if you need anything else!',
      claims: ["I’ve recorded that you used 3 eggs and 2 tomatoes.", 'All ingredients have been deducted.'],
      timers: [],
      steps: [],
    });
    expect(ground('I added 6 eggs bought today with no package date.', { committed: false }).text).toBe('');
    expect(ground('The eggs are now in your stock.', { committed: false }).text).toBe('');
    // The app's commit wording, copied before the user confirmed (eval P7).
    expect(ground('Saved: 20 grams of butter and 1 onion.', { committed: false }).text).toBe('');
    expect(ground('Recorded. Anything else?', { committed: false }).text).toBe('Anything else?');
  });

  it('keeps such a claim after a commit, and keeps what only proposes, asks or hedges', () => {
    expect(ground("I've added 6 eggs to your stock.", { committed: true }).text).toBe("I've added 6 eggs to your stock.");
    for (const s of [
      "I'll record 4 eggs instead of 3.",
      'Shall I deduct what you used?',
      'Nothing has been saved yet.',
      "It hasn't been recorded until you confirm.",
      "Once you confirm, it'll be added to your stock.",
      "I've made a card for that.",
      "I've added a card for the eggs.",
      'I started the tomato egg stir-fry for 2 servings.',
      // The shopping list changes with no card.
      "I've added milk to your shopping list.",
      'Added milk.',
    ]) {
      expect(ground(s, { committed: false })).toEqual({ text: s, claims: [], timers: [], steps: [] });
    }
  });

  it('leaves out a recital of a recipe step, by number or ordinal', () => {
    // As Nova said when a timer fired, with no step tool called (eval G5).
    expect(ground('Time is up for the eggs. The third step is to stir-fry the tomatoes.', { committed: false })).toEqual({
      text: 'Time is up for the eggs.',
      claims: [],
      timers: [],
      steps: ['The third step is to stir-fry the tomatoes.'],
    });
    expect(ground("I'm making the pasta. Step 1: Heat the butter in a skillet.", { committed: false }).text).toBe("I'm making the pasta.");
    expect(ground('On to step two.', { committed: true }).steps).toEqual(['On to step two.']);
    expect(ground("Say next when you're ready for the next step.", { committed: false }).steps).toEqual([]);
    // Nova's paraphrase of the step it was given (eval G6).
    expect(ground('The next step is to scramble the eggs.', { committed: false }).steps).toEqual(['The next step is to scramble the eggs.']);
    // Said ahead of the app's own "Step 2: …" (eval P1).
    expect(ground('Next step: Scramble the eggs in half the oil. Ready?', { committed: false }).text).toBe('Ready?');
  });

  it('leaves out a claim that a timer runs unless the turn started one', () => {
    // As Nova said of a step whose timer the app was only offering (eval G6).
    for (const s of [
      "There's a 60-second timer set for this step.",
      'The timer is now running.',
      "I've started a timer for the eggs.",
      // Of a timer the app was only offering (eval P1).
      'The app set a 60-second timer for the eggs.',
    ]) {
      expect(ground(s, { committed: false })).toEqual({ text: '', claims: [], timers: [s], steps: [] });
      expect(ground(s, { committed: false, timerStarted: true }).text).toBe(s);
    }
    for (const s of ['Shall I set a timer?', 'The timer has finished.', "I'll set a timer if you want."]) {
      expect(ground(s, { committed: false }).text).toBe(s);
    }
  });
});

describe('withoutRecital', () => {
  const milk = "I'll record that 125 milliliters of milk were thrown out: half of the 250 milliliters of milk the recipe uses. Say confirm, or tell me what to change.";
  const meal = "I'll record 3 eggs, 15 milliliters of olive oil and 2 tomatoes. Say confirm, or tell me what to change.";

  it('leaves out the read-back and paraphrases of it', () => {
    // As Nova 2 Lite said before the app's read-back (eval G4, P1).
    expect(
      withoutRecital(
        "I’ve prepared a proposal to record throwing out half the milk (125 ml) from the recipe’s 250 ml. Say **confirm** to apply this change, or tell me what to adjust.",
        milk,
      ),
    ).toBe('');
    expect(withoutRecital('The recipe now uses 125 ml of milk instead of 250 ml.', milk)).toBe('');
    expect(
      withoutRecital(
        'The app is ready to record what you used. It will deduct 3 eggs, 15 ml of olive oil and 2 tomatoes. Say "confirm" or tell me what to change.',
        meal,
      ),
    ).toBe('The app is ready to record what you used.');
    expect(withoutRecital(`Got it. ${meal}`, meal)).toBe('Got it.');
    // The read-back ends with the question the user answers.
    expect(withoutRecital('The meal would be short of milk: you can make fewer servings or use a substitute. Which would you like?', milk)).toBe(
      'The meal would be short of milk: you can make fewer servings or use a substitute.',
    );
  });

  it('keeps what the card does not say', () => {
    for (const s of [
      'That leaves 75 ml, less than the 125 ml the recipe needs.',
      'Sorry about the milk.',
      "Once you confirm, I'll look at what's left.",
    ]) {
      expect(withoutRecital(s, milk)).toBe(s);
    }
  });
});
