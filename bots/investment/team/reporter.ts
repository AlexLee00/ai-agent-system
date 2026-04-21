// @ts-nocheck
/**
 * team/reporter.js — 루나팀 투자 리포트 (일일 성과 요약)
 *
 * 역할: DB + 바이낸스 실시간 가격으로 성과 리포트 생성
 * 실행: node team/reporter.js [--telegram] [--days=N]
 *
 * 출력 항목:
 *   - 운영 모드 현황
 *   - 바이낸스 실잔고 (USDT + 코인)
 *   - 모의 포지션 현황 + 미실현 수익률
 *   - 신호 통계 (정확도)
 *   - 이번달 신호 일별 추이
 *   - LLM 비용
 */

import ccxt            from 'ccxt';
import { createRequire }  from 'module';
import * as db          from '../shared/db.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { loadSecrets, initHubSecrets, getMarketExecutionModeInfo } from '../shared/secrets.ts';
import { getDomesticPrice, getOverseasPrice } from '../shared/kis-client.ts';
import { tracker }      from '../shared/cost-tracker.ts';
import { buildAccuracyReport } from '../shared/analyst-accuracy.ts';
import { buildScreeningHistoryReport } from '../scripts/screening-history-report.ts';
import { buildPositionReevaluationSummary } from '../scripts/position-reevaluation-summary.ts';
import { buildRuntimeMinOrderPressureReport } from '../scripts/runtime-min-order-pressure-report.ts';
import { buildRuntimeKisOrderPressureReport } from '../scripts/runtime-kis-order-pressure-report.ts';
import { buildRuntimeKisDomesticAutotuneReport } from '../scripts/runtime-kis-domestic-autotune-report.ts';
import { buildRuntimeKisReentryPressureReport } from '../scripts/runtime-kis-reentry-pressure-report.ts';
import { buildRuntimeBinanceFailurePressureReport } from '../scripts/runtime-binance-failure-pressure-report.ts';
import { buildRuntimeBinanceCircuitBreakerReport } from '../scripts/runtime-binance-circuit-breaker-report.ts';
import { buildRuntimeBinanceCapitalGuardReport } from '../scripts/runtime-binance-capital-guard-report.ts';
import { buildRuntimeBinanceCorrelationGuardReport } from '../scripts/runtime-binance-correlation-guard-report.ts';
import { buildRuntimeCryptoSoftGuardReport } from '../scripts/runtime-crypto-soft-guard-report.ts';
import { buildRuntimeBinanceDustReport } from '../scripts/runtime-binance-dust-report.ts';
import { buildRuntimeReevalTvMtfAutotuneReport } from '../scripts/runtime-reeval-tvmft-autotune-report.ts';
import { buildRuntimeReevalTvMtfTrendReport } from '../scripts/runtime-reeval-tvmft-trend-report.ts';
import { buildRuntimeKisOverseasAutotuneReport } from '../scripts/runtime-kis-overseas-autotune-report.ts';

const _require = createRequire(import.meta.url);
const shadow   = _require('../../../packages/core/lib/shadow-mode.js');
const pgPool   = _require('../../../packages/core/lib/pg-pool.js');
const kst      = _require('../../../packages/core/lib/kst');
const { generateGemmaPilotText } = _require('../../../packages/core/lib/gemma-pilot.js') as {
  generateGemmaPilotText: (payload: Record<string, any>) => Promise<{ ok?: boolean; content?: string }>;
};
const {
  buildNoticeEvent,
  renderNoticeEvent,
  buildReportEvent,
  renderReportEvent,
} = _require('../../../packages/core/lib/reporting-hub.js');

// ─── 바이낸스 현재가 일괄 조회 ──────────────────────────────────────

async function fetchBinancePrices(symbols) {
  const prices = {};
  try {
    const ex = new ccxt.binance({ enableRateLimit: true });
    for (const sym of symbols) {
      try {
        const ticker = await ex.fetchTicker(sym);
        prices[sym] = ticker.last;
      } catch { prices[sym] = null; }
    }
  } catch { /* 가격 조회 실패 시 null */ }
  return prices;
}

async function fetchPositionPrices(positions = []) {
  const prices = {};
  const grouped = new Map();

  for (const pos of positions) {
    const exchange = pos.exchange || 'unknown';
    const key = `${exchange}:${pos.symbol}`;
    if (!grouped.has(key)) grouped.set(key, pos);
  }

  const binanceSymbols = Array.from(grouped.values())
    .filter((pos) => pos.exchange === 'binance')
    .map((pos) => pos.symbol);
  Object.assign(prices, await fetchBinancePrices(binanceSymbols));

  for (const pos of grouped.values()) {
    try {
      if (pos.exchange === 'kis') {
        prices[pos.symbol] = await getDomesticPrice(pos.symbol, Boolean(pos.paper));
      } else if (pos.exchange === 'kis_overseas') {
        const quote = await getOverseasPrice(pos.symbol);
        prices[pos.symbol] = Number(quote?.price || 0) || null;
      }
    } catch {
      prices[pos.symbol] = null;
    }
  }

  return prices;
}

function summarizeTradesByModeAndExchange(trades = []) {
  const getBrokerAccountModeForExchange = (exchange) =>
    getMarketExecutionModeInfo(exchange === 'binance' ? 'crypto' : 'stocks', exchange).brokerAccountMode;
  const buckets = {};
  for (const trade of trades) {
    const mode = trade.paper ? 'paper' : 'live';
    const exchange = inferExchange(trade);
    const brokerAccountMode = getBrokerAccountModeForExchange(exchange);
    const key = `${mode}:${exchange}:${brokerAccountMode}`;
    if (!buckets[key]) {
      buckets[key] = { mode, exchange, brokerAccountMode, count: 0, gross: 0 };
    }
    buckets[key].count += 1;
    buckets[key].gross += Number(trade.total_usdt || 0);
  }
  return Object.values(buckets).sort((a, b) => a.mode.localeCompare(b.mode) || a.exchange.localeCompare(b.exchange));
}

function summarizePositionsByModeAndExchange(positions = [], prices = {}) {
  const getBrokerAccountModeForExchange = (exchange) =>
    getMarketExecutionModeInfo(exchange === 'binance' ? 'crypto' : 'stocks', exchange).brokerAccountMode;
  const buckets = {};
  for (const pos of positions) {
    const mode = pos.paper ? 'paper' : 'live';
    const exchange = pos.exchange || 'unknown';
    const brokerAccountMode = getBrokerAccountModeForExchange(exchange);
    const key = `${mode}:${exchange}:${brokerAccountMode}`;
    if (!buckets[key]) {
      buckets[key] = { mode, exchange, brokerAccountMode, positions: 0, costBasis: 0, marketValue: 0, unrealized: 0 };
    }
    const currentPrice = prices[pos.symbol] || pos.avg_price || 0;
    const costBasis = Number(pos.amount || 0) * Number(pos.avg_price || 0);
    const marketValue = Number(pos.amount || 0) * Number(currentPrice || 0);
    buckets[key].positions += 1;
    buckets[key].costBasis += costBasis;
    buckets[key].marketValue += marketValue;
    buckets[key].unrealized += marketValue - costBasis;
  }
  return Object.values(buckets).sort((a, b) => a.mode.localeCompare(b.mode) || a.exchange.localeCompare(b.exchange));
}

