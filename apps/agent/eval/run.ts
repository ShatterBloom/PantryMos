// `pnpm eval [--only P1,G1] [--repeat 3]`: runs the eval cases against real Bedrock (§9.4, §9.6, §9.9)
// and writes docs/eval-log.md, plus every exchange to apps/agent/eval/out/ for debugging.
// MODEL_PROVIDER and its settings pick the model under test, as for the agent; EVAL_EXTRACTOR_MODEL_ID pins the
// reply-check extractor (default: the same model), so two models can be compared by one judge.
// It recreates the throwaway test database, so it must not run alongside the test suite.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { startServers } from '@pantrymos/mcp-server';
import { mcpTestConfig } from '../../../test/fixtures.ts';
import setupTestDatabase from '../../../test/global-setup.ts';
import { loadBedrockConfig, loadModelConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { createModel, modelName } from '../src/model/create.ts';
import { CASES } from './cases.ts';
import { BedrockClaimExtractor } from './extractor.ts';
import { type CaseResult, passed, runCase } from './harness.ts';
import { renderReport } from './report.ts';

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    repeat: { type: 'string', default: '1' },
  },
});
const only = values.only?.split(',').map((s) => s.trim().toUpperCase());
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');
const cases = CASES.filter((c) => !only || only.includes(c.id.toUpperCase()));
if (cases.length === 0) throw new Error(`No case matches --only ${values.only}`);

// The model under test follows MODEL_PROVIDER; the claim extractor always runs on Bedrock.
const modelConfig = loadModelConfig();
const bedrock = loadBedrockConfig();
const startedAt = new Date();
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();

const checkLedger = await setupTestDatabase();
const servers = await startServers(mcpTestConfig(), { log: false });
// A ChatGPT plan's sign-in lives in the dev database (sign in from the app first), not the test one.
const signInPool = modelConfig.provider === 'chatgpt' ? createPool(process.env.AGENT_DATABASE_URL ?? '') : null;
const { model } = createModel(modelConfig, signInPool!);
const extractorModelId = process.env.EVAL_EXTRACTOR_MODEL_ID || bedrock.modelId;
const extractor = new BedrockClaimExtractor({ region: bedrock.region, modelId: extractorModelId });
const results: CaseResult[] = [];
try {
  for (const c of cases) {
    for (let i = 0; i < repeat; i++) {
      process.stdout.write(`${c.id}${repeat > 1 ? ` #${i + 1}` : ''} ${c.title} … `);
      const r = await runCase(servers, model, extractor, c);
      results.push(r);
      const verdicts = Object.entries(r.checks).map(([k, v]) => `${k} ${v.verdict}`).join(', ');
      console.log(`${passed(r) ? 'PASS' : 'FAIL'} (${verdicts}${r.aborted ? `; aborted: ${r.aborted.split('\n')[0]}` : ''})`);
    }
  }
} finally {
  await servers.close();
  await signInPool?.end();
}
// R17 still holds after everything the cases did (I1: batch quantity = Σ events).
await checkLedger();

const info = { startedAt, modelId: modelName(modelConfig), extractorModelId, commit, repeat };
mkdirSync('docs', { recursive: true });
writeFileSync('docs/eval-log.md', renderReport(info, results));
const outDir = 'apps/agent/eval/out';
mkdirSync(outDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
writeFileSync(`${outDir}/${stamp}.json`, JSON.stringify({ info, results }, null, 2));
const ok = new Set(cases.filter((c) => results.filter((r) => r.id === c.id).every(passed)).map((c) => c.id));
console.log(`\n${ok.size} / ${cases.length} cases passed. Report: docs/eval-log.md; exchanges: ${outDir}/${stamp}.json`);
process.exitCode = ok.size === cases.length ? 0 : 1;
