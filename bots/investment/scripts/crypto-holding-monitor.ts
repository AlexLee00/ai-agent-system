#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/crypto-holding-monitor.ts
 *
 * 목적:
 *   - Binance(crypto) / KIS Overseas 포지션 중 보유일 초과 방치 포지션 탐지
 *   - 기술적 재평가(position-reevaluator) 후 SELL 권고 시 청산 신호 생성
 *   - Hard cap 초과 시 재평가 없이 강제 청산
 *   - launchd로 6시간마다 실행 (24/7 크립토 대응)
 *
 * 게이트 (기본: shadow/dry_run):
 *   LUNA_CRYPTO_STALE_SWEEP_ENABLED=false → dry_run만 (기본값)
 *   LUNA_CRYPTO_MAX_HOLD_DAYS=14     (binance 소프트 캡)
 *   LUNA_OVERSEAS_MAX_HOLD_DAYS=10   (kis_overseas 소프트 캡)
 *   LUNA_CRYPTO_HARD_MAX_HOLD_DAYS=30 (하드 캡, 재평가 없이 강제 청산)
 *
 * 실행:
 *   node bots/investment/scripts/crypto-holding-monitor.ts
 *   node bots/investment/scripts/crypto-holding-monitor.ts --dry-run
 *   node bots/investment/scripts/crypto-holding-monitor.ts --json
 */

import * as db from '../shared/db.ts';
import { runCliMain } from '../shared/cli-runtime.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';
import { recordGuardEvent } from '../shared/guard-event-recorder.ts';
import { executeSignal as executeBinanceSignal } from '../team/hephaestos.ts';
import { executeSignal as executeOverseasSignal } from '../team/hanul.ts';

const CRYPTO_SOFT_CAP_DAYS = Number(process.env.LUNA_CRYPTO_MAX_HOLD_DAYS ?? 14);
const OVERSEAS_SOFT_CAP_DAYS = Number(process.env.LUNA_OVERSEAS_MAX_HOLD_DAYS ?? 10);
const HARD_CAP_DAYS = Number(process.env.LUNA_CRYPTO_HARD_MAX_HOLD_DAYS ?? 30);
const SWEEP_ENABLED = process.env.LUNA_CRYPTO_STALE_SWEEP_ENABLED === 'true';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    dryRun: argv.includes('--dry-run') || !SWEEP_ENABLED,
    json: argv.includes('--json'),
  };
}

function calcHeldDays(entryTimeMs) {
  if (!entryTimeMs) return 0;
  return (Date.now() - Number(entryTimeMs)) / 86400000;
}

function calcPositionValue(pos) {
  return Number(pos.amount ?? 0) * Number(pos.avg_price ?? 0);
}

function getSoftCapDays(exchange) {
  return String(exchange).startsWith('kis_overseas') ? OVERSEAS_SOFT_CAP_DAYS : CRYPTO_SOFT_CAP_DAYS;
}

function getExecuteSignalFn(exchange) {
  return String(exchange).startsWith('kis_overseas') ? executeOverseasSignal : executeBinanceSignal;
}

async function identifyStaleCandidates() {
  const [cryptoResult, overseasResult] = await Promise.allSettled([
    db.getOpenPositions('binance', false, 'normal'),
    db.getOpenPositions('kis_overseas', false, 'normal'),
  ]);

  const allPositions = [
    ...(cryptoResult.status === 'fulfilled' ? (cryptoResult.value ?? []) : []),
    ...(overseasResult.status === 'fulfilled' ? (overseasResult.value ?? []) : []),
  ];

  const candidates = [];
  for (const pos of allPositions) {
    const heldDays = calcHeldDays(pos.entry_time);
    const softCap = getSoftCapDays(pos.exchange);
    if (heldDays >= softCap) {
      candidates.push({
        symbol: pos.symbol,
        exchange: pos.exchange,
        heldDays,
        positionValue: calcPositionValue(pos),
        tradeMode: pos.trade_mode ?? 'normal',
        amount: Number(pos.amount ?? 0),
        avgPrice: Number(pos.avg_price ?? 0),
        isHardCap: heldDays >= HARD_CAP_DAYS,
        softCapDays: softCap,
      });
    }
  }

  return candidates;
}

async function createStaleExitSignal(candidate, reasoning) {
  const signalId = await db.insertSignal({
    symbol: candidate.symbol,
    action: 'SELL',
    amountUsdt: candidate.positionValue,
    confidence: 1,
    reasoning,
    exchange: candidate.exchange,
    tradeMode: candidate.tradeMode,
    nemesisVerdict: 'approved',
    approvedAt: new Date().toISOString(),
    executionOrigin: 'stale_holding_sweep',
    qualityFlag: 'exclude_from_learning',
    excludeFromLearning: true,
    incidentLink: 'crypto_holding_stale_sweep',
  });
  const signal = await db.getSignalById(signalId);
  return {
    ...signal,
    exchange: candidate.exchange,
    trade_mode: candidate.tradeMode,
    exit_reason_override: 'stale_holding_sweep',
  };
}

