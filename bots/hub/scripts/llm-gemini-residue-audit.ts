#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.LLM_TEAM_SELECTOR_VERSION = 'v3.0_oauth_4';
process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';
process.env.HUB_BUDGET_GUARDIAN_ENABLED = 'false';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const distRuntimeRoot = path.join(repoRoot, 'dist', 'ts-runtime');
const selector = require('../../../packages/core/lib/llm-model-selector.ts');
const policyTable = require('../../../packages/core/lib/llm-policy-table.ts');
const {
  RETIRED_GEMINI_SELECTOR_KEYS,
  isGeminiProvider,
} = require('../../../packages/core/lib/llm-provider-retirement.ts');

const OPERATIONAL_SOURCE_PATHS = [
  'bots/edu-x/SPEC.md',
  'bots/edu-x/lib',
  'bots/edu-x/scripts',
  'bots/blog/api',
  'bots/blog/lib',
  'bots/blog/config.json',
  'bots/orchestrator/lib',
  'bots/orchestrator/src',
  'bots/orchestrator/config.json',
  'bots/claude/config.json',
  'bots/claude/lib/archer/config.ts',
  'packages/core/lib/chunked-llm.ts',
];

const SCANNED_OUTPUT_DIRS = [
  'bots/edu-x/output',
];

function isGeminiEntry(entry: any): boolean {
  return isGeminiProvider(entry?.provider) || isGeminiProvider(entry?.model);
}

const SCANNED_EXT_RE = /\.(ts|tsx|js|mjs|cjs|json|md|html|txt)$/i;

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (SCANNED_EXT_RE.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function collectPath(inputPath: string): string[] {
  if (!fs.existsSync(inputPath)) return [];
  const stats = fs.statSync(inputPath);
  if (stats.isDirectory()) return collectFiles(inputPath);
  return SCANNED_EXT_RE.test(inputPath) ? [inputPath] : [];
}

function relativePath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

const selectorFindings: Array<{ key: string; routes: string[] }> = [];
for (const key of selector.listLLMSelectorKeys()) {
  const description = selector.describeLLMSelector(key, {
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
    rolloutKey: `gemini-residue-audit:${key}`,
  });
  const chain = Array.isArray(description?.chain) ? description.chain : [];
  const geminiRoutes = chain
    .filter(isGeminiEntry)
    .map((entry: any) => `${entry.provider}/${entry.model}`);
  if (geminiRoutes.length > 0) selectorFindings.push({ key, routes: geminiRoutes });
}

const policyTableFindings = (policyTable.LLM_POLICY_RULES || [])
  .flatMap((rule: any) => (rule.chain || [])
    .filter(isGeminiEntry)
    .map((entry: any) => ({
      id: String(rule.id || ''),
      route: `${entry.provider}/${entry.model}`,
    })));
const policyTableGeminiConstants = (policyTable.LLM_POLICY_TABLE_CONFIGURED_MODEL_CONSTANTS || [])
  .filter((constant: any) => (
    /gemini/i.test(String(constant?.name || ''))
    || /gemini/i.test(String(constant?.token || ''))
    || (constant?.providerPrefixes || []).some((provider: string) => /gemini/i.test(provider))
  ))
  .map((constant: any) => String(constant.name || constant.token || ''));
const retiredSelectorRegistryEntries = RETIRED_GEMINI_SELECTOR_KEYS
  .filter((selectorKey) => selector.listLLMSelectorKeys().includes(selectorKey));
const retiredPolicyTableRules = (policyTable.LLM_POLICY_RULES || [])
  .filter((rule: any) => RETIRED_GEMINI_SELECTOR_KEYS.includes(String(rule?.match?.selectorKey || '')))
  .map((rule: any) => String(rule.id || rule?.match?.selectorKey || ''));

const activeTestRunner = fs.readFileSync(path.join(repoRoot, 'bots/hub/scripts/run-tests.ts'), 'utf8');
const precompileSource = fs.readFileSync(path.join(repoRoot, 'scripts/build-ts-phase1.mjs'), 'utf8');
const packageScripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'bots/hub/package.json'), 'utf8')).scripts || {};
const providerStatus = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/core/lib/llm-models.json'), 'utf8')).provider_status || {};
const retirementBoundarySources = {
  toolRegistry: fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/control/tool-registry.ts'), 'utf8'),
  secretsRoute: fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/routes/secrets.ts'), 'utf8'),
  investmentSecrets: fs.readFileSync(path.join(repoRoot, 'bots/investment/shared/secrets.ts'), 'utf8'),
  reservationDrill: fs.readFileSync(path.join(repoRoot, 'bots/reservation/scripts/ska-agent-llm-primary-fallback-call-drill.ts'), 'utf8'),
  speedTest: fs.readFileSync(path.join(repoRoot, 'scripts/speed-test.ts'), 'utf8'),
  dailyReview: fs.readFileSync(path.join(repoRoot, 'scripts/reviews/jay-llm-daily-review.ts'), 'utf8'),
};
const retiredActiveTests = [
  '__tests__/oauth-gemini-cli-signal.test.ts',
  'gemini-route-assignment-smoke.ts',
  'steward-gemini-model-drill-smoke.ts',
  'gemini-cli-oauth-import-smoke.ts',
  'gemini-cli-oauth-adapter-smoke.ts',
  'gemini-cli-live-error-smoke.ts',
  'gemini-codeassist-service-status-smoke.ts',
  'gemini-quota-project-policy-smoke.ts',
  'gemini-codeassist-oauth-direct-smoke.ts',
].filter((entry) => activeTestRunner.includes(entry));
const retiredPackageCommands = Object.keys(packageScripts).filter((name) => (
  name.startsWith('oauth:gemini') || name.startsWith('steward:gemini')
));
const activeModelOverrideResidue = [
  'llm-env-model-overrides-smoke.ts',
  'llm-runtime-selector-source-smoke.ts',
].filter((script) => (
  /process\.env\.LLM_GEMINI_/m.test(fs.readFileSync(path.join(repoRoot, 'bots', 'hub', 'scripts', script), 'utf8'))
));

