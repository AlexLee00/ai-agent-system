// @ts-nocheck
import { finishPipelineRun } from './pipeline-db.ts';
import { getPipelineRun } from './pipeline-db.ts';
import { getInvestmentNode } from '../nodes/index.ts';
import { recordNodeResult, runNode } from './node-runner.ts';
import * as db from './db.ts';
import { ACTIONS, validateSignal } from './signal.ts';
import { getDebateLimit, getExitDecisions, getMinConfidence, inspectPortfolioContext, shouldDebateForSymbol } from '../team/luna.ts';
import { evaluateSignal } from '../team/nemesis.ts';
import { notifyError } from './report.ts';
import { loadAnalysesForSession } from '../nodes/helpers.ts';
import { getInvestmentTradeMode } from './secrets.ts';
import { getLunaIntelligentDiscoveryFlags } from './luna-intelligent-discovery-config.ts';
import { ensureLunaDiscoveryEntryTables } from './luna-discovery-entry-store.ts';
import { buildDiscoveryUniverse, toDiscoveryMarket } from '../team/discovery/discovery-universe.ts';
import { runNewsToSymbolMapping } from '../team/discovery/news-to-symbol-mapper.ts';
import { scoreCommunitySentiment } from './community-sentiment.ts';
import { analyzeMultiTimeframe } from './multi-timeframe-analyzer.ts';
import { detectWyckoffPhase } from './wyckoff-phase-detector.ts';
import { classifyVsaBar } from './vsa-bar-classifier.ts';
import { fuseDiscoveryScore } from './discovery-score-fusion.ts';
import { evaluateEntryTriggers } from './entry-trigger-engine.ts';
import { applyPredictiveValidationGate } from './predictive-validation-gate.ts';
import { recordDiscoveryAttribution, buildDiscoveryReflectionSummary } from './discovery-reflection.ts';
import { getOHLCV } from './ohlcv-fetcher.ts';
import { buildDecisionPipelineMetrics, countDecisionActions } from './pipeline-decision-metrics.ts';
import { buildPipelineDecisionFinishMeta } from './pipeline-decision-finish-meta.ts';
import { buildPipelineSymbolCandidate, recordStrategyRouteStats } from './pipeline-symbol-candidate.ts';
import { executeApprovedDecision, persistRiskApprovalRationale } from './pipeline-approved-decision.ts';
import { buildDecisionBridgeMeta, loadDecisionPlannerCompact } from './pipeline-decision-bridge.ts';
import {
  applyCollectQualityGuard,
  applyDiscoveryHardCap,
  applyRuntimeCryptoRepresentativePass,
  buildAnalystSignals,
  buildExitEntryBridgeSummary,
  buildMidGapPromotedAmount,
  buildPredictiveObservationAmount,
  buildPlannerRunMeta,
  classifyWeakSignalReason,
  isActuallyExecuted,
  isExecutionStillApproved,
  isMidGapPromotionCandidate,
  isPredictiveObservationCandidate,
  mergeUniqueSymbols,
  normalizeCollectQuality,
  normalizeRegimeLabel,
} from './pipeline-decision-policy.ts';

function getDecisionNode(id) {
  const node = getInvestmentNode(id);
  if (!node) throw new Error(`노드 없음: ${id}`);
  return node;
}

async function runApprovedDecision(args) {
  return executeApprovedDecision({
    ...args,
    buildDecisionBridgeMeta,
  });
}

