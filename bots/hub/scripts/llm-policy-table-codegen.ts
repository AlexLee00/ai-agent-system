#!/usr/bin/env tsx
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { applyAuthoritativeLaunchdEnvironment } from './llm-launchd-environment.ts';

const require = createRequire(import.meta.url);
const {
  isGeminiProvider,
  isRetiredGeminiSelectorKey,
} = require('../../../packages/core/lib/llm-provider-retirement.ts');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_SNAPSHOT_PATH = path.join(PROJECT_ROOT, 'docs', 'hub', 'snapshots', 'llm-chain-snapshot-2026-07-19.json');
const DEFAULT_OUTPUT_PATH = path.join(PROJECT_ROOT, 'packages', 'core', 'lib', 'llm-policy-table.ts');
const DEFAULT_LAUNCHD_PLIST_PATH = path.join(PROJECT_ROOT, 'bots', 'hub', 'launchd', 'ai.hub.resource-api.plist');

let selectorModule = null;

function getSelectorModule() {
  if (!selectorModule) selectorModule = require('../../../packages/core/lib/llm-model-selector.ts');
  return selectorModule;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    check: false,
    json: false,
    envFromLaunchd: false,
    snapshotPath: DEFAULT_SNAPSHOT_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    launchdPlistPath: DEFAULT_LAUNCHD_PLIST_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') args.check = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--env-from-launchd') args.envFromLaunchd = true;
    else if (arg === '--launchd-plist') args.launchdPlistPath = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--launchd-plist=')) args.launchdPlistPath = path.resolve(arg.slice('--launchd-plist='.length));
    else if (arg === '--snapshot') args.snapshotPath = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--snapshot=')) args.snapshotPath = path.resolve(arg.slice('--snapshot='.length));
    else if (arg === '--out') args.outputPath = path.resolve(argv[++index] || '');
    else if (arg.startsWith('--out=')) args.outputPath = path.resolve(arg.slice('--out='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
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

function applyLaunchdEnvironment(plistPath = DEFAULT_LAUNCHD_PLIST_PATH, managedKeys = []) {
  const env = readLaunchdEnvironment(plistPath);
  return {
    path: path.relative(PROJECT_ROOT, plistPath),
    ...applyAuthoritativeLaunchdEnvironment(env, { managedKeys }),
  };
}

function clean(value) {
  return String(value || '').trim();
}

function slug(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function teamFromSelectorKey(selectorKey) {
  return clean(selectorKey).split('.')[0] || '*';
}

function providerMatchesConstant(provider, constant) {
  const normalizedProvider = clean(provider);
  const prefixes = Array.isArray(constant?.providerPrefixes) ? constant.providerPrefixes.map(clean).filter(Boolean) : [];
  return prefixes.length === 0 || prefixes.includes(normalizedProvider);
}

function buildModelTokenIndex() {
  const constants = (getSelectorModule().LLM_CONFIGURED_MODEL_CONSTANTS || [])
    .map((constant) => ({
      name: clean(constant.name),
      token: clean(constant.token),
      envName: clean(constant.envName),
      value: clean(constant.value),
      fallback: clean(constant.fallback),
      providerPrefixes: Array.isArray(constant.providerPrefixes) ? constant.providerPrefixes.map(clean).filter(Boolean) : [],
    }))
    .filter((constant) => !(
      isGeminiProvider(constant.value)
      || isGeminiProvider(constant.fallback)
      || constant.providerPrefixes.some(isGeminiProvider)
    ))
    .filter((constant) => constant.name && constant.token);
  const buckets = new Map();
  for (const constant of constants) {
    // Tokenize snapshot defaults, not unrelated literals that merely equal a LaunchAgent override today.
    const modelCandidates = constant.value === constant.fallback ? [constant.fallback] : [];
    for (const model of Array.from(new Set(modelCandidates.filter(Boolean)))) {
      for (const provider of constant.providerPrefixes.length > 0 ? constant.providerPrefixes : ['*']) {
        const key = `${provider}\u0000${model}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(constant);
      }
    }
  }

  const lookup = new Map();
  const warnings = [];
  for (const [key, candidates] of buckets.entries()) {
    const sorted = candidates.slice().sort((a, b) => a.name.localeCompare(b.name));
    const names = Array.from(new Set(sorted.map((candidate) => candidate.name)));
    if (names.length > 1) {
      const [provider, model] = key.split('\u0000');
      warnings.push(`model token conflict provider=${provider} model=${model} candidates=${names.join(',')} resolved_by_source_probe=true`);
      continue;
    }
    lookup.set(key, sorted[0]);
  }

  return {
    constants,
    lookup,
    warnings,
  };
}

function snapshotRowIdentity(row) {
  return [
    clean(row.key),
    clean(row.agentName),
    clean(row.variant),
    clean(row.taskType),
    clean(row.runtimePurpose),
  ].join('\u0000');
}

function chainEntrySourceKey(row, index) {
  return `${snapshotRowIdentity(row)}\u0000${index}`;
}

function runModelTokenProbe(constant, constants) {
  const marker = `__R2D_MODEL_TOKEN_${constant.name}__`;
  const env = { ...process.env };
  for (const candidate of constants) {
    env[candidate.envName] = candidate.fallback || '';
  }
  env[constant.envName] = marker;

  const output = execFileSync(process.execPath, ['--import', 'tsx', '-e', `
    const { buildLlmChainSnapshot } = require(process.cwd() + '/bots/hub/scripts/llm-chain-snapshot.ts');
    const snapshot = buildLlmChainSnapshot({ generatedAt: '2026-06-12T00:00:00.000Z' });
    const marker = ${JSON.stringify(marker)};
    const hits = [];
    function clean(value) { return String(value || '').trim(); }
    function rowIdentity(row) {
      return [
        clean(row.key),
        clean(row.agentName),
        clean(row.variant),
        clean(row.taskType),
        clean(row.runtimePurpose),
      ].join('\\u0000');
    }
    for (const row of snapshot.variants || []) {
      (row.chain || []).forEach((entry, index) => {
        if (entry && entry.model === marker) hits.push({ id: rowIdentity(row), index, provider: clean(entry.provider) });
      });
    }
    console.log(JSON.stringify(hits));
  `], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf8',
  });
  return JSON.parse(output);
}

function buildModelTokenSourceIndex(constants, warnings) {
  const sourceTokens = new Map();
  const conflicts = [];
  for (const constant of constants) {
    const hits = runModelTokenProbe(constant, constants);
    for (const hit of hits) {
      const key = `${hit.id}\u0000${hit.index}`;
      if (sourceTokens.has(key) && sourceTokens.get(key).token !== constant.token) {
        conflicts.push(`${key}:${sourceTokens.get(key).token}->${constant.token}`);
        continue;
      }
      sourceTokens.set(key, {
        token: constant.token,
        provider: clean(hit.provider),
      });
    }
  }
  if (conflicts.length > 0) {
    warnings.push(`model source token conflicts=${conflicts.slice(0, 10).join(',')}${conflicts.length > 10 ? `...(+${conflicts.length - 10})` : ''}`);
  }
  return sourceTokens;
}

function createCodegenContext() {
  const tokenIndex = buildModelTokenIndex();
  return {
    ...tokenIndex,
    sourceTokens: buildModelTokenSourceIndex(tokenIndex.constants, tokenIndex.warnings),
    tokenizedEntryCount: 0,
    tokenCounts: {},
  };
}

function tokenizeModel(provider, model, context, sourceKey = null) {
  const normalizedProvider = clean(provider);
  const normalizedModel = clean(model);
  if (!normalizedModel || !context) return normalizedModel;
  const sourceToken = sourceKey ? context.sourceTokens.get(sourceKey) : null;
  if (sourceToken && (!sourceToken.provider || sourceToken.provider === normalizedProvider)) {
    context.tokenizedEntryCount += 1;
    context.tokenCounts[sourceToken.token] = (context.tokenCounts[sourceToken.token] || 0) + 1;
    return sourceToken.token;
  }
  const direct = context.lookup.get(`${normalizedProvider}\u0000${normalizedModel}`);
  const wildcard = context.lookup.get(`*\u0000${normalizedModel}`);
  const constant = direct || wildcard;
  if (!constant || !providerMatchesConstant(normalizedProvider, constant)) return normalizedModel;
  context.tokenizedEntryCount += 1;
  context.tokenCounts[constant.token] = (context.tokenCounts[constant.token] || 0) + 1;
  return constant.token;
}

function normalizeChainEntry(entry = {}, context = null, sourceKey = null) {
  const provider = clean(entry.provider);
  const row = {
    provider,
    model: tokenizeModel(provider, entry.model, context, sourceKey),
  };
  const maxTokens = Number(entry.maxTokens);
  const temperature = Number(entry.temperature);
  const timeoutMs = Number(entry.timeoutMs);
  if (Number.isFinite(maxTokens)) row.maxTokens = maxTokens;
  if (Number.isFinite(temperature)) row.temperature = temperature;
  if (Number.isFinite(timeoutMs)) row.timeoutMs = timeoutMs;
  return row;
}

function assertNoRetiredGeminiRoute(row) {
  const selectorKey = clean(row?.key) || 'unknown';
  const chain = Array.isArray(row?.chain) ? row.chain : [];
  for (const entry of chain) {
    if (isGeminiProvider(entry?.provider) || isGeminiProvider(entry?.model)) {
      throw new Error(`retired Gemini route in snapshot: selector=${selectorKey}`);
    }
  }
}

function ruleFromSnapshotRow(row, context) {
  const selectorKey = clean(row.key);
  const agent = clean(row.agentName);
  const taskType = clean(row.taskType || row.runtimePurpose);
  const variant = clean(row.variant) || 'default';
  const match = {
    team: teamFromSelectorKey(selectorKey),
    selectorKey,
  };
  if (agent) match.agent = agent;
  if (taskType) match.taskType = taskType;
  const chain = Array.isArray(row.chain) ? row.chain : [];
  return {
    id: [selectorKey, agent || 'default', variant].map(slug).join('__'),
    match,
    chain: chain.map((entry, index) => (
      normalizeChainEntry(entry, context, chainEntrySourceKey(row, index))
    )),
  };
}

function sortRule(a, b) {
  const aKey = [
    a.match.selectorKey || '',
    a.match.agent || '',
    a.match.taskType || '',
    a.id,
  ].join('\u0000');
  const bKey = [
    b.match.selectorKey || '',
    b.match.agent || '',
    b.match.taskType || '',
    b.id,
  ].join('\u0000');
  return aKey.localeCompare(bKey);
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildPolicyTableSource(snapshot, snapshotPath = DEFAULT_SNAPSHOT_PATH) {
  const snapshotRows = (Array.isArray(snapshot?.variants) ? snapshot.variants : [])
    .filter((row) => !row.error);
  for (const row of snapshotRows) assertNoRetiredGeminiRoute(row);
  const context = createCodegenContext();
  const rules = snapshotRows
    .filter((row) => !isRetiredGeminiSelectorKey(row.key))
    .map((row) => ruleFromSnapshotRow(row, context))
    .sort(sortRule);
  const generatedFrom = path.relative(PROJECT_ROOT, snapshotPath);
  const configuredModelConstants = context.constants.map((constant) => ({
    name: constant.name,
    token: constant.token,
    envName: constant.envName,
    value: constant.value,
    fallback: constant.fallback,
    providerPrefixes: constant.providerPrefixes,
  }));
  const source = [
    '// @ts-nocheck',
    '// Generated by bots/hub/scripts/llm-policy-table-codegen.ts.',
    '// Do not edit by hand; update the R1 snapshot, retirement policy, or codegen and regenerate.',
    '// Operational note: run codegen/static diff with --env-from-launchd so env-backed model tokens match Hub runtime.',
    '',
    'export type PolicyChainEntry = string | {',
    '  provider: string;',
    '  model: string;',
    '  maxTokens?: number;',
    '  temperature?: number;',
    '  timeoutMs?: number;',
    '};',
    '',
    'export type PolicyRule = {',
    '  id: string;',
    '  match: { team: string; selectorKey?: string; agent?: string; taskType?: string };',
    '  chain: PolicyChainEntry[];',
    '  caps?: { maxTokens?: number; temperature?: number };',
    '};',
    '',
    `export const LLM_POLICY_TABLE_GENERATED_FROM = ${JSON.stringify(generatedFrom)};`,
    `export const LLM_POLICY_TABLE_GENERATED_AT = ${JSON.stringify(snapshot?.generatedAt || null)};`,
    `export const LLM_POLICY_TABLE_SELECTOR_VERSION = ${JSON.stringify(snapshot?.selectorVersion || null)};`,
    `export const LLM_POLICY_TABLE_RULE_COUNT = ${rules.length};`,
    `export const LLM_POLICY_TABLE_MODEL_TOKEN_COUNT = ${context.tokenizedEntryCount};`,
    `export const LLM_POLICY_TABLE_MODEL_TOKEN_COUNTS: Record<string, number> = ${stableStringify(context.tokenCounts).trim()};`,
    `export const LLM_POLICY_TABLE_CONFIGURED_MODEL_CONSTANTS = ${stableStringify(configuredModelConstants).trim()};`,
    '',
    `export const LLM_POLICY_RULES: PolicyRule[] = ${stableStringify(rules).trim()};`,
    '',
  ].join('\n');
  return {
    source,
    rules,
    tokenizedEntryCount: context.tokenizedEntryCount,
    tokenCounts: context.tokenCounts,
    configuredModelConstants,
    warnings: context.warnings,
  };
}

function buildReport(args, changed, codegen, launchdEnv = null) {
  return {
    ok: !args.check || !changed,
    changed,
    check: args.check,
    envFromLaunchd: args.envFromLaunchd,
    launchdEnv,
    snapshotPath: path.relative(PROJECT_ROOT, args.snapshotPath),
    outputPath: path.relative(PROJECT_ROOT, args.outputPath),
    ruleCount: codegen.rules.length,
    tokenizedEntryCount: codegen.tokenizedEntryCount,
    tokenCounts: codegen.tokenCounts,
    configuredModelConstants: codegen.configuredModelConstants,
    warnings: codegen.warnings,
  };
}

async function main() {
  const args = parseArgs();
  const snapshot = JSON.parse(fs.readFileSync(args.snapshotPath, 'utf8'));
  // R2d: generated policy tables must be built against the same LaunchAgent env as Hub runtime.
  const launchdEnv = args.envFromLaunchd
    ? applyLaunchdEnvironment(args.launchdPlistPath, Object.keys(snapshot?.envBaseline?.values || {}))
    : null;
  const codegen = buildPolicyTableSource(snapshot, args.snapshotPath);
  const source = codegen.source;
  const current = fs.existsSync(args.outputPath) ? fs.readFileSync(args.outputPath, 'utf8') : '';
  const changed = current !== source;
  const report = buildReport(args, changed, codegen, launchdEnv);

  if (args.check) {
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`[llm-policy-table-codegen] check changed=${changed} rules=${report.ruleCount} tokenized=${report.tokenizedEntryCount}`);
    process.exitCode = changed ? 1 : 0;
    return;
  }

  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, source);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const warning of codegen.warnings) console.warn(`[llm-policy-table-codegen] warning: ${warning}`);
    console.log(`[llm-policy-table-codegen] wrote ${path.relative(PROJECT_ROOT, args.outputPath)} rules=${report.ruleCount} tokenized=${report.tokenizedEntryCount}`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
