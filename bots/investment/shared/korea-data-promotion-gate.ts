// @ts-nocheck
// Shadow-only promotion gate for Korea public data strategies.

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  return Number(finite(value, 0).toFixed(digits));
}

function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(raw)) return true;
  if (['false', '0', 'no', 'n'].includes(raw)) return false;
  return fallback;
}

function countMetric(value) {
  if (value && typeof value === 'object' && 'count' in value) return finite(value.count, 0);
  return finite(value, 0);
}

function metricMissing(value) {
  return Boolean(value && typeof value === 'object' && value.tableMissing === true);
}

function addBlocker(blockers, condition, code, detail = {}) {
  if (!condition) return;
  blockers.push({ code, ...detail });
}

function addWarning(warnings, condition, code, detail = {}) {
  if (!condition) return;
  warnings.push({ code, ...detail });
}

export const DEFAULT_KOREA_DATA_PROMOTION_THRESHOLDS = {
  minFinancialReportRows: 1000,
  minCorpFundamentalRows: 200,
  minFreshCorpFundamentalRows24h: 200,
  minDisclosuresToday: 100,
  minKoreanFactorRows7d: 1000,
  minDomesticBacktestRows7d: 20,
  minDomesticBacktestFreshRows7d: 15,
  minDomesticBacktestHealthyRows7d: 15,
  minDomesticBacktestPassRate7d: 0.65,
  minShadowObservationDays: 7,
  minStrategyShadowSignals7d: 15,
  minWorldquantAlphaCount: 20,
};

export function normalizeKoreaDataPromotionThresholds(overrides = {}) {
  return {
    ...DEFAULT_KOREA_DATA_PROMOTION_THRESHOLDS,
    ...Object.fromEntries(
      Object.entries(overrides || {})
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => [key, finite(value, DEFAULT_KOREA_DATA_PROMOTION_THRESHOLDS[key])]),
    ),
  };
}

