// @ts-nocheck

import * as db from './db.ts';

const DEFAULT_AGENT_ROLE_PROFILES = [
  {
    agentId: 'argos',
    primaryRole: 'universe_selector',
    secondaryRoles: ['liquidity_filter', 'strategy_scout'],
    capabilities: ['screening', 'liquidity_filter', 'strategy_recommendation'],
    defaultPriority: 78,
    metadata: { owner: 'investment', marketAware: true },
  },
  {
    agentId: 'luna',
    primaryRole: 'portfolio_orchestrator',
    secondaryRoles: ['strategy_allocator', 'capital_director'],
    capabilities: ['decision_fusion', 'portfolio_decision', 'strategy_override'],
    defaultPriority: 95,
    metadata: { owner: 'investment', authority: 'final_decision' },
  },
  {
    agentId: 'nemesis',
    primaryRole: 'risk_gate',
    secondaryRoles: ['sizing_guard', 'execution_safeguard'],
    capabilities: ['risk_review', 'approval_modification', 'trade_gate'],
    defaultPriority: 92,
    metadata: { owner: 'investment', authority: 'risk' },
  },
  {
    agentId: 'hephaestos',
    primaryRole: 'execution_engine',
    secondaryRoles: ['partial_adjust_executor', 'reconciliation_executor'],
    capabilities: ['order_execution', 'position_reconciliation', 'exit_execution'],
    defaultPriority: 88,
    metadata: { owner: 'investment', authority: 'execution' },
  },
  {
    agentId: 'position_watch',
    primaryRole: 'live_position_watch',
    secondaryRoles: ['backtest_drift_watcher', 'risk_sentinel'],
    capabilities: ['realtime_watch', 'tv_monitoring', 'attention_generation'],
    defaultPriority: 85,
    metadata: { owner: 'investment', authority: 'watch' },
  },
];

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMarketKey(exchange = 'binance') {
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function countRows(rows = [], recommendation) {
  return rows.filter((row) => row?.ignored !== true && row?.recommendation === recommendation).length;
}

function countReason(rows = [], codes = []) {
  const set = new Set((Array.isArray(codes) ? codes : [codes]).filter(Boolean));
  return rows.filter((row) => row?.ignored !== true && set.has(String(row?.reasonCode || ''))).length;
}

function deriveRoleStates({
  reevaluationReport = null,
  latestRegime = null,
  exchange = 'binance',
} = {}) {
  const market = toMarketKey(exchange);
  const scopeType = 'market';
  const scopeKey = `${market}:live`;
  const rows = Array.isArray(reevaluationReport?.rows) ? reevaluationReport.rows : [];
  const activeRows = rows.filter((row) => row?.ignored !== true);
  const exits = countRows(rows, 'EXIT');
  const adjusts = countRows(rows, 'ADJUST');
  const holds = countRows(rows, 'HOLD');
  const managedCount = activeRows.length;
  const driftCount = activeRows.filter((row) => row?.analysisSnapshot?.backtestDrift && row.analysisSnapshot.backtestDrift.ignored !== 'thin_backtest').length;
  const bearishLossConsensusCount = countReason(rows, 'bearish_loss_consensus');
  const profitLockCount = countReason(rows, ['profit_lock_candidate', 'mean_reversion_profit_take', 'trend_following_trail']);
  const regime = String(latestRegime?.regime || 'unknown');
  const regimeConfidence = safeNumber(latestRegime?.confidence, 0);
  const bearishRegime = regime.includes('bear');
  const stressedPortfolio = exits > 0 || bearishLossConsensusCount > 0;
  const adjustmentHeavy = adjusts > 0 && adjusts >= holds;

  const sharedState = {
    market,
    exchange,
    scopeType,
    scopeKey,
    regime,
    regimeConfidence,
    managedCount,
    holds,
    adjusts,
    exits,
    driftCount,
    bearishLossConsensusCount,
    profitLockCount,
    updatedAt: new Date().toISOString(),
  };

  return [
    {
      agentId: 'argos',
      team: 'investment',
      scopeType,
      scopeKey,
      mission: bearishRegime || stressedPortfolio ? 'liquidity_tightening' : managedCount < 4 ? 'universe_expansion' : 'strategy_scouting',
      roleMode: bearishRegime ? 'defensive' : managedCount < 4 ? 'offensive' : 'balanced',
      priority: bearishRegime ? 86 : 72,
      reason: bearishRegime
        ? `${market} 장세가 ${regime}이고 EXIT/약세 합의가 보여 선별 범위를 보수적으로 조입니다`
        : managedCount < 4
          ? `${market} 관리 포지션이 ${managedCount}개라 신규 기회 탐색을 확대합니다`
          : `${market} 관리 포지션 ${managedCount}개를 유지하며 전략 스카우팅을 이어갑니다`,
      state: sharedState,
    },
    {
      agentId: 'luna',
      team: 'investment',
      scopeType,
      scopeKey,
      mission: stressedPortfolio ? 'capital_preservation' : managedCount < 5 ? 'opportunity_capture' : 'balanced_rotation',
      roleMode: stressedPortfolio ? 'defensive' : managedCount < 5 ? 'offensive' : 'balanced',
      priority: stressedPortfolio ? 98 : 90,
      reason: stressedPortfolio
        ? `${exits}건 EXIT와 ${bearishLossConsensusCount}건 약세 손실 합의가 있어 자본 보존 우선으로 전환합니다`
        : managedCount < 5
          ? `관리 포지션 ${managedCount}개로 여력이 있어 강한 기회를 포착하는 모드입니다`
          : `관리 포지션 ${managedCount}개를 유지하며 전략별 밸런스를 조절합니다`,
      state: {
        ...sharedState,
        overflowEligible: managedCount >= 6,
      },
    },
    {
      agentId: 'nemesis',
      team: 'investment',
      scopeType,
      scopeKey,
      mission: stressedPortfolio ? 'strict_risk_gate' : adjustmentHeavy ? 'soft_sizing_preference' : 'execution_safeguard',
      roleMode: stressedPortfolio ? 'strict' : adjustmentHeavy ? 'adaptive' : 'balanced',
      priority: stressedPortfolio ? 97 : 88,
      reason: stressedPortfolio
        ? `약세 손실 합의와 EXIT 후보가 있어 risk gate 강도를 높입니다`
        : adjustmentHeavy
          ? `ADJUST ${adjusts}건이 HOLD ${holds}건 이상이라 hard reject보다 sizing 조정을 우선합니다`
          : `현재는 승인형 execution safeguard 중심으로 운용합니다`,
      state: sharedState,
    },
    {
      agentId: 'hephaestos',
      team: 'investment',
      scopeType,
      scopeKey,
      mission: exits > 0 ? 'full_exit_cleanup' : adjusts > 0 ? 'partial_adjust_executor' : 'precision_execution',
      roleMode: exits > 0 ? 'exit_focused' : adjusts > 0 ? 'adjust_focused' : 'steady',
      priority: exits > 0 ? 94 : adjusts > 0 ? 84 : 76,
      reason: exits > 0
        ? `${exits}건 EXIT 후보가 있어 청산 준비와 포지션 정리를 우선합니다`
        : adjusts > 0
          ? `${adjusts}건 ADJUST 후보가 있어 부분익절/조정 실행을 우선합니다`
          : `현재는 신규/기존 주문을 정밀 실행하는 steady 모드입니다`,
      state: sharedState,
    },
    {
      agentId: 'position_watch',
      team: 'investment',
      scopeType,
      scopeKey,
      mission: driftCount > 0 ? 'backtest_drift_watcher' : stressedPortfolio ? 'risk_sentinel' : 'strategy_invalidation_watcher',
      roleMode: driftCount > 0 ? 'drift_sensitive' : stressedPortfolio ? 'risk_sensitive' : 'monitoring',
      priority: driftCount > 0 ? 96 : stressedPortfolio ? 93 : 82,
      reason: driftCount > 0
        ? `backtest drift ${driftCount}건이 보여 실시간 검증 감시를 강화합니다`
        : stressedPortfolio
          ? `약세 손실 합의와 EXIT 후보를 실시간으로 우선 감시합니다`
          : `전략 무효화와 partial-adjust 계열 attention을 중심으로 감시합니다`,
      state: sharedState,
    },
  ];
}

export async function ensureDefaultInvestmentAgentRoleProfiles() {
  await Promise.all(
    DEFAULT_AGENT_ROLE_PROFILES.map((profile) => db.upsertAgentRoleProfile(profile)),
  );
  return DEFAULT_AGENT_ROLE_PROFILES;
}

export async function refreshInvestmentAgentRoles({
  reevaluationReport = null,
  exchange = 'binance',
} = {}) {
  await ensureDefaultInvestmentAgentRoleProfiles();
  const market = toMarketKey(exchange);
  const latestRegime = await db.getLatestMarketRegimeSnapshot(market).catch(() => null);
  const states = deriveRoleStates({
    reevaluationReport,
    latestRegime,
    exchange,
  });

  const updated = [];
  for (const state of states) {
    const row = await db.upsertAgentRoleState(state).catch(() => null);
    if (row) updated.push(row);
  }
  return {
    ok: true,
    market,
    exchange,
    scopeType: 'market',
    scopeKey: `${market}:live`,
    regime: latestRegime?.regime || null,
    updatedCount: updated.length,
    rows: updated,
  };
}

export async function buildInvestmentAgentRoleSummary({
  exchange = 'binance',
  refresh = false,
  reevaluationReport = null,
} = {}) {
  const market = toMarketKey(exchange);
  const scopeKey = `${market}:live`;
  if (refresh) {
    await refreshInvestmentAgentRoles({ reevaluationReport, exchange });
  } else {
    await ensureDefaultInvestmentAgentRoleProfiles();
  }
  const rows = await db.getActiveAgentRoleStates({
    team: 'investment',
    scopeType: 'market',
    scopeKey,
    limit: 20,
  });
  return {
    ok: true,
    exchange,
    market,
    scopeKey,
    count: rows.length,
    rows,
  };
}
