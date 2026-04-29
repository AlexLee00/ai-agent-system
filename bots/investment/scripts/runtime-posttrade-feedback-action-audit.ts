#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysRaw = argv.find((arg) => arg.startsWith('--days='))?.split('=')[1];
  return {
    days: Math.max(1, Number(daysRaw || 30) || 30),
    strict: argv.includes('--strict'),
    json: argv.includes('--json'),
  };
}

function normalizeSuggestions(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function extractSourceTradeIds(suggestion = {}) {
  if (Array.isArray(suggestion.source_trade_ids)) {
    return suggestion.source_trade_ids.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  }
  const one = Number(suggestion.source_trade_id);
  return Number.isFinite(one) && one > 0 ? [one] : [];
}

export async function buildPosttradeFeedbackActionAudit({ days = 30, strict = false } = {}) {
  await db.initSchema();
  const rows = await db.query(
    `SELECT id, suggestions, applied_at
       FROM runtime_config_suggestion_log
      WHERE review_status = 'applied'
        AND applied_at >= NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY applied_at DESC
      LIMIT 100`,
    [Math.max(1, Number(days || 30))],
  ).catch(() => []);

  const expected = [];
  for (const row of rows || []) {
    for (const suggestion of normalizeSuggestions(row.suggestions)) {
      if (String(suggestion?.action || '') !== 'adjust') continue;
      const parameterName = String(suggestion?.key || '').trim();
      if (!parameterName) continue;
      for (const sourceTradeId of extractSourceTradeIds(suggestion)) {
        expected.push({
          suggestionLogId: row.id,
          sourceTradeId,
          parameterName,
        });
      }
    }
  }

  const missing = [];
  for (const item of expected) {
    const exists = await db.get(
      `SELECT id
         FROM feedback_to_action_map
        WHERE suggestion_log_id = $1
          AND source_trade_id = $2
          AND parameter_name = $3
        LIMIT 1`,
      [item.suggestionLogId, item.sourceTradeId, item.parameterName],
    ).catch(() => null);
    if (!exists?.id) missing.push(item);
  }

  return {
    ok: missing.length === 0,
    strict,
    days,
    appliedSuggestionLogs: rows.length,
    expectedMappings: expected.length,
    missingMappings: missing,
    status: missing.length === 0
      ? 'feedback_to_action_audit_clear'
      : 'feedback_to_action_audit_missing_mappings',
  };
}

async function main() {
  const args = parseArgs();
  const result = await buildPosttradeFeedbackActionAudit(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.status} — expected=${result.expectedMappings} missing=${result.missingMappings.length}`);
  }
  if (args.strict && result.ok !== true) {
    throw new Error(result.status);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-action-audit 실패:',
  });
}

