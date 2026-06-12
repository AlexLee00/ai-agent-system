#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(SCRIPT_DIR, '..', '..', '..');
const SELECTOR_SOURCE_PATH = path.join(PROJECT_ROOT, 'packages', 'core', 'lib', 'llm-model-selector.ts');
const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'docs', 'hub', 'snapshots');
const DEFAULT_LAUNCHD_PLIST_PATH = path.join(PROJECT_ROOT, 'bots', 'hub', 'launchd', 'ai.hub.resource-api.plist');
const SNAPSHOT_TIME_ZONE = process.env.HUB_LLM_CHAIN_SNAPSHOT_TIME_ZONE || 'Asia/Seoul';
const SNAPSHOT_DATE = process.env.HUB_LLM_CHAIN_SNAPSHOT_DATE || snapshotDateString(new Date(), SNAPSHOT_TIME_ZONE);
const DEFAULT_OUTPUT_PATH = path.join(SNAPSHOT_DIR, `llm-chain-snapshot-${SNAPSHOT_DATE}.json`);
const DEFAULT_BASELINE_PATH = path.join(SNAPSHOT_DIR, 'llm-chain-snapshot-2026-06-12.json');
const SNAPSHOT_SOURCE = 'packages/core/lib/llm-model-selector.ts';
const FIXED_SMOKE_TIMESTAMP = '2026-06-12T00:00:00.000Z';
const SELECTOR_VERSION = 'v3.0_oauth_4';
const ROLLOUT_PERCENT = 100;
const CROSS_TEAM_PROBE_TEAM = 'crossteam-probe';
let selectorModule = null;

function getSelector() {
  if (!selectorModule) selectorModule = require('../../../packages/core/lib/llm-model-selector.ts');
  return selectorModule;
}

function snapshotDateString(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const OAUTH4_SELECTOR_OPTIONS = Object.freeze({
  selectorVersion: SELECTOR_VERSION,
  rolloutPercent: ROLLOUT_PERCENT,
});

const TASK_VARIANTS = Object.freeze([
  { variant: 'default', taskType: null, runtimePurpose: null },
  { variant: 'backtest_judgment', taskType: 'backtest_judgment', runtimePurpose: 'backtest_judgment' },
  { variant: 'backtest_embedding', taskType: 'backtest_embedding', runtimePurpose: 'backtest_embedding' },
]);

const ENV_BASELINE_KEYS = Object.freeze([
  'LLM_TEAM_SELECTOR_AB_PERCENT',
  'LLM_TEAM_SELECTOR_VERSION_PCT',
  'LLM_TEAM_SELECTOR_AB_STAGE',
  'LLM_TEAM_SELECTOR_AB_TEST',
  'LLM_TEAM_SELECTOR_VERSION',
  'LLM_USE_OAUTH_PRIMARY',
  'LLM_CLAUDE_CODE_QUOTA_MODE',
  'LLM_CLAUDE_CODE_DISABLED',
  'LLM_CLAUDE_CODE_USAGE_SATURATED',
  'LLM_FORCE_OPENAI_OAUTH_UNTIL',
  'LLM_CLAUDE_CODE_SONNET_DISABLED',
  'HUB_LLM_PUBLIC_OPENAI_ENABLED',
  'LLM_PUBLIC_OPENAI_ENABLED',
  'LLM_CLAUDE_CODE_REPLACEMENT_MODEL',
  'LLM_CLAUDE_CODE_SONNET_REPLACEMENT',
  'LLM_GROQ_ROUTE_MAX_TOKENS',
  'HUB_GROQ_ROUTE_MAX_TOKENS',
  'HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED',
  'HUB_DARWIN_SIGMA_GROQ_PRIMARY',
  'HUB_LLM_LOCAL_BACKTEST_ONLY',
  'HUB_ALLOW_PLANNED_LLM_ROUTES',
  'LLM_OPENAI_PERF_MODEL',
  'LLM_OPENAI_MINI_MODEL',
  'LLM_OPENAI_OPUS_MODEL',
  'LLM_GROQ_FAST_MODEL',
  'LLM_GROQ_DEEP_MODEL',
  'LLM_GROQ_SCOUT_MODEL',
  'LLM_GEMINI_FLASH_LITE_MODEL',
  'LLM_GEMINI_FLASH_MODEL',
  'LLM_GEMINI_PRO_MODEL',
  'LLM_LOCAL_EMBED_MODEL',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    smoke: false,
    engine: false,
    noWrite: false,
    envFromLaunchd: false,
    outPath: DEFAULT_OUTPUT_PATH,
    diffPath: null,
    launchdPlistPath: DEFAULT_LAUNCHD_PLIST_PATH,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--smoke') args.smoke = true;
    else if (arg === '--engine') args.engine = true;
    else if (arg === '--no-write') args.noWrite = true;
    else if (arg === '--env-from-launchd') args.envFromLaunchd = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--out') args.outPath = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--out=')) args.outPath = path.resolve(arg.slice('--out='.length));
    else if (arg === '--diff') args.diffPath = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--diff=')) args.diffPath = path.resolve(arg.slice('--diff='.length));
    else if (arg === '--launchd-plist') args.launchdPlistPath = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--launchd-plist=')) args.launchdPlistPath = path.resolve(arg.slice('--launchd-plist='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function usage() {
  return [
    'Usage: tsx scripts/llm-chain-snapshot.ts [--json] [--no-write] [--out <path>] [--diff <old.json>] [--engine] [--env-from-launchd] [--smoke]',
    '',
    'Builds a deterministic Hub LLM selector chain snapshot for the OAuth4 selector version.',
  ].join('\n');
}

