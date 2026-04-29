#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(INVESTMENT_DIR, 'output', 'ops', 'posttrade-feedback-action-staging.json');

function parseArgs(argv = process.argv.slice(2)) {
  const daysRaw = argv.find((arg) => arg.startsWith('--days='))?.split('=')[1];
  const limitRaw = argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  const output = argv.find((arg) => arg.startsWith('--output='))?.split('=')[1] || DEFAULT_OUTPUT;
  return {
    json: argv.includes('--json'),
    write: argv.includes('--write'),
    days: Math.max(1, Number(daysRaw || 30) || 30),
    limit: Math.max(1, Number(limitRaw || 50) || 50),
    output,
  };
}

function normalizeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function isSafeRuntimeParameter(name: string) {
  const key = String(name || '').trim();
  if (!key) return false;
  if (!key.startsWith('runtime_config.')) return false;
  return !/(secret|token|password|private|credential|oauth|api[_-]?key)/i.test(key);
}

export async function buildPosttradeFeedbackActionStaging(input = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  await db.initSchema();
  const rows = await db.getRecentFeedbackToActionMap({ days: args.days, limit: args.limit });
  const patches = [];
  const rejected = [];

  for (const row of rows || []) {
    const parameterName = String(row.parameter_name || '').trim();
    const item = {
      feedbackMapId: row.id,
      sourceTradeId: row.source_trade_id || null,
      parameterName,
      oldValue: normalizeJson(row.old_value),
      newValue: normalizeJson(row.new_value),
      reason: row.reason || null,
      appliedAt: row.applied_at || null,
    };
    if (!isSafeRuntimeParameter(parameterName)) {
      rejected.push({ ...item, rejectReason: 'unsafe_or_non_runtime_parameter' });
      continue;
    }
    patches.push({
      op: 'replace',
      path: `/${parameterName.replace(/^runtime_config\./, '').replace(/\./g, '/')}`,
      value: item.newValue,
      meta: item,
    });
  }

  const result = {
    ok: true,
    status: 'posttrade_feedback_action_staged',
    generatedAt: new Date().toISOString(),
    days: args.days,
    scannedRows: rows.length,
    patchCount: patches.length,
    rejectedCount: rejected.length,
    requiresApproval: patches.length > 0,
    output: args.write ? args.output : null,
    patches,
    rejected,
  };

  if (args.write) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

async function main() {
  const args = parseArgs();
  const result = await buildPosttradeFeedbackActionStaging(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status} — patches=${result.patchCount} rejected=${result.rejectedCount}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-action-staging 실패:',
  });
}
