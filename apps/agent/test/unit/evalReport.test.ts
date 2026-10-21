import { describe, expect, it } from 'vitest';
import type { CaseResult } from '../../eval/harness.ts';
import { renderReport } from '../../eval/report.ts';

const pass = { verdict: 'pass' as const, notes: [] };

function result(id: string, overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    id,
    title: `case ${id}`,
    checks: { tools: pass, args: pass, db: pass, reply: pass },
    aborted: null,
    turns: [{ input: 'I bought 6 eggs', replies: ['Here is a card.'], claimable: ['Here is a card.'], calls: [], ms: 1500 }],
    calls: [{ name: 'propose_intake', input: {}, status: 'success' }],
    claims: [],
    exchanges: [],
    latency: { modelCalls: 2, modelMs: 1200, totalMs: 1500 },
    tokens: { input: 9000, output: 120 },
    ...overrides,
  };
}

describe('renderReport', () => {
  const info = { startedAt: new Date('2026-10-21T12:00:00Z'), modelId: 'nova', extractorModelId: 'judge', commit: 'abc1234', repeat: 2 };

  it('counts a case as passed only when every run passed, and shows each run', () => {
    const failed = result('P1', {
      checks: { tools: pass, args: pass, db: { verdict: 'fail', notes: ['egg: changed by -6, expected -3'] }, reply: pass },
    });
    const report = renderReport(info, [result('P1'), failed, result('G1'), result('G1')]);
    expect(report).toContain("commit `abc1234` · model `nova` (reply check: `judge`) · 2 run(s) per case");
    expect(report).toContain('- Passed: **1 / 2** cases');
    expect(report).toContain('- Agent model tokens: 36000 in, 480 out');
    expect(report).toContain('| P1 case P1 | 1 | ✅ | ✅ | ✅ | ✅ | 2 | 9000 | 1.2 | 1.5 |');
    expect(report).toContain('|  | 2 | ✅ | ✅ | ❌ | ✅ | 2 | 9000 | 1.2 | 1.5 |');
    expect(report).toContain('## P1 case P1 (run 2)\n\n- ❌ db: egg: changed by -6, expected -3\n');
    expect(report).toContain('Tools: propose_intake\n\n> **User:** I bought 6 eggs\n> **Mos:** Here is a card.\n');
    expect(report).toContain('p50 1.5 s, p95 1.5 s over 4; Bedrock 80% of the total.');
  });

  it('marks an aborted case and an unverified check, and escapes table cells', () => {
    const r = result('P6', {
      title: 'a | b',
      aborted: 'no proposal card was shown\nstack',
      checks: { tools: pass, args: pass, db: pass, reply: { verdict: 'unverified', notes: ['reply 0: removed 2 cups milk: cannot convert to ml'] } },
    });
    const report = renderReport({ ...info, repeat: 1 }, [r]);
    expect(report).toContain('| P6 a \\| b (aborted) | 1 | ✅ | ✅ | ✅ | ❔ |');
    expect(report).toContain('**Aborted:** no proposal card was shown\n');
    expect(report).toContain('- ❔ reply: reply 0: removed 2 cups milk: cannot convert to ml');
    expect(report).toContain('- Passed: **0 / 1** cases');
  });
});