export function buildKoreaDataPromotionGate(metrics = {}, options = {}) {
  const thresholds = normalizeKoreaDataPromotionThresholds(options.thresholds || {});
  const blockers = [];
  const warnings = [];
  const counts = {
    corpFinancialReports: countMetric(metrics.corpFinancialReports),
    corpFundamentals: countMetric(metrics.corpFundamentals),
    freshCorpFundamentals24h: countMetric(metrics.freshCorpFundamentals24h),
    disclosuresToday: countMetric(metrics.disclosuresToday),
    koreanFactorRows7d: countMetric(metrics.koreanFactorRows7d),
    domesticBacktestRows7d: countMetric(metrics.domesticBacktestRows7d),
    domesticBacktestFreshRows7d: countMetric(metrics.domesticBacktestFreshRows7d),
    domesticBacktestHealthyRows7d: countMetric(metrics.domesticBacktestHealthyRows7d),
    domesticBacktestPassRows7d: countMetric(metrics.domesticBacktestPassRows7d),
    shadowObservationDays: countMetric(metrics.shadowObservationDays),
    strategyShadowSignals7d: countMetric(metrics.strategyShadowSignals7d),
    worldquantAlphaCount: countMetric(metrics.worldquantAlphaCount),
  };
  const tableMissing = {
    corpFinancialReports: metricMissing(metrics.corpFinancialReports),
    corpFundamentals: metricMissing(metrics.corpFundamentals),
    disclosuresToday: metricMissing(metrics.disclosuresToday),
    koreanFactorRows7d: metricMissing(metrics.koreanFactorRows7d),
    domesticBacktestRows7d: metricMissing(metrics.domesticBacktestRows7d),
  };
  const openDartConfigured = bool(metrics.openDartConfigured, false);
  const dartFssAvailable = bool(metrics.dartFssAvailable, false);
  const domesticPassRate = counts.domesticBacktestRows7d > 0
    ? round(counts.domesticBacktestPassRows7d / counts.domesticBacktestRows7d, 4)
    : 0;

  addBlocker(blockers, !openDartConfigured, 'opendart_api_key_missing', {
    expected: 'hub or env Open DART API key',
  });
  addWarning(warnings, !dartFssAvailable, 'dart_fss_python_adapter_missing', {
    command: 'python3 -m pip install -r bots/investment/python/korea-data/requirements.txt',
  });
  addBlocker(blockers, tableMissing.corpFinancialReports, 'corp_financial_reports_table_missing');
  addBlocker(blockers, tableMissing.corpFundamentals, 'corp_fundamentals_table_missing');
  addBlocker(blockers, tableMissing.disclosuresToday, 'corp_disclosures_table_missing');
  addBlocker(blockers, tableMissing.koreanFactorRows7d, 'korean_factor_log_table_missing');
  addBlocker(blockers, tableMissing.domesticBacktestRows7d, 'candidate_backtest_status_table_missing');

  addBlocker(blockers, counts.corpFinancialReports < thresholds.minFinancialReportRows, 'financial_report_rows_below_target', {
    actual: counts.corpFinancialReports,
    expected: thresholds.minFinancialReportRows,
  });
  addBlocker(blockers, counts.corpFundamentals < thresholds.minCorpFundamentalRows, 'corp_fundamentals_below_target', {
    actual: counts.corpFundamentals,
    expected: thresholds.minCorpFundamentalRows,
  });
  addBlocker(blockers, counts.freshCorpFundamentals24h < thresholds.minFreshCorpFundamentalRows24h, 'fresh_fundamentals_24h_below_target', {
    actual: counts.freshCorpFundamentals24h,
    expected: thresholds.minFreshCorpFundamentalRows24h,
  });
  addBlocker(blockers, counts.disclosuresToday < thresholds.minDisclosuresToday, 'daily_disclosures_below_target', {
    actual: counts.disclosuresToday,
    expected: thresholds.minDisclosuresToday,
  });
  addBlocker(blockers, counts.koreanFactorRows7d < thresholds.minKoreanFactorRows7d, 'korean_factor_rows_7d_below_target', {
    actual: counts.koreanFactorRows7d,
    expected: thresholds.minKoreanFactorRows7d,
  });
  addBlocker(blockers, counts.domesticBacktestRows7d < thresholds.minDomesticBacktestRows7d, 'domestic_backtest_rows_7d_below_target', {
    actual: counts.domesticBacktestRows7d,
    expected: thresholds.minDomesticBacktestRows7d,
  });
  addBlocker(blockers, counts.domesticBacktestFreshRows7d < thresholds.minDomesticBacktestFreshRows7d, 'domestic_backtest_fresh_rows_7d_below_target', {
    actual: counts.domesticBacktestFreshRows7d,
    expected: thresholds.minDomesticBacktestFreshRows7d,
  });
  addBlocker(blockers, counts.domesticBacktestHealthyRows7d < thresholds.minDomesticBacktestHealthyRows7d, 'domestic_backtest_healthy_rows_7d_below_target', {
    actual: counts.domesticBacktestHealthyRows7d,
    expected: thresholds.minDomesticBacktestHealthyRows7d,
  });
  addBlocker(blockers, domesticPassRate < thresholds.minDomesticBacktestPassRate7d, 'domestic_backtest_pass_rate_below_target', {
    actual: domesticPassRate,
    expected: thresholds.minDomesticBacktestPassRate7d,
  });
  addBlocker(blockers, counts.shadowObservationDays < thresholds.minShadowObservationDays, 'shadow_observation_days_below_target', {
    actual: counts.shadowObservationDays,
    expected: thresholds.minShadowObservationDays,
  });
  addBlocker(blockers, counts.strategyShadowSignals7d < thresholds.minStrategyShadowSignals7d, 'strategy_shadow_signals_7d_below_target', {
    actual: counts.strategyShadowSignals7d,
    expected: thresholds.minStrategyShadowSignals7d,
  });
  addBlocker(blockers, counts.worldquantAlphaCount < thresholds.minWorldquantAlphaCount, 'worldquant_alpha_count_below_target', {
    actual: counts.worldquantAlphaCount,
    expected: thresholds.minWorldquantAlphaCount,
  });

  const promotionReady = blockers.length === 0;
  const stage1Ready = !blockers.some((item) => [
    'opendart_api_key_missing',
    'corp_financial_reports_table_missing',
    'corp_fundamentals_table_missing',
    'corp_disclosures_table_missing',
    'financial_report_rows_below_target',
    'corp_fundamentals_below_target',
    'fresh_fundamentals_24h_below_target',
    'daily_disclosures_below_target',
  ].includes(item.code));
  const stage2Ready = !blockers.some((item) => [
    'shadow_observation_days_below_target',
    'strategy_shadow_signals_7d_below_target',
  ].includes(item.code));
  const stage3Ready = !blockers.some((item) => [
    'korean_factor_log_table_missing',
    'candidate_backtest_status_table_missing',
    'korean_factor_rows_7d_below_target',
    'domestic_backtest_rows_7d_below_target',
    'domestic_backtest_fresh_rows_7d_below_target',
    'domestic_backtest_healthy_rows_7d_below_target',
    'domestic_backtest_pass_rate_below_target',
    'worldquant_alpha_count_below_target',
  ].includes(item.code));

  return {
    ok: true,
    status: promotionReady ? 'luna_korea_data_promotion_ready_pending_master_approval' : 'luna_korea_data_promotion_blocked',
    generatedAt: metrics.generatedAt || new Date().toISOString(),
    shadowOnly: true,
    liveTradeImpact: false,
    liveOrderAllowed: false,
    promotionReady,
    promotionAllowed: false,
    explicitMasterApprovalRequired: true,
    thresholds,
    metrics: {
      ...counts,
      domesticBacktestPassRate7d: domesticPassRate,
      domesticBacktestActiveTotal: countMetric(metrics.domesticBacktestActiveTotal),
      domesticBacktestActiveCandidates: countMetric(metrics.domesticBacktestActiveCandidates),
      domesticBacktestCooldownExcluded: countMetric(metrics.domesticBacktestCooldownExcluded),
      domesticBacktestBlockExcluded: countMetric(metrics.domesticBacktestBlockExcluded),
      domesticBacktestMetricScope: metrics.domesticBacktestMetricScope || null,
      disclosuresCurrentDate: countMetric(metrics.disclosuresCurrentDate ?? metrics.disclosuresToday?.currentDateCount),
      disclosuresLatestDate: metrics.disclosuresLatestDate || metrics.disclosuresToday?.latestDate || null,
      disclosuresLatestDateCount: countMetric(metrics.disclosuresLatestDateCount ?? metrics.disclosuresToday?.latestDateCount),
      openDartConfigured,
      dartFssAvailable,
      openDartSource: metrics.openDartSource || null,
    },
    stages: {
      stage1: {
        name: 'Open DART data accumulation',
        ready: stage1Ready,
        status: stage1Ready ? 'ready' : 'blocked',
      },
      stage2: {
        name: '3 domestic public-data strategies shadow run',
        ready: stage2Ready,
        status: stage2Ready ? 'ready' : 'blocked',
      },
      stage3: {
        name: 'WorldQuant Korea backtest and promotion gate',
        ready: stage3Ready,
        status: stage3Ready ? 'ready' : 'blocked',
      },
    },
    blockers,
    warnings,
    nextActions: blockers.length ? blockers.slice(0, 12).map((item) => actionForBlocker(item.code)) : [
      {
        blocker: null,
        action: 'manual_master_review_only',
        command: null,
        note: 'All shadow criteria passed, but live promotion remains disabled until explicit approval.',
      },
    ],
  };
}