const precompileRequiredEntries = [
  'packages/core/lib/agent-yaml-loader.ts',
  'packages/core/lib/agent-llm-routing-adapter.ts',
  'packages/core/lib/selector-timeout-profiles.ts',
  'packages/core/lib/llm-provider-retirement.ts',
];
const missingPrecompileEntries = precompileRequiredEntries.filter((entry) => !precompileSource.includes(entry));
const distRuntimeChecks: string[] = [];
if (fs.existsSync(distRuntimeRoot)) {
  const distRetirementPath = path.join(distRuntimeRoot, 'packages/core/lib/llm-provider-retirement.js');
  const distSelectorPath = path.join(distRuntimeRoot, 'packages/core/lib/llm-model-selector.js');
  const distHubPath = path.join(distRuntimeRoot, 'bots/hub/src/hub.js');
  const distProfilesPath = path.join(distRuntimeRoot, 'bots/hub/lib/runtime-profiles.js');
  for (const requiredPath of [distRetirementPath, distSelectorPath, distHubPath, distProfilesPath]) {
    assert(fs.existsSync(requiredPath), `missing precompiled retirement artifact: ${relativePath(requiredPath)}`);
  }

  const distRetirement = require(distRetirementPath);
  const distSelector = require(distSelectorPath);
  const hostileState = distRetirement.getGeminiRetirementState({
    HUB_LLM_GEMINI_DISABLED: 'false',
    HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES: 'true',
  });
  assert.equal(hostileState.disabled, true, 'precompiled retirement policy must ignore env re-enable attempts');
  assert.equal(hostileState.retired, true, 'precompiled retirement policy must remain permanent');

  const distSelectorFindings = distSelector.listLLMSelectorKeys().flatMap((key: string) => {
    const description = distSelector.describeLLMSelector(key, {
      selectorVersion: 'v3.0_oauth_4',
      rolloutPercent: 100,
      rolloutKey: `dist-gemini-residue:${key}`,
    });
    return (description?.chain || [])
      .filter(isGeminiEntry)
      .map((entry: any) => `${key}:${entry.provider}/${entry.model}`);
  });
  assert.deepEqual(distSelectorFindings, [], 'precompiled selector chains must not route to retired Gemini');
  const distAbstractEntry = distSelector.routeEntryFromAbstractRoute('gemini_flash', 'v3_oauth_4');
  assert.equal(isGeminiEntry(distAbstractEntry), false, 'precompiled public abstract resolver must not reconstruct Gemini');

  const distHubSource = fs.readFileSync(distHubPath, 'utf8');
  const distProfilesSource = fs.readFileSync(distProfilesPath, 'utf8');
  assert(!distHubSource.includes('GEMINI_DIAGNOSTIC_SELECTOR_KEYS'), 'precompiled Hub bundle must not retain stale Gemini diagnostics');
  for (const selectorKey of RETIRED_GEMINI_SELECTOR_KEYS) {
    assert(!distProfilesSource.includes(selectorKey), `precompiled runtime profile must not retain ${selectorKey}`);
  }
  distRuntimeChecks.push('retirement', 'selector', 'hub', 'runtime-profiles');
}