function summarizeStockPositionsBySymbol(positions = [], exchange = 'kis') {
  const rows = positions.filter((pos) => pos.exchange === exchange && !pos.paper);
  const buckets = new Map();

  for (const pos of rows) {
    const key = pos.symbol;
    const current = buckets.get(key) || {
      symbol: pos.symbol,
      totalAmount: 0,
      totalCost: 0,
      modes: new Set(),
      legs: 0,
    };
    const amount = Number(pos.amount || 0);
    const avgPrice = Number(pos.avg_price || 0);
    current.totalAmount += amount;
    current.totalCost += amount * avgPrice;
    current.modes.add(pos.trade_mode || 'normal');
    current.legs += 1;
    buckets.set(key, current);
  }

  return Array.from(buckets.values())
    .map((row) => ({
      symbol: row.symbol,
      totalAmount: row.totalAmount,
      weightedAvgPrice: row.totalAmount > 0 ? row.totalCost / row.totalAmount : 0,
      modes: Array.from(row.modes).sort(),
      legs: row.legs,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function inferExchange(row = {}) {
  if (row.exchange) return row.exchange;
  if (String(row.symbol || '').includes('/')) return 'binance';
  if (/^\d{6}$/.test(String(row.symbol || ''))) return 'kis';
  return 'kis_overseas';
}

function isValidReportSignalSymbol(symbol) {
  const text = String(symbol || '').trim().toUpperCase();
  if (!text) return false;
  if (text.includes('/')) return /^[A-Z0-9]+\/USDT$/.test(text);
  if (/^\d{6}$/.test(text)) return true;
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(text);
}

function getPositionFormat(exchange) {
  if (exchange === 'kis') return { amountUnit: '주', currency: '원', pricePrefix: '', priceSuffix: '원' };
  if (exchange === 'kis_overseas') return { amountUnit: '주', currency: '$', pricePrefix: '$', priceSuffix: '' };
  return { amountUnit: '개', currency: '$', pricePrefix: '$', priceSuffix: '' };
}

function formatNumber(value, decimals = 2) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatPrice(value, exchange) {
  const fmt = getPositionFormat(exchange);
  if (fmt.currency === '원') return `${Number(value || 0).toLocaleString('ko-KR')}원`;
  return `$${formatNumber(value, 2)}`;
}

function formatValue(value, exchange) {
  const fmt = getPositionFormat(exchange);
  const sign = Number(value || 0) >= 0 ? '+' : '-';
  const abs = Math.abs(Number(value || 0));
  if (fmt.currency === '원') return `${sign}${Math.round(abs).toLocaleString('ko-KR')}원`;
  return `${sign}$${formatNumber(abs, 2)}`;
}

function formatAmount(amount, exchange) {
  const unit = getPositionFormat(exchange).amountUnit;
  const decimals = exchange === 'binance' ? 6 : 0;
  return `${Number(amount || 0).toFixed(decimals)}${unit}`;
}

function sanitizeInvestmentInsightLine(text = '') {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) =>
      line &&
      !/^thinking process/i.test(line) &&
      !/^[-*]\s*(thinking|analysis)/i.test(line) &&
      !/^[0-9]+\.\s/.test(line) &&
      !/^<\|/.test(line) &&
      !/^ai[:：]/i.test(line)
    ) || '';
}

function buildInvestmentReportFallbackInsight({
  equity,
  sigTotal,
  sigExec,
  sigFailed,
  balances,
  screeningSummary,
}: {
  equity: number;
  sigTotal: number;
  sigExec: number;
  sigFailed: number;
  balances: Array<{ coin?: string; total?: number }>;
  screeningSummary: Record<string, any>;
}) {
  const summaryMarkets = Object.values(screeningSummary || {})
    .filter((summary: any) => summary && !summary.error);
  const activeMarketCount = summaryMarkets.filter(
    (summary: any) => Number(summary?.trend?.latestDynamicCount || 0) > 0,
  ).length;
  const hasBinanceBalance = Array.isArray(balances) && balances.some((row) => Number(row?.total || 0) > 0);

  if (sigFailed > 0) {
    return `신호 ${sigTotal}개 중 실패 ${sigFailed}개가 있어 실행 안정성을 먼저 점검하는 편이 좋습니다.`;
  }
  if (activeMarketCount >= 2) {
    return `총자산은 $${equity.toFixed(2)} 수준이며, 스크리닝 동향이 ${activeMarketCount}개 시장에서 동시에 살아 있습니다.`;
  }
  if (sigExec > 0) {
    return `총자산은 $${equity.toFixed(2)} 수준이며, 오늘은 실행된 신호 ${sigExec}개 중심으로 복기하면 좋습니다.`;
  }
  if (hasBinanceBalance) {
    return `총자산은 $${equity.toFixed(2)} 수준이며, 뚜렷한 실행 신호보다 자산 보전과 관망 비중이 높은 하루입니다.`;
  }
  return `총자산은 $${equity.toFixed(2)} 수준이며, 오늘은 신호보다 운영 상태와 비용 흐름을 점검하는 날입니다.`;
}

function dedupeEquityHistoryByKstDate(equityHistory = []) {
  const latestByDate = new Map();
  for (const snap of equityHistory) {
    const dt = new Date(snap.snapped_at).toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Seoul',
    });
    latestByDate.set(dt, snap);
  }
  return Array.from(latestByDate.values()).sort(
    (a, b) => new Date(a.snapped_at) - new Date(b.snapped_at),
  );
}

// ─── 바이낸스 실잔고 조회 ───────────────────────────────────────────

async function fetchBinanceBalance() {
  try {
    const s  = loadSecrets();
    const ex = new ccxt.binance({
      apiKey: s.binance_api_key,
      secret: s.binance_api_secret,
      enableRateLimit: true,
    });
    const bal = await ex.fetchBalance();
    const nonZero = Object.entries(bal.total || {})
      .filter(([, v]) => v > 0)
      .map(([coin, total]) => ({ coin, free: bal.free?.[coin] || 0, total }));
    return nonZero;
  } catch (e) {
    console.warn(`  ⚠️ 바이낸스 잔고 조회 실패: ${e.message}`);
    return [];
  }
}

// ─── 날짜 헬퍼 ──────────────────────────────────────────────────────

function kstStr() {
  return kst.datetimeStr() + ' KST';
}

function buildSection(title, lines) {
  return {
    title,
    lines: (lines || []).filter(Boolean),
  };
}

function buildBalanceSummaryLines({ balances, usdtBal, equity, balanceSource }) {
  if (balances.length === 0) {
    return [
      `조회 실패`,
      `USDT 가용: 조회 실패`,
      `총 자산(추정): $${equity.toFixed(2)} (최신 스냅샷 기준)`,
    ];
  }

  return [
    ...balances.map((b) => `  ${b.coin}: ${b.total.toFixed(6)} (가용 ${b.free.toFixed(6)})`),
    `  USDT 가용: $${(usdtBal?.free || 0).toFixed(2)}`,
    `  총 자산(추정): $${equity.toFixed(2)}`,
    `  자산 집계 소스: ${balanceSource === 'binance_live' ? '바이낸스 실잔고' : '최신 스냅샷 fallback'}`,
  ];
}

function buildTradeBreakdownLines(tradeBreakdown = []) {
  if (tradeBreakdown.length === 0) return ['거래 없음'];
  return tradeBreakdown.map((row) => {
    const modeLabel = row.mode === 'live' ? 'LIVE' : 'PAPER';
    return `${modeLabel} [${row.exchange} / ${row.brokerAccountMode}]: ${row.count}건 | 총 거래금액 ${formatPrice(row.gross, row.exchange)}`;
  });
}

function buildSignalStatsLines({ days, sigTotal, sigExec, sigApproved, sigFailed }) {
  return [
    `총 신호: ${sigTotal}개`,
    `실행(모의): ${sigExec}개 | 승인대기: ${sigApproved}개 | 실패: ${sigFailed}개`,
    ...(sigTotal > 0 ? [`실행률: ${((sigExec / sigTotal) * 100).toFixed(1)}%`] : []),
  ];
}

function summarizeFailedSignals(rows = []) {
  const total = rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const top = rows[0] || null;
  const byExchange = rows.reduce((acc, row) => {
    const exchange = String(row.exchange || 'unknown');
    acc[exchange] = (acc[exchange] || 0) + Number(row.count || 0);
    return acc;
  }, {});
  return {
    total,
    top,
    byExchange,
    rows,
  };
}

