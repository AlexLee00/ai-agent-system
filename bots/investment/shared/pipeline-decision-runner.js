import { finishPipelineRun } from './pipeline-db.js';
import { getInvestmentNode } from '../nodes/index.js';
import { recordNodeResult, runNode } from './node-runner.js';
import * as db from './db.js';
import { ACTIONS, ANALYST_TYPES, validateSignal } from './signal.js';
import { getDebateLimit, getMinConfidence, getPortfolioDecision, inspectPortfolioContext, shouldDebateForSymbol } from '../team/luna.js';
import { evaluateSignal } from '../team/nemesis.js';
import { notifyError } from './report.js';

function getDecisionNode(id) {
  const node = getInvestmentNode(id);
  if (!node) throw new Error(`노드 없음: ${id}`);
  return node;
}

function buildAnalystSignals(analyses) {
  const getChar = s => !s ? 'N' : s.toUpperCase() === 'BUY' ? 'B' : s.toUpperCase() === 'SELL' ? 'S' : 'N';
  return [
    `A:${getChar(analyses.find(a => a.analyst === ANALYST_TYPES.TA_MTF)?.signal)}`,
    `O:${getChar(analyses.find(a => a.analyst === ANALYST_TYPES.ONCHAIN)?.signal)}`,
    `H:${getChar(analyses.find(a => a.analyst === ANALYST_TYPES.NEWS)?.signal)}`,
    `S:${getChar(analyses.find(a => a.analyst === ANALYST_TYPES.SENTIMENT)?.signal)}`,
  ].join('|');
}

