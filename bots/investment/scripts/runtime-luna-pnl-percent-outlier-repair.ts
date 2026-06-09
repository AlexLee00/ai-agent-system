#!/usr/bin/env node
// @ts-nocheck
/**
 * One-off dry-run-gated repair for trade_journal.pnl_percent outliers.
 *
 * Source of truth: pnl_net stays immutable. Only pnl_percent can be repaired,
 * using pnl_net / abs(entry_value) * 100 when entry_value is available and
 * produces a normal-range percentage. Rows with polluted/missing basis are
 * reported as unrepairable instead of guessing.
 */

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query, run, close } from '../shared/db/core.ts';

const REQUIRED_CONFIRM = 'luna-pnl-percent-outlier-repair';
const DEFAULT_THRESHOLD = 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const getValue = (name, fallback = null) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
    return fallback;
  };
  return {
    json: argv.includes('--json'),
    write: argv.includes('--write'),
    confirm: getValue('--confirm'),
    market: getValue('--market', 'all'),
    limit: Math.max(1, Number(getValue('--limit', process.env.LUNA_PNL_PERCENT_REPAIR_LIMIT || '500')) || 500),
    threshold: Math.max(1, Number(getValue('--threshold', String(DEFAULT_THRESHOLD))) || DEFAULT_THRESHOLD),
  };
}

function safeNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundPnlPercent(value) {
  return Number(value.toFixed(4));
}

function calculateFromPnlNet(row, threshold = DEFAULT_THRESHOLD) {
  const pnlNet = safeNumber(row.pnl_net, null);
  const entryValue = Math.abs(safeNumber(row.entry_value, 0) || 0);
  if (pnlNet == null) return { ok: false, reason: 'missing_pnl_net' };
  if (!(entryValue > 0)) return { ok: false, reason: 'missing_entry_value' };
  const repaired = roundPnlPercent((pnlNet / entryValue) * 100);
  if (!Number.isFinite(repaired)) return { ok: false, reason: 'non_finite_repair' };
  if (Math.abs(repaired) > threshold) return { ok: false, reason: 'repair_still_outlier', repaired };
  return { ok: true, repaired };
}

async function fetchOutliers({ market, limit, threshold }) {
  const params = [threshold, limit];
  let marketClause = '';
  if (market && market !== 'all') {
    params.push(market);
    marketClause = `AND market = $${params.length}`;
  }
  return query(
    `SELECT
       id,
       trade_id,
       status,
       market,
       exchange,
       symbol,
       entry_value,
       exit_value,
       pnl_net,
       pnl_percent,
       exit_reason,
       exit_time
     FROM investment.trade_journal
     WHERE pnl_percent IS NOT NULL
       AND ABS(pnl_percent) > $1
       AND pnl_net IS NOT NULL
       AND (status = 'closed' OR exit_time IS NOT NULL)
       ${marketClause}
     ORDER BY ABS(pnl_percent) DESC, id DESC
     LIMIT $2::int`,
    params,
  );
}

async function repairRow(row, repaired) {
  return run(
    `UPDATE investment.trade_journal
        SET pnl_percent = $1
      WHERE id = $2
        AND pnl_net = $3
        AND pnl_percent = $4
        AND (status = 'closed' OR exit_time IS NOT NULL)`,
    [repaired, row.id, row.pnl_net, row.pnl_percent],
  );
}

export async function runPnlPercentOutlierRepair(options = {}) {
  const opts = {
    market: options.market || 'all',
    limit: Math.max(1, Number(options.limit || 500)),
    threshold: Math.max(1, Number(options.threshold || DEFAULT_THRESHOLD)),
    write: options.write === true,
    confirm: options.confirm || null,
  };
  const dryRun = opts.write !== true;
  if (opts.write && opts.confirm !== REQUIRED_CONFIRM) {
    return {
      ok: false,
      dryRun: false,
      applied: false,
      code: 'confirmation_required',
      requiredConfirm: REQUIRED_CONFIRM,
      options: opts,
    };
  }

  const rows = await fetchOutliers(opts);
  const summary = {
    ok: true,
    dryRun,
    applied: opts.write,
    market: opts.market,
    limit: opts.limit,
    threshold: opts.threshold,
    candidates: rows.length,
    repairable: 0,
    updated: 0,
    skipped: {
      missing_pnl_net: 0,
      missing_entry_value: 0,
      non_finite_repair: 0,
      repair_still_outlier: 0,
      stale_update_guard: 0,
    },
    samples: [],
  };

  for (const row of rows) {
    const result = calculateFromPnlNet(row, opts.threshold);
    if (!result.ok) {
      summary.skipped[result.reason] = Number(summary.skipped[result.reason] || 0) + 1;
      if (summary.samples.length < 10) {
        summary.samples.push({
          id: row.id,
          tradeId: row.trade_id,
          market: row.market,
          symbol: row.symbol,
          oldPnlPercent: Number(row.pnl_percent),
          attemptedPnlPercent: result.repaired ?? null,
          pnlNet: Number(row.pnl_net),
          entryValue: Number(row.entry_value),
          exitValue: Number(row.exit_value),
          skipped: result.reason,
        });
      }
      continue;
    }
    summary.repairable += 1;
    if (summary.samples.length < 10) {
      summary.samples.push({
        id: row.id,
        tradeId: row.trade_id,
        market: row.market,
        symbol: row.symbol,
        oldPnlPercent: Number(row.pnl_percent),
        repairedPnlPercent: result.repaired,
        pnlNet: Number(row.pnl_net),
        entryValue: Number(row.entry_value),
        exitValue: Number(row.exit_value),
      });
    }
    if (dryRun) continue;

    const update = await repairRow(row, result.repaired);
    const rowCount = Number(update?.rowCount || 0);
    if (rowCount === 1) summary.updated += 1;
    else summary.skipped.stale_update_guard += 1;
  }

  return summary;
}

async function main() {
  const args = parseArgs();
  const result = await runPnlPercentOutlierRepair(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) {
    console.log(
      `runtime-luna-pnl-percent-outlier-repair ${result.dryRun ? 'dry-run' : 'applied'} ` +
      `candidates=${result.candidates} repairable=${result.repairable} updated=${result.updated}`,
    );
  } else {
    console.log(`runtime-luna-pnl-percent-outlier-repair blocked code=${result.code || 'unknown'}`);
    process.exitCode = 1;
  }
  try { await close(); } catch {}
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-pnl-percent-outlier-repair 실패:' });
}