function readLaunchdEnvironment(plistPath = DEFAULT_LAUNCHD_PLIST_PATH) {
  const raw = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw);
  return parsed?.EnvironmentVariables && typeof parsed.EnvironmentVariables === 'object'
    ? parsed.EnvironmentVariables
    : {};
}

function applyLaunchdEnvironment(plistPath = DEFAULT_LAUNCHD_PLIST_PATH) {
  const env = readLaunchdEnvironment(plistPath);
  const injected = [];
  const preserved = [];
  for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (process.env[key] !== undefined) {
      preserved.push(key);
      continue;
    }
    process.env[key] = String(value);
    injected.push(key);
  }
  return {
    path: path.relative(PROJECT_ROOT, plistPath),
    injected,
    preserved,
  };
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]),
  );
}

function stableStringify(value) {
  return `${JSON.stringify(sortedObject(value), null, 2)}\n`;
}

function clean(value) {
  return String(value || '').trim();
}

function teamFromSelectorKey(key) {
  const team = clean(key).split('.')[0];
  return team || null;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeChainEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const row = {
    provider: clean(entry.provider) || null,
    model: clean(entry.model) || null,
  };
  const maxTokens = normalizeNumber(entry.maxTokens);
  const temperature = normalizeNumber(entry.temperature);
  const timeoutMs = normalizeNumber(entry.timeoutMs);
  if (maxTokens != null) row.maxTokens = maxTokens;
  if (temperature != null) row.temperature = temperature;
  if (timeoutMs != null) row.timeoutMs = timeoutMs;
  return row;
}

function normalizeChain(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map(normalizeChainEntry).filter(Boolean);
}

function findObjectLiteralBlock(source, variableName) {
  const markerIndex = source.indexOf(`const ${variableName}:`);
  if (markerIndex < 0) throw new Error(`missing ${variableName} route map`);
  const assignmentIndex = source.indexOf('=', markerIndex);
  if (assignmentIndex < 0) throw new Error(`missing ${variableName} assignment`);
  const openIndex = source.indexOf('{', assignmentIndex);
  if (openIndex < 0) throw new Error(`missing ${variableName} object literal`);
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, index + 1);
    }
  }
  throw new Error(`unterminated ${variableName} object literal`);
}