function buildFailedSignalLines(failedSummary) {
  if (!failedSummary || failedSummary.total <= 0) return [];
  const lines = [`실패 총계: ${failedSummary.total}건`];
  const exchangeLines = Object.entries(failedSummary.byExchange || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .map(([exchange, count]) => `${String(exchange).toUpperCase()} ${count}건`);
  if (exchangeLines.length > 0) {
    lines.push(`시장별 실패: ${exchangeLines.join(' | ')}`);
  }
  if (failedSummary.top?.label) {
    lines.push(`최다 실패: ${failedSummary.top.label} (${failedSummary.top.count}건)`);
  }
  const topByExchange = new Map();
  for (const row of failedSummary.rows || []) {
    const exchange = String(row.exchange || 'unknown');
    if (!topByExchange.has(exchange)) topByExchange.set(exchange, row);
  }
  for (const [exchange, row] of topByExchange.entries()) {
    if (!row?.label) continue;
    lines.push(`${String(exchange).toUpperCase()} 대표 실패: ${row.label} (${row.count}건)`);
  }
  return lines;
}

async function loadScreeningSummary() {
  const summaryByMarket = {};
  for (const market of ['crypto', 'domestic', 'overseas']) {
    try {
      const report = await buildScreeningHistoryReport({ market, limit: 3, json: true });
      summaryByMarket[market] = report.summary;
    } catch (error) {
      summaryByMarket[market] = {
        error: String(error?.message || error),
      };
    }
  }
  return summaryByMarket;
}

async function loadPositionReevaluationSummary() {
  try {
    const result = await buildPositionReevaluationSummary({
      json: true,
      paper: false,
      persist: true,
      minutesBack: 180,
    });
    return result?.decision ? result : null;
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadReevalTvMtfAutotuneSummary() {
  try {
    return await buildRuntimeReevalTvMtfAutotuneReport({
      exchange: 'binance',
      tradeMode: 'normal',
      paper: false,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadReevalTvMtfTrendSummary() {
  try {
    return await buildRuntimeReevalTvMtfTrendReport({
      exchange: 'binance',
      tradeMode: 'normal',
      paper: false,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadMinOrderPressureSummary() {
  try {
    return await buildRuntimeMinOrderPressureReport({
      market: 'kis',
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadKisOrderPressureSummary() {
  try {
    return await buildRuntimeKisOrderPressureReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadKisDomesticAutotuneSummary() {
  try {
    return await buildRuntimeKisDomesticAutotuneReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadKisReentryPressureSummary() {
  try {
    return await buildRuntimeKisReentryPressureReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadBinanceFailurePressureSummary() {
  try {
    return await buildRuntimeBinanceFailurePressureReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadBinanceCircuitBreakerSummary() {
  try {
    return await buildRuntimeBinanceCircuitBreakerReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadBinanceCapitalGuardSummary() {
  try {
    return await buildRuntimeBinanceCapitalGuardReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadBinanceCorrelationGuardSummary() {
  try {
    return await buildRuntimeBinanceCorrelationGuardReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadCryptoSoftGuardSummary() {
  try {
    return await buildRuntimeCryptoSoftGuardReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

async function loadKisOverseasAutotuneSummary() {
  try {
    return await buildRuntimeKisOverseasAutotuneReport({
      days: 14,
      json: true,
    });
  } catch (error) {
    return {
      error: String(error?.message || error),
    };
  }
}

function buildScreeningSummaryLines(screeningSummary = {}) {
  const lines = [];
  for (const market of ['crypto', 'domestic', 'overseas']) {
    const summary = screeningSummary[market];
    if (!summary) continue;
    if (summary.error) {
      lines.push(`${market}: 조회 실패`);
      continue;
    }
    const delta = Number(summary.trend?.deltaDynamicCount || 0);
    const signedDelta = `${delta >= 0 ? '+' : ''}${delta}`;
    const top = (summary.topSymbols || []).slice(0, 3).map((item) => `${item.symbol}(${item.count})`).join(', ');
    lines.push(`${market}: ${summary.trend?.latestDynamicCount ?? 0}개 (${signedDelta})`);
    if (top) lines.push(`top: ${top}`);
  }
  return lines;
}

function buildPositionReevaluationLines(reevaluationSummary = null) {
  if (!reevaluationSummary) return ['조회 결과 없음'];
  if (reevaluationSummary.error) return ['조회 실패'];
  if (!reevaluationSummary.decision) return ['결과 없음'];
  const metrics = reevaluationSummary.decision.metrics || {};
  const lines = [
    `${reevaluationSummary.decision.status}: HOLD ${metrics.holds || 0} / ADJUST ${metrics.adjusts || 0} / EXIT ${metrics.exits || 0}`,
  ];
  if (Array.isArray(reevaluationSummary.decision.reasons)) {
    lines.push(...reevaluationSummary.decision.reasons.slice(0, 2));
  }
  return lines;
}

function buildReevalTvMtfAutotuneLines(reevalTvMtfSummary = null) {
  if (!reevalTvMtfSummary) return ['조회 결과 없음'];
  if (reevalTvMtfSummary.error) return ['조회 실패'];
  if (!reevalTvMtfSummary.decision) return ['결과 없음'];
  const decision = reevalTvMtfSummary.decision || {};
  const metrics = decision.metrics || {};
  const lines = [
    `${decision.status}: ${decision.headline}`,
    `TV-MTF 표본 ${metrics.liveCoverage || 0}/${metrics.totalSymbols || 0} | divergence HOLD ${metrics.dailyDivergenceHoldCount || 0} | 후보 ${decision.candidates?.length || 0}`,
  ];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 2));
  }
  return lines;
}

function buildReevalTvMtfTrendLines(reevalTvMtfTrendSummary = null) {
  if (!reevalTvMtfTrendSummary) return ['조회 결과 없음'];
  if (reevalTvMtfTrendSummary.error) return ['조회 실패'];
  if (!reevalTvMtfTrendSummary.decision) return ['결과 없음'];
  const decision = reevalTvMtfTrendSummary.decision || {};
  const metrics = decision.metrics || {};
  const lines = [
    `${decision.status}: ${decision.headline}`,
    `최근 observe ${metrics.recentObserveCount || 0}회 | coverage_ready ${metrics.recentCoverageReadyCount || 0}회 | divergence ${metrics.recentDivergenceCount || 0}회`,
  ];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 2));
  }
  return lines;
}

function buildCryptoSoftGuardLines(cryptoSoftGuardSummary = null) {
  if (!cryptoSoftGuardSummary) return ['조회 결과 없음'];
  if (cryptoSoftGuardSummary.error) return ['조회 실패'];
  if (!cryptoSoftGuardSummary.decision) return ['결과 없음'];
  const decision = cryptoSoftGuardSummary.decision || {};
  const metrics = decision.metrics || {};
  const lines = [
    `${decision.status}: ${decision.headline}`,
    `soft guard ${metrics.total || 0}건 | 평균 감산 x${Number(metrics.avgReductionMultiplier || 1).toFixed(2)} | 대표 ${metrics.topKind || '없음'}`,
  ];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 2));
  }
  return lines;
}

function buildKisOverseasAutotuneLines(kisOverseasAutotuneSummary = null) {
  if (!kisOverseasAutotuneSummary) return ['조회 결과 없음'];
  if (kisOverseasAutotuneSummary.error) return ['조회 실패'];
  if (!kisOverseasAutotuneSummary.decision) return ['결과 없음'];
  const decision = kisOverseasAutotuneSummary.decision || {};
  const metrics = decision.metrics || {};
  const lines = [
    `${decision.status}: ${decision.headline}`,
    `BUY ${metrics.totalBuy || 0}건 | 실행률 ${Number(metrics.executionRate || 0).toFixed(1)}% | 최소주문 ${metrics.minOrderNotional || 0}건 | 후보 ${kisOverseasAutotuneSummary.candidate?.key || '없음'}`,
  ];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 2));
  }
  return lines;
}

function buildMinOrderPressureLines(minOrderPressureSummary = null) {
  if (!minOrderPressureSummary) return ['조회 결과 없음'];
  if (minOrderPressureSummary.error) return ['조회 실패'];
  if (!minOrderPressureSummary.decision) return ['결과 없음'];
  const decision = minOrderPressureSummary.decision || {};
  const lines = [`${decision.status}: ${decision.headline}`];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 3));
  }
  return lines;
}

function buildKisOrderPressureLines(kisOrderPressureSummary = null) {
  if (!kisOrderPressureSummary) return ['조회 결과 없음'];
  if (kisOrderPressureSummary.error) return ['조회 실패'];
  if (!kisOrderPressureSummary.decision) return ['결과 없음'];
  const decision = kisOrderPressureSummary.decision || {};
  const lines = [`${decision.status}: ${decision.headline}`];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 3));
  }
  return lines;
}

function buildKisDomesticAutotuneLines(kisDomesticAutotuneSummary = null) {
  if (!kisDomesticAutotuneSummary) return ['조회 결과 없음'];
  if (kisDomesticAutotuneSummary.error) return ['조회 실패'];
  if (!kisDomesticAutotuneSummary.decision) return ['결과 없음'];
  const decision = kisDomesticAutotuneSummary.decision || {};
  const metrics = decision.metrics || {};
  const lines = [
    `${decision.status}: ${decision.headline}`,
    `BUY ${metrics.totalBuy || 0}건 | 실행률 ${Number(metrics.executionRate || 0).toFixed(1)}% | 주문초과 ${metrics.orderPressureTotal || 0}건 | 후보 ${kisDomesticAutotuneSummary.candidate?.key || '없음'}`,
  ];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 2));
  }
  return lines;
}

function buildKisReentryPressureLines(kisReentryPressureSummary = null) {
  if (!kisReentryPressureSummary) return ['조회 결과 없음'];
  if (kisReentryPressureSummary.error) return ['조회 실패'];
  if (!kisReentryPressureSummary.decision) return ['결과 없음'];
  const decision = kisReentryPressureSummary.decision || {};
  const lines = [`${decision.status}: ${decision.headline}`];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 3));
  }
  return lines;
}

function buildBinanceFailurePressureLines(binanceFailurePressureSummary = null) {
  if (!binanceFailurePressureSummary) return ['조회 결과 없음'];
  if (binanceFailurePressureSummary.error) return ['조회 실패'];
  if (!binanceFailurePressureSummary.decision) return ['결과 없음'];
  const decision = binanceFailurePressureSummary.decision || {};
  const lines = [`${decision.status}: ${decision.headline}`];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 3));
  }
  return lines;
}

function buildBinanceCircuitBreakerLines(binanceCircuitBreakerSummary = null) {
  if (!binanceCircuitBreakerSummary) return ['조회 결과 없음'];
  if (binanceCircuitBreakerSummary.error) return ['조회 실패'];
  if (!binanceCircuitBreakerSummary.decision) return ['결과 없음'];
  const decision = binanceCircuitBreakerSummary.decision || {};
  const lines = [`${decision.status}: ${decision.headline}`];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 3));
  }
  return lines;
}

function buildBinanceCapitalGuardLines(binanceCapitalGuardSummary = null) {
  if (!binanceCapitalGuardSummary) return ['조회 결과 없음'];
  if (binanceCapitalGuardSummary.error) return ['조회 실패'];
  if (!binanceCapitalGuardSummary.decision) return ['결과 없음'];
  const decision = binanceCapitalGuardSummary.decision || {};
  const lines = [`${decision.status}: ${decision.headline}`];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 3));
  }
  return lines;
}

