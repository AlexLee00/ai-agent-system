import { finishPipelineRun } from './pipeline-db.js';
import { getInvestmentNode } from '../nodes/index.js';
import { recordNodeResult, runNode } from './node-runner.js';
import * as db from './db.js';
import { ACTIONS, ANALYST_TYPES, validateSignal } from './signal.js';
import { getDebateLimit, getExitDecisions, getMinConfidence, getPortfolioDecision, inspectPortfolioContext, shouldDebateForSymbol } from '../team/luna.js';
import { evaluateSignal } from '../team/nemesis.js';
import { notifyError } from './report.js';
import { loadAnalysesForSession } from '../nodes/helpers.js';
import { getInvestmentTradeMode } from './secrets.js';

function getDecisionNode(id) {
  const node = getInvestmentNode(id);
  if (!node) throw new Error(`노드 없음: ${id}`);
  return node;
}

function isActuallyExecuted(resultItem) {
  const execution = resultItem?.execution;
  if (!execution || execution.skipped) return false;
  if (execution.trade) return true;
  if (execution.signalStatus === 'executed') return true;
  if (execution.execution?.success && !execution.execution?.absorbed) return true;
  return false;
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

function classifyWeakSignalReason(confidence, minConfidence) {
  const gap = Number(minConfidence || 0) - Number(confidence || 0);
  if (gap <= 0.03) return 'confidence_near_threshold';
  if (gap <= 0.08) return 'confidence_mid_gap';
  return 'confidence_far_below_threshold';
}

function isMidGapPromotionCandidate({ exchange, investmentTradeMode, decision, weakReason }) {
  return exchange === 'binance'
    && investmentTradeMode === 'validation'
    && weakReason === 'confidence_mid_gap'
    && decision?.action === ACTIONS.BUY;
}

function buildMidGapPromotedAmount(amountUsdt, exchange) {
  const numeric = Number(amountUsdt || (exchange === 'binance' ? 100 : 500));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return exchange === 'binance' ? 50 : 500;
  }
  if (exchange === 'binance') {
    return Math.max(50, Math.round(numeric * 0.5));
  }
  return numeric;
}