function extractRouteKeysFromBlock(block) {
  const keys = [];
  const routeLinePattern = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{\s*route\s*:/gm;
  let match = routeLinePattern.exec(block);
  while (match) {
    const key = clean(match[1] || match[2] || match[3]);
    if (key) keys.push(key);
    match = routeLinePattern.exec(block);
  }
  return Array.from(new Set(keys)).sort((a, b) => a.localeCompare(b));
}

function extractAgentRouteKeys(source = fs.readFileSync(SELECTOR_SOURCE_PATH, 'utf8')) {
  return {
    darwin: extractRouteKeysFromBlock(findObjectLiteralBlock(source, 'DARWIN_ROUTES')),
    sigma: extractRouteKeysFromBlock(findObjectLiteralBlock(source, 'SIGMA_ROUTES')),
  };
}

function envBaseline() {
  return {
    mode: 'default_env_no_kill_switch_overrides',
    values: Object.fromEntries(ENV_BASELINE_KEYS.map((key) => [key, process.env[key] ? 'set' : 'unset'])),
  };
}

function rowIdentity(row) {
  return [
    clean(row.key),
    clean(row.agentName),
    clean(row.variant),
    clean(row.taskType),
    clean(row.runtimePurpose),
  ].join('\u0000');
}

function describeSnapshotRow(key, spec) {
  const team = teamFromSelectorKey(key);
  const options = {
    ...OAUTH4_SELECTOR_OPTIONS,
    rolloutKey: `llm-chain-snapshot:${key}:${spec.agentName || 'default'}:${spec.variant}`,
    team,
    callerTeam: team,
  };
  if (spec.agentName) options.agentName = spec.agentName;
  if (spec.taskType) {
    options.taskType = spec.taskType;
    options.task_type = spec.taskType;
  }
  if (spec.runtimePurpose) {
    options.runtimePurpose = spec.runtimePurpose;
    options.runtime_purpose = spec.runtimePurpose;
  }

  try {
    const description = getSelector().describeLLMSelector(key, options);
    const chain = normalizeChain(description?.chain);
    return {
      key,
      variant: spec.variant,
      agentName: spec.agentName || null,
      taskType: spec.taskType || null,
      runtimePurpose: spec.runtimePurpose || null,
      kind: clean(description?.kind) || 'unknown',
      primary: normalizeChainEntry(description?.primary) || chain[0] || null,
      fallbacks: normalizeChain(description?.fallbacks),
      chain,
      error: null,
    };
  } catch (error) {
    return {
      key,
      variant: spec.variant,
      agentName: spec.agentName || null,
      taskType: spec.taskType || null,
      runtimePurpose: spec.runtimePurpose || null,
      kind: 'error',
      primary: null,
      fallbacks: [],
      chain: [],
      error: String(error?.message || error),
    };
  }
}

function specsForSelectorKey(key, routeKeys) {
  const baseSpecs = TASK_VARIANTS.map((taskVariant) => ({
    ...taskVariant,
    agentName: null,
  }));
  const agentNames = key === 'darwin.agent_policy'
    ? routeKeys.darwin
    : (key === 'sigma.agent_policy' ? routeKeys.sigma : []);
  const agentSpecs = [];
  for (const agentName of agentNames) {
    for (const taskVariant of TASK_VARIANTS) {
      agentSpecs.push({ ...taskVariant, agentName });
    }
  }
  return [...baseSpecs, ...agentSpecs];
}

function buildLlmChainSnapshot(options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const routeKeys = options.routeKeys || extractAgentRouteKeys();
  const selectorKeys = getSelector().listLLMSelectorKeys().slice().sort((a, b) => a.localeCompare(b));
  const variants = [];
  const errors = [];

  for (const key of selectorKeys) {
    for (const spec of specsForSelectorKey(key, routeKeys)) {
      const row = describeSnapshotRow(key, spec);
      variants.push(row);
      if (row.error) {
        errors.push({
          key: row.key,
          variant: row.variant,
          agentName: row.agentName,
          error: row.error,
        });
      }
    }
  }

  variants.sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b)));
  errors.sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b)));

  return {
    generatedAt,
    selectorVersion: SELECTOR_VERSION,
    rolloutPercent: ROLLOUT_PERCENT,
    source: SNAPSHOT_SOURCE,
    envBaseline: envBaseline(),
    counts: {
      selectorKeys: selectorKeys.length,
      darwinAgentRoutes: routeKeys.darwin.length,
      sigmaAgentRoutes: routeKeys.sigma.length,
      variants: variants.length,
      errors: errors.length,
    },
    variants,
    errors,
  };
}