function buildBinanceCorrelationGuardLines(binanceCorrelationGuardSummary = null) {
  if (!binanceCorrelationGuardSummary) return ['조회 결과 없음'];
  if (binanceCorrelationGuardSummary.error) return ['조회 실패'];
  if (!binanceCorrelationGuardSummary.decision) return ['결과 없음'];
  const decision = binanceCorrelationGuardSummary.decision || {};
  const lines = [`${decision.status}: ${decision.headline}`];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 3));
  }
  return lines;
}

function buildBinanceDustLines(binanceDustSummary = null) {
  if (!binanceDustSummary) return ['조회 결과 없음'];
  if (binanceDustSummary.error) return ['조회 실패'];
  if (!binanceDustSummary.decision) return ['결과 없음'];
  const decision = binanceDustSummary.decision || {};
  const lines = [`${decision.status}: ${decision.headline}`];
  if (Array.isArray(decision.reasons)) {
    lines.push(...decision.reasons.slice(0, 3));
  }
  return lines;
}

// ─── 리포트 생성 ─────────────────────────────────────────────────────

export async function generateReport({ days = 30, telegram = false } = {}) {
  await initHubSecrets().catch(() => false);
  const screeningSummary = await loadScreeningSummary();
  const reevaluationSummary = await loadPositionReevaluationSummary();
  const reevalTvMtfAutotuneSummary = await loadReevalTvMtfAutotuneSummary();
  const reevalTvMtfTrendSummary = await loadReevalTvMtfTrendSummary();
  const minOrderPressureSummary = await loadMinOrderPressureSummary();
  const kisOrderPressureSummary = await loadKisOrderPressureSummary();
  const kisDomesticAutotuneSummary = await loadKisDomesticAutotuneSummary();
  const kisReentryPressureSummary = await loadKisReentryPressureSummary();
  const binanceFailurePressureSummary = await loadBinanceFailurePressureSummary();
  const binanceCircuitBreakerSummary = await loadBinanceCircuitBreakerSummary();
  const binanceCapitalGuardSummary = await loadBinanceCapitalGuardSummary();
  const binanceCorrelationGuardSummary = await loadBinanceCorrelationGuardSummary();
  const cryptoSoftGuardSummary = await loadCryptoSoftGuardSummary();
  const kisOverseasAutotuneSummary = await loadKisOverseasAutotuneSummary();
  const binanceDustSummary = await loadBinanceDustSummary();
  let dbAvailable = true;
  try {
    await db.initSchema();
  } catch (error) {
    dbAvailable = false;
    console.warn(`  ⚠️ 리포트 DB 미연결 — 축약 리포트로 진행: ${error.message}`);
  }

  if (!dbAvailable) {
    const balances = await fetchBinanceBalance();
    const usdtBal = balances.find((b) => b.coin === 'USDT');
    const cost = tracker.getToday();
    const cryptoMode = getMarketExecutionModeInfo('crypto');
    const domesticMode = getMarketExecutionModeInfo('stocks', 'kis');
    const overseasMode = getMarketExecutionModeInfo('stocks', 'kis_overseas');
    const lines = [
      `📊 루나팀 투자 리포트 (축약) — ${kstStr()}`,
      '',
      '━━━ 운영 모드 ━━━',
      `  ${cryptoMode.executionMode.toUpperCase()} / ${cryptoMode.brokerAccountMode.toUpperCase()} — 암호화폐`,
      `  ${domesticMode.executionMode.toUpperCase()} / ${domesticMode.brokerAccountMode.toUpperCase()} — 국내주식`,
      `  ${overseasMode.executionMode.toUpperCase()} / ${overseasMode.brokerAccountMode.toUpperCase()} — 미국주식`,
      '',
      '━━━ 자산/비용 ━━━',
      balances.length === 0 ? '  바이낸스 잔고 조회 실패' : `  USDT 가용: $${(usdtBal?.free || 0).toFixed(2)}`,
      `  오늘 LLM 비용: $${cost.usage.toFixed(4)} / $${cost.dailyBudget.toFixed(2)}`,
      `  이번달 LLM 비용: $${cost.monthUsage.toFixed(4)} / $${cost.monthlyBudget.toFixed(2)}`,
      '',
      '━━━ 스크리닝 동향 ━━━',
      ...buildScreeningSummaryLines(screeningSummary).map((line) => `  ${line}`),
      '',
      '━━━ 포지션 재평가 ━━━',
      ...buildPositionReevaluationLines(reevaluationSummary).map((line) => `  ${line}`),
      '',
      '━━━ 포지션 TV-MTF autotune ━━━',
      ...buildReevalTvMtfAutotuneLines(reevalTvMtfAutotuneSummary).map((line) => `  ${line}`),
      '',
      '━━━ 포지션 TV-MTF trend ━━━',
      ...buildReevalTvMtfTrendLines(reevalTvMtfTrendSummary).map((line) => `  ${line}`),
      '',
      '━━━ 최소 주문 병목 ━━━',
      ...buildMinOrderPressureLines(minOrderPressureSummary).map((line) => `  ${line}`),
      '',
      '━━━ 국내 주문 초과 압력 ━━━',
      ...buildKisOrderPressureLines(kisOrderPressureSummary).map((line) => `  ${line}`),
      '',
      '━━━ 국내장 self-tune ━━━',
      ...buildKisDomesticAutotuneLines(kisDomesticAutotuneSummary).map((line) => `  ${line}`),
      '',
      '━━━ 국내 재진입 차단 압력 ━━━',
      ...buildKisReentryPressureLines(kisReentryPressureSummary).map((line) => `  ${line}`),
      '',
      '━━━ 크립토 실행 실패 압력 ━━━',
      ...buildBinanceFailurePressureLines(binanceFailurePressureSummary).map((line) => `  ${line}`),
      '',
      '━━━ 크립토 circuit breaker 압력 ━━━',
      ...buildBinanceCircuitBreakerLines(binanceCircuitBreakerSummary).map((line) => `  ${line}`),
      '',
      '━━━ 크립토 capital guard 압력 ━━━',
      ...buildBinanceCapitalGuardLines(binanceCapitalGuardSummary).map((line) => `  ${line}`),
      '',
      '━━━ 크립토 correlation guard 압력 ━━━',
      ...buildBinanceCorrelationGuardLines(binanceCorrelationGuardSummary).map((line) => `  ${line}`),
      '',
      '━━━ 크립토 soft guard ━━━',
      ...buildCryptoSoftGuardLines(cryptoSoftGuardSummary).map((line) => `  ${line}`),
      '',
      '━━━ 국외장 self-tune ━━━',
      ...buildKisOverseasAutotuneLines(kisOverseasAutotuneSummary).map((line) => `  ${line}`),
      '',
      '━━━ 크립토 dust 상태 ━━━',
      ...buildBinanceDustLines(binanceDustSummary).map((line) => `  ${line}`),
      '',
      '━━━ 상태 ━━━',
      '  DB 미연결로 신호/거래 통계는 생략',
    ];
    const report = lines.join('\n');
    console.log('\n' + report);
    if (telegram) {
      await publishAlert({
        from_bot: 'reporter',
        event_type: 'report',
        alert_level: 1,
        message: report,
        payload: {
          title: '루나팀 투자 리포트 (축약)',
          summary: `기준: ${kstStr()} | 최근 ${days}일`,
          details: [
            'DB 미연결로 신호/거래 통계는 생략',
          ],
        },
      });
    }
    return report;
  }

  const today = kst.today();

  // ── 1. 신호 통계 ───────────────────────────────────────────────────
  const sigStats = await db.query(`
    SELECT
      status,
      COUNT(*)::INTEGER  AS cnt,
      ROUND(AVG(confidence)::numeric * 100, 1) AS avg_conf
    FROM signals
    WHERE created_at > now() - INTERVAL '${days} days'
    GROUP BY status
    ORDER BY cnt DESC
  `);

  const sigTotal    = sigStats.reduce((s, r) => s + r.cnt, 0);
  const sigExec     = sigStats.find(r => r.status === 'executed')?.cnt  || 0;
  const sigApproved = sigStats.find(r => r.status === 'approved')?.cnt  || 0;
  const sigFailed   = sigStats.find(r => r.status === 'failed')?.cnt    || 0;
  const sigHold     = sigStats.find(r => r.status === 'hold')?.cnt      || 0;
  const failedReasonRows = await db.query(`
    SELECT
      exchange,
      COALESCE(block_code, '') AS block_code,
      LEFT(COALESCE(block_reason, ''), 160) AS block_reason,
      COUNT(*)::INTEGER AS count
    FROM signals
    WHERE created_at > now() - INTERVAL '${days} days'
      AND status = 'failed'
    GROUP BY exchange, COALESCE(block_code, ''), LEFT(COALESCE(block_reason, ''), 160)
    ORDER BY count DESC
    LIMIT 12
  `);
  const failedSummary = summarizeFailedSignals(
    failedReasonRows.map((row) => ({
      ...row,
      label: [String(row.exchange || '').toUpperCase(), row.block_code || row.block_reason || 'unknown']
        .filter(Boolean)
        .join(' / '),
    })),
  );

  // ── 2. 심볼별 신호 분포 ────────────────────────────────────────────
  const rawSymStats = await db.query(`
    SELECT
      symbol,
      action,
      COUNT(*)::INTEGER AS cnt
    FROM signals
    WHERE created_at > now() - INTERVAL '${days} days'
    GROUP BY symbol, action
    ORDER BY symbol, action
  `);
  const symStats = rawSymStats.filter((row) => isValidReportSignalSymbol(row.symbol));

  // ── 3. 포지션 + 현재가 ─────────────────────────────────────────────
  const positions = await db.getAllPositions();
  const posPrices = positions.length > 0 ? await fetchPositionPrices(positions) : {};

  const positionTotals = {};
  const posLines = [];

  for (const p of positions) {
    const currentPrice = posPrices[p.symbol];
    const costBasis    = p.amount * p.avg_price;
    const bucket = positionTotals[p.exchange] || { costBasis: 0, unrealized: 0 };
    bucket.costBasis += costBasis;
    positionTotals[p.exchange] = bucket;
    const amountUnit = getPositionFormat(p.exchange).amountUnit;

    if (currentPrice) {
      const value     = p.amount * currentPrice;
      const pnl       = value - costBasis;
      const pnlPct    = (pnl / costBasis * 100);
      bucket.unrealized += pnl;
      const pnlSign   = pnl >= 0 ? '+' : '';
      posLines.push(
        `  ${p.symbol}: ${p.amount.toFixed(p.exchange === 'binance' ? 6 : 0)}${amountUnit}\n` +
        `    매수가 ${formatPrice(p.avg_price, p.exchange)} → 현재가 ${formatPrice(currentPrice, p.exchange)}\n` +
        `    평가금액 ${formatPrice(value, p.exchange)} | 수익 ${formatValue(pnl, p.exchange)} (${pnlSign}${pnlPct.toFixed(2)}%)`
      );
    } else {
      posLines.push(
        `  ${p.symbol}: ${p.amount.toFixed(p.exchange === 'binance' ? 6 : 0)}${amountUnit} @ ${formatPrice(p.avg_price, p.exchange)} (현재가 조회 실패)`
      );
    }
  }

  // ── 4. 바이낸스 실잔고 ─────────────────────────────────────────────
  const balances = await fetchBinanceBalance();
  const usdtBal  = balances.find(b => b.coin === 'USDT');

  // LU-002: 실잔고 기반 equity 계산 (USDT free + 보유 코인 현재가 환산)
  const nonUsdtHoldings = balances.filter(b => b.coin !== 'USDT' && b.total > 0);
  const realCoinPrices  = nonUsdtHoldings.length > 0
    ? await fetchBinancePrices(nonUsdtHoldings.map(b => `${b.coin}/USDT`))
    : {};
  const coinUsdValue = nonUsdtHoldings.reduce((s, b) => {
    const p = realCoinPrices[`${b.coin}/USDT`];
    return p ? s + b.total * p : s;
  }, 0);
  let equity = (usdtBal?.free || 0) + coinUsdValue;
  let balanceSource = balances.length > 0 ? 'binance_live' : 'snapshot_fallback';

  if (balances.length === 0) {
    try {
      const latestEquity = await db.getLatestEquity();
      if (Number.isFinite(Number(latestEquity)) && Number(latestEquity) > 0) {
        equity = Number(latestEquity);
      }
    } catch {}
  }

  // 스냅샷 저장 후 히스토리 조회 (오늘 포함)
  try { await db.insertAssetSnapshot(equity, usdtBal?.free || 0); } catch {}
  const equityHistory = dedupeEquityHistoryByKstDate(await db.getEquityHistory(7));

  // ── 5. LLM 비용 ────────────────────────────────────────────────────
  const cost = tracker.getToday();

  // ── 6. 거래 내역 요약 ──────────────────────────────────────────────
  const trades = await db.query(`
    SELECT
      symbol, side, amount, price, total_usdt, exchange, paper, executed_at
    FROM trades
    WHERE executed_at > now() - INTERVAL '${days} days'
    ORDER BY executed_at DESC
  `);

  const pnl = await db.getTodayPnl();
  const tradeBreakdown = summarizeTradesByModeAndExchange(trades);
  const positionBreakdown = summarizePositionsByModeAndExchange(positions, posPrices);
  const domesticSymbolTotals = summarizeStockPositionsBySymbol(positions, 'kis');
  const overseasSymbolTotals = summarizeStockPositionsBySymbol(positions, 'kis_overseas');

  // ── 7. 분석팀 정확도 ────────────────────────────────────────────────
  let accuracyReport = null;
  try {
    accuracyReport = await buildAccuracyReport();
  } catch (e) {
    console.warn(`  ⚠️ 분석팀 정확도 조회 실패: ${e.message}`);
  }

  // ─── 리포트 조립 ──────────────────────────────────────────────────
  const cryptoMode = getMarketExecutionModeInfo('crypto', '암호화폐');
  const domesticMode = getMarketExecutionModeInfo('stocks', '국내주식');
  const overseasMode = getMarketExecutionModeInfo('stocks', '미국주식');

  const lines = [
    `📊 *루나팀 투자 리포트*`,
    `기준: ${kstStr()} | 최근 ${days}일`,
    ``,
    `━━━ 운영 모드 ━━━`,
    `  ${cryptoMode.executionMode.toUpperCase()} / ${cryptoMode.brokerAccountMode.toUpperCase()} — 암호화폐`,
    `  ${domesticMode.executionMode.toUpperCase()} / ${domesticMode.brokerAccountMode.toUpperCase()} — 국내주식`,
    `  ${overseasMode.executionMode.toUpperCase()} / ${overseasMode.brokerAccountMode.toUpperCase()} — 미국주식`,
    ``,
  ];

  // 바이낸스 잔고
  lines.push(`━━━ 바이낸스 실잔고 ━━━`);
  lines.push(...buildBalanceSummaryLines({ balances, usdtBal, equity, balanceSource }));
  lines.push(``);

  lines.push(`━━━ 스크리닝 동향 ━━━`);
  lines.push(...buildScreeningSummaryLines(screeningSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 포지션 재평가 ━━━`);
  lines.push(...buildPositionReevaluationLines(reevaluationSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 포지션 TV-MTF autotune ━━━`);
  lines.push(...buildReevalTvMtfAutotuneLines(reevalTvMtfAutotuneSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 포지션 TV-MTF trend ━━━`);
  lines.push(...buildReevalTvMtfTrendLines(reevalTvMtfTrendSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 최소 주문 병목 ━━━`);
  lines.push(...buildMinOrderPressureLines(minOrderPressureSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 국내 주문 초과 압력 ━━━`);
  lines.push(...buildKisOrderPressureLines(kisOrderPressureSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 국내 재진입 차단 압력 ━━━`);
  lines.push(...buildKisReentryPressureLines(kisReentryPressureSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 크립토 실행 실패 압력 ━━━`);
  lines.push(...buildBinanceFailurePressureLines(binanceFailurePressureSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 크립토 circuit breaker 압력 ━━━`);
  lines.push(...buildBinanceCircuitBreakerLines(binanceCircuitBreakerSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 크립토 capital guard 압력 ━━━`);
  lines.push(...buildBinanceCapitalGuardLines(binanceCapitalGuardSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 크립토 correlation guard 압력 ━━━`);
  lines.push(...buildBinanceCorrelationGuardLines(binanceCorrelationGuardSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 크립토 soft guard ━━━`);
  lines.push(...buildCryptoSoftGuardLines(cryptoSoftGuardSummary).map((line) => `  ${line}`));
  lines.push(``);

  lines.push(`━━━ 크립토 dust 상태 ━━━`);
  lines.push(...buildBinanceDustLines(binanceDustSummary).map((line) => `  ${line}`));
  lines.push(``);

  // 자산 추이 (스냅샷 2개 이상일 때)
  if (equityHistory.length >= 2) {
    lines.push(`━━━ 자산 추이 ━━━`);
    for (const snap of equityHistory.slice(-5)) {
      const dt = new Date(snap.snapped_at).toLocaleDateString('ko-KR', {
        timeZone: 'Asia/Seoul', month: 'short', day: 'numeric',
      });
      lines.push(`  ${dt}: $${Number(snap.equity).toFixed(2)}`);
    }
    const oldest = Number(equityHistory[0].equity);
    const latest  = Number(equityHistory[equityHistory.length - 1].equity);
    const change  = latest - oldest;
    const pct     = oldest > 0 ? (change / oldest * 100).toFixed(1) : '0.0';
    const sign    = change >= 0 ? '+' : '';
    lines.push(`  기간 변화: ${sign}$${change.toFixed(2)} (${sign}${pct}%)`);
    lines.push(``);
  }

  // 모의 포지션
  lines.push(`━━━ 모의 포지션 현황 ━━━`);
  if (posLines.length === 0) {
    lines.push(`  포지션 없음`);
  } else {
    lines.push(...posLines);
    for (const exchange of Object.keys(positionTotals).sort()) {
      const total = positionTotals[exchange];
      const pnlSign = total.unrealized >= 0 ? '+' : '';
      const roiPct = total.costBasis > 0 ? (total.unrealized / total.costBasis * 100) : 0;
      lines.push(`  ─`);
      lines.push(`  ${exchange} 총 매수원가: ${formatPrice(total.costBasis, exchange)}`);
      lines.push(`  ${exchange} 미실현 PnL: ${formatValue(total.unrealized, exchange)} (${pnlSign}${roiPct.toFixed(2)}%)`);
    }
  }
  lines.push(``);

  // 신호 통계
  lines.push(`━━━ 신호 통계 (최근 ${days}일) ━━━`);
  lines.push(`  총 신호: ${sigTotal}개`);
  lines.push(`  실행(모의): ${sigExec}개 | 승인대기: ${sigApproved}개 | 실패: ${sigFailed}개`);
  if (sigTotal > 0) {
    const execRate = ((sigExec / sigTotal) * 100).toFixed(1);
    lines.push(`  실행률: ${execRate}%`);
  }
  for (const line of buildFailedSignalLines(failedSummary)) {
    lines.push(`  ${line}`);
  }

  if (symStats.length > 0) {
    lines.push(`  심볼별:`);
    const grouped = {};
    for (const r of symStats) {
      if (!grouped[r.symbol]) grouped[r.symbol] = {};
      grouped[r.symbol][r.action] = r.cnt;
    }
    for (const [sym, actions] of Object.entries(grouped)) {
      const parts = Object.entries(actions).map(([a, c]) => `${a} ${c}`).join(' / ');
      lines.push(`    ${sym}: ${parts}`);
    }
  }
  lines.push(``);

  // 거래 내역
  lines.push(`━━━ 최근 거래 내역 ━━━`);
  if (trades.length === 0) {
    lines.push(`  거래 없음`);
  } else {
    for (const t of trades) {
      const dtStr = kst.toKST(new Date(t.executed_at));
      const paper = t.paper ? '📄' : '🔴';
      const exchange = inferExchange(t);
      const notional = Number.isFinite(Number(t.total_usdt)) && Number(t.total_usdt) > 0
        ? Number(t.total_usdt)
        : Number(t.amount || 0) * Number(t.price || 0);
      lines.push(`  ${paper} ${dtStr} | ${t.symbol} ${t.side.toUpperCase()} ${formatAmount(t.amount, exchange)} @ ${formatPrice(t.price, exchange)} (≈${formatPrice(notional, exchange)})`);
    }
  }
  lines.push(``);

  lines.push(`━━━ 실행 모드 분리 ━━━`);
  lines.push(...buildTradeBreakdownLines(tradeBreakdown).map((line) => `  ${line}`));
  if (positionBreakdown.length > 0) {
    lines.push(`  포지션:`);
    for (const row of positionBreakdown) {
      const modeLabel = row.mode === 'live' ? 'LIVE' : 'PAPER';
      const unrealizedText = formatValue(row.unrealized, row.exchange);
      lines.push(`    ${modeLabel} [${row.exchange} / ${row.brokerAccountMode}]: ${row.positions}개 | 평가 ${formatPrice(row.marketValue, row.exchange)} | 미실현 ${unrealizedText}`);
    }
  }
  if (domesticSymbolTotals.length > 0) {
    lines.push(`  국내 심볼 합산:`);
    for (const row of domesticSymbolTotals) {
      lines.push(`    ${row.symbol}: ${row.totalAmount}주 | 가중평단 ${row.weightedAvgPrice.toFixed(2)}원 | legs=${row.legs} | modes=${row.modes.join('+')}`);
    }
  }
  if (overseasSymbolTotals.length > 0) {
    lines.push(`  해외 심볼 합산:`);
    for (const row of overseasSymbolTotals) {
      lines.push(`    ${row.symbol}: ${row.totalAmount}주 | 가중평단 $${row.weightedAvgPrice.toFixed(2)} | legs=${row.legs} | modes=${row.modes.join('+')}`);
    }
  }
  lines.push(``);

  // LLM 비용
  lines.push(`━━━ LLM 비용 ━━━`);
  lines.push(`  오늘: $${cost.usage.toFixed(4)} / $${cost.dailyBudget.toFixed(2)}`);
  lines.push(`  이번달: $${cost.monthUsage.toFixed(4)} / $${cost.monthlyBudget.toFixed(2)}`);
  lines.push(`  (Groq 무료 — 실비용 $0)`);

  // 분석팀 정확도
  if (accuracyReport) {
    lines.push(``);
    lines.push(accuracyReport.text);
  }

  let aiSummary = '';
  try {
    const prompt = `당신은 투자 운영 리포트 분석가입니다.
아래 데이터를 보고 오늘의 핵심 인사이트를 한국어 한 줄로만 작성하세요.
숫자 재나열보다 운영 패턴, 주의 포인트, 복기 우선순위를 짧게 요약하세요.

데이터:
${JSON.stringify({
  equity: Number(equity.toFixed(2)),
  signals: {
    total: sigTotal,
    executed: sigExec,
    approved: sigApproved,
    failed: sigFailed,
  },
  llmCost: {
    today: Number(cost.usage.toFixed(4)),
    month: Number(cost.monthUsage.toFixed(4)),
  },
  screening: Object.fromEntries(Object.entries(screeningSummary || {}).map(([market, summary]: [string, any]) => [
    market,
    summary?.error ? { error: summary.error } : {
      latestDynamicCount: Number(summary?.trend?.latestDynamicCount || 0),
      deltaDynamicCount: Number(summary?.trend?.deltaDynamicCount || 0),
          topSymbols: (summary?.topSymbols || []).slice(0, 3).map((item: any) => item.symbol),
    },
  ])),
  reevaluation: reevaluationSummary?.decision ? {
    status: reevaluationSummary.decision.status,
    holds: Number(reevaluationSummary.decision.metrics?.holds || 0),
    adjusts: Number(reevaluationSummary.decision.metrics?.adjusts || 0),
    exits: Number(reevaluationSummary.decision.metrics?.exits || 0),
  } : null,
  reevalTvMtfAutotune: reevalTvMtfAutotuneSummary?.decision ? {
    status: reevalTvMtfAutotuneSummary.decision.status,
    liveCoverage: Number(reevalTvMtfAutotuneSummary.decision.metrics?.liveCoverage || 0),
    totalSymbols: Number(reevalTvMtfAutotuneSummary.decision.metrics?.totalSymbols || 0),
    dailyDivergenceHoldCount: Number(reevalTvMtfAutotuneSummary.decision.metrics?.dailyDivergenceHoldCount || 0),
    candidates: Number(reevalTvMtfAutotuneSummary.decision.candidates?.length || 0),
  } : null,
  reevalTvMtfTrend: reevalTvMtfTrendSummary?.decision ? {
    status: reevalTvMtfTrendSummary.decision.status,
    recentObserveCount: Number(reevalTvMtfTrendSummary.decision.metrics?.recentObserveCount || 0),
    recentCoverageReadyCount: Number(reevalTvMtfTrendSummary.decision.metrics?.recentCoverageReadyCount || 0),
    recentDivergenceCount: Number(reevalTvMtfTrendSummary.decision.metrics?.recentDivergenceCount || 0),
  } : null,
  minOrderPressure: minOrderPressureSummary?.decision ? {
    status: minOrderPressureSummary.decision.status,
    headline: minOrderPressureSummary.decision.headline,
    reasons: minOrderPressureSummary.decision.reasons || [],
  } : null,
}, null, 2).slice(0, 2000)}`;

    const insight = await generateGemmaPilotText({
      team: 'investment',
      purpose: 'gemma-insight',
      bot: 'reporter',
      requestType: 'daily-report-summary',
      prompt,
      maxTokens: 120,
      temperature: 0.4,
      timeoutMs: 10000,
    });
    aiSummary = sanitizeInvestmentInsightLine(insight?.content || '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[reporter] AI 요약 생략: ${message}`);
  }
  if (!aiSummary) {
    aiSummary = buildInvestmentReportFallbackInsight({
      equity,
      sigTotal,
      sigExec,
      sigFailed,
      balances,
      screeningSummary,
    });
  }
  lines.push(``);
  lines.push(`🔍 AI: ${aiSummary}`);

  const report = lines.join('\n');
  console.log('\n' + report);

  // 가중치 조정 알림 (텔레그램, 조정 제안 있을 시)
  if (telegram && accuracyReport) {
    const needsAlert = accuracyReport.adjustments.some(
      a => (a.action !== 'maintain' && a.action !== 'insufficient_data') || a.needsReview
    );
    if (needsAlert) {
      const detailLines = [];
      for (const adj of accuracyReport.adjustments) {
        if (adj.action !== 'maintain' && adj.action !== 'insufficient_data') {
          detailLines.push(`${adj.botName}: ${adj.currentWeight} → ${adj.suggestedWeight} (${adj.reason})`);
        }
        if (adj.needsReview) {
          detailLines.push(`검토 필요: ${adj.botName} 3주 연속 50% 미만`);
        }
      }
      const alertNotice = buildNoticeEvent({
        from_bot: 'luna',
        team: 'investment',
        event_type: 'accuracy_alert',
        alert_level: 2,
        title: '분석팀 가중치 조정 제안',
        summary: '최근 정확도 기준으로 검토가 필요한 변경안이 있습니다',
        details: detailLines,
        action: '자동 변경 없이 마스터 승인 후 반영',
      });
      await publishAlert({
        from_bot: 'reporter',
        event_type: 'accuracy_alert',
        alert_level: 2,
        message: renderNoticeEvent(alertNotice),
        payload: alertNotice.payload,
      });
      console.log('\n📊 가중치 조정 알림 발송 완료');
    }
  }

  if (telegram) {
    const reportMessage = renderReportEvent(buildReportEvent({
      from_bot: 'luna',
      team: 'investment',
      event_type: 'report',
      alert_level: 1,
      title: '📊 루나팀 투자 리포트',
      summary: `기준: ${kstStr()} | 최근 ${days}일`,
      sections: [
        buildSection('운영 모드', [
          `${cryptoMode.executionMode.toUpperCase()} / ${cryptoMode.brokerAccountMode.toUpperCase()} — 암호화폐`,
          `${domesticMode.executionMode.toUpperCase()} / ${domesticMode.brokerAccountMode.toUpperCase()} — 국내주식`,
          `${overseasMode.executionMode.toUpperCase()} / ${overseasMode.brokerAccountMode.toUpperCase()} — 미국주식`,
        ]),
        buildSection('실행 모드', tradeBreakdown.length === 0
          ? ['거래 없음']
          : buildTradeBreakdownLines(tradeBreakdown)),
        buildSection('자산/비용', [
          balances.length === 0 ? 'USDT 가용: 조회 실패' : `USDT 가용: $${(usdtBal?.free || 0).toFixed(2)}`,
          balances.length === 0
            ? `총 자산(추정): $${equity.toFixed(2)} (최신 스냅샷 기준)`
            : `총 자산(추정): $${equity.toFixed(2)}`,
          `오늘 LLM 비용: $${cost.usage.toFixed(4)} / $${cost.dailyBudget.toFixed(2)}`,
          `이번달 LLM 비용: $${cost.monthUsage.toFixed(4)} / $${cost.monthlyBudget.toFixed(2)}`,
          `자산 집계 소스: ${balanceSource === 'binance_live' ? '바이낸스 실잔고' : '최신 스냅샷 fallback'}`,
        ]),
        buildSection('스크리닝 동향', buildScreeningSummaryLines(screeningSummary)),
        buildSection('포지션 재평가', buildPositionReevaluationLines(reevaluationSummary)),
        buildSection('포지션 TV-MTF autotune', buildReevalTvMtfAutotuneLines(reevalTvMtfAutotuneSummary)),
        buildSection('포지션 TV-MTF trend', buildReevalTvMtfTrendLines(reevalTvMtfTrendSummary)),
        buildSection('최소 주문 병목', buildMinOrderPressureLines(minOrderPressureSummary)),
        buildSection('국내 주문 초과 압력', buildKisOrderPressureLines(kisOrderPressureSummary)),
        buildSection('국내장 self-tune', buildKisDomesticAutotuneLines(kisDomesticAutotuneSummary)),
        buildSection('국내 재진입 차단 압력', buildKisReentryPressureLines(kisReentryPressureSummary)),
        buildSection('크립토 실행 실패 압력', buildBinanceFailurePressureLines(binanceFailurePressureSummary)),
        buildSection('크립토 circuit breaker 압력', buildBinanceCircuitBreakerLines(binanceCircuitBreakerSummary)),
        buildSection('크립토 capital guard 압력', buildBinanceCapitalGuardLines(binanceCapitalGuardSummary)),
        buildSection('크립토 correlation guard 압력', buildBinanceCorrelationGuardLines(binanceCorrelationGuardSummary)),
        buildSection('크립토 soft guard', buildCryptoSoftGuardLines(cryptoSoftGuardSummary)),
        buildSection('국외장 self-tune', buildKisOverseasAutotuneLines(kisOverseasAutotuneSummary)),
        buildSection('크립토 dust 상태', buildBinanceDustLines(binanceDustSummary)),
        buildSection(`신호 통계 (${days}일)`, [
          ...buildSignalStatsLines({ days, sigTotal, sigExec, sigApproved, sigFailed }),
          ...buildFailedSignalLines(failedSummary),
        ]),
        buildSection('AI 요약', [aiSummary]),
      ],
      footer: '상세: 콘솔 리포트 참고',
    }));
    await publishAlert({
      from_bot: 'reporter',
      event_type: 'report',
      alert_level: 1,
      message: reportMessage,
      payload: {
        title: '루나팀 투자 리포트',
        summary: `기준: ${kstStr()} | 최근 ${days}일`,
        details: [
          `신호 ${sigTotal}개`,
          `실행 ${sigExec}개 / 승인대기 ${sigApproved}개 / 실패 ${sigFailed}개`,
          reevaluationSummary?.decision
            ? `재평가 ${reevaluationSummary.decision.status} / EXIT ${reevaluationSummary.decision.metrics?.exits || 0}`
            : null,
          reevalTvMtfAutotuneSummary?.decision
            ? `TV-MTF ${reevalTvMtfAutotuneSummary.decision.status} / 후보 ${reevalTvMtfAutotuneSummary.decision.candidates?.length || 0}`
            : null,
          reevalTvMtfTrendSummary?.decision
            ? `TV-MTF trend ${reevalTvMtfTrendSummary.decision.status} / divergence ${reevalTvMtfTrendSummary.decision.metrics?.recentDivergenceCount || 0}`
            : null,
          cryptoSoftGuardSummary?.decision
            ? `crypto soft guard ${cryptoSoftGuardSummary.decision.status} / ${cryptoSoftGuardSummary.decision.metrics?.total || 0}건`
            : null,
          kisOverseasAutotuneSummary?.decision
            ? `overseas self-tune ${kisOverseasAutotuneSummary.decision.status} / 최소주문 ${kisOverseasAutotuneSummary.decision.metrics?.minOrderNotional || 0}건`
            : null,
          minOrderPressureSummary?.decision
            ? `최소주문 ${minOrderPressureSummary.decision.status}`
            : null,
          kisDomesticAutotuneSummary?.decision
            ? `domestic self-tune ${kisDomesticAutotuneSummary.decision.status} / 주문초과 ${kisDomesticAutotuneSummary.decision.metrics?.orderPressureTotal || 0}건`
            : null,
        ].filter(Boolean),
      },
    });
    console.log('\n📱 제이 큐 발송 완료');
  }

  // 4주차 안정화 지표 (콘솔 로그)
  const week4Summary = await buildWeek4Summary();
  console.log('\n' + week4Summary);

  return report;
}

async function loadBinanceDustSummary() {
  try {
    return await buildRuntimeBinanceDustReport({ json: true });
  } catch (error) {
    return { error: error.message };
  }
}

// ─── 4주차 종합 안정화 지표 ──────────────────────────────────────────

export async function buildWeek4Summary() {
  const lines = [
    `📊 4주차 안정화 지표`,
    `════════════════════════`,
  ];

  // 1. Shadow 일치율 (7일)
  try {
    const [lunaStats, skaStats, claudeStats] = await Promise.all([
      shadow.getMatchRate('luna',       null, 7),
      shadow.getMatchRate('ska',        null, 7),
      shadow.getMatchRate('claude-lead', null, 7),
    ]);
    lines.push(`━━ Shadow 일치율 (7일) ━━`);
    const fmtRate = (s) => s.total > 0 ? `${s.matchRate}% (${s.total}건)` : '데이터 없음';
    lines.push(`  루나:   ${fmtRate(lunaStats)}`);
    lines.push(`  스카:   ${fmtRate(skaStats)}`);
    lines.push(`  클로드: ${fmtRate(claudeStats)}`);
  } catch (e) {
    lines.push(`━━ Shadow 일치율 ━━\n  조회 실패: ${e.message}`);
  }
  lines.push(``);

  // 2. LLM 비용
  const cost = tracker.getToday();
  lines.push(`━━ LLM 비용 ━━`);
  lines.push(`  오늘: $${cost.usage.toFixed(4)} (Groq: $0.00)`);
  lines.push(`  이번달: $${cost.monthUsage.toFixed(4)} / $${cost.monthlyBudget.toFixed(2)}`);
  lines.push(``);

  // 3. LLM 졸업 후보 (claude.graduation_candidates)
  try {
    const candidates = await pgPool.query('claude', `
      SELECT team, context, predicted_decision, sample_count, match_rate
      FROM graduation_candidates
      WHERE status = 'candidate'
      ORDER BY match_rate DESC
      LIMIT 5
    `, []);
    lines.push(`━━ LLM 졸업 후보 ━━`);
    if (candidates.length === 0) {
      lines.push(`  없음 (90%+ 일치 패턴 미도달)`);
    } else {
      for (const c of candidates) {
        lines.push(`  [${c.team}] ${c.context} → ${c.predicted_decision}: ${(Number(c.match_rate) * 100).toFixed(1)}% (n=${c.sample_count})`);
      }
    }
  } catch (e) {
    lines.push(`━━ LLM 졸업 후보 ━━\n  조회 실패: ${e.message}`);
  }

  return lines.join('\n');
}

// ─── CLI 실행 ───────────────────────────────────────────────────────

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args     = process.argv.slice(2);
      const telegram = args.includes('--telegram');
      const daysArg  = args.find(a => a.startsWith('--days='));
      const days     = daysArg ? parseInt(daysArg.split('=')[1]) : 30;
      return generateReport({ days, telegram });
    },
  });
}
