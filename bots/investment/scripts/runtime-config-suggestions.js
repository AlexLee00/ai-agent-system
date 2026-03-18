#!/usr/bin/env node
/**
 * scripts/runtime-config-suggestions.js
 *
 * 최근 자동매매 운영 데이터를 바탕으로 runtime_config 변경 후보를 제안한다.
 * 실제 값을 자동 변경하지 않고, current -> suggested / 근거 / confidence 만 출력한다.
 */

import * as db from '../shared/db.js';
import { getInvestmentRuntimeConfig } from '../shared/runtime-config.js';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = Math.max(7, Number(daysArg?.split('=')[1] || 14));
  return { days, json: argv.includes('--json') };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toCount(rows, predicate) {
  return rows.filter(predicate).reduce((sum, row) => sum + Number(row.cnt || 0), 0);
}

async function loadSignalRows(fromDate, toDate) {
  return db.query(`
    SELECT
      exchange,
      action,
      status,
      COUNT(*) AS cnt
    FROM signals
    WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
    GROUP BY exchange, action, status
    ORDER BY exchange, action, status
  `);
}

async function loadBlockCodeRows(fromDate, toDate) {
  return db.query(`
    SELECT
      exchange,
      COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
      COUNT(*) AS cnt
    FROM signals
    WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
      AND status IN ('failed', 'rejected', 'expired')
    GROUP BY exchange, 2
    ORDER BY exchange, cnt DESC
  `);
}

async function loadAnalysisRows(fromDate, toDate) {
  return db.query(`
    SELECT
      exchange,
      analyst,
      signal,
      COUNT(*) AS cnt
    FROM analysis
    WHERE CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) BETWEEN '${fromDate}' AND '${toDate}'
    GROUP BY exchange, analyst, signal
    ORDER BY exchange, analyst, signal
  `);
}

function buildDateRange(days) {
  const to = new Date();
  const from = new Date(Date.now() - (days - 1) * 86400000);
  const toDate = to.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const fromDate = from.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return { fromDate, toDate };
}

function summarizeExchange(signalRows, blockRows, analysisRows, exchange) {
  const exchangeSignals = signalRows.filter(row => row.exchange === exchange);
  const exchangeBlocks = blockRows.filter(row => row.exchange === exchange);
  const exchangeAnalysis = analysisRows.filter(row => row.exchange === exchange);
  const totalBuy = toCount(exchangeSignals, row => row.action === 'BUY');
  const executed = toCount(exchangeSignals, row => row.status === 'executed');
  const failed = toCount(exchangeSignals, row => ['failed', 'rejected', 'expired'].includes(row.status));
  const topBlocks = exchangeBlocks
    .map(row => ({ code: row.block_code, count: Number(row.cnt || 0) }))
    .sort((a, b) => b.count - a.count);
  const taTotal = toCount(exchangeAnalysis, row => row.analyst === 'ta_mtf');
  const taHold = toCount(exchangeAnalysis, row => row.analyst === 'ta_mtf' && row.signal === 'HOLD');
  const sentimentTotal = toCount(exchangeAnalysis, row => row.analyst === 'sentiment');
  const sentimentHold = toCount(exchangeAnalysis, row => row.analyst === 'sentiment' && row.signal === 'HOLD');

  return {
    exchange,
    totalBuy,
    executed,
    failed,
    executionRate: totalBuy > 0 ? round((executed / totalBuy) * 100, 1) : 0,
    failureRate: totalBuy > 0 ? round((failed / totalBuy) * 100, 1) : 0,
    topBlocks,
    taHoldRate: taTotal > 0 ? round((taHold / taTotal) * 100, 1) : null,
    sentimentHoldRate: sentimentTotal > 0 ? round((sentimentHold / sentimentTotal) * 100, 1) : null,
  };
}

