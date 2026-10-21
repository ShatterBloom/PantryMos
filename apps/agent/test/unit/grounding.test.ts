import { describe, expect, it } from 'vitest';
import { ground } from '../../src/turn/grounding.ts';

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
      steps: [],
    });
    expect(ground('I added 6 eggs bought today with no package date.', { committed: false }).text).toBe('');
    expect(ground('The eggs are now in your stock.', { committed: false }).text).toBe('');
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
    ]) {
      expect(ground(s, { committed: false })).toEqual({ text: s, claims: [], steps: [] });
    }
  });

  it('leaves out a recital of a recipe step, by number or ordinal', () => {
    // As Nova said when a timer fired, with no step tool called (eval G5).
    expect(ground('Time is up for the eggs. The third step is to stir-fry the tomatoes.', { committed: false })).toEqual({
      text: 'Time is up for the eggs.',
      claims: [],
      steps: ['The third step is to stir-fry the tomatoes.'],
    });
    expect(ground("I'm making the pasta. Step 1: Heat the butter in a skillet.", { committed: false }).text).toBe("I'm making the pasta.");
    expect(ground('On to step two.', { committed: true }).steps).toEqual(['On to step two.']);
    expect(ground("Say next when you're ready for the next step.", { committed: false }).steps).toEqual([]);
  });
});