export async function runDecisionExecutionPipeline({
  sessionId,
  symbols,
  exchange,
  portfolio = null,
  analystWeights,
  params = null,
} = {}) {
  const startedAt = Date.now();
  const currentPortfolio = portfolio || await inspectPortfolioContext(exchange);
  const l10Node = getDecisionNode('L10');
  const l11Node = getDecisionNode('L11');
  const l12Node = getDecisionNode('L12');
  const l13Node = getDecisionNode('L13');
  const l14Node = getDecisionNode('L14');
  const l21Node = getDecisionNode('L21');
  const l30Node = getDecisionNode('L30');
  const l31Node = getDecisionNode('L31');
  const l32Node = getDecisionNode('L32');
  const l33Node = getDecisionNode('L33');
  const l34Node = getDecisionNode('L34');

  const symbolDecisions = [];
  const symbolAnalysesMap = new Map();
  let debateCount = 0;
  const debateLimit = getDebateLimit(exchange);
  let riskRejected = 0;
  let weakSignalSkipped = 0;
  let invalidSignalSkipped = 0;

  const buildMetrics = (extra = {}) => ({
    durationMs: Date.now() - startedAt,
    inputSymbols: symbols.length,
    decidedSymbols: symbolDecisions.length,
    executedSymbols: extra.executedSymbols ?? 0,
    debateCount,
    debateLimit,
    riskRejected,
    weakSignalSkipped,
    invalidSignalSkipped,
    savedExecutionWork: riskRejected * 5,
    warnings: buildDecisionWarnings({
      symbols,
      debateCount,
      debateLimit,
      riskRejected,
      weakSignalSkipped,
    }),
    ...extra,
  });

  for (const symbol of symbols) {
    try {
      const analyses = await db.getRecentAnalysis(symbol, 70, exchange);
      if (analyses.length === 0) continue;
      symbolAnalysesMap.set(symbol, analyses);

      await runNode(l10Node, {
        sessionId,
        market: exchange,
        symbol,
        meta: { bridge: 'luna_orchestrate', stage: 'fusion' },
      });

      if (debateCount < debateLimit && shouldDebateForSymbol(analyses, exchange, analystWeights)) {
        try {
          await runNode(l11Node, {
            sessionId,
            market: exchange,
            symbol,
            meta: { bridge: 'luna_orchestrate', stage: 'debate' },
          });
          await runNode(l12Node, {
            sessionId,
            market: exchange,
            symbol,
            meta: { bridge: 'luna_orchestrate', stage: 'debate' },
          });
          debateCount++;
        } catch (err) {
          console.warn(`  ⚠️ [노드 브리지] ${symbol} debate 노드 실패: ${err.message}`);
        }
      }

      const decisionResult = await runNode(l13Node, {
        sessionId,
        market: exchange,
        symbol,
        meta: { bridge: 'luna_orchestrate', stage: 'decision' },
      });
      const decision = decisionResult.result?.decision;
      if (!decision?.action) continue;
      symbolDecisions.push({ symbol, exchange, ...decision });
    } catch (err) {
      console.error(`  ❌ [노드 브리지] ${symbol} 판단 실패: ${err.message}`);
      await notifyError(`루나 노드 브리지 - ${symbol}`, err);
    }
  }

  if (symbolDecisions.length === 0) {
    await finishPipelineRun(sessionId, {
      status: 'completed',
      meta: { bridge_status: 'no_symbol_decisions' },
    });
    return {
      results: [],
      metrics: buildMetrics({
        bridgeStatus: 'no_symbol_decisions',
        executedSymbols: 0,
      }),
    };
  }

  const portfolioDecisionResult = await runNode(l14Node, {
    sessionId,
    market: exchange,
    meta: { bridge: 'luna_orchestrate', stage: 'portfolio' },
    symbolDecisions,
    portfolio: currentPortfolio,
  });
  const portfolioDecision = portfolioDecisionResult.result?.portfolioDecision;
  if (!portfolioDecision) {
    await finishPipelineRun(sessionId, {
      status: 'failed',
      meta: { bridge_status: 'portfolio_decision_failed' },
    });
    return {
      results: [],
      metrics: buildMetrics({
        bridgeStatus: 'portfolio_decision_failed',
        executedSymbols: 0,
      }),
    };
  }

  const results = [];
  for (const dec of (portfolioDecision.decisions || [])) {
    if (dec.action === ACTIONS.HOLD) continue;
    const minConf = params?.minSignalScore ?? getMinConfidence(exchange);
    if ((dec.confidence || 0) < minConf) {
      weakSignalSkipped++;
      continue;
    }

    const analyses = symbolAnalysesMap.get(dec.symbol) || [];
    const analystSignals = buildAnalystSignals(analyses);
    const signalData = {
      symbol: dec.symbol,
      action: dec.action,
      amountUsdt: dec.amount_usdt || (exchange === 'binance' ? 100 : 500),
      confidence: dec.confidence,
      reasoning: `[루나] ${dec.reasoning}`,
      exchange,
      analystSignals,
    };
    const { valid } = validateSignal(signalData);
    if (!valid) {
      invalidSignalSkipped++;
      continue;
    }

    const taAnalysis = analyses.find(a => a.metadata?.atrRatio != null);
    const riskResult = await evaluateSignal({
      symbol: dec.symbol,
      action: dec.action,
      amount_usdt: signalData.amountUsdt,
      confidence: dec.confidence,
      reasoning: signalData.reasoning,
      exchange,
    }, {
      totalUsdt: currentPortfolio.totalAsset,
      atrRatio: taAnalysis?.metadata?.atrRatio ?? null,
      currentPrice: taAnalysis?.metadata?.currentPrice ?? null,
      persist: false,
    }).catch(err => ({ approved: false, reason: err.message, error: true }));

    await recordNodeResult(l21Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      meta: { bridge: 'luna_orchestrate', stage: 'risk' },
    }, {
      symbol: dec.symbol,
      market: exchange,
      decision: dec,
      portfolio: {
        totalAsset: currentPortfolio.totalAsset,
        positionCount: currentPortfolio.positionCount,
        usdtFree: currentPortfolio.usdtFree,
      },
      risk: riskResult,
    });

    if (!riskResult?.approved) {
      riskRejected++;
      results.push({
        symbol: dec.symbol,
        action: dec.action,
        confidence: dec.confidence,
        reasoning: dec.reasoning,
        adjustedAmount: null,
        signalId: null,
        skipped: true,
        skipReason: riskResult?.reason || 'risk_rejected',
        risk: riskResult,
      });
      continue;
    }

    const saved = await runNode(l30Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      meta: { bridge: 'luna_orchestrate', stage: 'execute' },
    });

    const ragStore = await runNode(l33Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      meta: { bridge: 'luna_orchestrate', stage: 'execute' },
    });

    const notify = await runNode(l32Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      meta: { bridge: 'luna_orchestrate', stage: 'execute' },
      storeArtifact: false,
    });

    const execute = await runNode(l31Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      meta: { bridge: 'luna_orchestrate', stage: 'execute' },
    });

    const journal = await runNode(l34Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      meta: { bridge: 'luna_orchestrate', stage: 'journal' },
      storeArtifact: false,
    });

    results.push({
      symbol: dec.symbol,
      action: dec.action,
      confidence: dec.confidence,
      reasoning: dec.reasoning,
      adjustedAmount: riskResult?.approved ? riskResult.adjustedAmount : null,
      signalId: saved.result?.signalId ?? null,
      notify: notify.result,
      ragStore: ragStore.result,
      execution: execute.result,
      journal: journal.result,
    });
  }

  await finishPipelineRun(sessionId, {
    status: 'completed',
    meta: {
      bridge_status: 'completed',
      decided_symbols: symbolDecisions.length,
      executed_symbols: results.filter(item => !item.skipped).length,
      portfolio_view: portfolioDecision.portfolio_view,
      risk_level: portfolioDecision.risk_level,
    },
  });

  return {
    results,
    metrics: buildMetrics({
      bridgeStatus: 'completed',
      executedSymbols: results.filter(item => !item.skipped).length,
    }),
  };
}

export default {
  runDecisionExecutionPipeline,
};

function buildDecisionWarnings({ symbols, debateCount, debateLimit, riskRejected, weakSignalSkipped }) {
  const warnings = [];
  if (symbols.length >= 20 && debateCount >= Math.max(1, debateLimit - 1)) warnings.push('debate_capacity_hot');
  if (riskRejected >= 5) warnings.push('risk_reject_saved_work');
  if (weakSignalSkipped >= 10) warnings.push('weak_signal_pressure');
  return warnings;
}