function comparableRow(row) {
  return {
    key: row.key,
    variant: row.variant,
    agentName: row.agentName || null,
    taskType: row.taskType || null,
    runtimePurpose: row.runtimePurpose || null,
    kind: row.kind,
    primary: row.primary || null,
    fallbacks: row.fallbacks || [],
    chain: row.chain || [],
    error: row.error || null,
  };
}

function indexSnapshotRows(snapshot) {
  const indexed = new Map();
  for (const row of snapshot?.variants || []) {
    indexed.set(rowIdentity(row), comparableRow(row));
  }
  return indexed;
}

function diffLlmChainSnapshots(oldSnapshot, newSnapshot) {
  const oldRows = indexSnapshotRows(oldSnapshot);
  const newRows = indexSnapshotRows(newSnapshot);
  const added = [];
  const removed = [];
  const changedRows = [];

  for (const [id, row] of newRows.entries()) {
    if (!oldRows.has(id)) {
      added.push(row);
      continue;
    }
    const before = oldRows.get(id);
    if (stableStringify(before) !== stableStringify(row)) {
      changedRows.push({ id, before, after: row });
    }
  }
  for (const [id, row] of oldRows.entries()) {
    if (!newRows.has(id)) removed.push(row);
  }

  added.sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b)));
  removed.sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b)));
  changedRows.sort((a, b) => a.id.localeCompare(b.id));

  const changeCount = added.length + removed.length + changedRows.length;
  return {
    ok: changeCount === 0,
    changed: changeCount > 0,
    changeCount,
    added,
    removed,
    changedRows,
  };
}

function buildEngineRow(row) {
  const policyEngine = require('../../../packages/core/lib/llm-policy-engine.ts');
  const team = row.engineTeam || teamFromSelectorKey(row.key);
  const chain = normalizeChain(policyEngine.resolvePolicyChain({
    team,
    callerTeam: team,
    selectorKey: row.key,
    agentName: row.agentName || null,
    agent: row.agentName || null,
    taskType: row.taskType || null,
    task_type: row.taskType || null,
    runtimePurpose: row.runtimePurpose || row.taskType || null,
    runtime_purpose: row.runtimePurpose || row.taskType || null,
  }));
  return {
    key: row.key,
    variant: row.variant,
    agentName: row.agentName || null,
    team,
    taskType: row.taskType || null,
    runtimePurpose: row.runtimePurpose || null,
    kind: chain.length > 0 ? 'chain' : 'none',
    primary: chain[0] || null,
    fallbacks: chain.slice(1),
    chain,
    error: null,
  };
}

function buildCrossTeamEngineRows(rows) {
  return rows
    .filter((row) => row.variant === 'default')
    .map((row) => ({
      ...row,
      variant: 'cross_team',
      engineTeam: CROSS_TEAM_PROBE_TEAM,
    }));
}

function buildEngineDiffRows(baseline) {
  const rows = Array.isArray(baseline?.variants) ? baseline.variants : [];
  return [...rows, ...buildCrossTeamEngineRows(rows)];
}

