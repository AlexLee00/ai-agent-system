// @ts-nocheck
'use strict';

/**
 * Read-only smoke for SKA self-healing Phase D.
 *
 * This validates the auto-dev document path with a temp directory and checks
 * that the roundtable trigger still has its kill switch and budget guards.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function readUtf8(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  assert.ok(haystack.includes(needle), `${label}: expected to include ${needle}`);
}

function assertNotIncludes(haystack: string, needle: string, label: string): void {
  assert.ok(!haystack.includes(needle), `${label}: expected not to include ${needle}`);
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ska-autodev-smoke-'));
  process.env.SKA_AUTO_DEV_DIR = tempDir;

  const { buildSkaIncidentDocument } = require('../../ska/lib/ska-auto-dev-builder.ts');
  const samplePhone = ['010', '1234', '5678'].join('-');

  const result = await buildSkaIncidentDocument({
    condition: {
      type: 'repeat_failure',
      agent: 'andy',
      error_type: 'selector_broken',
      count: 7,
      failure_case_id: 42,
      metadata: {
        sampleBearer: 'Bearer abc.def.ghi',
        samplePassword: 'password=very-secret',
        samplePhone,
      },
    },
    consensus: {
      roundtable_id: 'ska-rt-smoke',
      root_cause: `Selector drift exposed Bearer abc.def.ghi and phone ${samplePhone} in logs.`,
      proposed_fix: 'Add selector fallback and redact password=very-secret before persistence.',
      estimated_complexity: 'simple',
      risk_level: 'medium',
      success_criteria: 'No recurrence for selector_broken and no secret leakage.',
    },
    reflexion: {
      hindsight: 'Do not persist raw tokens such as auth_token=secret-token-value.',
      avoid_pattern: {
        reason: 'Raw customer identifiers must not enter generated docs.',
        avoid_action: `Never include ${samplePhone} in remediation artifacts.`,
      },
    },
  });

  assert.strictEqual(result.ok, true, 'auto-dev builder should succeed');
  assert.strictEqual(result.created, true, 'auto-dev builder should create a new document');

  const generated = fs.readdirSync(tempDir).filter((name: string) => name.startsWith('CODEX_SKA_EXCEPTION_'));
  assert.strictEqual(generated.length, 1, 'expected exactly one generated SKA exception document');

  const content = readUtf8(path.join(tempDir, generated[0]));
  assertIncludes(content, 'SKA Exception Case', 'generated doc');
  assertIncludes(content, 'SKA_NEVER_BLOCK_OPERATIONS=true', 'generated doc safety');
  assertIncludes(content, 'requires_live_execution: false', 'generated doc safety');
  assertIncludes(content, 'ska_never_block_operations: true', 'generated doc frontmatter');
  assertIncludes(content, 'bots/reservation/lib', 'generated doc write scope');
  assertIncludes(content, 'bots/ska/lib', 'generated doc write scope');
  assertIncludes(content, 'npm --prefix bots/hub run test:unit', 'generated doc test scope');
  assertIncludes(content, 'npm --prefix bots/hub run transition:completion-gate', 'generated doc test scope');
  assertNotIncludes(content, 'npm --prefix bots/reservation', 'generated doc test scope');
  assertNotIncludes(content, ' 2>/dev/null || true', 'generated doc test scope');
  assertNotIncludes(content, ' run -s ', 'generated doc test scope');

  const autoDevPipeline = require('../../claude/lib/auto-dev-pipeline.ts');
  const analysis = autoDevPipeline.analyzeAutoDevDocument(path.join(tempDir, generated[0]));
  const scoped = autoDevPipeline._testOnly_resolveScopedTestCommands(analysis, path.resolve(__dirname, '../../..'));
  assert.deepStrictEqual(scoped.rejected, [], 'generated doc test_scope should pass auto-dev scoped validation');
  assert.deepStrictEqual(scoped.commands, [
    "npm --prefix 'bots/hub' run test:unit",
    "npm --prefix 'bots/hub' run transition:completion-gate",
  ], 'generated doc test_scope should normalize to executable hub commands');
  assertNotIncludes(content, 'Bearer abc.def.ghi', 'generated doc redaction');
  assertNotIncludes(content, 'password=very-secret', 'generated doc redaction');
  assertNotIncludes(content, 'auth_token=secret-token-value', 'generated doc redaction');
  assertNotIncludes(content, samplePhone, 'generated doc redaction');
  assertIncludes(content, 'Bearer [REDACTED]', 'generated doc redaction marker');
  assertIncludes(content, 'password=[REDACTED]', 'generated doc redaction marker');
  assertIncludes(content, '010-****-****', 'generated doc redaction marker');

  const roundtableSourcePath = path.resolve(__dirname, '../../ska/lib/ska-roundtable-trigger.ts');
  const roundtableSource = readUtf8(roundtableSourcePath);
  assertIncludes(roundtableSource, "process.env.SKA_ROUNDTABLE_ENABLED !== 'true'", 'roundtable kill switch');
  assertIncludes(roundtableSource, 'SKA_ROUNDTABLE_DAILY_LIMIT', 'roundtable daily limit');
  assertIncludes(roundtableSource, 'SKA_ROUNDTABLE_LLM_DAILY_BUDGET_USD', 'roundtable budget guard');
  assertIncludes(roundtableSource, 'buildSkaIncidentDocument', 'roundtable auto-dev integration');
  assertIncludes(roundtableSource, "process.env.SKA_AUTO_DEV_DOC_ENABLED !== 'false'", 'roundtable doc toggle');
  assertIncludes(roundtableSource, 'ska.failure_cases', 'roundtable repeat failure source');
  assertIncludes(roundtableSource, 'ska.selector_history', 'roundtable selector churn source');

  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log(JSON.stringify({
    ok: true,
    generatedDocs: generated.length,
    tempDirCleaned: true,
    checked: [
      'auto_dev_document_created',
      'secret_and_phone_redaction',
      'never_block_operations_guard',
      'roundtable_kill_switch',
      'roundtable_budget_guards',
      'roundtable_sources',
    ],
  }, null, 2));
}

main().catch((err: Error) => {
  console.error('[ska-self-healing-autodev-smoke] failed:', err.message);
  process.exit(1);
});
