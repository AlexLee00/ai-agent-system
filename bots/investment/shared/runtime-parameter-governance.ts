// @ts-nocheck

import { getCapitalConfig } from './capital-manager.ts';
import { getInvestmentRuntimeConfig, getTimeProfiles } from './runtime-config.ts';

const GOVERNANCE_SPECS = [
  { key: 'capital_management.max_capital_usage', tier: 'allow', min: 0.5, max: 0.95, label: '총 자본 사용률' },
  { key: 'capital_management.reserve_ratio', tier: 'allow', min: 0.05, max: 0.5, label: '예비금 비율' },
  { key: 'capital_management.risk_per_trade', tier: 'allow', min: 0.01, max: 0.05, label: '거래당 리스크' },
  { key: 'capital_management.max_position_pct', tier: 'allow', min: 0.05, max: 0.5, label: '단일 포지션 비율' },
  { key: 'capital_management.max_concurrent_positions', tier: 'allow', min: 1, max: 8, label: '동시 포지션 수' },
  { key: 'capital_management.max_same_direction_positions', tier: 'allow', min: 1, max: 6, label: '동일 방향 포지션 수' },
  { key: 'capital_management.cooldown_after_loss_streak', tier: 'allow', min: 2, max: 5, label: '연속 손실 쿨다운 횟수' },
  { key: 'capital_management.cooldown_minutes', tier: 'allow', min: 30, max: 360, label: '쿨다운 분' },
  { key: 'runtime_config.luna.fastPathThresholds.minAverageConfidence', tier: 'allow', min: 0.2, max: 0.8, label: 'fast-path 평균 확신도' },
  { key: 'runtime_config.luna.fastPathThresholds.minAbsScore', tier: 'allow', min: 0.05, max: 0.5, label: 'fast-path 절대 점수' },
  { key: 'runtime_config.luna.fastPathThresholds.minStockConfidence', tier: 'allow', min: 0.15, max: 0.7, label: '주식 fast-path 확신도' },
  { key: 'runtime_config.luna.fastPathThresholds.minCryptoConfidence', tier: 'allow', min: 0.15, max: 0.8, label: '암호화폐 fast-path 확신도' },
  { key: 'runtime_config.luna.minConfidence.paper.kis_overseas', tier: 'allow', min: 0.1, max: 0.4, label: '해외장 paper 최소 확신도' },
  { key: 'runtime_config.luna.stockStrategyProfiles.aggressive.tradeModes.validation.minConfidence.live', tier: 'allow', min: 0.1, max: 0.4, label: '공격적 validation live 최소 확신도' },
  { key: 'runtime_config.nemesis.thresholds.stockStarterApproveDomestic', tier: 'allow', min: 200000, max: 1200000, label: '국내장 starter 자동승인 한도' },
  { key: 'capital_management.rr_fallback.tp_pct', tier: 'allow', min: 0.01, max: 0.12, label: '기본 TP 비율' },
  { key: 'capital_management.rr_fallback.sl_pct', tier: 'allow', min: 0.005, max: 0.08, label: '기본 SL 비율' },
  { key: 'capital_management.time_profiles.active.max_position_pct', tier: 'allow', min: 0.05, max: 0.5, label: 'ACTIVE 포지션 비율' },
  { key: 'capital_management.time_profiles.active.max_open_positions', tier: 'allow', min: 1, max: 8, label: 'ACTIVE 포지션 수' },
  { key: 'capital_management.time_profiles.active.min_signal_score', tier: 'allow', min: 0.2, max: 0.9, label: 'ACTIVE 최소 신호 점수' },
  { key: 'capital_management.time_profiles.slowdown.max_position_pct', tier: 'allow', min: 0.05, max: 0.5, label: 'SLOWDOWN 포지션 비율' },
  { key: 'capital_management.time_profiles.slowdown.max_open_positions', tier: 'allow', min: 1, max: 8, label: 'SLOWDOWN 포지션 수' },
  { key: 'capital_management.time_profiles.slowdown.min_signal_score', tier: 'allow', min: 0.2, max: 0.95, label: 'SLOWDOWN 최소 신호 점수' },
  { key: 'capital_management.time_profiles.night.max_position_pct', tier: 'allow', min: 0.03, max: 0.3, label: 'NIGHT 포지션 비율' },
  { key: 'capital_management.time_profiles.night.max_open_positions', tier: 'allow', min: 1, max: 4, label: 'NIGHT 포지션 수' },
  { key: 'capital_management.time_profiles.night.min_signal_score', tier: 'allow', min: 0.2, max: 0.98, label: 'NIGHT 최소 신호 점수' },
  { key: 'capital_management.max_daily_loss_pct', tier: 'escalate', min: 0.02, max: 0.10, label: '일간 손실 한도' },
  { key: 'capital_management.max_weekly_loss_pct', tier: 'escalate', min: 0.05, max: 0.20, label: '주간 손실 한도' },
  { key: 'capital_management.max_drawdown_pct', tier: 'escalate', min: 0.08, max: 0.20, label: '최대 드로우다운' },
  { key: 'perception_first.fear_greed_extreme_high', tier: 'escalate', min: 75, max: 95, label: '극단 공포탐욕 상단' },
  { key: 'perception_first.fear_greed_extreme_low', tier: 'escalate', min: 5, max: 25, label: '극단 공포탐욕 하단' },
  { key: 'paper_mode', tier: 'block', label: 'PAPER_MODE' },
  { key: 'order_rules', tier: 'block', label: '거래소 주문 규칙' },
];

