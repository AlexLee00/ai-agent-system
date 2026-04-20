#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildRuntimeDecisionSummary } from './runtime-decision-summary.ts';
import { buildRuntimeBinanceFailurePressureReport } from './runtime-binance-failure-pressure-report.ts';
import { buildRuntimeBinanceCircuitBreakerReport } from './runtime-binance-circuit-breaker-report.ts';
import { buildRuntimeBinanceCapitalGuardReport } from './runtime-binance-capital-guard-report.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

async function loadQueueRows(days = 14) {
  const safeDays = Math.max(1, Number(days || 14));
  return db.query(`
    SELECT
      id,
      symbol,
      action,
      status,
      COALESCE(trade_mode, 'normal') AS trade_mode,
      confidence,
      amount_usdt,
      nemesis_verdict,
      block_code,
      block_reason,
      approved_at,
      created_at
    FROM investment.signals
    WHERE exchange = 'binance'
      AND status IN ('pending', 'approved')
      AND created_at > now() - INTERVAL '${safeDays} days'
    ORDER BY created_at DESC
    LIMIT 20
  `);
}

function toAgeMinutes(value) {
  const ts = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

function summarizeQueue(rows = []) {
  const pending = rows.filter((row) => row.status === 'pending');
  const approved = rows.filter((row) => row.status === 'approved');
  const stalePending = pending.filter((row) => toAgeMinutes(row.created_at) >= 30);
  const pendingWithoutNemesis = pending.filter((row) => !row.nemesis_verdict);
  const top = rows[0] || null;
  return {
    total: rows.length,
    pending: pending.length,
    approved: approved.length,
    stalePending: stalePending.length,
    pendingWithoutNemesis: pendingWithoutNemesis.length,
    top: top
      ? {
          id: top.id,
          symbol: top.symbol,
          status: top.status,
          tradeMode: top.trade_mode,
          ageMinutes: toAgeMinutes(top.approved_at || top.created_at),
          confidence: Number(top.confidence || 0),
          amountUsdt: Number(top.amount_usdt || 0),
          nemesisVerdict: top.nemesis_verdict || null,
        }
      : null,
  };
}

function buildDecision({ runtime, failure, circuit, capital, queueRows }) {
  const runtimeDecision = runtime?.decision || {};
  const runtimeMetrics = runtimeDecision.metrics || {};
  const failureMetrics = failure?.decision?.metrics || {};
  const circuitMetrics = circuit?.decision?.metrics || {};
  const capitalMetrics = capital?.decision?.metrics || {};
  const queue = summarizeQueue(queueRows);

  let status = 'crypto_execution_gate_ok';
  let headline = '암호화폐 실행 게이트는 비교적 안정적으로 보입니다.';
  const reasons = [
    `runtime: ${runtimeDecision.status || 'unknown'}`,
    `approved ${runtimeMetrics.approvedSignals || 0} / executed ${runtimeMetrics.executedSymbols || 0}`,
    `queue pending ${queue.pending} / approved ${queue.approved}`,
    `stale pending ${queue.stalePending} / nemesis missing ${queue.pendingWithoutNemesis}`,
    `failure pressure total ${failureMetrics.total || 0}`,
    `circuit ${circuitMetrics.total || 0} / capital_guard ${capitalMetrics.total || 0}`,
  ];
  const actionItems = [];

  if (queue.stalePending > 0 && queue.pendingWithoutNemesis > 0) {
    status = 'crypto_approval_gate_stale_pending';
    headline = '암호화폐 신호가 nemesis 승인 전 pending 상태로 오래 남아 실행 레인에 올라가지 못하고 있습니다.';
    actionItems.push('stale pending 신호가 왜 nemesis verdict 없이 남는지 먼저 확인합니다.');
  } else if ((runtimeMetrics.approvedSignals || 0) > 0 && (runtimeMetrics.executedSymbols || 0) === 0) {
    status = 'crypto_execution_gate_hold';
    headline = '승인 신호는 있으나 암호화폐 실행이 실제 체결로 이어지지 않고 있습니다.';
    actionItems.push('pending/approved 신호가 실제 실행 큐에 남아 있는지 먼저 확인합니다.');
  }

  if ((capitalMetrics.total || 0) >= (circuitMetrics.total || 0) && (capitalMetrics.total || 0) > 0) {
    actionItems.push('capital guard가 execution gate를 막는지 먼저 점검합니다.');
  } else if ((circuitMetrics.total || 0) > 0) {
    actionItems.push('circuit breaker 완화보다 최근 집중 심볼과 손실 연속 구간을 먼저 복기합니다.');
  }

  if (queue.approved > 0 || queue.pending > 0) {
    actionItems.push('승인 후 잔류 신호의 ageMinutes를 같이 보며 stale/pending 적체를 확인합니다.');
  }
  if (actionItems.length === 0) {
    actionItems.push('현재 execution gate 지표를 계속 누적하며 approved 대비 executed 추세를 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      approvedSignals: Number(runtimeMetrics.approvedSignals || 0),
      executedSymbols: Number(runtimeMetrics.executedSymbols || 0),
      pendingSignals: queue.pending,
      approvedQueue: queue.approved,
      stalePending: queue.stalePending,
      pendingWithoutNemesis: queue.pendingWithoutNemesis,
      failureTotal: Number(failureMetrics.total || 0),
      circuitBreaker: Number(circuitMetrics.total || 0),
      capitalGuard: Number(capitalMetrics.total || 0),
    },
    queue,
  };
}

function renderText(payload) {
  const queueTop = payload.decision.queue?.top;
  const lines = [
    '🪙 Runtime Crypto Execution Gate',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '큐 상태:',
    `- pending: ${payload.decision.metrics.pendingSignals}`,
    `- approved: ${payload.decision.metrics.approvedQueue}`,
    `- stale pending: ${payload.decision.metrics.stalePending}`,
    `- pending without nemesis: ${payload.decision.metrics.pendingWithoutNemesis}`,
    ...(queueTop
      ? [`- latest: ${queueTop.symbol} | ${queueTop.status} | ${queueTop.tradeMode} | age=${queueTop.ageMinutes}m | conf=${queueTop.confidence} | nemesis=${queueTop.nemesisVerdict || 'none'}`]
      : ['- latest: 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  if (decision.status === 'crypto_approval_gate_stale_pending') {
    return '암호화폐는 실행 레인보다 앞단에서 pending 적체가 보이며, nemesis 승인 누락과 stale queue를 먼저 확인하는 편이 좋습니다.';
  }
  if (decision.status === 'crypto_execution_gate_hold') {
    return '암호화폐는 승인 신호가 있지만 실행이 0이라, pending/approved 잔류와 capital/circuit 축을 함께 보는 편이 좋습니다.';
  }
  return '암호화폐 실행 게이트는 비교적 안정적이며 approved 대비 executed 추세를 계속 누적하면 됩니다.';
}

export async function buildRuntimeCryptoExecutionGateReport({ days = 14, json = false } = {}) {
  const [runtime, failure, circuit, capital, queueRows] = await Promise.all([
    buildRuntimeDecisionSummary({ market: 'crypto', limit: 5, json: true }).catch(() => null),
    buildRuntimeBinanceFailurePressureReport({ days, json: true }).catch(() => null),
    buildRuntimeBinanceCircuitBreakerReport({ days, json: true }).catch(() => null),
    buildRuntimeBinanceCapitalGuardReport({ days, json: true }).catch(() => null),
    loadQueueRows(days).catch(() => []),
  ]);

  const decision = buildDecision({ runtime, failure, circuit, capital, queueRows });
  const payload = {
    ok: true,
    days,
    runtime,
    failure,
    circuit,
    capital,
    queueRows,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-crypto-execution-gate-report',
    requestType: 'runtime-crypto-execution-gate-report',
    title: '투자 암호화폐 execution gate 리포트 요약',
    data: {
      days,
      decision,
      runtimeDecision: runtime?.decision,
      failureDecision: failure?.decision,
      circuitDecision: circuit?.decision,
      capitalDecision: capital?.decision,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeCryptoExecutionGateReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-crypto-execution-gate-report 오류:',
  });
}