const filesToScan = [
  ...OPERATIONAL_SOURCE_PATHS.flatMap((file) => collectPath(path.join(repoRoot, file))),
  ...SCANNED_OUTPUT_DIRS.flatMap((dir) => collectFiles(path.join(repoRoot, dir))),
];

const residueFiles = filesToScan
  .filter((filePath, index, list) => list.indexOf(filePath) === index)
  .filter((filePath) => fs.existsSync(filePath))
  .filter((filePath) => /gemini/i.test(fs.readFileSync(filePath, 'utf8')))
  .map(relativePath);

assert.deepEqual(selectorFindings, [], 'selector chains must not route to retired Gemini');
assert.deepEqual(policyTableFindings, [], 'generated policy table must not contain retired Gemini routes');
assert.deepEqual(policyTableGeminiConstants, [], 'generated policy table must not contain retired Gemini model constants');
assert.deepEqual(retiredSelectorRegistryEntries, [], 'retired Gemini selector keys must not remain registered');
assert.deepEqual(retiredPolicyTableRules, [], 'retired Gemini selector keys must not remain in the policy table');
assert.deepEqual(residueFiles, [], 'operational posting/team source files must not contain Gemini residue');
assert.deepEqual(retiredActiveTests, [], 'active Hub tests must not exercise retired Gemini paths');
assert.deepEqual(retiredPackageCommands, [], 'Hub package scripts must not expose retired Gemini operations');
assert.deepEqual(activeModelOverrideResidue, [], 'active selector tests must not configure retired Gemini model overrides');
assert.deepEqual(missingPrecompileEntries, [], 'precompile must include all selector retirement dependencies');
assert(retirementBoundarySources.toolRegistry.includes('getGeminiRetirementState'), 'OAuth ops status must use Gemini retirement policy');
assert(!retirementBoundarySources.toolRegistry.includes("getProviderRecord('gemini-cli-oauth')"), 'OAuth ops status must not read Gemini credentials');
assert(!retirementBoundarySources.secretsRoute.includes('gemini: store.gemini'), 'Hub secrets route must not expose Gemini keys');
assert(!retirementBoundarySources.secretsRoute.includes('c.gemini?.api_key'), 'Hub config fallback must not expose Gemini keys');
assert(!retirementBoundarySources.investmentSecrets.includes('gemini_api_key'), 'investment secrets must not ingest Gemini keys');
assert(!retirementBoundarySources.reservationDrill.includes("provider === 'gemini-cli-oauth'"), 'reservation route drill must not materialize Gemini routes');
assert(!retirementBoundarySources.speedTest.includes('refreshGeminiToken,'), 'speed test must not refresh Gemini credentials');
assert(!retirementBoundarySources.dailyReview.includes('geminiChat'), 'daily review must not recommend retired Gemini fallback');
for (const provider of ['gemini-cli-oauth', 'gemini-codeassist-oauth', 'gemini-oauth']) {
  assert.equal(providerStatus[provider]?.enabled, false, `${provider} must be disabled in the provider registry`);
  assert.equal(providerStatus[provider]?.retired, true, `${provider} must be marked retired in the provider registry`);
}
assert(activeTestRunner.includes('gemini-disabled-guard-smoke.ts'), 'active Hub tests must enforce the Gemini disabled guard');
assert(activeTestRunner.includes('llm-gemini-residue-audit.ts'), 'active Hub tests must enforce the Gemini residue audit');

console.log(JSON.stringify({
  ok: true,
  selector_keys_checked: selector.listLLMSelectorKeys().length,
  selector_gemini_routes: 0,
  policy_table_gemini_routes: 0,
  policy_table_gemini_constants: 0,
  retired_selector_registry_entries: 0,
  retired_policy_table_rules: 0,
  retired_active_tests: retiredActiveTests.length,
  retired_package_commands: retiredPackageCommands.length,
  active_gemini_model_override_tests: activeModelOverrideResidue.length,
  retirement_boundaries_checked: Object.keys(retirementBoundarySources).length,
  precompile_entries_checked: precompileRequiredEntries.length,
  dist_runtime_checks: distRuntimeChecks,
  operational_files_checked: filesToScan.length,
  scanned_output_dirs: SCANNED_OUTPUT_DIRS,
}, null, 2));
