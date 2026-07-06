// @ts-nocheck

import { createRequire } from 'node:module';
import { formatMarketRegime, getMarketRegime } from './market-regime.ts';

const require = createRequire(import.meta.url);
const { buildLifecyclePromptContext } = require('../../../packages/core/lib/agent-lifecycle.ts');

function lifecycleTopicFor(symbols, exchange, signalLines) {
  return [
    `exchange:${exchange}`,
    `symbols:${symbols.join(',')}`,
    signalLines,
  ].filter(Boolean).join(' | ');
}

export async function buildLunaLifecyclePromptBlock({ symbols, exchange, signalLines, lifecycleBuilder = buildLifecyclePromptContext } = {}) {
  try {
    const context = await lifecycleBuilder({
      team: 'investment',
      agent: 'luna',
      topic: lifecycleTopicFor(symbols || [], exchange, signalLines),
      enabled: process.env.LUNA_LIFECYCLE_INJECT_ENABLED === 'true',
      telemetry: {
        stage: 'luna_portfolio_decision_prompt',
        exchange,
        symbolCount: Array.isArray(symbols) ? symbols.length : 0,
      },
    });
    return context?.promptBlock || '';
  } catch {
    return '';
  }
}

export async function buildPortfolioDecisionPromptParts(symbolDecisions, portfolio, exchange = 'binance', exitSummary = null, {
  maxPosCount = 5,
  buildPortfolioPrompt,
  lifecycleBuilder = buildLifecyclePromptContext,
} = {}) {
  const symbols = [...new Set(symbolDecisions.map(s => s.symbol))];
  const signalLines = symbolDecisions
    .map(s => {
      const route = s.strategy_route || s.strategyRoute || null;
      const routeText = route?.selectedFamily
        ? ` | 전략 ${route.selectedFamily}/${route.quality || 'unknown'}(${Number(route.readinessScore || 0).toFixed(2)})`
        : '';
      return `${s.symbol}: ${s.action} | 확신도 ${((s.confidence || 0) * 100).toFixed(0)}%${routeText} | ${s.reasoning}`;
    })
    .join('\n');

  let regimeSection = '';
  try {
    const regime = await getMarketRegime(exchange);
    regimeSection = formatMarketRegime(regime);
  } catch {}

  const exitSection = exitSummary?.closedCount
    ? [
        `=== EXIT Phase 결과 ===`,
        `방금 ${exitSummary.closedCount}개 포지션을 청산했습니다.`,
        ...(Array.isArray(exitSummary.closedPositions) ? exitSummary.closedPositions.map(item => {
          const reclaimed = Number(item.reclaimedUsdt || 0);
          const reclaimedText = reclaimed > 0 ? ` | 회수 $${reclaimed.toFixed(2)}` : '';
          return `- ${item.symbol}: ${item.reason || '청산'}${reclaimedText}`;
        }) : []),
        `회수된 USDT: $${Number(exitSummary.reclaimedUsdt || 0).toFixed(2)}`,
        ``,
      ].join('\n')
    : '';
  const lifecyclePromptBlock = await buildLunaLifecyclePromptBlock({
    symbols,
    exchange,
    signalLines,
    lifecycleBuilder,
  });

  const userMsg = [
    `=== 포트폴리오 현황 ===`,
    `USDT 가용: $${portfolio.usdtFree.toFixed(2)} | 총자산: $${portfolio.totalAsset.toFixed(2)}`,
    `현재 포지션: ${portfolio.positionCount}/${maxPosCount}개`,
    `오늘 P&L: ${(portfolio.todayPnl?.pnl || 0) >= 0 ? '+' : ''}$${(portfolio.todayPnl?.pnl || 0).toFixed(2)}`,
    ``,
    regimeSection,
    regimeSection ? `` : '',
    exitSection,
    ...(lifecyclePromptBlock ? [lifecyclePromptBlock, ``] : []),
    `=== 분석가 신호 (${symbols.join(', ')}) ===`,
    signalLines,
    ``,
    `최종 포트폴리오 투자 결정:`,
  ].join('\n');

  return {
    symbols,
    userMsg,
    systemPrompt: buildPortfolioPrompt(symbols, exchange, exitSummary),
  };
}

export default {
  buildPortfolioDecisionPromptParts,
  buildLunaLifecyclePromptBlock,
};
