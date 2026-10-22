// Turn plumbing without I/O: message shaping for Converse, local tool specs, speech templates.
import { describe, expect, it } from 'vitest';
import { localToolSpecs } from '../../src/tools/local.ts';
import { mentions, nextsSaid, toModelMessages } from '../../src/turn/runTurn.ts';
import { duration, eventBlock, fallbackSpeech, timeLeft, timerOffer } from '../../src/turn/speech.ts';

describe('toModelMessages', () => {
  it('merges consecutive messages of one role, results first, and drops empty text', () => {
    const toolResult = { toolResult: { toolUseId: 't1', status: 'success' as const, content: [{ json: {} }] } };
    expect(
      toModelMessages([
        { role: 'user', content: [{ text: 'hi' }] },
        { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'x', input: {} } }] },
        { role: 'user', content: [toolResult] },
        { role: 'user', content: [{ text: 'next turn' }] },
        { role: 'assistant', content: [{ text: '  ' }] },
      ]),
    ).toEqual([
      { role: 'user', content: [{ text: 'hi' }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'x', input: {} } }] },
      { role: 'user', content: [toolResult, { text: 'next turn' }] },
      { role: 'assistant', content: [{ text: '(no reply)' }] },
    ]);
  });
});

describe('local tool specs', () => {
  it('describes each timer tool with a JSON schema and no $schema key', () => {
    const specs = localToolSpecs();
    expect(specs.map((s) => s.name)).toEqual(['start_timer', 'pause_timer', 'resume_timer', 'cancel_timer', 'list_timers']);
    const start = specs[0]!;
    expect(start.inputSchema).not.toHaveProperty('$schema');
    expect(start.inputSchema).toMatchObject({ type: 'object', required: ['label', 'seconds'] });
  });
});

describe('speech templates', () => {
  it('says durations the way people do', () => {
    expect(duration(60)).toBe('1 minute');
    expect(duration(480)).toBe('8 minutes');
    expect(duration(90)).toBe('90 seconds');
    expect(timerOffer(480)).toBe('This step takes 8 minutes — start a timer?');
    // A running timer's time left, rounded to the minute.
    expect([599, 570, 75, 120, 100].map(timeLeft)).toEqual(['about 10 minutes', 'about 10 minutes', '75 seconds', '2 minutes', 'about 2 minutes']);
  });

  it('writes each event as an [app event] block, and a fallback for when the turn keeps failing', () => {
    const p = { proposal_id: 'p1', version: 2, kind: 'intake', reason: 'batch_changed', label: 'pasta', step_no: 3, utterance: 'yes' };
    const kinds = ['timer_fired', 'proposal_committed', 'proposal_stale', 'proposal_rejected', 'window_expired'] as const;
    expect(kinds.map((kind) => eventBlock({ kind, payload: p }))).toEqual([
      '[app event] timer "pasta" finished (recipe step 3).',
      '[app event] proposal p1 v2 (intake) committed.',
      '[app event] proposal p1 v2 (intake) was not committed: things changed since it was made (batch_changed).',
      '[app event] proposal p1 v2 (intake) was discarded by the user.',
      '[app event] the user said "yes" after the confirmation window closed; the app read the card again.',
    ]);
    expect(kinds.map((kind) => fallbackSpeech({ kind, payload: p }))).toEqual([
      "Timer 'pasta' is done.",
      'Done — added to your stock.',
      'That card changed before it was saved. Ask me to refresh it.',
      'OK, I discarded that card.',
      'Say confirm when you are ready.',
    ]);
  });

  it('puts what a commit saved into its [app event] block', () => {
    const summary = { lines: [{ item: 'egg', quantity: 3, unit: 'pcs' }], new_items: [], new_conversions: [] };
    expect(eventBlock({ kind: 'proposal_committed', payload: { proposal_id: 'p1', version: 2, kind: 'intake', summary } })).toBe(
      '[app event] proposal p1 v2 (intake) committed. Saved: {"lines":[{"item":"egg","quantity":3,"unit":"pcs"}],"new_items":[],"new_conversions":[]}',
    );
  });
});

describe('what the user said', () => {
  it('counts the steps asked for, one per "next", at least one', () => {
    expect(nextsSaid('next')).toBe(1);
    expect(nextsSaid('Next, next!')).toBe(2);
    expect(nextsSaid("what's after this?")).toBe(1);
    expect(nextsSaid('nextstep')).toBe(1);
  });

  it('finds an item named as a word, singular or plural', () => {
    expect(mentions("Let's use the onion", 'onion')).toBe(true);
    expect(mentions('the onions, please', 'onion')).toBe(true);
    expect(mentions('use onion', 'onions')).toBe(true);
    expect(mentions('Bell pepper it is', 'bell pepper')).toBe(true);
    expect(mentions('make dinner with what is going bad', 'onion')).toBe(false);
    expect(mentions('scallion', 'onion')).toBe(false);
    expect(mentions('add the half-and-half', 'half-and-half')).toBe(true);
    expect(mentions('axb', 'a.b')).toBe(false); // a name is matched literally
  });
});
