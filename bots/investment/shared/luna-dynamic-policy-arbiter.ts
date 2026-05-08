// @ts-nocheck
import { getLunaOperatingEpoch } from './luna-operating-epoch.ts';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMarket(value = '') {
  const market = String(value || '').trim().toLowerCase();
  if (market === 'binance') return 'crypto';
  if (market === 'kis') return 'domestic';
  if (market === 'kis_overseas') return 'overseas';
  return market || 'unknown';
}

export function buildLunaDynamicPolicyDecision({
  market = 'unknown',
  signalSummary = {},
  tradeSummary = {},
  decisionFilterSummary = {},
  guardSummary = {},
  operatingEpochSummary = null,
  env = process.env,
} = {}) {
  const epoch = getLunaOperatingEpoch(env);
  const normalizedMarket = normalizeMarket(market);
  const operatingSamples = num(
    operatingEpochSummary?.operating
      ?? signalSummary.operatingSamples
      ?? tradeSummary.operatingSamples
      ?? signalSummary.totalBuy
      ?? 0,
  );
  const minOperatingSamples = Math.max(1, num(env.LUNA_DYNAMIC_POLICY_MIN_OPERATING_SAMPLES, 5));
  const hardBlockers = [];
  const warnings = [];
  const suggestions = [];

  if (epoch.enabled && operatingSamples < minOperatingSamples) {
    warnings.push('insufficient_operating_epoch_samples');
    suggestions.push({
      key: `luna.${normalizedMarket}.policyLearning`,
      action: 'collect_operating_epoch_samples',
      reason: `운영 epoch 이후 표본 ${operatingSamples}/${minOperatingSamples}건이라 과거 개발단계 통계는 하드 정책 근거에서 제외합니다.`,
    });
  }

  const hardBlockerCount = num(guardSummary.hardBlockers ?? guardSummary.hardBlockerCount ?? 0);
  if (hardBlockerCount > 0) {
    hardBlockers.push('runtime_hard_blockers_present');
  }

  const technicalBlocks = num(decisionFilterSummary?.reasonCounts?.technical_not_confirmed || 0);
  const marketFlowBlocks = num(decisionFilterSummary?.reasonCounts?.market_flow_not_confirmed || 0);
  const sentimentBlocks = num(decisionFilterSummary?.reasonCounts?.sentiment_not_confirmed || 0);
  if (technicalBlocks + marketFlowBlocks + sentimentBlocks > 0) {
    suggestions.push({
      key: `luna.${normalizedMarket}.candidateEvidence`,
      action: 'refresh_evidence_before_threshold_change',
      reason: `필터 병목 technical=${technicalBlocks}, market_flow=${marketFlowBlocks}, sentiment=${sentimentBlocks}. 임계값 완화보다 근거 refresh를 우선합니다.`,
    });
  }

  const totalBuy = num(signalSummary.totalBuy || 0);
  const executed = num(signalSummary.executedSignals || 0);
  if (totalBuy >= minOperatingSamples && executed === 0 && hardBlockerCount === 0) {
    suggestions.push({
      key: `luna.${normalizedMarket}.probeSizing`,
      action: 'allow_small_probe_when_all_runtime_guards_clear',
      reason: `BUY 후보 ${totalBuy}건 대비 실행 0건이며 하드블로커가 없습니다. 개발단계 통계 기반 차단 대신 소형 probe 후보를 비교할 수 있습니다.`,
    });
  }

  const status = hardBlockers.length > 0
    ? 'blocked_by_runtime_guard'
    : warnings.includes('insufficient_operating_epoch_samples')
      ? 'collect_operating_epoch_samples'
      : suggestions.length > 0
        ? 'dynamic_policy_review_ready'
        : 'dynamic_policy_stable';

  return {
    ok: hardBlockers.length === 0,
    status,
    market: normalizedMarket,
    epoch,
    minOperatingSamples,
    operatingSamples,
    hardBlockers,
    warnings,
    suggestions,
    evidence: {
      signalSummary,
      tradeSummary,
      decisionFilterSummary: {
        status: decisionFilterSummary?.status || null,
        reasonCounts: decisionFilterSummary?.reasonCounts || {},
      },
      guardSummary,
      operatingEpochSummary,
    },
  };
}

export default {
  buildLunaDynamicPolicyDecision,
};
