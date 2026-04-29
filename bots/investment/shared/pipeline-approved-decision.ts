// @ts-nocheck
/**
 * Approved-decision execution seam for Luna's decision pipeline.
 *
 * The pipeline runner owns orchestration state. This module owns the repeated
 * "risk-approved decision -> save -> notify -> execute -> journal" contract so
 * the state-machine migration can continue without changing trading semantics.
 */

import * as db from './db.ts';
import * as journalDb from './trade-journal-db.ts';
import { recordNodeResult, runNode } from './node-runner.ts';
import { ACTIONS, validateSignal } from './signal.ts';
import { evaluateSignal } from '../team/nemesis.ts';
import { buildAnalystSignals } from './pipeline-decision-policy.ts';

export function buildRiskApprovalRationalePayload({ signalId = null, signal = {}, riskResult = {} } = {}) {
  if (!signalId || signal?.action !== ACTIONS.BUY || !riskResult?.risk_approval_preview) return null;
  return {
    signal_id: signalId,
    luna_decision: 'enter',
    luna_reasoning: signal.reasoning || '',
    luna_confidence: signal.confidence ?? null,
    nemesis_verdict: riskResult.nemesis_verdict || 'approved',
    nemesis_notes: riskResult.risk_approval_preview?.application?.reason || null,
    position_size_original: signal.amount_usdt ?? signal.amountUsdt ?? null,
    position_size_approved: riskResult.adjustedAmount ?? signal.amount_usdt ?? signal.amountUsdt ?? null,
    strategy_config: {
      risk_approval_preview: riskResult.risk_approval_preview,
      risk_approval_application: riskResult.risk_approval_application || riskResult.risk_approval_preview?.application || null,
    },
  };
}

export async function persistRiskApprovalRationale({ signalId = null, signal = {}, riskResult = {} } = {}) {
  if (!signalId || signal?.action !== ACTIONS.BUY || !riskResult?.risk_approval_preview) return null;
  const existing = await db.query(`
    SELECT id
      FROM investment.trade_rationale
     WHERE signal_id = $1
       AND strategy_config->'risk_approval_preview' IS NOT NULL
     LIMIT 1
  `, [signalId]).catch(() => []);
  if (existing.length > 0) return { skipped: true, reason: 'already_recorded' };

  const payload = buildRiskApprovalRationalePayload({ signalId, signal, riskResult });
  if (!payload) return null;
  await journalDb.insertRationale(payload);
  return { recorded: true };
}

export async function executeApprovedDecision({
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
  buildDecisionBridgeMeta,
  stage = 'execute',
  analystSignalsOverride = null,
  plannerCompact = null,
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
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: exchange,
      symbol: decision.symbol,
      stage,
      planner: plannerCompact,
    }),
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
    decision: {
      ...decision,
      trade_mode: decision?.trade_mode || null,
      amount_usdt: amountUsdt,
    },
    risk: riskResult,
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: exchange,
      symbol: decision.symbol,
      stage,
      planner: plannerCompact,
    }),
  });
  await persistRiskApprovalRationale({
    signalId: saved.result?.signalId ?? null,
    signal: {
      ...signalData,
      symbol: decision.symbol,
      action: decision.action,
      confidence: decision.confidence,
      amount_usdt: signalData.amountUsdt,
    },
    riskResult,
  }).catch((error) => {
    console.warn(`  ⚠️ risk approval rationale 기록 실패: ${error.message}`);
  });

  const ragStore = await runNode(l33Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    saved: saved.result,
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: exchange,
      symbol: decision.symbol,
      stage,
      planner: plannerCompact,
    }),
  });

  const notify = await runNode(l32Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    saved: saved.result,
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: exchange,
      symbol: decision.symbol,
      stage,
      planner: plannerCompact,
    }),
    storeArtifact: false,
  });

  const execute = await runNode(l31Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    saved: saved.result,
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: exchange,
      symbol: decision.symbol,
      stage,
      planner: plannerCompact,
    }),
  });

  const journal = await runNode(l34Node, {
    sessionId,
    market: exchange,
    symbol: decision.symbol,
    meta: await buildDecisionBridgeMeta({
      sessionId,
      market: exchange,
      symbol: decision.symbol,
      stage,
      planner: plannerCompact,
    }),
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

