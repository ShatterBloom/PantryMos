// The household the dev scripts seed and issue tokens in: the agent's, so the app shows what they make.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentHouseholdId, DEMO_HOUSEHOLD_ID } from '../../../../scripts/lib/env.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('agentHouseholdId', () => {
  it("is the demo household unless AGENT_HOUSEHOLD_ID names the agent's", () => {
    vi.stubEnv('AGENT_HOUSEHOLD_ID', undefined);
    expect(agentHouseholdId()).toBe(DEMO_HOUSEHOLD_ID);
    vi.stubEnv('AGENT_HOUSEHOLD_ID', '11111111-1111-4111-8111-111111111111');
    expect(agentHouseholdId()).toBe('11111111-1111-4111-8111-111111111111');
  });
});