export async function runDecisionExecutionStateMachine({
  sessionId,
  symbols,
  exchange,
  portfolio = null,
  analystWeights,
  params = null,
} = {}) {
  const startedAt = Date.now();
  const intelligentFlags = getLunaIntelligentDiscoveryFlags();
  const discoveryMarket = toDiscoveryMarket(exchange);
  let runtimeSymbols = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
  let discoveryCandidates = [];
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

  if (Object.values(intelligentFlags.phases || {}).some(Boolean)) {
    await ensureLunaDiscoveryEntryTables().catch(() => {});
  }

  if (intelligentFlags.phases.discoveryOrchestratorEnabled) {
    const universe = await buildDiscoveryUniverse(discoveryMarket, new Date(), {
      refresh: true,
      fallbackSymbols: runtimeSymbols,
      limit: Math.max(60, runtimeSymbols.length * 4),
    }).catch(() => null);
    if (universe?.symbols?.length) {
      runtimeSymbols = mergeUniqueSymbols(universe.symbols, runtimeSymbols);
    }
    if (Array.isArray(universe?.candidates)) {
      discoveryCandidates = universe.candidates;
    }
  }

  if (intelligentFlags.phases.newsSymbolMappingEnabled) {
    await runNewsToSymbolMapping({
      exchange,
      market: discoveryMarket,
      ttlHours: 24,
    }).catch(() => {});
    const refreshed = await buildDiscoveryUniverse(discoveryMarket, new Date(), {
      refresh: false,
      fallbackSymbols: runtimeSymbols,
      limit: Math.max(60, runtimeSymbols.length * 4),
    }).catch(() => null);
    if (refreshed?.symbols?.length) {
      runtimeSymbols = mergeUniqueSymbols(refreshed.symbols, runtimeSymbols);
    }
    if (Array.isArray(refreshed?.candidates) && refreshed.candidates.length > 0) {
      discoveryCandidates = refreshed.candidates;
    }
  }
  runtimeSymbols = applyDiscoveryHardCap(runtimeSymbols, intelligentFlags.discovery?.maxSymbols || 60);
  const discoveryCandidateBySymbol = new Map((discoveryCandidates || []).map((row) => [String(row.symbol || ''), row]));
  const communitySentimentBySymbol = new Map();
  if (intelligentFlags.phases.communitySentimentEnabled && runtimeSymbols.length > 0) {
    const sentimentRows = await scoreCommunitySentiment(runtimeSymbols, { exchange, minutes: 720 }).catch(() => []);
    for (const row of sentimentRows || []) {
      communitySentimentBySymbol.set(String(row.symbol || ''), row);
    }
  }

  const symbolDecisions = [];
  const symbolAnalysesMap = new Map();
  const intelligentBySymbol = new Map();
  let debateCount = 0;
  const debateLimit = getDebateLimit(exchange, runtimeSymbols.length);
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
  let exitEntrySummary = null;
  let representativeReduction = null;
  const plannerCompact = await loadDecisionPlannerCompact(sessionId);
  const pipelineRun = await getPipelineRun(sessionId).catch(() => null);
  const collectQuality = normalizeCollectQuality(
    pipelineRun?.meta?.collect_quality,
    pipelineRun?.meta?.collect_metrics?.collectQuality,
  );
  let collectQualityReducedBuyCount = 0;
  let collectQualityBlockedBuyCount = 0;
  let entryTriggerStats = null;
  let predictiveValidationStats = null;
  const strategyRouteCounts = {};
  const strategyRouteQualityCounts = {};
  let strategyRouteReadinessSum = 0;
  let strategyRouteReadinessCount = 0;

  const buildMetrics = (extra = {}) => buildDecisionPipelineMetrics({
    startedAt,
    runtimeSymbols,
    symbolDecisions,
    debateCount,
    debateLimit,
    riskRejected,
    riskRejectReasons,
    weakSignalSkipped,
    weakSignalReasons,
    strategyRouteCounts,
    strategyRouteQualityCounts,
    strategyRouteReadinessSum,
    strategyRouteReadinessCount,
    midGapPromoted,
    midGapRejectedByRisk,
    invalidSignalSkipped,
    exitPhaseEvaluated,
    exitPhaseSellSignals,
    exitPhaseExecuted,
    exitBelowMinSkipped,
    representativeReduction,
    collectQuality,
    collectQualityBlockedBuyCount,
    collectQualityReducedBuyCount,
    entryTriggerStats,
    predictiveValidationStats,
    extra,
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
          meta: await buildDecisionBridgeMeta({
            sessionId,
            market: exchange,
            symbol: dec.symbol,
            stage: 'exit',
            planner: plannerCompact,
          }),
        }, {
          symbol: dec.symbol,
          market: exchange,
          decision: exitDecision,
          analystSignals: 'EXIT_PHASE',
          exitView: exitDecisionResult?.exit_view || null,
        });

        const exitResult = await runApprovedDecision({
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
          plannerCompact,
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
      exitEntrySummary = buildExitEntryBridgeSummary(exitResults);
    } catch (err) {
      console.error(`  ❌ [EXIT Phase] 실패: ${err.message}`);
      await notifyError(`루나 EXIT Phase - ${exchange}`, err);
    }
  }

  for (const symbol of runtimeSymbols) {
    try {
      const analysisLoad = await loadAnalysesForSession(sessionId, symbol, exchange);
      const analyses = analysisLoad.analyses || [];
      if (analyses.length === 0) continue;
      symbolAnalysesMap.set(symbol, analyses);

      await runNode(l10Node, {
        sessionId,
        market: exchange,
        symbol,
        meta: await buildDecisionBridgeMeta({
          sessionId,
          market: exchange,
          symbol,
          stage: 'fusion',
          planner: plannerCompact,
        }),
      });

      if (debateCount < debateLimit && shouldDebateForSymbol(analyses, exchange, analystWeights)) {
        try {
          await runNode(l11Node, {
            sessionId,
            market: exchange,
            symbol,
            meta: await buildDecisionBridgeMeta({
              sessionId,
              market: exchange,
              symbol,
              stage: 'debate',
              planner: plannerCompact,
            }),
          });
          await runNode(l12Node, {
            sessionId,
            market: exchange,
            symbol,
            meta: await buildDecisionBridgeMeta({
              sessionId,
              market: exchange,
              symbol,
              stage: 'debate',
              planner: plannerCompact,
            }),
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
        meta: await buildDecisionBridgeMeta({
          sessionId,
          market: exchange,
          symbol,
          stage: 'decision',
          planner: plannerCompact,
        }),
      });
      const decision = decisionResult.result?.decision;
      if (!decision?.action) continue;
      const { enrichedDecision, intelligentState } = await buildPipelineSymbolCandidate({
        symbol,
        exchange,
        decision,
        analyses,
        intelligentFlags,
        currentPortfolio,
        discoveryCandidateBySymbol,
        communitySentimentBySymbol,
        discoveryMarket,
        getOHLCV,
        analyzeMultiTimeframe,
        detectWyckoffPhase,
        classifyVsaBar,
        fuseDiscoveryScore,
        normalizeRegimeLabel,
      });
      intelligentBySymbol.set(symbol, intelligentState);
      const strategyRouteStats = recordStrategyRouteStats(enrichedDecision, {
        strategyRouteCounts,
        strategyRouteQualityCounts,
        strategyRouteReadinessSum,
        strategyRouteReadinessCount,
      });
      strategyRouteReadinessSum = strategyRouteStats.strategyRouteReadinessSum;
      strategyRouteReadinessCount = strategyRouteStats.strategyRouteReadinessCount;
      symbolDecisions.push({ symbol, exchange, ...enrichedDecision });
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
      meta: buildPipelineDecisionFinishMeta({
        bridgeStatus: 'no_symbol_decisions',
        symbolDecisions,
        metrics,
        actionCounts: { buy: 0, sell: 0, hold: 0 },
        decisionCount: 0,
        approvedSignals: metrics.approvedSignals,
        executedSymbols: metrics.executedSymbols,
        exitEntrySummary,
        investmentTradeMode,
        plannerMeta: buildPlannerRunMeta(plannerCompact),
      }),
    });
    return {
      results: exitResults,
      metrics,
    };
  }

  const portfolioDecisionResult = await runNode(l14Node, {
    sessionId,
    market: exchange,
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: exchange,
      stage: 'portfolio',
      planner: plannerCompact,
    }),
    symbolDecisions,
    portfolio: currentPortfolio,
    exitSummary: exitEntrySummary,
  });
  portfolioDecision = portfolioDecisionResult.result?.portfolioDecision;
  if (portfolioDecision) {
    const representativePass = await applyRuntimeCryptoRepresentativePass({
      portfolioDecision,
      exchange,
      investmentTradeMode,
    });
    portfolioDecision = representativePass.decision;
    representativeReduction = representativePass.reduction;
    const collectQualityGuard = applyCollectQualityGuard(portfolioDecision, collectQuality);
    portfolioDecision = collectQualityGuard.portfolioDecision;
    collectQualityReducedBuyCount = collectQualityGuard.reducedBuyCount;
    collectQualityBlockedBuyCount = collectQualityGuard.blockedBuyCount;

    if (intelligentFlags.phases.predictiveValidationEnabled) {
      const predictiveGate = applyPredictiveValidationGate(
        portfolioDecision.decisions || [],
        intelligentFlags.predictive,
      );
      portfolioDecision = {
        ...portfolioDecision,
        decisions: predictiveGate.decisions,
        predictiveValidation: {
          mode: intelligentFlags.predictive.mode,
          threshold: intelligentFlags.predictive.threshold,
          blocked: predictiveGate.blocked,
          advisory: predictiveGate.advisory,
          observation: predictiveGate.observation,
        },
      };
      predictiveValidationStats = portfolioDecision.predictiveValidation;
    }

    if (intelligentFlags.phases.entryTriggerEnabled) {
      const triggerResult = await evaluateEntryTriggers(portfolioDecision.decisions || [], {
        exchange,
        regime: normalizeRegimeLabel(currentPortfolio?.marketRegime || null),
      }).catch(() => null);
      if (triggerResult?.decisions) {
        entryTriggerStats = triggerResult.stats || null;
        portfolioDecision = {
          ...portfolioDecision,
          decisions: triggerResult.decisions,
          entryTriggerStats,
        };
      }
    }
  }
  if (!portfolioDecision) {
    const metrics = buildMetrics({
      bridgeStatus: 'portfolio_decision_failed',
      executedSymbols: 0,
    });
    await finishPipelineRun(sessionId, {
      status: 'failed',
      meta: buildPipelineDecisionFinishMeta({
        bridgeStatus: 'portfolio_decision_failed',
        symbolDecisions,
        metrics,
        actionCounts: { buy: 0, sell: 0, hold: 0 },
        decisionCount: 0,
        executedSymbols: 0,
        exitEntrySummary,
        investmentTradeMode,
        plannerMeta: buildPlannerRunMeta(plannerCompact),
      }),
    });
    return {
      results: [],
      metrics,
    };
  }

  const actionCounts = countDecisionActions(portfolioDecision.decisions || []);

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
    const predictiveObservationCandidate = isPredictiveObservationCandidate(dec);
    const predictiveObservationRatio = dec?.block_meta?.predictiveValidation?.sizeRatio
      ?? intelligentFlags.predictive?.observationSizeRatio
      ?? 0.35;
    const amountUsdt = midGapPromotedCandidate
      ? buildMidGapPromotedAmount(dec.amount_usdt, exchange)
      : predictiveObservationCandidate
        ? buildPredictiveObservationAmount(dec.amount_usdt, exchange, predictiveObservationRatio)
      : (dec.amount_usdt || (exchange === 'binance' ? 100 : 500));
    const effectiveTradeMode = (midGapPromotedCandidate || predictiveObservationCandidate)
      ? 'validation'
      : investmentTradeMode;
    const signalData = {
      symbol: dec.symbol,
      action: dec.action,
      amountUsdt,
      confidence: dec.confidence,
      trade_mode: effectiveTradeMode,
      reasoning: midGapPromotedCandidate
        ? `[루나] mid-gap validation 승격 | ${dec.reasoning}`
        : predictiveObservationCandidate
          ? `[루나] predictive observation 소액 검증 | ${dec.reasoning}`
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
      meta: await buildDecisionBridgeMeta({
        sessionId,
        market: exchange,
        symbol: dec.symbol,
        stage: 'risk',
        regime: riskResult?.strategyConfig?.market_regime || null,
        planner: plannerCompact,
      }),
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
        predictiveObservation: predictiveObservationCandidate,
      });
      continue;
    }

    const saved = await runNode(l30Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      decision: {
        ...dec,
        trade_mode: effectiveTradeMode,
        amount_usdt: amountUsdt,
      },
      risk: riskResult,
      meta: await buildDecisionBridgeMeta({
        sessionId,
        market: exchange,
        symbol: dec.symbol,
        stage: 'execute',
        planner: plannerCompact,
      }),
    });
    if (intelligentFlags.phases.reflectionEnabled && saved?.result?.signalId) {
      const intel = intelligentBySymbol.get(dec.symbol) || {};
      await recordDiscoveryAttribution({
        signalId: saved.result.signalId,
        source: intel?.discoverySeed?.source || dec?.block_meta?.discoveryContext?.source || null,
        setupType: dec?.setup_type || dec?.strategy_route?.setupType || dec?.strategyRoute?.setupType || null,
        triggerType: dec?.block_meta?.entryTrigger?.triggerType || null,
        discoveryScore: Number(intel?.fused?.discoveryScore ?? dec?.predictiveScore ?? dec?.confidence ?? 0),
        predictiveScore: Number(dec?.predictiveScore ?? intel?.predictiveScore ?? 0),
        note: 'approved',
      }).catch(() => null);
    }
    await persistRiskApprovalRationale({
      signalId: saved.result?.signalId ?? null,
      signal: {
        ...signalData,
        symbol: dec.symbol,
        action: dec.action,
        confidence: dec.confidence,
        amount_usdt: signalData.amountUsdt,
      },
      riskResult,
    }).catch((error) => {
      console.warn(`  ⚠️ risk approval rationale 기록 실패: ${error.message}`);
    });

    const ragStore = await runNode(l33Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      saved: saved.result,
      meta: await buildDecisionBridgeMeta({
        sessionId,
        market: exchange,
        symbol: dec.symbol,
        stage: 'execute',
        planner: plannerCompact,
      }),
    });

    const notify = await runNode(l32Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      saved: saved.result,
      meta: await buildDecisionBridgeMeta({
        sessionId,
        market: exchange,
        symbol: dec.symbol,
        stage: 'execute',
        planner: plannerCompact,
      }),
      storeArtifact: false,
    });

    const execute = await runNode(l31Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      saved: saved.result,
      meta: await buildDecisionBridgeMeta({
        sessionId,
        market: exchange,
        symbol: dec.symbol,
        stage: 'execute',
        planner: plannerCompact,
      }),
    });

    const journal = await runNode(l34Node, {
      sessionId,
      market: exchange,
      symbol: dec.symbol,
      meta: await buildDecisionBridgeMeta({
        sessionId,
        market: exchange,
        symbol: dec.symbol,
        stage: 'journal',
        planner: plannerCompact,
      }),
      storeArtifact: false,
    });

    results.push({
      symbol: dec.symbol,
      action: dec.action,
      confidence: dec.confidence,
      reasoning: dec.reasoning,
      adjustedAmount: riskResult?.approved ? riskResult.adjustedAmount : null,
      signalId: saved.result?.signalId ?? null,
      signalStatus: execute.result?.signalStatus ?? null,
      blockCode: execute.result?.signalBlockCode ?? null,
      blockReason: execute.result?.signalBlockReason ?? null,
      notify: notify.result,
      ragStore: ragStore.result,
      execution: execute.result,
      journal: journal.result,
      midGapPromoted: midGapPromotedCandidate,
    });
  }

  const completedMetrics = buildMetrics({
    bridgeStatus: 'completed',
    approvedSignals: results.filter(isExecutionStillApproved).length,
    executedSymbols: results.filter(isActuallyExecuted).length,
    midGapExecuted: results.filter(item => item.midGapPromoted && isActuallyExecuted(item)).length,
    postExecutionBlocked: results.filter(item => (item?.blockCode ?? item?.execution?.signalBlockCode) === 'safety_gate_blocked').length,
  });
  await finishPipelineRun(sessionId, {
    status: 'completed',
    meta: buildPipelineDecisionFinishMeta({
      bridgeStatus: 'completed',
      symbolDecisions,
      metrics: completedMetrics,
      actionCounts,
      decisionCount: (portfolioDecision.decisions || []).length,
      approvedSignals: completedMetrics.approvedSignals,
      executedSymbols: completedMetrics.executedSymbols,
      exitEntrySummary,
      investmentTradeMode,
      plannerMeta: buildPlannerRunMeta(plannerCompact),
      portfolioDecision,
      topRiskRejectReason: getTopRiskRejectReason(),
      topWeakSignalReason: getTopWeakSignalReason(),
      midGapExecuted: completedMetrics.midGapExecuted,
      postExecutionBlocked: completedMetrics.postExecutionBlocked,
    }),
  });

  if (intelligentFlags.phases.reflectionEnabled) {
    const reflection = await buildDiscoveryReflectionSummary({ days: 14, exchange }).catch(() => null);
    if (reflection?.bySource?.[0]) {
      completedMetrics.discoveryReflectionTop = reflection.bySource[0];
    }
  }

  return {
    results,
    metrics: completedMetrics,
  };
}
