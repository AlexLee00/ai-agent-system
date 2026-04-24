// @ts-nocheck
import * as db from '../shared/db.ts';
import * as journalDb from '../shared/trade-journal-db.ts';
import { createOrUpdatePositionStrategyProfile } from '../shared/strategy-profile.ts';
import { buildSignalApprovalUpdate } from '../shared/signal-approval.ts';
import { ACTIONS, SIGNAL_STATUS } from '../shared/signal.ts';
import { loadAnalysesForSession, loadLatestNodePayload, buildAnalystSignals } from './helpers.ts';

const NODE_ID = 'L30';

async function persistRiskApprovalRationaleAtSave({
  signalId = null,
  symbol = null,
  decision = null,
  risk = null,
} = {}) {
  if (!signalId || decision?.action !== ACTIONS.BUY || !risk?.risk_approval_preview) return;

  const existing = await db.query(`
    SELECT id
      FROM investment.trade_rationale
     WHERE signal_id = $1
       AND strategy_config->'risk_approval_preview' IS NOT NULL
     LIMIT 1
  `, [signalId]).catch(() => []);
  if (existing.length > 0) return;

  await journalDb.insertRationale({
    signal_id: signalId,
    luna_decision: 'enter',
    luna_reasoning: `[노드:${NODE_ID}] ${decision?.reasoning || ''}`.slice(0, 255),
    luna_confidence: decision?.confidence ?? null,
    nemesis_verdict: risk?.nemesis_verdict || 'approved',
    nemesis_notes: risk?.risk_approval_application?.reason || risk?.risk_approval_preview?.application?.reason || null,
    position_size_original: decision?.amount_usdt ?? null,
    position_size_approved: risk?.adjustedAmount ?? decision?.amount_usdt ?? null,
    strategy_config: {
      risk_approval_preview: risk.risk_approval_preview,
      risk_approval_application: risk.risk_approval_application || risk.risk_approval_preview?.application || null,
    },
  });
}

async function run({ sessionId, market, symbol, decision: decisionOverride = null, risk: riskOverride = null }) {
  if (!sessionId) throw new Error('sessionId 필요');
  if (!symbol) throw new Error('symbol 필요');

  const decisionHit = await loadLatestNodePayload(sessionId, 'L13', symbol);
  const riskHit = await loadLatestNodePayload(sessionId, 'L21', symbol);
  const decision = decisionOverride || decisionHit?.payload?.decision || null;
  const risk = riskOverride || riskHit?.payload?.risk || null;

  if (!decision?.action || decision.action === 'HOLD') {
    return {
      symbol,
      market,
      skipped: true,
      reason: decision?.action === 'HOLD' ? 'HOLD 신호' : '최종 판단 없음',
    };
  }

  const { analyses } = await loadAnalysesForSession(sessionId, symbol, market);
  const analystSignals = decisionHit?.payload?.analystSignals
    || decision?.analyst_signals
    || buildAnalystSignals(analyses);
  const amountUsdt = risk?.approved
    ? (risk.adjustedAmount ?? decision.amount_usdt)
    : (decision.amount_usdt ?? 0);

  const signalInsert = await db.insertSignalIfFresh({
    symbol,
    action: decision.action,
    amountUsdt,
    confidence: decision.confidence,
    reasoning: `[노드:${NODE_ID}] ${decision.reasoning || ''}`.slice(0, 255),
    exchange: market,
    analystSignals,
    tradeMode: decision?.trade_mode || null,
    nemesisVerdict: risk?.nemesis_verdict ?? null,
    approvedAt: risk?.approved_at ?? null,
  });
  const signalId = signalInsert.id;

  if (signalInsert.duplicate) {
    return {
      symbol,
      market,
      signalId,
      status: signalInsert.existingSignal?.status || 'duplicate',
      skipped: true,
      reason: `최근 ${signalInsert.dedupeWindowMinutes}분 내 중복 신호`,
      duplicateOf: signalInsert.existingSignal?.id || signalId,
      analystSignals,
    };
  }

  let status = SIGNAL_STATUS.PENDING;
  if (risk) {
    if (risk.approved) {
      status = SIGNAL_STATUS.APPROVED;
      await db.updateSignalApproval(signalId, buildSignalApprovalUpdate({
        ...risk,
        status: SIGNAL_STATUS.APPROVED,
      }));
      if (risk.adjustedAmount != null) {
        await db.updateSignalAmount(signalId, risk.adjustedAmount);
      }
      await persistRiskApprovalRationaleAtSave({
        signalId,
        symbol,
        decision,
        risk,
      }).catch((error) => {
        console.warn(`  ⚠️ risk approval rationale 저장 실패(${symbol}): ${error.message}`);
      });
      await createOrUpdatePositionStrategyProfile({
        signalId,
        symbol,
        exchange: market,
        tradeMode: decision?.trade_mode || null,
        decision,
      }).catch(() => null);
    } else {
      status = SIGNAL_STATUS.REJECTED;
      await db.updateSignalBlock(signalId, {
        status: SIGNAL_STATUS.REJECTED,
        reason: risk.reason || null,
        code: 'risk_rejected',
        meta: {
          market,
          symbol,
          action: decision.action,
          amount: decision.amount_usdt,
          adjustedAmount: risk.adjustedAmount ?? null,
        },
      });
      await persistRiskApprovalRationaleAtSave({
        signalId,
        symbol,
        decision,
        risk,
      }).catch((error) => {
        console.warn(`  ⚠️ risk approval rationale 저장 실패(${symbol}): ${error.message}`);
      });
    }
  }

  return {
    symbol,
    market,
    signalId,
    status,
    decision,
    risk,
    analystSignals,
  };
}

export default {
  id: NODE_ID,
  type: 'execute',
  label: 'signal-save',
  run,
};