async function runTechnicalReevaluation(candidate) {
  try {
    const revalResults = await reevaluateOpenPositions({
      exchange: candidate.exchange,
      symbol: candidate.symbol,
      paper: false,
      persist: false,
      liveIndicators: true,
      eventSource: 'stale_holding_sweep',
    });
    const item = Array.isArray(revalResults)
      ? revalResults.find((r) => String(r.symbol).toUpperCase() === String(candidate.symbol).toUpperCase())
      : null;
    return {
      recommendation: item?.recommendation ?? null,
      reason: item?.reason ?? item?.reasonCode ?? '재평가 결과 없음',
    };
  } catch (err) {
    return { recommendation: null, reason: `재평가 오류: ${err.message}` };
  }
}

async function main() {
  const options = parseArgs();
  const prefix = options.dryRun ? '[크립토보유모니터][DRY-RUN]' : '[크립토보유모니터]';

  if (options.dryRun && !process.argv.includes('--dry-run')) {
    console.log(`${prefix} LUNA_CRYPTO_STALE_SWEEP_ENABLED=false — shadow 모드 (실제 청산 없음)`);
  }

  const candidates = await identifyStaleCandidates();

  if (candidates.length === 0) {
    const msg = `${prefix} 방치 포지션 없음 (binance≥${CRYPTO_SOFT_CAP_DAYS}일, overseas≥${OVERSEAS_SOFT_CAP_DAYS}일)`;
    if (options.json) {
      console.log(JSON.stringify({ sweepEnabled: SWEEP_ENABLED, processed: 0, candidates: [] }));
    } else {
      console.log(msg);
    }
    return;
  }

  console.log(`${prefix} 방치 후보 ${candidates.length}건 탐지`);

  const results = [];

  for (const candidate of candidates) {
    const dayStr = candidate.heldDays.toFixed(1);

    // ─── Hard cap: 재평가 없이 강제 청산 ────────────────────────
    if (candidate.isHardCap) {
      const reasoning = `방치 포지션 hard cap 초과 (${dayStr}일 ≥ ${HARD_CAP_DAYS}일) — 강제 청산`;
      console.log(`${prefix} ${candidate.symbol} ${dayStr}일 hard cap → 강제 청산`);

      if (!options.dryRun) {
        try {
          const signal = await createStaleExitSignal(candidate, reasoning);
          const execResult = await getExecuteSignalFn(candidate.exchange)(signal);
          console.log(`  ✅ 청산 완료: ${candidate.symbol}`);
          results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'executed', capType: 'hard', execResult });
        } catch (err) {
          console.error(`  ❌ 청산 실패: ${candidate.symbol} — ${err.message}`);
          results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'error', capType: 'hard', error: err.message });
        }
      } else {
        results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'dry_run', capType: 'hard' });
      }
      continue;
    }

    // ─── Soft cap: 기술적 재평가 후 결정 ────────────────────────
    const reval = await runTechnicalReevaluation(candidate);
    const recommendation = reval.recommendation;
    const revalReason = reval.reason;

    const shouldSell = !recommendation || recommendation === 'SELL' || recommendation === 'ADJUST';
    const reasoning = `방치 포지션 soft cap 초과 (${dayStr}일 ≥ ${candidate.softCapDays}일), 재평가=${recommendation ?? 'null'}: ${revalReason}`;

    if (shouldSell) {
      console.log(`${prefix} ${candidate.symbol} ${dayStr}일 soft cap, 재평가=${recommendation ?? 'null'} → 청산`);

      if (!options.dryRun) {
        try {
          const signal = await createStaleExitSignal(candidate, reasoning);
          const execResult = await getExecuteSignalFn(candidate.exchange)(signal);
          console.log(`  ✅ 청산 완료: ${candidate.symbol}`);
          results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'executed', capType: 'soft', recommendation, execResult });
        } catch (err) {
          console.error(`  ❌ 청산 실패: ${candidate.symbol} — ${err.message}`);
          results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'error', capType: 'soft', error: err.message });
        }
      } else {
        results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'dry_run', capType: 'soft', recommendation, revalReason });
      }
    } else {
      // HOLD — 보유 연장, guard_events에 사유 기록
      console.log(`${prefix} ${candidate.symbol} ${dayStr}일 soft cap, 재평가=${recommendation} → 보유 연장 (${revalReason})`);
      recordGuardEvent({
        guardName: 'stale_holding_sweep',
        symbol: candidate.symbol,
        exchange: candidate.exchange,
        reason: reasoning,
        severity: 'info',
        decisionBefore: { heldDays: candidate.heldDays, softCapDays: candidate.softCapDays, action: 'SELL_CANDIDATE' },
        decisionAfter: { action: 'HOLD_EXTENDED', recommendation, revalReason },
        guardMetadata: { capType: 'soft', hardCapDays: HARD_CAP_DAYS },
      });
      results.push({ symbol: candidate.symbol, heldDays: candidate.heldDays, status: 'held', capType: 'soft', recommendation, revalReason });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ sweepEnabled: SWEEP_ENABLED, processed: results.length, results }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCliMain(main);
}

export { parseArgs, main };
