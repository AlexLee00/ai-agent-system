import { finishPipelineRun } from './pipeline-db.js';
import { getInvestmentNode } from '../nodes/index.js';
import { recordNodeResult, runNode } from './node-runner.js';
import * as db from './db.js';
import { ACTIONS, ANALYST_TYPES, SIGNAL_STATUS, validateSignal } from './signal.js';
import { getPortfolioDecision, getSymbolDecision, inspectPortfolioContext } from '../team/luna.js';
import { evaluateSignal } from '../team/nemesis.js';
import { buildAnalysisSummary } from '../team/luna.js';
import { runBullResearcher } from '../team/zeus.js';
import { runBearResearcher } from '../team/athena.js';
import { notifyError } from './report.js';

const MAX_DEBATE_SYMBOLS = 2;

function getDecisionNode(id) {
  const node = getInvestmentNode(id);
  if (!node) throw new Error(`노드 없음: ${id}`);
  return node;
}

async function runDebateRound(symbol, summary, exchange, prevDebate = null) {
  if (!prevDebate) {
    const [bull, bear] = await Promise.all([
      runBullResearcher(symbol, summary, null, exchange),
      runBearResearcher(symbol, summary, null, exchange),
    ]);
    return { bull, bear, round: 1 };
  }

  const bullCtx = prevDebate.bear
    ? `${summary}\n\n[약세 주장 반박 요청]\n${prevDebate.bear.reasoning}`
    : summary;
  const bearCtx = prevDebate.bull
    ? `${summary}\n\n[강세 주장 반박 요청]\n${prevDebate.bull.reasoning}`
    : summary;

  const [bull2, bear2] = await Promise.all([
    runBullResearcher(symbol, bullCtx, null, exchange),
    runBearResearcher(symbol, bearCtx, null, exchange),
  ]);
  return { bull: bull2, bear: bear2, round: 2 };
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
  const currentPortfolio = portfolio || await inspectPortfolioContext(exchange);
  const l13Node = getDecisionNode('L13');
  const l21Node = getDecisionNode('L21');
  const l30Node = getDecisionNode('L30');
  const l31Node = getDecisionNode('L31');
  const l34Node = getDecisionNode('L34');

  const symbolDecisions = [];
  const symbolAnalysesMap = new Map();
  let debateCount = 0;

  for (const symbol of symbols) {
    try {
      const analyses = await db.getRecentAnalysis(symbol, 70, exchange);
      if (analyses.length === 0) continue;
      symbolAnalysesMap.set(symbol, analyses);

      let debate = null;
      if (debateCount < MAX_DEBATE_SYMBOLS) {
        try {
          const summary = buildAnalysisSummary(analyses);
          const r1 = await runDebateRound(symbol, summary, exchange, null);
          const r2 = await runDebateRound(symbol, summary, exchange, r1);
          debate = { bull: r2.bull, bear: r2.bear, r1 };
          debateCount++;
        } catch (err) {
          console.warn(`  ⚠️ [노드 브리지] ${symbol} debate 실패: ${err.message}`);
        }
      }

      const decision = await getSymbolDecision(symbol, analyses, exchange, debate, analystWeights);
      symbolDecisions.push({ symbol, exchange, ...decision });

      await recordNodeResult(l13Node, {
        sessionId,
        market: exchange,
        symbol,
        meta: { bridge: 'luna_orchestrate', stage: 'decision' },
      }, {
        symbol,
        market: exchange,
        source: 'bridge',
        analyses_count: analyses.length,
        decision,
        debate,
      });
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
    return [];
  }

  const portfolioDecision = await getPortfolioDecision(symbolDecisions, currentPortfolio, exchange);
  if (!portfolioDecision) {
    await finishPipelineRun(sessionId, {
      status: 'failed',
      meta: { bridge_status: 'portfolio_decision_failed' },
    });
    return [];
  }

  const results = [];
  for (const dec of (portfolioDecision.decisions || [])) {
    if (dec.action === ACTIONS.HOLD) continue;
    const minConf = params?.minSignalScore ?? (exchange === 'binance' ? 0.55 : 0.35);
    if ((dec.confidence || 0) < minConf) continue;

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
    if (!valid) continue;

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

    const saved = await runNode(l30Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      meta: { bridge: 'luna_orchestrate', stage: 'execute' },
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
    });

    results.push({
      symbol: dec.symbol,
      action: dec.action,
      confidence: dec.confidence,
      reasoning: dec.reasoning,
      adjustedAmount: riskResult?.approved ? riskResult.adjustedAmount : null,
      signalId: saved.result?.signalId ?? null,
      execution: execute.result,
      journal: journal.result,
    });
  }

  await finishPipelineRun(sessionId, {
    status: 'completed',
    meta: {
      bridge_status: 'completed',
      decided_symbols: symbolDecisions.length,
      executed_symbols: results.length,
      portfolio_view: portfolioDecision.portfolio_view,
      risk_level: portfolioDecision.risk_level,
    },
  });

  return results;
}

export default {
  runDecisionExecutionPipeline,
};
