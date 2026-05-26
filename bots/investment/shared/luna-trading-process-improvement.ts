// @ts-nocheck

const P0 = 'P0';
const P1 = 'P1';
const P2 = 'P2';

const PREFILTER_ACTIONS = {
  capital_guard_rejected: {
    stage: 'capital_preflight',
    action: 'Move capital backpressure into candidate scoring and sizing preflight before execution.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:binance-failure-pressure -- --json --days=14',
  },
  sec015_overseas_stale_approval: {
    stage: 'approval_freshness_preflight',
    action: 'Check overseas SEC015 approval freshness before order construction and defer stale approvals to refresh queue.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:execution-risk-guard -- --json --days=14',
  },
  sec015_stale_approval: {
    stage: 'approval_freshness_preflight',
    action: 'Enforce approval TTL at entry preflight so stale approvals do not reach execution.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:execution-risk-guard -- --json --days=14',
  },
  live_position_reentry_blocked: {
    stage: 'reentry_prefilter',
    action: 'Inject live position and recent-buy cooldown state into candidate generation to suppress repeated reentry signals.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:binance-failure-pressure -- --json --days=14',
  },
  position_sizing_rejected: {
    stage: 'sizing_preflight',
    action: 'Record min-notional, max-risk, and quantity-normalization rejects during sizing instead of order preflight.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:position-runtime-autopilot-bottleneck -- --json',
  },
  safety_gate_blocked: {
    stage: 'safety_preflight',
    action: 'Attach safety-gate outcome before execution request creation.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-operational-action-board -- --json',
  },
  journal_open_entry_missing_for_sell: {
    stage: 'journal_integrity_preflight',
    action: 'Verify open-journal existence before SELL signal creation and route misses to reconcile evidence.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-hygiene -- --json',
  },
  trade_data_entry_guard_rejected: {
    stage: 'trade_data_entry_guard',
    action: 'Feed trade-data entry guard rejections into candidate score penalties and observation-mode routing.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
  },
};

const STRATEGY_ACTIONS = {
  promotion_ready_shadow: {
    action: 'Demote new entries to observation/probe until closed samples and expectancy recover.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-process-integrity-loop -- --json',
  },
  mean_reversion: {
    action: 'Require reversal evidence in ranging markets and downweight weak mean-reversion candidates.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
  },
  trend_following: {
    action: 'Require pullback, volume, or multi-timeframe confirmation before trend-following live sizing.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
  },
  short_term_scalping: {
    action: 'Keep early-exit loss-pressure guard active and require confirmation before fast scalp entries.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-process-integrity-loop -- --json',
  },
  defensive_rotation: {
    action: 'Route defensive rotation to cautious sizing until exit timing and drawdown behavior stabilize.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
  },
  equity_live_fire_probe: {
    action: 'Keep equity probe sizing capped until closed samples exceed the minimum learning floor.',
    validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
  },
};

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const scale = 10 ** digits;
  return Math.round(parsed * scale) / scale;
}

function unique(items = []) {
  return [...new Set((items || []).filter(Boolean))];
}

function topItems(items = [], limit = 5) {
  return [...(items || [])]
    .filter(Boolean)
    .sort((a, b) => num(b.count ?? b.total ?? b.closed) - num(a.count ?? a.total ?? a.closed))
    .slice(0, limit);
}

