// @ts-nocheck

import { ACTIONS } from './signal.ts';
import {
  buildRiskApprovalTarget,
  executionFreshnessRiskModel,
  runRiskApprovalChain,
} from './risk-approval-chain.ts';
import { recordGuardEvent } from './guard-event-recorder.ts';

function normalizeVerdict(value = null) {
  return String(value || '').toLowerCase();
}

function isNemesisApproved(signal = {}) {
  const verdict = normalizeVerdict(signal.nemesis_verdict || signal.nemesisVerdict);
  return ['approved', 'modified'].includes(verdict);
}

export function buildExecutionRiskApprovalGuard(signal = {}, {
  market = signal.exchange || 'binance',
  codePrefix = 'risk_approval',
  executionBlockedBy = 'execution_guard',
  paperMode = false,
} = {}) {
  const action = signal.action;
  if (action === ACTIONS.SELL || paperMode) {
    return {
      approved: true,
      skipped: true,
      reason: action === ACTIONS.SELL ? 'SELL은 포지션 청산이라 진입 승인 재검증 생략' : 'paper mode에서는 실행 승인 재검증 생략',
    };
  }

  const verdict = signal.nemesis_verdict || signal.nemesisVerdict || null;
  if (!isNemesisApproved(signal)) {
    // HARD block: 네메시스 미승인 → 실투자 안전 보호 유지 + 이벤트 기록
    recordGuardEvent({
      guardName: 'nemesis_bypass_guard',
      symbol: signal.symbol || null,
      exchange: market || null,
      reason: `nemesis_verdict=${verdict || 'null'}`,
      severity: 'danger',
      decisionBefore: { action, nemesis_verdict: verdict },
      guardMetadata: { codePrefix, executionBlockedBy },
    });
    return {
      approved: false,
      code: `${codePrefix}_nemesis_bypass_guard`,
      status: 'blocked',
      reason: `네메시스 승인 없는 BUY signal 실행 차단 (verdict=${verdict || 'null'})`,
      meta: {
        market,
        symbol: signal.symbol,
        action,
        nemesis_verdict: verdict,
        execution_blocked_by: executionBlockedBy,
      },
    };
  }

  const target = buildRiskApprovalTarget({
    signal,
    context: {
      exchange: signal.exchange || market,
      tradeMode: signal.trade_mode || signal.tradeMode || 'normal',
      approvedAt: signal.approved_at || signal.approvedAt || null,
    },
  });
  const result = runRiskApprovalChain(target, [executionFreshnessRiskModel]);

  if (!result.approved || result.decision === 'REJECT') {
    const staleStep = (result.steps || []).find((step) => step.model === 'execution_freshness') || null;
    const ageMatch = String(staleStep?.reason || result.rejectReason || '').match(/(\d+)초/u);
    const ageSeconds = ageMatch ? Number(ageMatch[1]) : null;
    recordGuardEvent({
      guardName: 'execution_freshness_guard',
      symbol: signal.symbol || null,
      exchange: market || null,
      reason: result.rejectReason || staleStep?.reason || 'stale_approval',
      severity: 'danger',
      decisionBefore: {
        action,
        approved_at: signal.approved_at || signal.approvedAt || null,
        age_seconds: ageSeconds,
      },
      guardMetadata: {
        decision: result.decision,
        steps: result.steps || [],
        codePrefix,
      },
    });
    return {
      approved: false,
      code: `${codePrefix}_stale_approval_guard`,
      status: 'blocked',
      reason: result.rejectReason || staleStep?.reason || '승인 freshness 재검증 실패',
      meta: {
        market,
        symbol: signal.symbol,
        action,
        approved_at: signal.approved_at || signal.approvedAt || null,
        age_seconds: ageSeconds,
        execution_blocked_by: executionBlockedBy,
        risk_approval_execution: {
          decision: result.decision,
          rejectReason: result.rejectReason || null,
          steps: result.steps || [],
        },
      },
    };
  }

  return {
    approved: true,
    code: null,
    reason: 'execution freshness 통과',
    meta: {
      risk_approval_execution: {
        decision: result.decision,
        steps: result.steps || [],
      },
    },
  };
}
