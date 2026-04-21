#!/usr/bin/env node
// @ts-nocheck

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { buildRuntimeKisOverseasAutotuneReport } from './runtime-kis-overseas-autotune-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.yaml');
const HISTORY_PATH = '/tmp/investment-runtime-kis-overseas-autotune-history.jsonl';
const AUTO_KEYS = new Set([
  'runtime_config.luna.stockOrderDefaults.kis_overseas.min',
  'runtime_config.luna.minConfidence.live.kis_overseas',
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

function buildCandidate(report) {
  const candidate = report?.candidate || null;
  if (!candidate) return null;
  if (!AUTO_KEYS.has(candidate.key)) return null;
  if (!candidate.governance || candidate.governance.tier !== 'allow') return null;
  return {
    key: candidate.key,
    path: toRuntimePath(candidate.key),
    current: candidate.current,
    suggested: candidate.suggested,
    confidence: candidate.confidence,
    reason: candidate.reason,
  };
}

function readLastHistorySnapshot() {
  try {
    const lines = readFileSync(HISTORY_PATH, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function isSameEvidence(report, snapshot) {
  if (!report?.candidate || !snapshot) return false;
  return report.candidate.key === snapshot.candidateKey
    && Number(report?.decision?.metrics?.totalBuy || 0) === Number(snapshot.totalBuy || 0)
    && Number(report?.decision?.metrics?.executedSignals || 0) === Number(snapshot.executedSignals || 0)
    && Number(report?.decision?.metrics?.failedSignals || 0) === Number(snapshot.failedSignals || 0)
    && Number(report?.decision?.metrics?.minOrderNotional || 0) === Number(snapshot.minOrderNotional || 0)
    && Number(report.candidate.current ?? NaN) === Number(snapshot.candidateSuggested ?? NaN);
}

function renderText(result) {
  const lines = [
    '🌍 Runtime KIS Overseas Self-Tune',
    `status: ${result.status}`,
    `headline: ${result.headline}`,
    `candidate: ${result.candidate?.key || '없음'}`,
  ];
  if (result.applied) {
    lines.push(`applied: ${result.applied.key} ${result.applied.before} -> ${result.applied.after}`);
  } else if (result.candidate) {
    lines.push(`preview: ${result.candidate.current} -> ${result.candidate.suggested} (${result.candidate.confidence})`);
  }
  return lines.join('\n');
}

export async function buildRuntimeKisOverseasSelfTune({ days = 14, write = false, json = false } = {}) {
  const report = await buildRuntimeKisOverseasAutotuneReport({ days, json: true });
  const lastSnapshot = readLastHistorySnapshot();
  const candidate = isSameEvidence(report, lastSnapshot) ? null : buildCandidate(report);
  const result = {
    ok: true,
    status: 'kis_overseas_self_tune_idle',
    headline: isSameEvidence(report, lastSnapshot)
      ? '같은 표본 기준 self-tune은 이미 한 번 적용돼 추가 변화 없이 관찰합니다.'
      : '자동 적용 가능한 해외장 self-tune 후보가 아직 없습니다.',
    days,
    candidate,
    applied: null,
  };

  if (candidate) {
    result.status = write ? 'kis_overseas_self_tune_applied' : 'kis_overseas_self_tune_ready';
    result.headline = write
      ? '안전 범위의 해외장 self-tune 후보를 자동 적용했습니다.'
      : '안전 범위의 해외장 self-tune 후보를 자동 적용할 수 있습니다.';
  }

  if (write && candidate) {
    const raw = yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
    if (!raw.runtime_config || typeof raw.runtime_config !== 'object') raw.runtime_config = {};
    const before = getByPath(raw.runtime_config, candidate.path);
    setByPath(raw.runtime_config, candidate.path, candidate.suggested);
    writeFileSync(CONFIG_PATH, yaml.dump(raw, { lineWidth: 120, noRefs: true }), 'utf8');
    result.applied = {
      key: candidate.key,
      before,
      after: candidate.suggested,
    };
  }

  if (json) return result;
  return renderText(result);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeKisOverseasSelfTune(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-kis-overseas-self-tune 오류:',
  });
}