function actionForBlocker(code) {
  const map = {
    opendart_api_key_missing: {
      action: 'enter_redacted_opendart_key',
      command: 'npm --prefix bots/investment run -s secrets-doctor:luna-opendart -- --template',
    },
    financial_report_rows_below_target: {
      action: 'run_shadow_financial_refresh_until_coverage_target',
      command: 'npm --prefix bots/investment run -s runtime:luna-opendart-financial-batch-refresh -- --json --network --limit=25 --skip-fresh --write --confirm=luna-opendart-financial-batch-write',
      requiresDataWriteApproval: true,
      liveTradeImpact: false,
    },
    corp_fundamentals_below_target: {
      action: 'run_shadow_financial_refresh_until_fundamental_target',
      command: 'npm --prefix bots/investment run -s runtime:luna-opendart-financial-batch-refresh -- --json --network --limit=25 --skip-fresh --write --confirm=luna-opendart-financial-batch-write',
      requiresDataWriteApproval: true,
      liveTradeImpact: false,
    },
    fresh_fundamentals_24h_below_target: {
      action: 'refresh_daily_fundamental_shadow_snapshot',
      command: 'npm --prefix bots/investment run -s runtime:luna-opendart-financial-batch-refresh -- --json --network --limit=25 --skip-fresh --write --confirm=luna-opendart-financial-batch-write',
      requiresDataWriteApproval: true,
      liveTradeImpact: false,
    },
    daily_disclosures_below_target: {
      action: 'refresh_open_dart_disclosures_and_recheck_market_day_volume',
      command: 'npm --prefix bots/investment run -s runtime:luna-opendart-disclosure-refresh -- --json --write',
      requiresDataWriteApproval: true,
      liveTradeImpact: false,
    },
    korean_factor_rows_7d_below_target: {
      action: 'run_korean_factor_shadow_refresh',
      command: 'npm --prefix bots/investment run -s runtime:luna-korean-factor-refresh -- --json --write',
      requiresDataWriteApproval: true,
      liveTradeImpact: false,
    },
    domestic_backtest_rows_7d_below_target: {
      action: 'refresh_domestic_candidate_discovery_and_backtests_before_promotion',
      command: 'npm --prefix bots/investment run -s runtime:luna-discovery-refresh -- --json --force --markets=domestic --limit=30 --ttl-hours=6 && npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json --dry-run --market=domestic',
    },
    domestic_backtest_fresh_rows_7d_below_target: {
      action: 'refresh_domestic_candidate_discovery_and_stale_backtests',
      command: 'npm --prefix bots/investment run -s runtime:luna-discovery-refresh -- --json --force --markets=domestic --limit=30 --ttl-hours=6 && npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json --dry-run --force --market=domestic',
    },
    domestic_backtest_healthy_rows_7d_below_target: {
      action: 'improve_or_filter_unhealthy_domestic_candidates',
      command: 'npm --prefix bots/investment run -s runtime:luna-candidate-quality-governance -- --json --dry-run --market=domestic',
    },
    domestic_backtest_pass_rate_below_target: {
      action: 'lower_domestic_strategy_bias_until_backtest_pass_rate_recovers',
      command: 'npm --prefix bots/investment run -s runtime:luna-candidate-quality-governance -- --json --dry-run --market=domestic',
    },
    shadow_observation_days_below_target: {
      action: 'continue_shadow_observation_without_live_promotion',
      command: 'npm --prefix bots/investment run -s runtime:luna-korea-data-promotion-gate -- --json --no-write',
    },
    strategy_shadow_signals_7d_below_target: {
      action: 'run_three_public_data_strategy_shadow_runtimes_and_record_ledger',
      command: 'npm --prefix bots/investment run -s runtime:luna-fundamental-quant-trading -- --json --apply --confirm=luna-fundamental-quant-shadow-signal && npm --prefix bots/investment run -s runtime:luna-earnings-surprise-trading -- --json --apply --confirm=luna-earnings-surprise-shadow-signal && npm --prefix bots/investment run -s runtime:luna-disclosure-event-driven -- --json --apply --confirm=luna-disclosure-event-shadow-signal',
      requiresDataWriteApproval: true,
      liveTradeImpact: false,
    },
    worldquant_alpha_count_below_target: {
      action: 'verify_worldquant_korean_alpha_coverage',
      command: 'npm --prefix bots/investment run -s smoke:luna-korea-data',
    },
  };
  return {
    blocker: code,
    ...(map[code] || {
      action: 'inspect_korea_data_shadow_blocker',
      command: 'npm --prefix bots/investment run -s runtime:luna-korea-data-report -- --json --no-write',
    }),
  };
}

export default {
  DEFAULT_KOREA_DATA_PROMOTION_THRESHOLDS,
  normalizeKoreaDataPromotionThresholds,
  buildKoreaDataPromotionGate,
};
