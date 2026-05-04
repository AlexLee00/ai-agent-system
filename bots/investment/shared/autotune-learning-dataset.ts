// @ts-nocheck
import { LUNA_AUTONOMY_PHASES } from './autonomy-phase.ts';
import { safeJournalPnlPercent } from './trade-journal-db.ts';

function normalizePhase(value = null) {
  const phase = String(value || '').trim();
  return phase || LUNA_AUTONOMY_PHASES.L4_PRE_AUTOTUNE;
}

function isClosed(row = {}) {
  return row.status === 'closed' || row.exit_time != null || row.exitTime != null;
}

export function buildAutotuneLearningDataset(rows = []) {
  const phaseCounts = {};
  const learningRows = [];
  let skipped = 0;
  let preAutotuneIncluded = 0;

  for (const row of rows || []) {
    const phase = normalizePhase(row.autonomy_phase ?? row.autonomyPhase);
    phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;

    if (!isClosed(row)) {
      skipped += 1;
      continue;
    }

    const pnlPercent = safeJournalPnlPercent({
      entryPrice: row.entry_price ?? row.entryPrice,
      exitPrice: row.exit_price ?? row.exitPrice,
      entryValue: row.entry_value ?? row.entryValue,
      exitValue: row.exit_value ?? row.exitValue,
      direction: row.direction,
      pnlPercent: row.pnl_percent ?? row.pnlPercent,
    });
    if (pnlPercent == null) {
      skipped += 1;
      continue;
    }

    if (phase === LUNA_AUTONOMY_PHASES.L4_PRE_AUTOTUNE) preAutotuneIncluded += 1;
    learningRows.push({
      tradeId: row.trade_id ?? row.tradeId ?? row.id,
      symbol: row.symbol,
      market: row.market,
      exchange: row.exchange,
      strategyFamily: row.strategy_family ?? row.strategyFamily ?? 'unknown',
      marketRegime: row.market_regime ?? row.marketRegime ?? 'unknown',
      autonomyPhase: phase,
      pnlPercent,
      win: pnlPercent > 0,
      source: phase === LUNA_AUTONOMY_PHASES.L4_PRE_AUTOTUNE ? 'pre_autotune' : 'post_autotune',
    });
  }

  return {
    ok: true,
    totalRows: rows.length,
    learningRows: learningRows.length,
    skipped,
    preAutotuneIncluded,
    phaseCounts,
    dataset: learningRows,
    contract: {
      includesPreAutotune: true,
      defaultPhase: LUNA_AUTONOMY_PHASES.L4_PRE_AUTOTUNE,
      safePnlRequired: true,
    },
  };
}

export default {
  buildAutotuneLearningDataset,
};
