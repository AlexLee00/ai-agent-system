#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    onlyFamilyBias: argv.includes('--family-bias-only'),
    limit: Math.max(1, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=').slice(1).join('=') || 2000)),
  };
}

function pickIncidentLink(row = {}, onlyFamilyBias = false) {
  const candidates = [
    row.signal_incident_link,
    row.trade_incident_link,
  ].map((item) => String(item || '').trim()).filter(Boolean);
  const picked = candidates.find((item) => !onlyFamilyBias || item.includes('family_bias='));
  return picked || null;
}

function pickExecutionOrigin(row = {}) {
  return row.signal_execution_origin || row.trade_execution_origin || null;
}

function pickQualityFlag(row = {}) {
  return row.signal_quality_flag || row.trade_quality_flag || null;
}

function pickExcludeFromLearning(row = {}) {
  if (row.signal_exclude_from_learning != null) return Boolean(row.signal_exclude_from_learning);
  if (row.trade_exclude_from_learning != null) return Boolean(row.trade_exclude_from_learning);
  return null;
}

function renderText(payload) {
  const lines = [
    '🧷 Trade Incident Link Backfill',
    `scanned: ${payload.scanned}`,
    `updated: ${payload.updated}`,
    `unresolved: ${payload.unresolved}`,
    `dryRun: ${payload.dryRun}`,
  ];
  if (payload.samples.length) {
    lines.push('');
    lines.push('samples:');
    for (const sample of payload.samples) {
      lines.push(`- ${sample.tradeId} ${sample.exchange}/${sample.symbol} <- ${sample.incidentLink}`);
    }
  }
  return lines.join('\n');
}

export async function backfillTradeIncidentLinks({ dryRun = false, json = false, onlyFamilyBias = false, limit = 2000 } = {}) {
  await db.initSchema();
  await journalDb.initJournalSchema();

  const rows = await db.query(
    `SELECT
       j.trade_id,
       j.signal_id,
       j.symbol,
       j.exchange,
       j.trade_mode,
       j.incident_link AS journal_incident_link,
       j.execution_origin AS journal_execution_origin,
       j.quality_flag AS journal_quality_flag,
       j.exclude_from_learning AS journal_exclude_from_learning,
       s.incident_link AS signal_incident_link,
       s.execution_origin AS signal_execution_origin,
       s.quality_flag AS signal_quality_flag,
       s.exclude_from_learning AS signal_exclude_from_learning,
       t.incident_link AS trade_incident_link,
       t.execution_origin AS trade_execution_origin,
       t.quality_flag AS trade_quality_flag,
       t.exclude_from_learning AS trade_exclude_from_learning
     FROM investment.trade_journal j
     LEFT JOIN investment.signals s ON s.id = j.signal_id
     LEFT JOIN LATERAL (
       SELECT incident_link, execution_origin, quality_flag, exclude_from_learning
       FROM investment.trades t
       WHERE t.signal_id = j.signal_id
          OR (
            j.signal_id IS NULL
            AND t.symbol = j.symbol
            AND t.exchange = j.exchange
            AND COALESCE(t.trade_mode, 'normal') = COALESCE(j.trade_mode, 'normal')
            AND ABS(EXTRACT(EPOCH FROM (t.executed_at - to_timestamp(j.created_at / 1000.0)))) < 86400
          )
       ORDER BY executed_at DESC
       LIMIT 1
     ) t ON true
     WHERE COALESCE(j.incident_link, '') = ''
       AND (
         COALESCE(s.incident_link, '') <> ''
         OR COALESCE(t.incident_link, '') <> ''
       )
     ORDER BY j.created_at DESC
     LIMIT $1`,
    [limit],
  );

  let updated = 0;
  let unresolved = 0;
  const samples = [];

  for (const row of rows) {
    const incidentLink = pickIncidentLink(row, onlyFamilyBias);
    if (!incidentLink) {
      unresolved += 1;
      continue;
    }
    const executionOrigin = pickExecutionOrigin(row);
    const qualityFlag = pickQualityFlag(row);
    const excludeFromLearning = pickExcludeFromLearning(row);

    if (!dryRun) {
      await db.run(
        `UPDATE investment.trade_journal
         SET incident_link = COALESCE(NULLIF(incident_link, ''), $1),
             execution_origin = COALESCE(NULLIF(execution_origin, ''), $2, execution_origin),
             quality_flag = COALESCE(NULLIF(quality_flag, ''), $3, quality_flag),
             exclude_from_learning = COALESCE($4, exclude_from_learning)
         WHERE trade_id = $5`,
        [
          incidentLink,
          executionOrigin,
          qualityFlag,
          excludeFromLearning,
          row.trade_id,
        ],
      );
    }

    updated += 1;
    if (samples.length < 12) {
      samples.push({
        tradeId: row.trade_id,
        signalId: row.signal_id,
        symbol: row.symbol,
        exchange: row.exchange,
        tradeMode: row.trade_mode || 'normal',
        incidentLink,
      });
    }
  }

  const payload = {
    ok: true,
    scanned: rows.length,
    updated,
    unresolved,
    dryRun,
    onlyFamilyBias,
    samples,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await backfillTradeIncidentLinks(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ trade incident link backfill 실패:',
  });
}
