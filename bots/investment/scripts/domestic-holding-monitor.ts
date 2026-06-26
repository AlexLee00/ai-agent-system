#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/domestic-holding-monitor.ts
 *
 * 목적:
 *   - KIS 국내장 포지션 중 24h 초과 보유된 손실 포지션을 자동 청산
 *   - launchd로 30분마다 실행 (장중에만 실행)
 *   - exit_reason: 'domestic_holding_limit_24h'
 *   - LUNA_DOMESTIC_HOLDING_SWEEP_ENABLED=true일 때만 실제 청산
 *
 * 실행:
 *   node bots/investment/scripts/domestic-holding-monitor.ts
 *   node bots/investment/scripts/domestic-holding-monitor.ts --dry-run
 */

import * as db from '../shared/db.ts';
import { runCliMain } from '../shared/cli-runtime.ts';
import { getKisMarketStatus } from '../shared/secrets.ts';
import { enforceDomesticHoldingLimit } from '../shared/luna-portfolio-decision-guards.ts';
import { executeSignal as executeDomesticSignal } from '../team/hanul.ts';

const MAX_HOLD_HOURS = 24;
const SWEEP_ENABLED = process.env.LUNA_DOMESTIC_HOLDING_SWEEP_ENABLED === 'true';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run') || !SWEEP_ENABLED,
    json: argv.includes('--json'),
  };
}

async function createDomesticHoldingExitSignal(candidate) {
  const signalId = await db.insertSignal({
    symbol: candidate.symbol,
    action: 'SELL',
    amountUsdt: candidate.positionValue,
    confidence: 1,
    reasoning: `국내장 ${candidate.heldHours.toFixed(1)}h 보유 초과 자동 청산 (${MAX_HOLD_HOURS}h 제한)`,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode || 'normal',
    nemesisVerdict: 'approved',
    approvedAt: new Date().toISOString(),
    executionOrigin: 'domestic_holding_monitor',
    qualityFlag: 'exclude_from_learning',
    excludeFromLearning: true,
    incidentLink: 'domestic_holding_limit_24h',
  });

  const signal = await db.getSignalById(signalId);
  return {
    ...signal,
    exchange: candidate.exchange,
    trade_mode: candidate.tradeMode || 'normal',
    exit_reason_override: 'domestic_holding_limit_24h',
  };
}

export async function hasPendingOrApprovedSellSignal(candidate, queryFn = db.query) {
  const rows = await queryFn(
    `SELECT id
       FROM signals
      WHERE symbol = $1
        AND action = 'SELL'
        AND exchange = $2
        AND COALESCE(trade_mode, 'normal') = $3
        AND status IN ('pending', 'approved')
      ORDER BY created_at DESC
      LIMIT 1`,
    [candidate.symbol, candidate.exchange, candidate.tradeMode || 'normal'],
  ).catch(() => []);
  return rows?.[0] || null;
}

async function main() {
  const options = parseArgs();
  const prefix = options.dryRun ? '[국내보유모니터][DRY-RUN]' : '[국내보유모니터]';

  if (options.dryRun && !process.argv.includes('--dry-run')) {
    console.log(`${prefix} LUNA_DOMESTIC_HOLDING_SWEEP_ENABLED=false — shadow 모드 (실제 청산 없음)`);
  }

  const marketStatus = await getKisMarketStatus().catch(() => ({ isOpen: false, reason: '상태 조회 실패' }));
  if (!marketStatus.isOpen) {
    const msg = `${prefix} 장외/휴장 (${marketStatus.reason}) — 스킵`;
    if (options.json) {
      console.log(JSON.stringify({ skipped: true, reason: marketStatus.reason, dryRun: options.dryRun, sweepEnabled: SWEEP_ENABLED }));
    } else {
      console.log(msg);
    }
    return;
  }

  const openPositions = await db.getOpenPositions('kis', false, 'normal').catch(() => []);
  const candidates = enforceDomesticHoldingLimit(openPositions, MAX_HOLD_HOURS);

  if (candidates.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ processed: 0, candidates: [], dryRun: options.dryRun, sweepEnabled: SWEEP_ENABLED }));
    } else {
      console.log(`${prefix} 24h 초과 포지션 없음`);
    }
    return;
  }

  const results = [];
  for (const candidate of candidates) {
    const logLine = `[국내보유모니터] ${candidate.symbol} ${candidate.heldHours.toFixed(1)}h 보유 → 자동 청산 대상`;
    const duplicateSell = await hasPendingOrApprovedSellSignal(candidate);
    if (duplicateSell) {
      console.log(`${prefix} ${candidate.symbol} 기존 SELL 신호(${duplicateSell.id}) 존재 — safety net 스킵`);
      results.push({ symbol: candidate.symbol, heldHours: candidate.heldHours, status: 'skipped_duplicate_sell', signalId: duplicateSell.id });
      continue;
    }
    if (options.dryRun) {
      console.log(`[DRY-RUN] ${logLine}`);
      results.push({ symbol: candidate.symbol, heldHours: candidate.heldHours, status: 'dry_run' });
      continue;
    }

    console.log(logLine);
    try {
      const signal = await createDomesticHoldingExitSignal(candidate);
      const execResult = await executeDomesticSignal(signal);
      console.log(`  ✅ 청산 완료: ${candidate.symbol} (${JSON.stringify(execResult?.status || 'ok')})`);
      results.push({ symbol: candidate.symbol, heldHours: candidate.heldHours, status: 'executed', execResult });
    } catch (err) {
      console.error(`  ❌ 청산 실패: ${candidate.symbol} — ${err.message}`);
      results.push({ symbol: candidate.symbol, heldHours: candidate.heldHours, status: 'error', error: err.message });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ processed: results.length, results, dryRun: options.dryRun, sweepEnabled: SWEEP_ENABLED }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCliMain({ run: main });
}

export { parseArgs, main };
