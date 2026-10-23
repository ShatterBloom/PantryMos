import { describe, expect, it } from 'vitest';
import { ground, NO_REPLY, withoutImpactTalk, withoutQuestions, withoutRecital, withoutStepRecital } from '../../src/turn/grounding.ts';

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

  it('says markdown as speech', () => {
    // As Nova 2 Lite said of a shortfall (eval G4).
    expect(
      ground(
        'The meal would be **short** of milk. I can offer three ways to fix this:\n- Make fewer servings\n- Use a substitute ingredient\n- Add milk to your shopping list\n\nWhich would you like?',
        { committed: false },
      ).text,
    ).toBe(
      'The meal would be short of milk. I can offer three ways to fix this: make fewer servings, use a substitute ingredient, add milk to your shopping list. Which would you like?',
    );
    expect(ground('## Options\n1. BLT sandwich.\n2) Omelette', { committed: false }).text).toBe('Options BLT sandwich, omelette.');
  });

  it("never says the history's stand-in for an empty reply", () => {
    // Nova copied it from earlier turns whose replies had nothing left (demo walkthrough).
    expect(ground(NO_REPLY, { committed: false }).text).toBe('');
    expect(ground(`${NO_REPLY} Got it.`, { committed: false }).text).toBe('Got it.');
  });

  it('leaves out a claim that a timer runs unless the turn started one', () => {
    // As Nova said of a step whose timer the app was only offering (eval G6).
    for (const s of [
      "There's a 60-second timer set for this step.",
      'The timer is now running.',
      "I've started a timer for the eggs.",
      // Of a timer the app was only offering (eval P1).
      'The app set a 60-second timer for the eggs.',
      // Words between the timer and the claim (eval P12).
      'A timer for 480 seconds (8 minutes) has been set for the pasta.',
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
    // A question put as a request (eval G4).
    expect(withoutRecital("Sorry about the milk. Please tell me what you'd like to do.", milk)).toBe('Sorry about the milk.');
    // Talk of confirming, and a promise nobody keeps: a confirm gets the app's templated reply (eval G4).
    expect(
      withoutRecital(
        "Throwing out half the milk means we now have less than the recipe needs. You'll see a card asking you to confirm. After you confirm, I'll tell you what to do next.",
        milk,
      ),
    ).toBe('Throwing out half the milk means we now have less than the recipe needs.');
  });

  it('keeps what the card does not say', () => {
    for (const s of ['That leaves 75 ml, less than the 125 ml the recipe needs.', 'Sorry about the milk.']) {
      expect(withoutRecital(s, milk)).toBe(s);
    }
  });
});

describe('withoutImpactTalk', () => {
  it("leaves out the model's account of what a change leaves the meal, and keeps the rest", () => {
    const namesMilk = (s: string) => /\bmilk\b/i.test(s);
    // As Nova 2 Lite said, wrongly, with a discard card whose read-back says it right (eval P10).
    expect(
      withoutImpactTalk(
        'Oh no! The recipe still needs 125 milliliters of milk, and you have 875 milliliters left, so we can carry on with less. Ready for the next step when you are!',
        namesMilk,
      ),
    ).toBe('Oh no! Ready for the next step when you are!');
    expect(withoutImpactTalk('That spill is a pity. The meal would be short.', namesMilk)).toBe('That spill is a pity.');
  });
});

describe('withoutQuestions', () => {
  it('leaves out questions and keeps the rest', () => {
    expect(withoutQuestions('I started the stir-fry for 2 servings. What would you like to do next?')).toBe('I started the stir-fry for 2 servings.');
    expect(withoutQuestions('Ready? Go.')).toBe('Go.');
    expect(withoutQuestions('')).toBe('');
  });
});

describe('withoutStepRecital', () => {
  it("leaves out the model's retelling of the step the app reads, and its questions", () => {
    // As Nova 2 Lite said before the app's "Step N: …" (eval P9, G5, P1).
    for (const [said, step] of [
      ["Here's your current step: Pour in the milk and simmer for 3 minutes.", 'Pour in the milk and simmer for 3 minutes.'],
      ['The pasta is boiling and will be done in about 8 minutes.', 'Add the pasta and boil it until al dente, about 8 minutes.'],
      ['The spinach is wilting.', 'Add the spinach and stir until it wilts.'],
      ['The butter is melting and the garlic and scallions are softening.', 'Meanwhile, melt the butter in a pan and soften the garlic and scallions.'],
      ["What's your next move?", 'Return the eggs, add the scallions and soy sauce, and toss.'],
    ]) {
      expect(withoutStepRecital(said!, step!)).toEqual({ text: '', cue: null });
    }
  });

  it('keeps what the step does not say', () => {
    const step = 'Beat the eggs with a pinch of salt and cut the tomatoes into wedges.';
    for (const s of [
      'I started the tomato egg stir-fry for 2 servings.',
      'The tomato egg stir-fry is cooking!',
      "I'm making it with the tomatoes that expire on Oct 22.",
      'Sorry, I can only move one step at a time.',
    ]) {
      expect(withoutStepRecital(s, step)).toEqual({ text: s, cue: null });
    }
  });

  it('keeps one cue to say "next" for after the step, and drops other talk of the next step', () => {
    const step = 'Beat the eggs with a pinch of salt and cut the tomatoes into wedges.';
    // As Nova 2 Lite said before the app's "Step 1: …" (eval P1, P9).
    expect(withoutStepRecital('I started the stir-fry for 2 servings. Say "next" when ready.', step)).toEqual({
      text: 'I started the stir-fry for 2 servings.',
      cue: 'Say "next" when ready.',
    });
    expect(
      withoutStepRecital(
        `Let me know when you're ready for the next step by saying "next". Just say "next" once more and I'll confirm when the meal is finished.`,
        step,
      ),
    ).toEqual({ text: '', cue: `Let me know when you're ready for the next step by saying "next".` });
    expect(withoutStepRecital("Let's make it. I'll let you know when it's time for the next step.", step)).toEqual({ text: "Let's make it.", cue: null });
  });
});