function buildSuggestions(config, summaries) {
  const suggestions = [];
  const crypto = summaries.binance;
  const domestic = summaries.kis;
  const overseas = summaries.kis_overseas;

  if (crypto.totalBuy >= 3 && crypto.executed === 0 && crypto.failed >= 3) {
    suggestions.push({
      key: 'runtime_config.luna.fastPathThresholds.minCryptoConfidence',
      current: config.luna.fastPathThresholds.minCryptoConfidence,
      suggested: round(clamp(config.luna.fastPathThresholds.minCryptoConfidence - 0.04, 0.42, 0.70), 2),
      action: 'adjust',
      confidence: 'medium',
      reason: `최근 ${crypto.totalBuy}건 BUY 중 실행 0건, 실패 ${crypto.failed}건으로 암호화폐 fast-path가 과도하게 보수적일 가능성이 있습니다.`,
    });
    suggestions.push({
      key: 'runtime_config.luna.debateThresholds.crypto.minAverageConfidence',
      current: config.luna.debateThresholds.crypto.minAverageConfidence,
      suggested: round(clamp(config.luna.debateThresholds.crypto.minAverageConfidence - 0.04, 0.50, 0.70), 2),
      action: 'adjust',
      confidence: 'medium',
      reason: `암호화폐 실행 전환이 0%라 debate 승격 기준을 소폭 완화해 비교할 가치가 있습니다.`,
    });
    suggestions.push({
      key: 'runtime_config.luna.debateThresholds.crypto.minAbsScore',
      current: config.luna.debateThresholds.crypto.minAbsScore,
      suggested: round(clamp(config.luna.debateThresholds.crypto.minAbsScore - 0.03, 0.15, 0.40), 2),
      action: 'adjust',
      confidence: 'low',
      reason: `암호화폐 신호가 BUY로 저장되더라도 실행으로 이어지지 않아 절대 점수 기준을 조금 완화해볼 후보입니다.`,
    });
  } else {
    suggestions.push({
      key: 'runtime_config.luna.fastPathThresholds.minCryptoConfidence',
      current: config.luna.fastPathThresholds.minCryptoConfidence,
      suggested: config.luna.fastPathThresholds.minCryptoConfidence,
      action: 'hold',
      confidence: 'medium',
      reason: '암호화폐 실행/실패 표본이 설정 조정까지 판단하기엔 아직 충분하지 않습니다.',
    });
  }

  if (crypto.taHoldRate != null && crypto.taHoldRate >= 95) {
    suggestions.push({
      key: 'runtime_config.luna.analystWeights.crypto.taMtf',
      current: config.luna.analystWeights.crypto.taMtf,
      suggested: round(clamp(config.luna.analystWeights.crypto.taMtf - 0.03, 0.10, 0.30), 2),
      action: 'adjust',
      confidence: 'low',
      reason: `암호화폐 ta_mtf HOLD 비율이 ${crypto.taHoldRate}%로 과도하게 높아 최종 승격을 누를 가능성이 있습니다.`,
    });
  }

  if (domestic.totalBuy > 0 && domestic.executed === 0 && domestic.topBlocks[0]?.code === 'min_order_notional') {
    suggestions.push({
      key: 'runtime_config.luna.stockOrderDefaults.kis.min',
      current: config.luna.stockOrderDefaults.kis.min,
      suggested: config.luna.stockOrderDefaults.kis.min,
      action: 'hold',
      confidence: 'medium',
      reason: `국내장 실패는 최소 주문금액 미달 패턴이지만 현재 기본 주문금액은 이미 ${config.luna.stockOrderDefaults.kis.buyDefault.toLocaleString()} KRW라, 과거 레거시 실패 가능성이 커서 즉시 조정보다 신규 데이터 확인이 우선입니다.`,
    });
  }

  if (overseas.totalBuy >= 8 && overseas.executed >= 3 && overseas.topBlocks[0]?.code === 'legacy_order_rejected') {
    suggestions.push({
      key: 'runtime_config.luna.stockOrderDefaults.kis_overseas.max',
      current: config.luna.stockOrderDefaults.kis_overseas.max,
      suggested: config.luna.stockOrderDefaults.kis_overseas.max,
      action: 'hold',
      confidence: 'medium',
      reason: `해외장은 실행 ${overseas.executed}건이 이미 나오고 있고, 주 실패 코드는 과거 legacy_order_rejected라 현재 한도보다는 원인 정제와 신규 데이터 관찰이 우선입니다.`,
    });
  }

  if (overseas.totalBuy >= 8 && overseas.executed > 0 && overseas.executionRate < 50) {
    suggestions.push({
      key: 'runtime_config.luna.minConfidence.paper.kis_overseas',
      current: config.luna.minConfidence.paper.kis_overseas,
      suggested: round(clamp(config.luna.minConfidence.paper.kis_overseas - 0.02, 0.18, 0.30), 2),
      action: 'adjust',
      confidence: 'low',
      reason: `해외장 실행률이 ${overseas.executionRate}%로 아직 낮아 최소 confidence 기준을 소폭 완화해 비교할 수 있습니다.`,
    });
  }

  return suggestions;
}

function buildReport(days, summaries, suggestions) {
  return {
    periodDays: days,
    marketSummary: summaries,
    suggestions,
    actionableSuggestions: suggestions.filter(item => item.action === 'adjust').length,
  };
}

function printHuman(report) {
  const lines = [];
  lines.push(`🔧 투자 runtime_config 변경 제안 (${report.periodDays}일)`);
  lines.push('');
  lines.push('시장 요약:');
  for (const summary of Object.values(report.marketSummary)) {
    lines.push(`- ${summary.exchange}: BUY ${summary.totalBuy}건 / 실행 ${summary.executed}건 / 실패 ${summary.failed}건 / 실행률 ${summary.executionRate}%`);
    if (summary.topBlocks[0]) {
      lines.push(`  주요 실패 코드: ${summary.topBlocks[0].code} (${summary.topBlocks[0].count}건)`);
    }
  }
  lines.push('');
  lines.push('설정 제안:');
  for (const item of report.suggestions) {
    const marker = item.action === 'adjust' ? '•' : '◦';
    lines.push(`${marker} ${item.key}`);
    lines.push(`  current: ${item.current}`);
    lines.push(`  suggested: ${item.suggested}`);
    lines.push(`  action: ${item.action} / confidence: ${item.confidence}`);
    lines.push(`  reason: ${item.reason}`);
  }
  return lines.join('\n');
}

async function main() {
  const { days, json } = parseArgs();
  await db.initSchema();
  const { fromDate, toDate } = buildDateRange(days);
  const [signalRows, blockRows, analysisRows] = await Promise.all([
    loadSignalRows(fromDate, toDate),
    loadBlockCodeRows(fromDate, toDate),
    loadAnalysisRows(fromDate, toDate),
  ]);
  const config = getInvestmentRuntimeConfig();
  const summaries = {
    binance: summarizeExchange(signalRows, blockRows, analysisRows, 'binance'),
    kis: summarizeExchange(signalRows, blockRows, analysisRows, 'kis'),
    kis_overseas: summarizeExchange(signalRows, blockRows, analysisRows, 'kis_overseas'),
  };
  const suggestions = buildSuggestions(config, summaries);
  const report = buildReport(days, summaries, suggestions);

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${printHuman(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
