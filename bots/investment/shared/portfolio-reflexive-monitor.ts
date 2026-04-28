// @ts-nocheck

import { resolvePositionLifecycleFlags } from './position-lifecycle-flags.ts';
import { getPositionRuntimeMarket } from './position-runtime-state.ts';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  const scale = 10 ** digits;
  return Math.round(Number(value || 0) * scale) / scale;
}

function normalizeRegime(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'unknown';
}

function normalizeCorrelationMatrix(matrix = null) {
  const pairs = new Map();
  if (!matrix || typeof matrix !== 'object') return pairs;
  for (const [left, value] of Object.entries(matrix)) {
    if (value && typeof value === 'object') {
      for (const [right, corr] of Object.entries(value)) {
        const a = String(left || '').toUpperCase();
        const b = String(right || '').toUpperCase();
        if (!a || !b || a === b) continue;
        const key = [a, b].sort().join('::');
        pairs.set(key, Math.max(Math.abs(n(corr, 0)), pairs.get(key) || 0));
      }
    }
  }
  return pairs;
}

export function analyzeReflexivePortfolioState({
  positions = [],
  latestRegimeByMarket = {},
  correlationMatrix = null,
} = {}) {
  const flags = resolvePositionLifecycleFlags();
  const enabled = flags.shouldApplyReflexiveMonitoring();
  const matrixPairs = normalizeCorrelationMatrix(correlationMatrix);

  const normalized = (Array.isArray(positions) ? positions : []).map((item) => {
    const amount = Math.max(0, n(item?.amount, n(item?.size, 0)));
    const avgPrice = Math.max(0, n(item?.avg_price, n(item?.entry_price, 0)));
    const notional = Math.max(0, n(item?.notional_value, amount * avgPrice));
    const pnlPct = n(item?.pnlPct, (() => {
      const unreal = n(item?.unrealized_pnl, 0);
      return notional > 0 ? (unreal / notional) * 100 : 0;
    })());
    return {
      symbol: String(item?.symbol || ''),
      exchange: String(item?.exchange || ''),
      notional,
      pnlPct,
      setupType: String(item?.setup_type || item?.setupType || '').trim().toLowerCase() || null,
      market: getPositionRuntimeMarket(String(item?.exchange || '')),
      correlation: Math.abs(n(item?.correlation, 0)),
    };
  }).filter((item) => item.symbol && item.exchange && item.notional >= 0);

  if (matrixPairs.size > 0) {
    for (const row of normalized) {
      const symbol = String(row.symbol || '').toUpperCase();
      let maxCorr = row.correlation;
      for (const other of normalized) {
        const otherSymbol = String(other.symbol || '').toUpperCase();
        if (!symbol || !otherSymbol || symbol === otherSymbol) continue;
        const key = [symbol, otherSymbol].sort().join('::');
        maxCorr = Math.max(maxCorr, matrixPairs.get(key) || 0);
      }
      row.correlation = maxCorr;
    }
  }

  const totalNotional = normalized.reduce((sum, item) => sum + item.notional, 0);
  const bySymbol = new Map();
  for (const row of normalized) {
    const prev = bySymbol.get(row.symbol) || { notional: 0, exchanges: new Set() };
    prev.notional += row.notional;
    prev.exchanges.add(row.exchange);
    bySymbol.set(row.symbol, prev);
  }
  const symbolConcentration = Array.from(bySymbol.entries()).map(([symbol, value]) => ({
    symbol,
    weight: totalNotional > 0 ? value.notional / totalNotional : 0,
    notional: value.notional,
    exchangeCount: value.exchanges.size,
  })).sort((a, b) => b.weight - a.weight);

  const topSymbol = symbolConcentration[0] || null;
  const drawdownChain = normalized.filter((row) => row.pnlPct <= -2).length;
  const maxCorrelation = normalized.reduce((max, row) => Math.max(max, row.correlation), 0);
  const correlationCoverage = normalized.length > 0
    ? normalized.filter((row) => row.correlation > 0).length / normalized.length
    : 0;
  const regimeMisalignmentCount = normalized.filter((row) => {
    const regime = normalizeRegime(latestRegimeByMarket?.[row.market]);
    if (regime === 'unknown') return false;
    const setup = String(row.setupType || '');
    if (!setup) return false;
    if (setup.includes('trend') && regime === 'trending_bear') return true;
    if (setup.includes('mean_reversion') && regime === 'trending_bull') return true;
    return false;
  }).length;

  const concentrationAlert = topSymbol && topSymbol.weight >= flags.phaseG.maxConcentrationPct;
  const drawdownAlert = drawdownChain >= flags.phaseG.maxDrawdownChainCount;
  const correlationAlert = maxCorrelation >= flags.phaseG.maxCorrelation;
  const regimeAlert = regimeMisalignmentCount >= 2;
  const protective = enabled && (concentrationAlert || drawdownAlert || correlationAlert || regimeAlert);

  return {
    enabled,
    protective,
    eventType: protective ? 'portfolio_reflexive_alert' : 'portfolio_reflexive_ok',
    reasonCodes: [
      concentrationAlert ? 'concentration_over_limit' : null,
      drawdownAlert ? 'drawdown_chain_detected' : null,
      correlationAlert ? 'correlation_cluster_detected' : null,
      regimeAlert ? 'regime_misalignment_detected' : null,
    ].filter(Boolean),
    metrics: {
      totalPositions: normalized.length,
      totalNotional: round(totalNotional, 4),
      topSymbolWeight: round(topSymbol?.weight || 0, 4),
      drawdownChain,
      maxCorrelation: round(maxCorrelation, 4),
      correlationCoverage: round(correlationCoverage, 4),
      correlationEvidence: matrixPairs.size > 0 ? 'matrix' : correlationCoverage > 0 ? 'position_rows' : 'missing',
      regimeMisalignmentCount,
    },
    thresholds: {
      maxConcentrationPct: flags.phaseG.maxConcentrationPct,
      maxDrawdownChainCount: flags.phaseG.maxDrawdownChainCount,
      maxCorrelation: flags.phaseG.maxCorrelation,
    },
    topSymbol: topSymbol ? {
      symbol: topSymbol.symbol,
      weight: round(topSymbol.weight, 4),
      notional: round(topSymbol.notional, 4),
    } : null,
    symbolConcentration,
    bias: {
      protective,
      positionSizeMultiplier: protective ? 0.8 : 1,
      preferExit: protective && drawdownAlert,
      blockPyramid: protective,
      createdAt: new Date().toISOString(),
    },
  };
}

export default {
  analyzeReflexivePortfolioState,
};