function buildEngineDiff(baseline = loadJsonFile(DEFAULT_BASELINE_PATH)) {
  const mismatches = [];
  const rows = buildEngineDiffRows(baseline);
  for (const expected of rows) {
    const actual = buildEngineRow(expected);
    const expectedChain = normalizeChain(expected.chain);
    const actualChain = normalizeChain(actual.chain);
    if (stableStringify(expectedChain) !== stableStringify(actualChain)) {
      mismatches.push({
        key: expected.key,
        variant: expected.variant,
        agentName: expected.agentName || null,
        team: actual.team || null,
        taskType: expected.taskType || null,
        runtimePurpose: expected.runtimePurpose || null,
        expectedChain,
        actualChain,
      });
    }
  }
  return {
    total: rows.length,
    mismatched: mismatches.length,
    mismatches,
  };
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stableStringify(value));
}

function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertSmokeResult(results, id, name, fn) {
  try {
    const evidence = fn();
    results.push({ id, name, pass: true, evidence: clean(evidence) || 'ok' });
  } catch (error) {
    results.push({ id, name, pass: false, evidence: String(error?.message || error) });
  }
}

function runSmoke() {
  const results = [];
  const first = buildLlmChainSnapshot({ generatedAt: FIXED_SMOKE_TIMESTAMP });
  const second = buildLlmChainSnapshot({ generatedAt: FIXED_SMOKE_TIMESTAMP });
  const selectorKeys = getSelector().listLLMSelectorKeys();

  assertSmokeResult(results, 'TS-R1-1', 'selector key coverage and deterministic output', () => {
    assert.equal(first.counts.selectorKeys, selectorKeys.length);
    assert(first.counts.selectorKeys >= 89, `expected at least 89 selector keys, got ${first.counts.selectorKeys}`);
    assert.equal(stableStringify(first), stableStringify(second));
    const defaultKeys = new Set(
      first.variants
        .filter((row) => row.variant === 'default' && !row.agentName)
        .map((row) => row.key),
    );
    for (const key of selectorKeys) assert(defaultKeys.has(key), `missing default variant for ${key}`);
    assert(first.counts.darwinAgentRoutes > 0, 'missing darwin agent route variants');
    assert(first.counts.sigmaAgentRoutes > 0, 'missing sigma agent route variants');
    return `${first.counts.selectorKeys} selector keys, ${first.counts.variants} variants`;
  });

  assertSmokeResult(results, 'TS-R1-2', 'oauth4 alarm interpreter route is groq primary', () => {
    const row = first.variants.find((candidate) => (
      candidate.key === 'hub.alarm.interpreter.error'
      && candidate.variant === 'default'
      && !candidate.agentName
    ));
    assert(row, 'missing hub.alarm.interpreter.error default row');
    assert.equal(row.primary?.provider, 'groq');
    return `primary=${row.primary?.provider}/${row.primary?.model}`;
  });

  assertSmokeResult(results, 'TS-R1-3', 'diff mode detects selector chain changes', () => {
    const changed = JSON.parse(stableStringify(first));
    const target = changed.variants.find((row) => row.key === 'hub.alarm.interpreter.error' && row.variant === 'default' && !row.agentName);
    assert(target, 'missing diff target row');
    target.primary = { ...target.primary, provider: 'fixture-provider' };
    target.chain = [{ ...target.chain[0], provider: 'fixture-provider' }, ...target.chain.slice(1)];
    const sameDiff = diffLlmChainSnapshots(first, second);
    const changedDiff = diffLlmChainSnapshots(first, changed);
    assert.equal(sameDiff.changed, false, 'identical snapshots should not diff');
    assert.equal(changedDiff.changed, true, 'modified snapshot should diff');
    assert(changedDiff.changedRows.length > 0, 'modified snapshot should include changed rows');
    return `${changedDiff.changeCount} changed row(s) detected`;
  });

  assertSmokeResult(results, 'TS-R1-4', 'smoke path has no external or mutation dependencies', () => {
    const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const forbidden = [
      ['p', 'g', 'P', 'o', 'o', 'l'].join(''),
      ['f', 'e', 't', 'c', 'h', '('].join(''),
      ['I', 'N', 'S', 'E', 'R', 'T'].join(''),
      ['U', 'P', 'D', 'A', 'T', 'E'].join(''),
      ['D', 'E', 'L', 'E', 'T', 'E'].join(''),
      ['l', 'a', 'u', 'n', 'c', 'h', 'c', 't', 'l'].join(''),
    ];
    for (const pattern of forbidden) {
      assert(!source.includes(pattern), `unexpected dependency marker: ${pattern}`);
    }
    return 'source has no DB, HTTP, SQL mutation, or process restart markers';
  });

  const passed = results.filter((result) => result.pass).length;
  const report = {
    ok: passed === results.length,
    generatedAt: new Date().toISOString(),
    selectorVersion: SELECTOR_VERSION,
    results,
  };
  return report;
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const launchdEnv = args.envFromLaunchd ? applyLaunchdEnvironment(args.launchdPlistPath) : null;
  if (args.help) {
    console.log(usage());
    return 0;
  }

  if (args.smoke) {
    const report = runSmoke();
    console.log(stableStringify(report));
    return report.ok ? 0 : 1;
  }

  if (args.engine) {
    // R2d: env-backed model-token diff must compare the engine against the old selector in the same Hub runtime env.
    const baseline = args.envFromLaunchd
      ? buildLlmChainSnapshot({ generatedAt: FIXED_SMOKE_TIMESTAMP })
      : loadJsonFile(DEFAULT_BASELINE_PATH);
    const engineDiff = buildEngineDiff(baseline);
    const output = {
      ok: engineDiff.mismatched === 0,
      generatedAt: new Date().toISOString(),
      selectorVersion: SELECTOR_VERSION,
      baselinePath: path.relative(PROJECT_ROOT, DEFAULT_BASELINE_PATH),
      baselineSource: args.envFromLaunchd ? 'current_selector_with_launchd_env' : 'snapshot_file',
      envFromLaunchd: args.envFromLaunchd,
      launchdEnv,
      engineDiff,
    };
    if (args.json) {
      console.log(stableStringify(output));
    } else {
      console.log(`[llm-chain-snapshot:engine] total=${engineDiff.total} mismatched=${engineDiff.mismatched}`);
      if (engineDiff.mismatched > 0) console.log(stableStringify(engineDiff.mismatches.slice(0, 10)));
    }
    return engineDiff.mismatched === 0 ? 0 : 1;
  }

  const snapshot = buildLlmChainSnapshot();
  let output = snapshot;
  let exitCode = 0;

  if (args.diffPath) {
    const oldSnapshot = loadJsonFile(args.diffPath);
    const diff = diffLlmChainSnapshots(oldSnapshot, snapshot);
    output = {
      ok: diff.ok,
      generatedAt: snapshot.generatedAt,
      selectorVersion: snapshot.selectorVersion,
      diff,
      current: snapshot,
    };
    exitCode = diff.changed ? 1 : 0;
  }

  if (!args.noWrite) {
    writeJsonFile(args.outPath, snapshot);
  }

  if (args.json || args.diffPath) {
    console.log(stableStringify(output));
  } else {
    console.log(`wrote ${path.relative(PROJECT_ROOT, args.outPath)}`);
    console.log(`selectorKeys=${snapshot.counts.selectorKeys} variants=${snapshot.counts.variants} errors=${snapshot.counts.errors}`);
  }

  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  });
}

export {
  buildLlmChainSnapshot,
  buildEngineDiff,
  diffLlmChainSnapshots,
  extractAgentRouteKeys,
  runCli,
};
