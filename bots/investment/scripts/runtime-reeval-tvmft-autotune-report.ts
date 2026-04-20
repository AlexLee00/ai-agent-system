#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { getPositionReevaluationRuntimeConfig } from '../shared/runtime-config.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const exchangeArg = argv.find((arg) => arg.startsWith('--exchange='));
  const tradeModeArg = argv.find((arg) => arg.startsWith('--trade-mode='));
  return {
    days: Math.max(3, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(10, Number(limitArg?.split('=')[1] || 200)),
    exchange: exchangeArg?.split('=')[1] || 'binance',
    tradeMode: tradeModeArg?.split('=')[1] || 'normal',
    paper: argv.includes('--paper'),
    json: argv.includes('--json'),
  };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getExchangeFramesConfig(exchange) {
  const runtime = getPositionReevaluationRuntimeConfig();
  const tv = runtime?.tradingViewFrames || {};
  const weights = tv?.weightsByExchange?.[exchange] || {};
  const thresholds = tv?.thresholdsByExchange?.[exchange] || {};
  const frames = tv?.byExchange?.[exchange] || ['1h', '4h', '1d'];
  return {
    frames,
    weights,
    thresholds: {
      buy: Number(thresholds.buy ?? 0.25),
      sell: Number(thresholds.sell ?? -0.25),
    },
  };
}

async function loadRows({ days, limit, exchange, tradeMode, paper }) {
  const openPositions = await db.getOpenPositions(exchange, paper, tradeMode).catch(() => []);
  const openSymbols = new Set((openPositions || []).map((row) => String(row.symbol || '').trim()).filter(Boolean));
  if (openSymbols.size === 0) return [];

  const rows = await db.query(
    `
      SELECT
        symbol,
        recommendation,
        reason_code,
        pnl_pct,
        analysis_snapshot,
        created_at
      FROM position_reevaluation_runs
      WHERE exchange = $1
        AND trade_mode = $2
        AND paper = $3
        AND created_at >= NOW() - ($4::text || ' days')::interval
      ORDER BY created_at DESC
      LIMIT $5
    `,
    [exchange, tradeMode, paper === true, String(days), limit],
  );

  const latestBySymbol = new Map();
  for (const row of rows) {
    const symbol = String(row.symbol || '').trim();
    if (!openSymbols.has(symbol)) continue;
    if (!latestBySymbol.has(symbol)) latestBySymbol.set(symbol, row);
  }
  return Array.from(latestBySymbol.values());
}

function getLiveIndicator(row) {
  return row?.analysis_snapshot?.liveIndicator || null;
}

function getLiveFrames(row) {
  const raw = row?.analysis_snapshot?.liveIndicatorFrames || {};
  if (Array.isArray(raw)) {
    return raw.reduce((acc, frame) => {
      const key = String(frame?.interval || '').trim();
      if (key) acc[key] = frame;
      return acc;
    }, {});
  }
  return raw;
}

function buildCandidateMetrics(rows, exchangeConfig) {
  const metrics = {
    totalSymbols: rows.length,
    liveCoverage: 0,
    recommendation: { hold: 0, adjust: 0, exit: 0 },
    nearSellHoldCount: 0,
    nearBuyHoldCount: 0,
    dailyDivergenceHoldCount: 0,
    mtfBearishAdjustExitCount: 0,
    symbols: [],
  };

  for (const row of rows) {
    const live = getLiveIndicator(row);
    const frames = getLiveFrames(row);
    if (!live) continue;
    metrics.liveCoverage += 1;

    const rec = String(row.recommendation || 'HOLD').toLowerCase();
    if (metrics.recommendation[rec] != null) metrics.recommendation[rec] += 1;

    const weightedBias = Number(live.weightedBias || 0);
    const thresholds = live.thresholds || exchangeConfig.thresholds;
    const composite = String(live.compositeSignal || 'HOLD').toUpperCase();
    const frame1d = String(frames['1d']?.signal || 'HOLD').toUpperCase();
    const frame4h = String(frames['4h']?.signal || 'HOLD').toUpperCase();

    if (
      rec === 'hold' &&
      composite === 'HOLD' &&
      weightedBias < 0 &&
      weightedBias > Number(thresholds.sell || -0.25)
    ) {
      metrics.nearSellHoldCount += 1;
    }

    if (
      rec === 'hold' &&
      composite === 'HOLD' &&
      weightedBias > 0 &&
      weightedBias < Number(thresholds.buy || 0.25)
    ) {
      metrics.nearBuyHoldCount += 1;
    }

    if (rec === 'hold' && composite === 'HOLD' && frame1d !== 'HOLD') {
      metrics.dailyDivergenceHoldCount += 1;
    }

    if ((rec === 'adjust' || rec === 'exit') && (frame4h === 'SELL' || frame1d === 'SELL' || composite === 'SELL')) {
      metrics.mtfBearishAdjustExitCount += 1;
    }

    metrics.symbols.push({
      symbol: row.symbol,
      recommendation: row.recommendation,
      reasonCode: row.reason_code,
      pnlPct: Number(row.pnl_pct || 0),
      composite,
      weightedBias: round(weightedBias, 4),
      frame1d,
      frame4h,
    });
  }

  return metrics;
}

function buildCandidates(metrics, exchangeConfig, exchange) {
  const candidates = [];
  const total = Math.max(1, Number(metrics.liveCoverage || 0));
  const buyThreshold = Number(exchangeConfig.thresholds.buy || 0.25);
  const sellThreshold = Number(exchangeConfig.thresholds.sell || -0.25);
  const currentWeights = { ...(exchangeConfig.weights || {}) };

  if (metrics.nearSellHoldCount >= 2 && metrics.nearSellHoldCount / total >= 0.4) {
    candidates.push({
      key: `runtime_config.reevaluation.tradingViewFrames.thresholdsByExchange.${exchange}.sell`,
      label: `${exchange} TV-MTF sell threshold`,
      current: sellThreshold,
      suggested: round(clamp(sellThreshold + 0.05, -0.4, -0.1), 2),
      action: 'adjust',
      confidence: 'medium',
      reason: `negative bias HOLD ${metrics.nearSellHoldCount}건이 sell threshold ${sellThreshold} 바로 위에 몰렸습니다.`,
    });
  }

  if (metrics.nearBuyHoldCount >= 2 && metrics.nearBuyHoldCount / total >= 0.4) {
    candidates.push({
      key: `runtime_config.reevaluation.tradingViewFrames.thresholdsByExchange.${exchange}.buy`,
      label: `${exchange} TV-MTF buy threshold`,
      current: buyThreshold,
      suggested: round(clamp(buyThreshold - 0.05, 0.1, 0.4), 2),
      action: 'adjust',
      confidence: 'medium',
      reason: `positive bias HOLD ${metrics.nearBuyHoldCount}건이 buy threshold ${buyThreshold} 바로 아래에 몰렸습니다.`,
    });
  }

  if (
    metrics.dailyDivergenceHoldCount >= 2 &&
    metrics.dailyDivergenceHoldCount / total >= 0.4 &&
    Number(currentWeights['1d'] || 0) > 0
  ) {
    const current1d = Number(currentWeights['1d'] || 0);
    const current1h = Number(currentWeights['1h'] || 0);
    const suggested1d = round(clamp(current1d + 0.05, 0.2, 0.7), 2);
    const suggested1h = round(clamp(current1h - 0.05, 0.05, 0.5), 2);
    candidates.push({
      key: `runtime_config.reevaluation.tradingViewFrames.weightsByExchange.${exchange}`,
      label: `${exchange} TV-MTF higher timeframe weight`,
      current: currentWeights,
      suggested: {
        ...currentWeights,
        '1d': suggested1d,
        ...(currentWeights['1h'] != null ? { '1h': suggested1h } : {}),
      },
      action: 'adjust',
      confidence: 'low',
      reason: `1d signal이 있는데 composite HOLD로 눌린 케이스가 ${metrics.dailyDivergenceHoldCount}건 있어 상위 프레임 비중을 조금 키워볼 수 있습니다.`,
    });
  }

  return candidates;
}

function buildDecision(metrics, candidates, exchangeConfig, exchange) {
  if (metrics.totalSymbols === 0) {
    return {
      status: 'reeval_tvmft_autotune_idle',
      headline: '최근 포지션 재평가 표본이 없어 TV-MTF autotune 후보가 아직 없습니다.',
      reasons: [],
      actionItems: ['포지션 재평가 표본이 더 쌓일 때까지 현재 설정을 유지합니다.'],
      metrics,
      currentConfig: exchangeConfig,
      candidates,
    };
  }

  const reasons = [
    `최신 표본 ${metrics.totalSymbols}개`,
    `TV-MTF 표본 ${metrics.liveCoverage}/${metrics.totalSymbols}`,
    `HOLD ${metrics.recommendation.hold} / ADJUST ${metrics.recommendation.adjust} / EXIT ${metrics.recommendation.exit}`,
  ];
  if (metrics.nearSellHoldCount > 0) reasons.push(`near-sell HOLD ${metrics.nearSellHoldCount}`);
  if (metrics.nearBuyHoldCount > 0) reasons.push(`near-buy HOLD ${metrics.nearBuyHoldCount}`);
  if (metrics.dailyDivergenceHoldCount > 0) reasons.push(`1d divergence HOLD ${metrics.dailyDivergenceHoldCount}`);

  if (candidates.length === 0) {
    return {
      status: 'reeval_tvmft_autotune_observe',
      headline: '현재 TV-MTF 임계치/가중치는 유지하고 더 많은 표본을 관찰하는 편이 좋습니다.',
      reasons,
      actionItems: [
        '가중치나 임계치를 바로 바꾸기보다 최근 표본을 더 누적합니다.',
        'near-threshold HOLD와 1d divergence가 계속 늘어나는지 다음 재평가 배치를 관찰합니다.',
      ],
      metrics,
      currentConfig: exchangeConfig,
      candidates,
    };
  }

  return {
    status: 'reeval_tvmft_autotune_ready',
    headline: `${exchange} TV-MTF 임계치/가중치 조정 후보를 dry-run으로 검토할 수 있습니다.`,
    reasons,
    actionItems: [
      'rank 1 후보를 바로 적용하지 말고 다음 재평가 배치에서 near-threshold 표본이 반복되는지 함께 봅니다.',
      '조정 전후 EXIT/ADJUST/HOLD 구성 변화가 어떻게 달라질지 synthetic 비교로 먼저 확인합니다.',
    ],
    metrics,
    currentConfig: exchangeConfig,
    candidates,
  };
}

function renderCandidate(candidate) {
  const current = typeof candidate.current === 'object' ? JSON.stringify(candidate.current) : String(candidate.current);
  const suggested = typeof candidate.suggested === 'object' ? JSON.stringify(candidate.suggested) : String(candidate.suggested);
  return [
    `- key: ${candidate.key}`,
    `- label: ${candidate.label}`,
    `- current/suggested: ${current} -> ${suggested}`,
    `- confidence: ${candidate.confidence}`,
    `- reason: ${candidate.reason}`,
  ];
}

function renderText(payload) {
  const lines = [
    '📺 Runtime Reevaluation TV-MTF Autotune',
    `exchange: ${payload.exchange}`,
    `tradeMode: ${payload.tradeMode}`,
    `paper: ${payload.paper}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '현재 설정:',
    `- frames: ${payload.decision.currentConfig.frames.join(', ')}`,
    `- weights: ${JSON.stringify(payload.decision.currentConfig.weights)}`,
    `- thresholds: ${JSON.stringify(payload.decision.currentConfig.thresholds)}`,
    '',
    '후보:',
    ...(payload.decision.candidates.length > 0
      ? payload.decision.candidates.flatMap((candidate) => renderCandidate(candidate))
      : ['- 지금은 observe-only']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildFallback(payload) {
  if (payload.decision.status === 'reeval_tvmft_autotune_ready') {
    return '최근 재평가 표본을 보면 TV-MTF 임계치나 상위 프레임 가중치를 dry-run으로 조정해볼 수 있습니다.';
  }
  if (payload.decision.status === 'reeval_tvmft_autotune_observe') {
    return '아직은 TV-MTF 설정을 바꾸기보다 표본을 더 누적해 보는 편이 안정적입니다.';
  }
  return '최근 재평가 표본이 없어 TV-MTF autotune 후보가 아직 없습니다.';
}

export async function buildRuntimeReevalTvMtfAutotuneReport({
  days = 14,
  limit = 200,
  exchange = 'binance',
  tradeMode = 'normal',
  paper = false,
  json = false,
} = {}) {
  const rows = await loadRows({ days, limit, exchange, tradeMode, paper });
  const exchangeConfig = getExchangeFramesConfig(exchange);
  const metrics = buildCandidateMetrics(rows, exchangeConfig);
  const candidates = buildCandidates(metrics, exchangeConfig, exchange);
  const decision = buildDecision(metrics, candidates, exchangeConfig, exchange);
  const payload = {
    ok: true,
    days,
    limit,
    exchange,
    tradeMode,
    paper,
    rows,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-reeval-tvmft-autotune-report',
    requestType: 'runtime-reeval-tvmft-autotune-report',
    title: '투자 포지션 재평가 TV-MTF autotune 리포트 요약',
    data: {
      days,
      exchange,
      tradeMode,
      paper,
      decision,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeReevalTvMtfAutotuneReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-reeval-tvmft-autotune-report 오류:',
  });
}
