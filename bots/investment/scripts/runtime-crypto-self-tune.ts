#!/usr/bin/env node
// @ts-nocheck

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import * as db from '../shared/db.ts';
import { buildRuntimeConfigSuggestionsReport } from './runtime-config-suggestions.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.yaml');
const AUTO_KEYS = new Set([
  'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.circuitBreaker.reductionMultiplier',
  'runtime_config.execution.cryptoGuardSoftening.byExchange.binance.tradeModes.normal.correlationGuard.reductionMultiplier',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
    write: argv.includes('--write'),
  };
}

function toRuntimePath(key) {
  return String(key || '')
    .replace(/^runtime_config\./, '')
    .split('.')
    .filter(Boolean);
}

function setByPath(target, path, value) {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

function getByPath(target, path) {
  return path.reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), target);
}

function selectAutoCandidates(report) {
  return (report?.suggestions || [])
    .filter((item) => AUTO_KEYS.has(item.key))
    .filter((item) => ['adjust', 'promote_candidate'].includes(item.action))
    .filter((item) => item.changeAllowed && !item.blockedByPolicy)
    .map((item) => ({
      key: item.key,
      path: toRuntimePath(item.key),
      current: item.current,
      suggested: item.suggested,
      confidence: item.confidence,
      reason: item.reason,
    }));
}

function renderText(result) {
  const lines = [
    '🤖 Runtime Crypto Self-Tune',
    `status: ${result.status}`,
    `headline: ${result.headline}`,
    `candidates: ${result.candidates.length}`,
  ];
  if (result.savedId) lines.push(`suggestion_log_id: ${result.savedId}`);
  if (result.applied.length > 0) {
    lines.push('', '적용 항목:');
    for (const item of result.applied) {
      lines.push(`- ${item.key}: ${item.before} -> ${item.after}`);
    }
  }
  if (result.candidates.length > 0 && result.applied.length === 0) {
    lines.push('', '후보 항목:');
    for (const item of result.candidates) {
      lines.push(`- ${item.key}: ${item.current} -> ${item.suggested} (${item.confidence})`);
    }
  }
  return lines.join('\n');
}

export async function buildRuntimeCryptoSelfTune({ days = 14, write = false, json = false } = {}) {
  await db.initSchema();
  const report = await buildRuntimeConfigSuggestionsReport({ days, write });
  const candidates = selectAutoCandidates(report);

  const result = {
    ok: true,
    status: 'crypto_self_tune_idle',
    headline: '자동 적용 가능한 crypto soft guard 후보가 아직 없습니다.',
    days,
    savedId: report?.saved?.id || null,
    candidates,
    applied: [],
    source: {
      actionableSuggestions: report?.actionableSuggestions || 0,
      totalSuggestions: report?.suggestions?.length || 0,
    },
  };

  if (candidates.length > 0) {
    result.status = write ? 'crypto_self_tune_applied' : 'crypto_self_tune_ready';
    result.headline = write
      ? '안전 범위의 crypto soft guard 후보를 자동 적용했습니다.'
      : '안전 범위의 crypto soft guard 후보를 자동 적용할 수 있습니다.';
  }

  if (write && candidates.length > 0) {
    const raw = yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
    if (!raw.runtime_config || typeof raw.runtime_config !== 'object') raw.runtime_config = {};

    for (const candidate of candidates) {
      const before = getByPath(raw.runtime_config, candidate.path);
      setByPath(raw.runtime_config, candidate.path, candidate.suggested);
      result.applied.push({
        key: candidate.key,
        before,
        after: candidate.suggested,
      });
    }

    writeFileSync(CONFIG_PATH, yaml.dump(raw, { lineWidth: 120, noRefs: true }), 'utf8');

    if (report?.saved?.id) {
      const autoKeys = candidates.map((item) => item.key).join(',');
      await db.updateRuntimeConfigSuggestionLogReview(report.saved.id, {
        reviewStatus: 'applied',
        reviewNote: `crypto_self_tune_auto_applied:${autoKeys}`,
      }).catch(() => {});
    }
  }

  if (json) return result;
  return renderText(result);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeCryptoSelfTune(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-crypto-self-tune 오류:',
  });
}