async function executeApprovedDecision({
  decision,
  sessionId,
  exchange,
  currentPortfolio,
  symbolAnalysesMap,
  l21Node,
  l30Node,
  l31Node,
  l32Node,
  l33Node,
  l34Node,
  riskRejectReasons,
  stage = 'execute',
  analystSignalsOverride = null,
}) {
  const analyses = symbolAnalysesMap.get(decision.symbol) || [];
  const analystSignals = analystSignalsOverride || buildAnalystSignals(analyses);
  const isFullExitSell = stage === 'exit' && decision.action === ACTIONS.SELL && Number(decision.amount_usdt) === 0;
  const amountUsdt = decision.amount_usdt ?? (exchange === 'binance' ? 100 : 500);
  const signalData = {
    symbol: decision.symbol,
    action: decision.action,
    amountUsdt,
    confidence: decision.confidence,
    reasoning: `[루나] ${decision.reasoning}`,
    exchange,
    analystSignals,
  };
  const { valid } = validateSignal(signalData);
  if (!valid && !isFullExitSell) {
    return {
      symbol: decision.symbol,
      action: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      adjustedAmount: null,
      signalId: null,
      skipped: true,
      skipReason: 'invalid_signal',
      risk: null,
      stage,
      invalidSignal: true,
    };
  }

  const taAnalysis = analyses.find(a => a.metadata?.atrRatio != null);
  const riskResult = await evaluateSignal({
    symbol: decision.symbol,
    action: decision.action,
    amount_usdt: signalData.amountUsdt,
    confidence: decision.confidence,
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
    symbol: decision.symbol,
    meta: { bridge: 'luna_orchestrate', stage },
  }, {
    symbol: decision.symbol,
    market: exchange,
    decision: {
      ...decision,
      analyst_signals: analystSignals,
    },
    portfolio: {
      totalAsset: currentPortfolio.totalAsset,
      positionCount: currentPortfolio.positionCount,
      usdtFree: currentPortfolio.usdtFree,
    },
    risk: riskResult,
  });

  if (!riskResult?.approved) {
    const riskReason = String(riskResult?.reason || 'risk_rejected');
    riskRejectReasons[riskReason] = (riskRejectReasons[riskReason] || 0) + 1;
    return {
      symbol: decision.symbol,
      action: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      adjustedAmount: null,
      signalId: null,
      skipped: true,
      skipReason: riskReason,
      risk: riskResult,
      stage,
    };
  }

  const saved = await runNode(l30Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    meta: { bridge: 'luna_orchestrate', stage },
  });

  const ragStore = await runNode(l33Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    meta: { bridge: 'luna_orchestrate', stage },
  });

  const notify = await runNode(l32Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    meta: { bridge: 'luna_orchestrate', stage },
    storeArtifact: false,
  });

  const execute = await runNode(l31Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    meta: { bridge: 'luna_orchestrate', stage },
  });

  const journal = await runNode(l34Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    meta: { bridge: 'luna_orchestrate', stage },
    storeArtifact: false,
  });

  const signalId = saved.result?.signalId ?? null;
  const signalStatus = execute.result?.signalStatus ?? null;
  const signalBlockCode = execute.result?.signalBlockCode ?? null;
  const signalBlockReason = execute.result?.signalBlockReason ?? null;
  const signalBlockMeta = execute.result?.signalBlockMeta ?? null;

  if (stage === 'exit' && signalId && signalBlockCode === 'sell_amount_below_minimum') {
    await db.updateSignalBlock(signalId, {
      status: 'skipped_below_min',
      reason: signalBlockReason || '최소 수량 미달',
      code: signalBlockCode,
      meta: {
        ...(signalBlockMeta || {}),
        stage,
        skippedBy: 'exit_phase',
      },
    }).catch(() => {});

    return {
      symbol: decision.symbol,
      action: decision.action,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      adjustedAmount: riskResult.adjustedAmount ?? null,
      signalId,
      skipped: true,
      skipReason: 'exit_below_minimum',
      signalStatus: 'skipped_below_min',
      blockCode: signalBlockCode,
      notify: notify.result,
      ragStore: ragStore.result,
      execution: execute.result,
      journal: journal.result,
      stage,
    };
  }

  return {
    symbol: decision.symbol,
    action: decision.action,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
    adjustedAmount: riskResult.adjustedAmount ?? null,
    signalId,
    signalStatus,
    blockCode: signalBlockCode,
    notify: notify.result,
    ragStore: ragStore.result,
    execution: execute.result,
    journal: journal.result,
    stage,
  };
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
  const investmentTradeMode = getInvestmentTradeMode();
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
  const riskRejectReasons = {};
  let weakSignalSkipped = 0;
  const weakSignalReasons = {};
  let midGapPromoted = 0;
  let midGapRejectedByRisk = 0;
  let invalidSignalSkipped = 0;
  let portfolioDecision = null;
  let exitPhaseEvaluated = 0;
  let exitPhaseSellSignals = 0;
  let exitPhaseExecuted = 0;
  let exitBelowMinSkipped = 0;
  const exitResults = [];

  function countDecisionActions() {
    const counts = { buy: 0, sell: 0, hold: 0 };
    for (const decision of (portfolioDecision?.decisions || [])) {
      if (decision.action === ACTIONS.BUY) counts.buy += 1;
      else if (decision.action === ACTIONS.SELL) counts.sell += 1;
      else counts.hold += 1;
    }
    return counts;
  }

  const buildMetrics = (extra = {}) => ({
    durationMs: Date.now() - startedAt,
    inputSymbols: symbols.length,
    decidedSymbols: symbolDecisions.length,
    approvedSignals: extra.approvedSignals ?? 0,
    executedSymbols: extra.executedSymbols ?? 0,
    debateCount,
    debateLimit,
    riskRejected,
    riskRejectReasons: { ...riskRejectReasons },
    weakSignalSkipped,
    weakSignalReasons: { ...weakSignalReasons },
    midGapPromoted,
    midGapRejectedByRisk,
    invalidSignalSkipped,
    exitPhaseEvaluated,
    exitPhaseSellSignals,
    exitPhaseExecuted,
    exitBelowMinSkipped,
    savedExecutionWork: riskRejected * 5,
    warnings: buildDecisionWarnings({
      symbols,
      debateCount,
      debateLimit,
      riskRejected,
      weakSignalSkipped,
      midGapPromoted,
    }),
    ...extra,
  });

  function getTopRiskRejectReason() {
    const entries = Object.entries(riskRejectReasons);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }

  function getTopWeakSignalReason() {
    const entries = Object.entries(weakSignalReasons);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }

  const openPositions = await db.getOpenPositions(exchange, false, investmentTradeMode).catch(() => []);
  if (openPositions.length > 0) {
    console.log(`\n🔴 [EXIT Phase] ${openPositions.length}개 보유 포지션 청산 판단...`);
    try {
      const exitDecisionResult = await getExitDecisions(openPositions, exchange);
      const exitDecisions = Array.isArray(exitDecisionResult?.decisions) ? exitDecisionResult.decisions : [];
      exitPhaseEvaluated = exitDecisions.length;

      for (const dec of exitDecisions) {
        if (dec.action !== ACTIONS.SELL) continue;
        exitPhaseSellSignals++;

        const exitDecision = {
          symbol: dec.symbol,
          action: ACTIONS.SELL,
          amount_usdt: 0,
          confidence: dec.confidence,
          reasoning: `[EXIT] ${dec.reasoning}`,
          exit_type: dec.exit_type || 'normal_exit',
        };

        await recordNodeResult(l13Node, {
          sessionId,
          market: exchange,
          symbol: dec.symbol,
          meta: { bridge: 'luna_orchestrate', stage: 'exit' },
        }, {
          symbol: dec.symbol,
          market: exchange,
          decision: exitDecision,
          analystSignals: 'EXIT_PHASE',
          exitView: exitDecisionResult?.exit_view || null,
        });

        const exitResult = await executeApprovedDecision({
          decision: exitDecision,
          sessionId,
          exchange,
          currentPortfolio,
          symbolAnalysesMap,
          l21Node,
          l30Node,
          l31Node,
          l32Node,
          l33Node,
          l34Node,
          riskRejectReasons,
          stage: 'exit',
          analystSignalsOverride: 'EXIT_PHASE',
        });

        if (exitResult?.invalidSignal) {
          invalidSignalSkipped++;
          continue;
        }
        if (exitResult) exitResults.push(exitResult);
        if (exitResult?.skipReason === 'exit_below_minimum') {
          exitBelowMinSkipped++;
          console.log(`⏭️ [EXIT] ${dec.symbol} 최소 수량 미달 — 스킵`);
          continue;
        }
        if (exitResult?.skipReason) {
          riskRejected++;
        }
        if (isActuallyExecuted(exitResult)) exitPhaseExecuted++;
      }

      console.log(`✅ [EXIT Phase] 완료: ${exitPhaseSellSignals}건 SELL / 실행 ${exitPhaseExecuted}건`);
    } catch (err) {
      console.error(`  ❌ [EXIT Phase] 실패: ${err.message}`);
      await notifyError(`루나 EXIT Phase - ${exchange}`, err);
    }
  }

  for (const symbol of symbols) {
    try {
      const analysisLoad = await loadAnalysesForSession(sessionId, symbol, exchange);
      const analyses = analysisLoad.analyses || [];
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
    const metrics = buildMetrics({
      bridgeStatus: 'no_symbol_decisions',
      approvedSignals: exitResults.filter(item => !item.skipped).length,
      executedSymbols: exitResults.filter(isActuallyExecuted).length,
    });
    await finishPipelineRun(sessionId, {
      status: 'completed',
      meta: {
        bridge_status: 'no_symbol_decisions',
        decided_symbols: 0,
        executed_symbols: metrics.executedSymbols,
        decision_count: 0,
        buy_decisions: 0,
        sell_decisions: 0,
        hold_decisions: 0,
        approved_signals: metrics.approvedSignals,
        debate_count: metrics.debateCount,
        debate_limit: metrics.debateLimit,
        risk_rejected: metrics.riskRejected,
        risk_reject_reason_top: null,
        risk_reject_reasons: {},
        weak_signal_skipped: metrics.weakSignalSkipped,
        weak_signal_reason_top: null,
        weak_signal_reasons: {},
        mid_gap_promoted: metrics.midGapPromoted,
        mid_gap_rejected_by_risk: metrics.midGapRejectedByRisk,
        mid_gap_executed: 0,
        invalid_signal_skipped: metrics.invalidSignalSkipped,
        exit_phase_evaluated: metrics.exitPhaseEvaluated,
        exit_phase_sell_signals: metrics.exitPhaseSellSignals,
        exit_phase_executed: metrics.exitPhaseExecuted,
        exit_below_min_skipped: metrics.exitBelowMinSkipped,
        saved_execution_work: metrics.savedExecutionWork,
        warnings: metrics.warnings,
        investment_trade_mode: investmentTradeMode,
      },
    });
    return {
      results: exitResults,
      metrics,
    };
  }

  const portfolioDecisionResult = await runNode(l14Node, {
    sessionId,
    market: exchange,
    meta: { bridge: 'luna_orchestrate', stage: 'portfolio' },
    symbolDecisions,
    portfolio: currentPortfolio,
  });
  portfolioDecision = portfolioDecisionResult.result?.portfolioDecision;
  if (!portfolioDecision) {
    const metrics = buildMetrics({
      bridgeStatus: 'portfolio_decision_failed',
      executedSymbols: 0,
    });
    await finishPipelineRun(sessionId, {
      status: 'failed',
      meta: {
        bridge_status: 'portfolio_decision_failed',
        decided_symbols: symbolDecisions.length,
        executed_symbols: 0,
        decision_count: 0,
        buy_decisions: 0,
        sell_decisions: 0,
        hold_decisions: 0,
        debate_count: metrics.debateCount,
        debate_limit: metrics.debateLimit,
        risk_rejected: metrics.riskRejected,
        risk_reject_reason_top: null,
        risk_reject_reasons: {},
        weak_signal_skipped: metrics.weakSignalSkipped,
        weak_signal_reason_top: null,
        weak_signal_reasons: {},
        mid_gap_promoted: metrics.midGapPromoted,
        mid_gap_rejected_by_risk: metrics.midGapRejectedByRisk,
        mid_gap_executed: 0,
        invalid_signal_skipped: metrics.invalidSignalSkipped,
        exit_phase_evaluated: metrics.exitPhaseEvaluated,
        exit_phase_sell_signals: metrics.exitPhaseSellSignals,
        exit_phase_executed: metrics.exitPhaseExecuted,
        exit_below_min_skipped: metrics.exitBelowMinSkipped,
        saved_execution_work: metrics.savedExecutionWork,
        warnings: metrics.warnings,
        investment_trade_mode: investmentTradeMode,
      },
    });
    return {
      results: [],
      metrics,
    };
  }

  const actionCounts = countDecisionActions();

  const results = [...exitResults];
  for (const dec of (portfolioDecision.decisions || [])) {
    if (dec.action === ACTIONS.HOLD) continue;
    const runtimeMinConf = getMinConfidence(exchange);
    const minConf = exchange === 'binance'
      ? Math.min(params?.minSignalScore ?? runtimeMinConf, runtimeMinConf)
      : (params?.minSignalScore ?? runtimeMinConf);
    let midGapPromotedCandidate = false;
    if ((dec.confidence || 0) < minConf) {
      const weakReason = classifyWeakSignalReason(dec.confidence, minConf);
      if (isMidGapPromotionCandidate({
        exchange,
        investmentTradeMode,
        decision: dec,
        weakReason,
      })) {
        midGapPromoted++;
        midGapPromotedCandidate = true;
      } else {
        weakSignalSkipped++;
        weakSignalReasons[weakReason] = (weakSignalReasons[weakReason] || 0) + 1;
        continue;
      }
    }

    const analyses = symbolAnalysesMap.get(dec.symbol) || [];
    const analystSignals = buildAnalystSignals(analyses);
    const amountUsdt = midGapPromotedCandidate
      ? buildMidGapPromotedAmount(dec.amount_usdt, exchange)
      : (dec.amount_usdt || (exchange === 'binance' ? 100 : 500));
    const signalData = {
      symbol: dec.symbol,
      action: dec.action,
      amountUsdt,
      confidence: dec.confidence,
      reasoning: midGapPromotedCandidate
        ? `[루나] mid-gap validation 승격 | ${dec.reasoning}`
        : `[루나] ${dec.reasoning}`,
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
      if (midGapPromotedCandidate) midGapRejectedByRisk++;
      const riskReason = String(riskResult?.reason || 'risk_rejected');
      riskRejectReasons[riskReason] = (riskRejectReasons[riskReason] || 0) + 1;
      results.push({
        symbol: dec.symbol,
        action: dec.action,
        confidence: dec.confidence,
        reasoning: dec.reasoning,
        adjustedAmount: null,
        signalId: null,
        skipped: true,
        skipReason: riskReason,
        risk: riskResult,
        midGapPromoted: midGapPromotedCandidate,
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
      midGapPromoted: midGapPromotedCandidate,
    });
  }

  const completedMetrics = buildMetrics({
    bridgeStatus: 'completed',
    approvedSignals: results.filter(item => !item.skipped).length,
    executedSymbols: results.filter(isActuallyExecuted).length,
    midGapExecuted: results.filter(item => item.midGapPromoted && isActuallyExecuted(item)).length,
  });
  await finishPipelineRun(sessionId, {
    status: 'completed',
    meta: {
      bridge_status: 'completed',
      decided_symbols: symbolDecisions.length,
      decision_count: (portfolioDecision.decisions || []).length,
      buy_decisions: actionCounts.buy,
      sell_decisions: actionCounts.sell,
      hold_decisions: actionCounts.hold,
      approved_signals: completedMetrics.approvedSignals,
      executed_symbols: completedMetrics.executedSymbols,
      portfolio_view: portfolioDecision.portfolio_view,
      risk_level: portfolioDecision.risk_level,
      debate_count: completedMetrics.debateCount,
      debate_limit: completedMetrics.debateLimit,
      risk_rejected: completedMetrics.riskRejected,
      risk_reject_reason_top: getTopRiskRejectReason(),
      risk_reject_reasons: completedMetrics.riskRejectReasons,
      weak_signal_skipped: completedMetrics.weakSignalSkipped,
      weak_signal_reason_top: getTopWeakSignalReason(),
      weak_signal_reasons: completedMetrics.weakSignalReasons,
      mid_gap_promoted: completedMetrics.midGapPromoted,
      mid_gap_rejected_by_risk: completedMetrics.midGapRejectedByRisk,
      mid_gap_executed: completedMetrics.midGapExecuted,
      invalid_signal_skipped: completedMetrics.invalidSignalSkipped,
      exit_phase_evaluated: completedMetrics.exitPhaseEvaluated,
      exit_phase_sell_signals: completedMetrics.exitPhaseSellSignals,
      exit_phase_executed: completedMetrics.exitPhaseExecuted,
      exit_below_min_skipped: completedMetrics.exitBelowMinSkipped,
      saved_execution_work: completedMetrics.savedExecutionWork,
      warnings: completedMetrics.warnings,
      investment_trade_mode: investmentTradeMode,
    },
  });

  return {
    results,
    metrics: completedMetrics,
  };
}

export default {
  runDecisionExecutionPipeline,
};

function buildDecisionWarnings({ symbols, debateCount, debateLimit, riskRejected, weakSignalSkipped, midGapPromoted }) {
  const warnings = [];
  if (symbols.length >= 20 && debateCount >= Math.max(1, debateLimit - 1)) warnings.push('debate_capacity_hot');
  if (riskRejected >= 5) warnings.push('risk_reject_saved_work');
  if (weakSignalSkipped >= 10) warnings.push('weak_signal_pressure');
  if (midGapPromoted >= 3) warnings.push('mid_gap_validation_promoted');
  return warnings;
}