function getSpecMap() {
  return new Map(GOVERNANCE_SPECS.map((spec) => [spec.key, spec]));
}

function resolveCurrentValue(key) {
  const capital = getCapitalConfig();
  const runtime = getInvestmentRuntimeConfig();
  const timeProfiles = getTimeProfiles();

  const lookup = {
    'capital_management.max_capital_usage': capital.max_capital_usage,
    'capital_management.reserve_ratio': capital.reserve_ratio,
    'capital_management.risk_per_trade': capital.risk_per_trade,
    'capital_management.max_position_pct': capital.max_position_pct,
    'capital_management.max_concurrent_positions': capital.max_concurrent_positions,
    'capital_management.max_same_direction_positions': capital.max_same_direction_positions,
    'capital_management.cooldown_after_loss_streak': capital.cooldown_after_loss_streak,
    'capital_management.cooldown_minutes': capital.cooldown_minutes,
    'capital_management.max_daily_loss_pct': capital.max_daily_loss_pct,
    'capital_management.max_weekly_loss_pct': capital.max_weekly_loss_pct,
    'capital_management.max_drawdown_pct': capital.max_drawdown_pct,
    'capital_management.rr_fallback.tp_pct': capital.rr_fallback?.tp_pct,
    'capital_management.rr_fallback.sl_pct': capital.rr_fallback?.sl_pct,
    'runtime_config.luna.fastPathThresholds.minAverageConfidence': runtime.luna?.fastPathThresholds?.minAverageConfidence,
    'runtime_config.luna.fastPathThresholds.minAbsScore': runtime.luna?.fastPathThresholds?.minAbsScore,
    'runtime_config.luna.fastPathThresholds.minStockConfidence': runtime.luna?.fastPathThresholds?.minStockConfidence,
    'runtime_config.luna.fastPathThresholds.minCryptoConfidence': runtime.luna?.fastPathThresholds?.minCryptoConfidence,
    'runtime_config.luna.minConfidence.paper.kis_overseas': runtime.luna?.minConfidence?.paper?.kis_overseas,
    'runtime_config.luna.stockStrategyProfiles.aggressive.tradeModes.validation.minConfidence.live': runtime.luna?.stockStrategyProfiles?.aggressive?.tradeModes?.validation?.minConfidence?.live,
    'runtime_config.nemesis.thresholds.stockStarterApproveDomestic': runtime.nemesis?.thresholds?.stockStarterApproveDomestic,
    'capital_management.time_profiles.active.max_position_pct': timeProfiles.ACTIVE?.maxPositionPct,
    'capital_management.time_profiles.active.max_open_positions': timeProfiles.ACTIVE?.maxOpenPositions,
    'capital_management.time_profiles.active.min_signal_score': timeProfiles.ACTIVE?.minSignalScore,
    'capital_management.time_profiles.slowdown.max_position_pct': timeProfiles.SLOWDOWN?.maxPositionPct,
    'capital_management.time_profiles.slowdown.max_open_positions': timeProfiles.SLOWDOWN?.maxOpenPositions,
    'capital_management.time_profiles.slowdown.min_signal_score': timeProfiles.SLOWDOWN?.minSignalScore,
    'capital_management.time_profiles.night.max_position_pct': timeProfiles.NIGHT_AUTO?.maxPositionPct,
    'capital_management.time_profiles.night.max_open_positions': timeProfiles.NIGHT_AUTO?.maxOpenPositions,
    'capital_management.time_profiles.night.min_signal_score': timeProfiles.NIGHT_AUTO?.minSignalScore,
    'perception_first.fear_greed_extreme_high': 85,
    'perception_first.fear_greed_extreme_low': 15,
    'paper_mode': false,
    'order_rules': 'immutable',
  };

  return lookup[key];
}

export function getParameterGovernance(key) {
  const spec = getSpecMap().get(key);
  if (!spec) return { key, tier: 'unknown', label: key };
  return {
    ...spec,
    current: resolveCurrentValue(key),
  };
}

export function annotateRuntimeSuggestions(suggestions = []) {
  return suggestions.map((item) => {
    const governance = getParameterGovernance(item.key);
    return {
      ...item,
      governance,
      changeAllowed: governance.tier === 'allow',
      requiresApproval: governance.tier === 'escalate',
      blockedByPolicy: governance.tier === 'block',
    };
  });
}

export function buildParameterGovernanceReport() {
  const rows = GOVERNANCE_SPECS.map((spec) => ({
    ...spec,
    current: resolveCurrentValue(spec.key),
  }));
  const grouped = {
    allow: rows.filter((row) => row.tier === 'allow'),
    escalate: rows.filter((row) => row.tier === 'escalate'),
    block: rows.filter((row) => row.tier === 'block'),
  };
  return {
    ok: true,
    summary: {
      allow: grouped.allow.length,
      escalate: grouped.escalate.length,
      block: grouped.block.length,
      total: rows.length,
    },
    grouped,
    rows,
  };
}