function topObjectEntries(obj = {}, limit = 8) {
  return Object.entries(obj || {})
    .map(([key, value]) => ({ key, count: num(value) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function actionItem({ id, priority, area, title, evidence = {}, action, validationCommand }) {
  return {
    id,
    priority,
    area,
    title,
    evidence,
    action,
    validationCommand,
    liveMutation: false,
  };
}

function buildDataQualityPillar(tradeData = {}) {
  const hygiene = tradeData.hygiene || {};
  const realizedCoverage = hygiene.realizedPnlCoverage?.coverage ?? tradeData.trades?.realizedPnlCoverage?.coverage ?? null;
  const posttradeCoverage = hygiene.qualityCoverage?.coverage ?? tradeData.posttrade?.qualityCoverage?.coverage ?? null;
  const findings = hygiene.findings || [];
  const openJournalStatus = hygiene.openJournal?.status || null;
  const blockers = [];
  if (tradeData.status && tradeData.status !== 'ready') blockers.push(`trade_data_status:${tradeData.status}`);
  if (hygiene.status && hygiene.status !== 'ready') blockers.push(`hygiene_status:${hygiene.status}`);
  if (openJournalStatus && openJournalStatus !== 'ready') blockers.push(`open_journal:${openJournalStatus}`);
  if (realizedCoverage != null && num(realizedCoverage) < 1) blockers.push('realized_pnl_coverage_below_100pct');
  if (posttradeCoverage != null && num(posttradeCoverage) < 1) blockers.push('posttrade_quality_coverage_below_100pct');
  for (const finding of findings) blockers.push(`hygiene_finding:${finding.id || finding.code || 'unknown'}`);

  const actions = [];
  if (blockers.length > 0) {
    actions.push(actionItem({
      id: 'trade_data_quality_repair',
      priority: P0,
      area: 'data_quality',
      title: 'Repair trade-data quality before using outcomes for policy learning.',
      evidence: { blockers, realizedCoverage, posttradeCoverage, openJournalStatus },
      action: 'Run hygiene, PnL backfill, and posttrade coverage repair in dry-run first; apply only after operator review.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
    }));
  }

  return {
    id: 'data_quality',
    status: blockers.length > 0 ? 'blocked' : 'ready',
    blockers,
    evidence: {
      tradeDataStatus: tradeData.status || null,
      hygieneStatus: hygiene.status || null,
      openJournalStatus,
      openJournalSummary: hygiene.openJournal?.summary || null,
      realizedCoverage,
      posttradeCoverage,
      findingCount: findings.length,
    },
    actions,
  };
}

function buildEntryPrefilterPillar(tradeData = {}) {
  const signals = tradeData.signals || {};
  const blockedReasons = topItems(signals.blockedReasons || [], 8);
  const rawExecutionRate = signals.executionRate ?? null;
  const policyAdjustedExecutionRate = signals.policyAdjustedExecutionRate ?? rawExecutionRate;
  const actions = blockedReasons.map((item) => {
    const reason = String(item.reason || item.block_code || item.code || 'unknown');
    const policy = PREFILTER_ACTIONS[reason] || {
      stage: 'reason_specific_prefilter',
      action: 'Classify this recurring block reason and move it to the earliest safe candidate, approval, or sizing stage.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
    };
    return actionItem({
      id: `prefilter_${reason}`,
      priority: P1,
      area: 'entry_prefilter',
      title: `${reason} should be absorbed before execution.`,
      evidence: { reason, count: num(item.count), stage: policy.stage, rawExecutionRate, policyAdjustedExecutionRate },
      action: policy.action,
      validationCommand: policy.validationCommand,
    });
  });

  const needsWatch = blockedReasons.length > 0 || (policyAdjustedExecutionRate != null && num(policyAdjustedExecutionRate) < 0.9);
  return {
    id: 'entry_prefilter',
    status: needsWatch ? 'watch' : 'ready',
    evidence: {
      totalSignals: signals.total ?? null,
      rawExecutionRate,
      policyAdjustedExecutionRate,
      policyBlockedSignals: signals.policyBlockedSignals ?? null,
      executionCandidateSignals: signals.executionCandidateSignals ?? null,
      blockedReasons,
    },
    actions,
  };
}

function buildStrategyBiasPillar(tradeData = {}) {
  const buckets = tradeData.journal?.strategyFamily?.buckets || [];
  const weakStrategies = [...buckets]
    .filter((bucket) => num(bucket.closed) >= 3 && bucket.avgPnlPercent != null && num(bucket.avgPnlPercent) < 0)
    .sort((a, b) => num(a.avgPnlPercent) - num(b.avgPnlPercent))
    .slice(0, 8);
  const actions = weakStrategies.map((bucket) => {
    const key = String(bucket.name || bucket.strategy || 'unknown').toLowerCase();
    const policy = STRATEGY_ACTIONS[key] || {
      action: 'Downweight this strategy family until post-guard closed samples recover.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
    };
    return actionItem({
      id: `strategy_bias_${key}`,
      priority: key === 'promotion_ready_shadow' ? P1 : P2,
      area: 'strategy_bias',
      title: `${key} has negative current-epoch expectancy.`,
      evidence: {
        closed: num(bucket.closed),
        avgPnlPercent: bucket.avgPnlPercent,
        winRate: bucket.winRate,
      },
      action: policy.action,
      validationCommand: policy.validationCommand,
    });
  });

  return {
    id: 'strategy_bias',
    status: weakStrategies.length > 0 ? 'watch' : 'ready',
    evidence: {
      strategyCoverage: tradeData.journal?.strategyFamily?.coverage ?? null,
      weakStrategies: weakStrategies.map((bucket) => ({
        strategy: bucket.name,
        closed: bucket.closed,
        avgPnlPercent: bucket.avgPnlPercent,
        winRate: bucket.winRate,
      })),
    },
    actions,
  };
}

function buildExitTimingPillar(tradeData = {}, optimalExit = {}) {
  const summary = optimalExit.learningEligibleSummary?.total > 0
    ? optimalExit.learningEligibleSummary
    : optimalExit.summary || {};
  const timing = summary.timingCategories || {};
  const tags = summary.optimalReasonTags || {};
  const earlyExit = tradeData.journal?.earlyExit || {};
  const lateExitCount = num(timing.late_exit_after_peak);
  const earlyRecoveredCount = num(timing.early_loss_exit_recovered_later);
  const earlyLossCount = num(earlyExit.losses);
  const missedDuringHoldAvgPct = summary.missedDuringHoldAvgPct ?? null;
  const missedToNowAvgPct = summary.missedToNowAvgPct ?? null;
  const actions = [];

  if (optimalExit.status === 'ready' && (num(missedDuringHoldAvgPct) >= 3 || lateExitCount > 0 || earlyRecoveredCount > 0)) {
    actions.push(actionItem({
      id: 'exit_dual_horizon_labels',
      priority: P0,
      area: 'exit_timing',
      title: 'Train exit labels across actual, best-within-hold, and forward-return horizons.',
      evidence: { missedDuringHoldAvgPct, missedToNowAvgPct, lateExitCount, earlyRecoveredCount },
      action: 'Add dual-horizon exit labels and use them as inputs for exit patience, partial profit, and trailing decisions.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-optimal-exit-analysis -- --json --no-write',
    }));
    actions.push(actionItem({
      id: 'exit_peak_reversal_probability',
      priority: P0,
      area: 'exit_timing',
      title: 'Add peak/reversal probability head for sell timing.',
      evidence: { topOptimalReasonTags: topObjectEntries(tags, 6) },
      action: 'Use RSI overbought, Bollinger position, SMA20 extension, volume spike, MACD cooling, local peak, and forward drawdown tags to estimate reversal risk.',
      validationCommand: 'npm --prefix bots/investment run -s smoke:luna-optimal-exit-analysis',
    }));
  }

  if (earlyLossCount > 0) {
    actions.push(actionItem({
      id: 'exit_early_loss_recheck_gate',
      priority: P1,
      area: 'exit_timing',
      title: 'Require a recheck before non-hard early loss exits.',
      evidence: {
        underOneHour: earlyExit.underOneHour ?? null,
        total: earlyExit.total ?? null,
        losses: earlyExit.losses ?? null,
        samples: (earlyExit.samples || []).slice(0, 5),
      },
      action: 'For non-hard exits under one hour, require technical recheck unless stop-loss, safety, or reconciliation rules force close.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-process-integrity-loop -- --json',
    }));
  }

  if (lateExitCount > 0) {
    actions.push(actionItem({
      id: 'exit_partial_profit_trailing',
      priority: P1,
      area: 'exit_timing',
      title: 'Replace all-or-nothing profit exits with partial lock and trailing logic.',
      evidence: {
        lateExitCount,
        nearOptimal: timing.near_optimal_within_hold ?? null,
        optimalReasonTags: topObjectEntries(tags, 5),
      },
      action: 'Use partial profit lock plus ATR/chandelier trailing when peak/reversal risk rises but trend continuation is not fully broken.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:position-runtime -- --json',
    }));
  }

  return {
    id: 'exit_timing',
    status: actions.some((item) => item.priority === P0) ? 'priority' : actions.length > 0 ? 'watch' : 'ready',
    evidence: {
      optimalExitStatus: optimalExit.status || null,
      analyzedTrades: optimalExit.scope?.analyzedTrades ?? null,
      learningEligibleTrades: optimalExit.scope?.learningEligibleTrades ?? null,
      actualAvgPnlPct: summary.actualAvgPnlPct ?? null,
      winRate: summary.winRate ?? null,
      missedDuringHoldAvgPct,
      missedToNowAvgPct,
      timingCategories: timing,
      optimalReasonTags: topObjectEntries(tags, 8),
      earlyExit,
    },
    actions,
  };
}

function buildLearningLoopPillar({ tradeData = {}, strategyFeedback = {}, posttrade = {} } = {}) {
  const closed = num(tradeData.journal?.summary?.closed);
  const minClosed = 30;
  const actionMapRequiresApproval = posttrade.actionStaging?.requiresApproval === true;
  const feedbackAttention = String(strategyFeedback.decision?.status || '').includes('attention');
  const actions = [];
  if (closed < minClosed) {
    actions.push(actionItem({
      id: 'learning_sample_floor',
      priority: P2,
      area: 'learning_loop',
      title: 'Keep autotune in sample-collection mode until the current epoch has enough closed trades.',
      evidence: { closed, minimumClosedForStableLearning: minClosed },
      action: 'Do not promote sample-thin strategy changes; compare post-guard samples only after the closed-trade floor is met.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
    }));
  }
  if (feedbackAttention) {
    actions.push(actionItem({
      id: 'strategy_feedback_attention',
      priority: P1,
      area: 'learning_loop',
      title: 'Strategy feedback outcomes require bias review.',
      evidence: strategyFeedback.decision?.metrics || strategyFeedback.decision || {},
      action: 'Compare feedback-tagged partial-adjust and strategy-exit outcomes before restoring weak family bias.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:strategy-feedback-outcomes -- --json --days=90',
    }));
  }
  if (actionMapRequiresApproval) {
    actions.push(actionItem({
      id: 'posttrade_action_requires_approval',
      priority: P1,
      area: 'learning_loop',
      title: 'Posttrade action staging has pending approval-required patches.',
      evidence: posttrade.actionStaging || {},
      action: 'Review staged posttrade action-map patches before applying them.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:posttrade-feedback-action-staging -- --json',
    }));
  }
  return {
    id: 'learning_loop',
    status: actions.some((item) => item.priority === P1) ? 'watch' : actions.length > 0 ? 'advisory' : 'ready',
    evidence: {
      currentEpochClosedTrades: closed,
      posttradeStatus: posttrade.status || null,
      strategyFeedbackStatus: strategyFeedback.decision?.status || null,
    },
    actions,
  };
}

function buildSymbolExitPolicyPillar(symbolExit = {}) {
  const scope = symbolExit.scope || {};
  const p0Symbols = num(scope.p0Symbols);
  const p1Symbols = num(scope.p1Symbols);
  const actions = [];
  const matrixAction = (symbolExit.strategyActions || []).find((item) => item.id === 'symbol_exit_policy_matrix');
  const driftAction = (symbolExit.strategyActions || []).find((item) => item.id === 'current_close_post_exit_label');
  const peakAction = (symbolExit.strategyActions || []).find((item) => item.id === 'peak_tag_exit_trigger');

  if (p0Symbols > 0 || matrixAction) {
    actions.push(actionItem({
      id: 'symbol_exit_policy_matrix_materialize',
      priority: p0Symbols > 0 ? P0 : P1,
      area: 'symbol_exit_policy',
      title: 'Materialize symbol-specific exit policies before changing live sell behavior.',
      evidence: {
        status: symbolExit.status || null,
        symbols: scope.symbols ?? null,
        p0Symbols,
        p1Symbols,
        byPolicy: matrixAction?.evidence?.byPolicy || null,
        topP0Symbols: (symbolExit.symbolList || [])
          .filter((row) => row.priority === P0)
          .slice(0, 10)
          .map((row) => ({
            symbolKey: row.symbolKey,
            policy: row.recommendedExitPolicy,
            missedDuringHoldAvgPct: row.policyMissedDuringHoldAvgPct ?? row.missedDuringHoldAvgPct,
          })),
      },
      action: 'Feed recommendedExitPolicy into exit patience, partial-profit, trailing-stop, and non-hard loss recheck gates by symbol.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-symbol-exit-timing-strategy-report -- --json --no-write',
    }));
  }

  if (driftAction) {
    actions.push(actionItem({
      id: 'post_exit_drift_label_backfill',
      priority: P1,
      area: 'symbol_exit_policy',
      title: 'Backfill post-exit drift labels to separate protected exits from premature exits.',
      evidence: driftAction.evidence || {},
      action: driftAction.action,
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-optimal-exit-analysis -- --json --no-write --include-records',
    }));
  }

  if (peakAction) {
    actions.push(actionItem({
      id: 'peak_tag_partial_exit_gate',
      priority: P1,
      area: 'symbol_exit_policy',
      title: 'Convert peak/reversal tags into partial-exit gates.',
      evidence: peakAction.evidence || {},
      action: peakAction.action,
      validationCommand: 'npm --prefix bots/investment run -s smoke:luna-symbol-exit-timing-strategy',
    }));
  }

  return {
    id: 'symbol_exit_policy',
    status: actions.some((item) => item.priority === P0) ? 'priority' : actions.length > 0 ? 'watch' : 'ready',
    evidence: {
      status: symbolExit.status || null,
      source: symbolExit.source || null,
      scope,
      topLateExitAfterPeak: (symbolExit.topLateExitAfterPeak || []).slice(0, 5).map((row) => ({
        symbolKey: row.symbolKey,
        policy: row.recommendedExitPolicy,
        missedDuringHoldAvgPct: row.policyMissedDuringHoldAvgPct ?? row.missedDuringHoldAvgPct,
      })),
      topSoldTooEarlyVsCurrentClose: (symbolExit.topSoldTooEarlyVsCurrentClose || []).slice(0, 5).map((row) => ({
        symbolKey: row.symbolKey,
        currentFromExitAvgPct: row.policyCurrentFromExitAvgPct,
      })),
    },
    actions,
  };
}

function buildAgenticOperatingModelPillar({ tradeData = {}, optimalExit = {}, symbolExit = {} } = {}) {
  const p0ExitSymbols = num(symbolExit.scope?.p0Symbols);
  const signalFailureRate = tradeData.signals?.failureRate ?? null;
  const currentEpochWinRate = tradeData.journal?.tpSl?.set?.winRate ?? null;
  const closedTrades = num(tradeData.journal?.summary?.closed);
  const actions = [];

  if (p0ExitSymbols > 0 || num(optimalExit.learningEligibleSummary?.missedDuringHoldAvgPct) >= 3) {
    actions.push(actionItem({
      id: 'deterministic_exit_policy_before_llm_override',
      priority: P0,
      area: 'agentic_operating_model',
      title: 'Keep sell timing controlled by deterministic policy labels before any LLM override.',
      evidence: {
        p0ExitSymbols,
        missedDuringHoldAvgPct: optimalExit.learningEligibleSummary?.missedDuringHoldAvgPct ?? optimalExit.summary?.missedDuringHoldAvgPct ?? null,
      },
      action: 'Use LLM only as critic/explainer for candidate sell plans; require symbol policy, peak tags, and post-exit drift labels to approve timing changes.',
      validationCommand: 'npm --prefix bots/investment run -s check:luna-trading-process-improvement',
    }));
  }

  if ((signalFailureRate != null && num(signalFailureRate) > 0.05) || closedTrades < 30) {
    actions.push(actionItem({
      id: 'analyze_simulate_promote_observe_loop',
      priority: P1,
      area: 'agentic_operating_model',
      title: 'Gate every strategy change through analyze, simulate, promote, and observe stages.',
      evidence: { signalFailureRate, closedTrades, currentEpochWinRate },
      action: 'Do not let agents mutate strategy thresholds directly; stage proposals with validation commands, smoke tests, and posttrade outcome checks.',
      validationCommand: 'npm --prefix bots/investment run -s runtime:luna-trading-process-improvement-report -- --json --no-write',
    }));
  }

  return {
    id: 'agentic_operating_model',
    status: actions.some((item) => item.priority === P0) ? 'priority' : actions.length > 0 ? 'watch' : 'ready',
    evidence: {
      model: 'quant_risk_primary_llm_critic_secondary',
      deterministicOwners: ['candidate_scoring', 'position_sizing', 'risk_limits', 'exit_policy', 'promotion_gate'],
      llmAllowedRoles: ['critic', 'rationale_reviewer', 'posttrade_label_explainer', 'roadmap_prioritizer'],
      llmForbiddenRoles: ['unvalidated_live_signal_owner', 'direct_threshold_mutator', 'live_order_executor'],
      signalFailureRate,
      currentEpochClosedTrades: closedTrades,
      currentEpochWinRate,
      p0ExitSymbols,
    },
    actions,
  };
}

function buildExecutionLoop(roadmap = []) {
  const p0 = roadmap.filter((item) => item.priority === P0).map((item) => item.id);
  const p1 = roadmap.filter((item) => item.priority === P1).map((item) => item.id);
  return [
    {
      stage: 'analyze',
      owner: 'deterministic_reports',
      objective: 'Collect trade quality, symbol exit timing, strategy feedback, and posttrade staging evidence.',
      requiredInputs: ['trade_data_analysis', 'optimal_exit_analysis', 'symbol_exit_policy', 'strategy_feedback_outcomes'],
      currentFocus: p0.slice(0, 5),
    },
    {
      stage: 'simulate',
      owner: 'backtest_and_smoke',
      objective: 'Validate policy candidates before any runtime threshold or live-flow change.',
      requiredInputs: unique(roadmap.map((item) => item.validationCommand)).slice(0, 8),
      currentFocus: p1.slice(0, 5),
    },
    {
      stage: 'stage',
      owner: 'posttrade_action_staging',
      objective: 'Convert only safe runtime-config proposals into approval-required patches.',
      guardrail: 'No secret, launchd, live trade, reconcile apply, or protected PID mutation.',
    },
    {
      stage: 'promote',
      owner: 'promotion_gate',
      objective: 'Promote only after sample floor, positive expectancy, and safety gates pass.',
      guardrail: 'LLM review cannot bypass deterministic promotion gates.',
    },
    {
      stage: 'observe',
      owner: 'watchdog_posttrade_feedback',
      objective: 'Feed realized PnL, post-exit drift, and family-bias outcomes back into the next cycle.',
      guardrail: 'Failures become prefilters or observation-mode downgrades, not repeated execution attempts.',
    },
  ];
}

function overallStatus(pillars = []) {
  if (pillars.some((pillar) => pillar.status === 'blocked')) return 'process_improvement_blocked';
  if (pillars.some((pillar) => pillar.actions?.some((item) => item.priority === P0))) return 'process_improvement_required';
  if (pillars.some((pillar) => ['watch', 'priority'].includes(pillar.status))) return 'process_improvement_watch';
  if (pillars.some((pillar) => pillar.status === 'advisory')) return 'process_improvement_advisory';
  return 'process_improvement_ready';
}

export function buildLunaTradingProcessImprovementReport({
  tradeData = {},
  optimalExit = {},
  symbolExit = {},
  strategyFeedback = {},
  posttrade = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const pillars = [
    buildDataQualityPillar(tradeData),
    buildEntryPrefilterPillar(tradeData),
    buildStrategyBiasPillar(tradeData),
    buildExitTimingPillar(tradeData, optimalExit),
    buildSymbolExitPolicyPillar(symbolExit),
    buildAgenticOperatingModelPillar({ tradeData, optimalExit, symbolExit }),
    buildLearningLoopPillar({ tradeData, strategyFeedback, posttrade }),
  ];
  const roadmap = pillars.flatMap((pillar) => pillar.actions || [])
    .sort((left, right) => {
      const order = { P0: 0, P1: 1, P2: 2 };
      return (order[left.priority] ?? 9) - (order[right.priority] ?? 9) || left.area.localeCompare(right.area);
    });
  const status = overallStatus(pillars);
  return {
    ok: !status.includes('blocked'),
    status,
    generatedAt,
    readOnly: true,
    liveTradeImpact: false,
    summary: {
      dataQualityStatus: pillars.find((item) => item.id === 'data_quality')?.status || null,
      entryPrefilterStatus: pillars.find((item) => item.id === 'entry_prefilter')?.status || null,
      strategyBiasStatus: pillars.find((item) => item.id === 'strategy_bias')?.status || null,
      exitTimingStatus: pillars.find((item) => item.id === 'exit_timing')?.status || null,
      symbolExitPolicyStatus: pillars.find((item) => item.id === 'symbol_exit_policy')?.status || null,
      agenticOperatingModelStatus: pillars.find((item) => item.id === 'agentic_operating_model')?.status || null,
      learningLoopStatus: pillars.find((item) => item.id === 'learning_loop')?.status || null,
      currentEpochTrades: tradeData.journal?.summary || null,
      currentEpochAvgPnlPct: tradeData.journal?.tpSl?.set?.avgPnlPercent ?? tradeData.journal?.summary?.avgPnlPercent ?? null,
      currentEpochWinRate: tradeData.journal?.tpSl?.set?.winRate ?? null,
      rawExecutionRate: tradeData.signals?.executionRate ?? null,
      policyAdjustedExecutionRate: tradeData.signals?.policyAdjustedExecutionRate ?? null,
      optimalExitAnalyzedTrades: optimalExit.scope?.analyzedTrades ?? null,
      optimalExitLearningEligibleTrades: optimalExit.scope?.learningEligibleTrades ?? null,
      symbolExitAnalyzedSymbols: symbolExit.scope?.symbols ?? null,
      symbolExitP0Symbols: symbolExit.scope?.p0Symbols ?? null,
      roadmapCount: roadmap.length,
      p0Count: roadmap.filter((item) => item.priority === P0).length,
      p1Count: roadmap.filter((item) => item.priority === P1).length,
      p2Count: roadmap.filter((item) => item.priority === P2).length,
    },
    pillars,
    roadmap,
    executionLoop: buildExecutionLoop(roadmap),
    nextCommands: unique(roadmap.map((item) => item.validationCommand).concat([
      'npm --prefix bots/investment run -s smoke:luna-trading-process-improvement',
      'npm --prefix bots/investment run -s runtime:luna-trading-process-improvement-report -- --json --no-write',
    ])),
    sourceReports: {
      tradeData: tradeData.source || null,
      optimalExit: optimalExit.source || null,
      symbolExit: symbolExit.source || null,
      strategyFeedback: strategyFeedback.source || null,
      posttrade: posttrade.source || null,
    },
  };
}

export function summarizeLunaTradingProcessImprovement(report = {}) {
  return {
    status: report.status || 'unknown',
    p0: (report.roadmap || []).filter((item) => item.priority === P0).map((item) => item.id),
    p1: (report.roadmap || []).filter((item) => item.priority === P1).map((item) => item.id),
    p2: (report.roadmap || []).filter((item) => item.priority === P2).map((item) => item.id),
    nextCommands: report.nextCommands || [],
  };
}

export default {
  buildLunaTradingProcessImprovementReport,
  summarizeLunaTradingProcessImprovement,
};
