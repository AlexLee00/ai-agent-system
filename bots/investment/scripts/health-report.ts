// @ts-nocheck
/**
 * scripts/health-report.js — 루나팀 운영자용 헬스 리포트
 *
 * 목적:
 *   - launchd 상태와 trade_review 정합성을 사람이 읽기 좋은 형태로 요약
 *   - 공용 health-core 포맷을 사용하는 1차 report 스크립트
 *
 * 실행:
 *   node bots/investment/scripts/health-report.js [--json]
 */

import path from 'path';
import fs from 'node:fs';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import gemmaPilot from '../../../packages/core/lib/gemma-pilot.js';
import {
  getKisExecutionModeInfo,
  getKisMarketStatus,
  getKisOverseasMarketStatus,
} from '../shared/secrets.ts';
import { getValidationSoftBudgetConfig } from '../shared/runtime-config.ts';
import { loadCandidates as loadForceExitCandidates } from './force-exit-candidate-report.ts';
import {
  buildGuardHealth,
  buildScheduledDeploymentState,
  formatLaneLabel,
  loadCapitalGuardBreakdown,
  loadCapitalPolicySnapshot,
  loadCryptoValidationBudgetBlockHealth,
  loadCryptoValidationBudgetPolicyHealth,
  loadCryptoSentinelFallbackHealth,
  loadCryptoValidationSoftBudgetHealth,
  loadDomesticCollectPressure,
  loadDomesticRejectBreakdown,
  loadMockUntradableSymbolHealth,
  loadRecentLaneBlockPressure,
  loadRecentSignalBlockHealth,
  loadSignalBlockHealth,
  loadTradeLaneHealth,
} from './health-report-support.ts';

const { generateGemmaPilotText } = gemmaPilot as {
  generateGemmaPilotText: (payload: Record<string, any>) => Promise<{ ok?: boolean; content?: string }>;
};

const require = createRequire(import.meta.url);
const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthCountSection,
  buildHealthSampleSection,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const hsm = require('../../../packages/core/lib/health-state-manager');
const {
  getServiceOwnership,
  isElixirOwnedService,
  isRetiredService,
} = require('../../../packages/core/lib/service-ownership.legacy.js');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
} = require('../../../packages/core/lib/health-provider');
const billingGuard = require('../../../packages/core/lib/billing-guard');
const pgPool = require('../../../packages/core/lib/pg-pool');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONTINUOUS = [
  'ai.investment.commander',
];

const CONTINUOUS_RUNTIME_CHECKS = {
  'ai.investment.commander': {
    type: 'lockfile',
    path: path.join(process.env.HOME || '', '.openclaw', 'workspace', 'luna-commander.lock'),
    description: '루나 commander 실행 중',
  },
};

const ALL_SERVICES = [
  'ai.investment.commander',
  'ai.investment.crypto',
  'ai.investment.domestic',
  'ai.investment.overseas',
  'ai.investment.argos',
  'ai.investment.market-alert-crypto-daily',
  'ai.investment.market-alert-domestic-open',
  'ai.investment.market-alert-domestic-close',
  'ai.investment.market-alert-overseas-open',
  'ai.investment.market-alert-overseas-close',
  'ai.investment.prescreen-domestic',
  'ai.investment.prescreen-overseas',
  'ai.investment.reporter',
];

const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const SCHEDULED_SERVICE_DEPLOYMENTS = {
  'ai.investment.crypto': {
    scriptPath: path.resolve(__dirname, '..', 'markets', 'crypto.ts'),
    errorLogPath: '/tmp/investment-crypto.err.log',
  },
  'ai.investment.domestic': {
    scriptPath: path.resolve(__dirname, '..', 'markets', 'domestic.ts'),
    errorLogPath: '/tmp/investment-domestic.err.log',
  },
  'ai.investment.overseas': {
    scriptPath: path.resolve(__dirname, '..', 'markets', 'overseas.ts'),
    errorLogPath: '/tmp/investment-overseas.err.log',
  },
};

function sanitizeInsightLine(text = '') {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) =>
      line &&
      !/^thinking process/i.test(line) &&
      !/^[0-9]+\.\s/.test(line) &&
      !/^<\|/.test(line) &&
      !/^ai[:：]/i.test(line)
    ) || '';
}

function labelToPortAgentName(label) {
  return String(label || '')
    .replace(/^ai\.investment\./, '')
    .replace(/[.-]+/g, '_');
}

function isPidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function isContinuousServiceHealthy(label = '') {
  const check = CONTINUOUS_RUNTIME_CHECKS[label];
  if (!check) return false;

  if (check.type === 'lockfile') {
    try {
      if (!fs.existsSync(check.path)) return false;
      const pid = String(fs.readFileSync(check.path, 'utf8') || '').trim();
      return pid !== '' && isPidAlive(pid);
    } catch {
      return false;
    }
  }

  return false;
}

async function loadElixirOwnedInvestmentRows(labels = []) {
  if (!labels.length) return { ok: [], warn: [] };

  const botNames = labels.map(labelToPortAgentName);
  const rows = await pgPool.query(
    'agent',
    `
    SELECT DISTINCT ON (bot_name)
      bot_name,
      event_type,
      created_at
    FROM agent.event_lake
    WHERE team = 'investment'
      AND bot_name = ANY($1)
      AND event_type IN ('port_agent_started', 'port_agent_run', 'port_agent_completed', 'port_agent_failed')
      AND created_at::timestamptz >= NOW() - INTERVAL '6 hours'
    ORDER BY bot_name, created_at::timestamptz DESC
  `,
    [botNames],
  ).catch(() => []);

  const latestByBot = new Map((rows || []).map((row) => [String(row.bot_name || ''), row]));
  const ok = [];
  const warn = [];

  for (const label of labels) {
    const shortName = hsm.shortLabel(label);
    const ownership = getServiceOwnership(label);
    const botName = labelToPortAgentName(label);
    const latest = latestByBot.get(botName);

    if (!latest) {
      const ownerText = ownership?.expectedIdle ? 'Elixir ownership (scheduled)' : 'Elixir ownership';
      ok.push(`  ${shortName}: ${ownerText}`);
      continue;
    }

    const eventType = String(latest.event_type || '');
    if (eventType === 'port_agent_failed') {
      if (CONTINUOUS.includes(label) && isContinuousServiceHealthy(label)) {
        ok.push(`  ${shortName}: Elixir ownership (runtime healthy despite prior failure)`);
        continue;
      }
      warn.push(`  ${shortName}: Elixir ownership / 최근 PortAgent 실패`);
      continue;
    }

    const ownerText = ownership?.expectedIdle
      ? 'Elixir ownership (recent PortAgent activity)'
      : 'Elixir ownership';
    ok.push(`  ${shortName}: ${ownerText}`);
  }

  return { ok, warn };
}

function buildHealthFallbackInsight(report) {
  const warnCount = Number(report?.serviceHealth?.warnCount || 0);
  const findings = Number(report?.tradeReview?.findings || 0);
  const staleLive = Number(report?.stalePositionHealth?.warnCount || 0);
  const signalBlocks = Number(report?.signalBlockHealth?.total || 0);
  const recentBlocks = Number(report?.recentSignalBlockHealth?.total || 0);
  const liveGateWarn = Number(report?.cryptoLiveGateHealth?.warnCount || 0);

  if (warnCount > 0) {
    return `서비스 경고 ${warnCount}건이 있어 launchd 상태와 실패 서비스부터 먼저 점검하는 편이 좋습니다.`;
  }
  if (findings > 0) {
    return `trade_review 정합성 점검 필요 ${findings}건이 있어 데이터 정합성 보정을 우선하는 편이 좋습니다.`;
  }
  if (staleLive > 0) {
    return `장기 미결 LIVE 포지션 ${staleLive}건이 있어 실행 대기와 capability 제약을 먼저 확인하는 편이 좋습니다.`;
  }
  if (liveGateWarn > 0) {
    return `암호화폐 LIVE 게이트가 아직 보수 구간이라 PAPER·LIVE 전환 판단 근거를 먼저 확인하는 편이 좋습니다.`;
  }
  if (signalBlocks > 0 || recentBlocks > 0) {
    return `신호 차단 흐름이 남아 있어 자본 가드와 rail 압력부터 복기하는 편이 좋습니다.`;
  }
  return '핵심 서비스와 trade_review 정합성은 대체로 안정적이며, 현재는 추가 조치보다 관찰 유지가 적절합니다.';
}

async function buildHealthInsight(report) {
  try {
    const prompt = `당신은 투자 운영 헬스 리포트 분석가입니다.
아래 데이터를 보고 운영자가 바로 읽을 수 있는 핵심 인사이트를 한국어 한 줄로만 작성하세요.
숫자 재나열보다 위험 신호, 우선 점검 포인트, 운영 안정성 판단을 중심으로 적으세요.

데이터:
${JSON.stringify({
  serviceHealth: {
    okCount: report?.serviceHealth?.okCount,
    warnCount: report?.serviceHealth?.warnCount,
  },
  tradeReview: report?.tradeReview,
  signalBlocks: {
    total: report?.signalBlockHealth?.total,
    recentTotal: report?.recentSignalBlockHealth?.total,
    topGroups: (report?.signalBlockHealth?.topReasonGroups || []).slice(0, 5),
  },
  staleLive: report?.stalePositionHealth?.readinessSummary,
  liveGate: {
    warnCount: report?.cryptoLiveGateHealth?.warnCount,
    decision: report?.cryptoLiveGateHealth?.review?.liveGate?.decision,
    reason: report?.cryptoLiveGateHealth?.review?.liveGate?.reason,
  },
  tradeLaneHealth: {
    okCount: report?.tradeLaneHealth?.okCount,
    warnCount: report?.tradeLaneHealth?.warnCount,
  },
  decision: report?.decision,
}, null, 2).slice(0, 2200)}`;

    const insight = await generateGemmaPilotText({
      team: 'investment',
      purpose: 'gemma-insight',
      bot: 'health-report',
      requestType: 'health-summary',
      prompt,
      maxTokens: 120,
      temperature: 0.35,
      timeoutMs: 10000,
    });
    return sanitizeInsightLine(insight?.content || '') || buildHealthFallbackInsight(report);
  } catch (error) {
    console.warn(`[health-report] AI 요약 생략: ${error?.message || error}`);
    return buildHealthFallbackInsight(report);
  }
}

async function loadTradeReviewHealth() {
  const modulePath = path.resolve(__dirname, './validate-trade-review.ts');
  const mod = await import(pathToFileURL(modulePath).href);
  const result = await mod.validateTradeReview({ days: 90, fix: false });
  return {
    findings: result.findings || 0,
    closedTrades: result.closedTrades || 0,
  };
}


function getStalePositionThresholdHours(exchange) {
  if (exchange === 'kis_overseas') return 72;
  if (exchange === 'kis') return 48;
  if (exchange === 'binance') return 48;
  return 48;
}

async function loadStalePositionHealth() {
  const staleRows = await loadForceExitCandidates().catch(() => []);
  const actionableRows = staleRows.filter((row) => row.readiness === 'ready_now' || row.readiness === 'guarded_ready');
  const blockedRows = staleRows.filter((row) => row.readiness === 'blocked_by_capability');
  const waitingRows = staleRows.filter((row) => row.readiness === 'wait_market_open');
  const executeNowRows = actionableRows.filter((row) =>
    row.candidateLevel === 'strong_force_exit_candidate' || Number(row.positionValue || 0) >= 100,
  );
  const observeFirstRows = actionableRows.filter((row) => !executeNowRows.includes(row));

  const warn = [
    ...observeFirstRows.slice(0, 4).map((row) => {
      const thresholdHours = getStalePositionThresholdHours(row.exchange);
      const value = Number(row.positionValue || 0).toFixed(2);
      return `  [observe-first] ${formatLaneLabel(row.exchange, row.tradeMode)} ${row.symbol} ${Number(row.ageHours || 0).toFixed(1)}h / value ${value} (${row.readinessLabel}, threshold ${thresholdHours}h)`;
    }),
    ...executeNowRows.slice(0, 4).map((row) => {
      const thresholdHours = getStalePositionThresholdHours(row.exchange);
      const value = Number(row.positionValue || 0).toFixed(2);
      return `  [execute-now] ${formatLaneLabel(row.exchange, row.tradeMode)} ${row.symbol} ${Number(row.ageHours || 0).toFixed(1)}h / value ${value} (${row.readinessLabel}, threshold ${thresholdHours}h)`;
    }),
    ...blockedRows.slice(0, 4).map((row) => {
      const thresholdHours = getStalePositionThresholdHours(row.exchange);
      const value = Number(row.positionValue || 0).toFixed(2);
      return `  [blocked] ${formatLaneLabel(row.exchange, row.tradeMode)} ${row.symbol} ${Number(row.ageHours || 0).toFixed(1)}h / value ${value} (${row.readinessReason}, threshold ${thresholdHours}h)`;
    }),
    ...waitingRows.slice(0, 2).map((row) => {
      const thresholdHours = getStalePositionThresholdHours(row.exchange);
      const value = Number(row.positionValue || 0).toFixed(2);
      return `  [waiting] ${formatLaneLabel(row.exchange, row.tradeMode)} ${row.symbol} ${Number(row.ageHours || 0).toFixed(1)}h / value ${value} (${row.readinessReason}, threshold ${thresholdHours}h)`;
    }),
  ];

  const ok = staleRows.length === 0
    ? ['  장기 미결 LIVE 포지션 없음']
    : [];

  return {
    okCount: staleRows.length === 0 ? 1 : 0,
    warnCount: staleRows.length,
    ok,
    warn,
    staleRows,
    actionableRows,
    observeFirstRows,
    executeNowRows,
    blockedRows,
    waitingRows,
    readinessSummary: {
      actionable: actionableRows.length,
      observeFirst: observeFirstRows.length,
      executeNow: executeNowRows.length,
      blockedByCapability: blockedRows.length,
      waitMarketOpen: waitingRows.length,
    },
  };
}

async function loadCryptoLiveGateHealth() {
  try {
    const modulePath = path.resolve(__dirname, './crypto-live-gate-review.ts');
    const mod = await import(pathToFileURL(modulePath).href);
    const periodDays = Number(mod.DEFAULT_CRYPTO_LIVE_GATE_DAYS || 7);
    const review = await mod.loadCryptoLiveGateReview(periodDays);
    const decision = String(review?.liveGate?.decision || 'unknown');
    const maxPositions = Number(review?.metrics?.pipeline?.riskRejectReasons?.max_positions || 0);
    const validationLiveOverlap = Number(review?.metrics?.pipeline?.riskRejectReasons?.validation_live_overlap || 0);
    const lines = [
      `  게이트: ${decision}`,
      `  사유: ${String(review?.liveGate?.reason || 'n/a')}`,
      `  체결: ${Number(review?.metrics?.trades?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.paper || 0)})`,
      `  mode 체결: NORMAL ${Number(review?.metrics?.trades?.byMode?.NORMAL?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.byMode?.NORMAL?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.byMode?.NORMAL?.paper || 0)}), VALIDATION ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.paper || 0)})`,
      `  퍼널: decision ${Number(review?.metrics?.pipeline?.decision || 0)} / BUY ${Number(review?.metrics?.pipeline?.buy || 0)} / approved ${Number(review?.metrics?.pipeline?.approved || 0)} / executed ${Number(review?.metrics?.pipeline?.executed || 0)}`,
      `  weak: ${Number(review?.metrics?.pipeline?.weak || 0)}${review?.metrics?.pipeline?.weakTop ? ` (top ${review.metrics.pipeline.weakTop})` : ''}`,
      `  risk reject: max positions ${maxPositions} / validation LIVE overlap ${validationLiveOverlap}`,
      `  reentry: PAPER ${Number(review?.metrics?.blocks?.paperReentry || 0)} / LIVE ${Number(review?.metrics?.blocks?.liveReentry || 0)} / same-day ${Number(review?.metrics?.blocks?.sameDayReentry || 0)}`,
      `  종료 리뷰: ${Number(review?.metrics?.closedReviews || 0)}건`,
    ];
    return {
      okCount: decision === 'candidate' ? 1 : 0,
      warnCount: decision === 'blocked' ? 1 : 0,
      ok: decision === 'candidate' ? lines : [],
      warn: decision === 'blocked' ? lines : [],
      review,
      periodDays,
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  LIVE 게이트 리뷰 로드 실패: ${error?.message || String(error)}`],
      review: null,
      periodDays: 0,
    };
  }
}


async function loadKisCapabilityHealth() {
  const domesticMode = getKisExecutionModeInfo('국내주식');
  const overseasMode = getKisExecutionModeInfo('해외주식');
  const domesticStatus = await getKisMarketStatus();
  const overseasStatus = getKisOverseasMarketStatus();

  const domesticCapability = domesticMode.brokerAccountMode === 'mock'
    ? (domesticStatus.isOpen ? 'mock SELL 검증 가능' : 'mock SELL 장중에만 가능')
    : 'real SELL 가능';
  const overseasCapability = overseasMode.brokerAccountMode === 'mock'
    ? 'mock SELL 미지원 (KIS 90000000)'
    : 'real SELL 가능';

  return {
    domestic: {
      accountMode: domesticMode.brokerAccountMode,
      executionMode: domesticMode.executionMode,
      marketStatus: domesticStatus,
      capability: domesticCapability,
    },
    overseas: {
      accountMode: overseasMode.brokerAccountMode,
      executionMode: overseasMode.executionMode,
      marketStatus: overseasStatus,
      capability: overseasCapability,
    },
    okCount: overseasMode.brokerAccountMode === 'mock' && !overseasStatus.isOpen ? 1 : 2,
    warnCount: overseasMode.brokerAccountMode === 'mock' && !overseasStatus.isOpen ? 1 : 0,
    ok: [
      `  국내주식 ${domesticMode.executionMode}/${domesticMode.brokerAccountMode} — ${domesticStatus.reason} / ${domesticCapability}`,
      ...(overseasMode.brokerAccountMode === 'mock'
        ? []
        : [`  해외주식 ${overseasMode.executionMode}/${overseasMode.brokerAccountMode} — ${overseasStatus.reason} / ${overseasCapability}`]),
    ],
    warn: overseasMode.brokerAccountMode === 'mock'
      ? [`  해외주식 ${overseasMode.executionMode}/${overseasMode.brokerAccountMode} — ${overseasStatus.reason} / ${overseasCapability}`]
      : [],
  };
}

function buildDecision(
  serviceRows,
  tradeReview,
  guardHealth,
  signalBlockHealth,
  recentSignalBlockHealth,
  recentLaneBlockPressure,
  mockUntradableSymbolHealth,
  domesticCollectPressure,
  domesticRejectBreakdown,
  tradeLaneHealth,
  cryptoValidationSoftBudgetHealth,
  cryptoValidationBudgetBlockHealth,
  cryptoSentinelFallbackHealth,
  stalePositionHealth,
  cryptoLiveGateHealth,
  capitalGuardBreakdown,
  cryptoValidationBudgetPolicyHealth,
) {
  const topBlock = signalBlockHealth.top[0] || null;
  const topReasonGroup = signalBlockHealth.topReasonGroups?.[0] || null;
  const recentTopReasonGroup = recentSignalBlockHealth.topReasonGroups?.[0] || null;
  const saturatedLane = tradeLaneHealth.lanes.find((lane) => lane.atLimit);
  const nearLimitLane = tradeLaneHealth.lanes.find((lane) => lane.nearLimit);
  const pressureLane = recentLaneBlockPressure.topLane || null;
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `launchd 경고 ${serviceRows.warn.length}건이 있어 서비스 상태 점검이 필요합니다.`,
      },
      {
        active: tradeReview.findings > 0,
        level: 'medium',
        reason: `trade_review 정합성 이슈 ${tradeReview.findings}건이 남아 있습니다.`,
      },
      {
        active: guardHealth.warnCount > 0,
        level: 'medium',
        reason: `투자 LLM guard ${guardHealth.warnCount}건이 활성 상태입니다.`,
      },
      {
        active: signalBlockHealth.total >= 5,
        level: topReasonGroup?.group === 'daily_trade_limit' ? 'medium' : 'low',
        reason: `오늘 차단/거부 신호 ${signalBlockHealth.total}건 — 최다 코드 ${topBlock?.code || 'n/a'} ${topBlock?.count || 0}건 / 최다 세부 그룹 ${topReasonGroup?.group || 'n/a'} ${topReasonGroup?.count || 0}건`,
      },
      {
        active: recentSignalBlockHealth.total >= 1,
        level: recentTopReasonGroup?.group === 'daily_trade_limit' ? 'medium' : 'low',
        reason: `최근 ${recentSignalBlockHealth.windowMinutes}분 차단/거부 ${recentSignalBlockHealth.total}건 — 최다 세부 그룹 ${recentTopReasonGroup?.group || 'n/a'} ${recentTopReasonGroup?.count || 0}건`,
      },
      {
        active: recentLaneBlockPressure.total >= 1,
        level: pressureLane?.count >= 3 ? 'medium' : 'low',
        reason: `최근 ${recentLaneBlockPressure.windowMinutes}분 일간 한도 압력 ${recentLaneBlockPressure.total}건 — 최다 rail ${pressureLane?.label || 'n/a'} ${pressureLane?.count || 0}건`,
      },
      {
        active: domesticCollectPressure.warnCount > 0,
        level: domesticCollectPressure.counts.collectOverload > 0 || domesticCollectPressure.counts.debateCapacityHot > 0 ? 'medium' : 'low',
        reason: `국내장 최신 cycle(${domesticCollectPressure.windowLines}줄) 기준 수집 압력 — symbols ${domesticCollectPressure.latestMetrics?.symbols ?? 'n/a'}, tasks ${domesticCollectPressure.latestMetrics?.tasks ?? 'n/a'}, overload ${domesticCollectPressure.counts.collectOverload}, wide ${domesticCollectPressure.counts.wideUniverse}, debate ${domesticCollectPressure.counts.debateCapacityHot}, data_sparsity ${domesticCollectPressure.counts.dataSparsity}`,
      },
      {
        active: mockUntradableSymbolHealth.total > 0,
        level: 'low',
        reason: `최근 ${mockUntradableSymbolHealth.windowMinutes / 60}시간 KIS mock 주문 불가 종목 ${mockUntradableSymbolHealth.total}건 — screening/approval 쿨다운 관찰 필요`,
      },
      {
        active: domesticRejectBreakdown.total > 0,
        level: domesticRejectBreakdown.rows[0]?.block_code === 'broker_rate_limited' ? 'medium' : 'low',
        reason: `최근 ${domesticRejectBreakdown.windowMinutes / 60}시간 국내장 주문 실패 ${domesticRejectBreakdown.total}건 — 최다 ${domesticRejectBreakdown.rows[0]?.label || 'n/a'} ${domesticRejectBreakdown.rows[0]?.cnt || 0}건`,
      },
      {
        active: Boolean(saturatedLane || nearLimitLane),
        level: saturatedLane ? 'medium' : 'low',
        reason: saturatedLane
          ? `거래 한도 도달 rail ${formatLaneLabel(saturatedLane.exchange, saturatedLane.tradeMode)} ${saturatedLane.count}/${saturatedLane.limit}`
          : `거래 한도 근접 rail ${formatLaneLabel(nearLimitLane?.exchange, nearLimitLane?.tradeMode)} ${nearLimitLane?.count}/${nearLimitLane?.limit}`,
      },
      {
        active: cryptoValidationSoftBudgetHealth.enabled && (cryptoValidationSoftBudgetHealth.atSoftCap || cryptoValidationSoftBudgetHealth.nearSoftCap),
        level: cryptoValidationSoftBudgetHealth.atSoftCap ? 'medium' : 'low',
        reason: `crypto validation soft budget ${cryptoValidationSoftBudgetHealth.count}/${cryptoValidationSoftBudgetHealth.softCap} (hard ${cryptoValidationSoftBudgetHealth.hardCap}, reserve ${cryptoValidationSoftBudgetHealth.reserveSlots})`,
      },
      {
        active: cryptoValidationBudgetBlockHealth.total > 0,
        level: 'medium',
        reason: `최근 ${Math.round(cryptoValidationBudgetBlockHealth.windowMinutes / 60)}시간 crypto validation soft cap 차단 ${cryptoValidationBudgetBlockHealth.total}건`,
      },
      {
        active: cryptoSentinelFallbackHealth.total > 0,
        level: 'low',
        reason: `최근 ${Math.round(cryptoSentinelFallbackHealth.windowMinutes / 60)}시간 센티널 부분 폴백 ${cryptoSentinelFallbackHealth.total}건 — ${cryptoSentinelFallbackHealth.sources[0]?.source || 'unknown'} ${cryptoSentinelFallbackHealth.sources[0]?.count || 0}건`,
      },
      {
        active: capitalGuardBreakdown.total > 0,
        level: capitalGuardBreakdown.byReasonGroup[0]?.group === 'daily_trade_limit' ? 'medium' : 'low',
        reason: `최근 ${capitalGuardBreakdown.periodDays}일 crypto capital guard ${capitalGuardBreakdown.total}건 — validation ${capitalGuardBreakdown.laneSnapshot?.validationCount || 0}건 (${capitalGuardBreakdown.laneSnapshot?.validationRatio || 0}%) / normal ${capitalGuardBreakdown.laneSnapshot?.normalCount || 0}건 / 최다 ${capitalGuardBreakdown.laneSnapshot?.topReason?.label || 'n/a'} ${capitalGuardBreakdown.laneSnapshot?.topReason?.count || 0}건`,
      },
      {
        active: Boolean(capitalGuardBreakdown.topHotspot),
        level: 'low',
        reason: `crypto capital guard hotspot — ${capitalGuardBreakdown.topHotspot?.label || 'n/a'} ${capitalGuardBreakdown.topHotspot?.count || 0}건`,
      },
      {
        active: Boolean(capitalGuardBreakdown.topOverlapHotspot),
        level: 'low',
        reason: `validation/live overlap hotspot — ${capitalGuardBreakdown.topOverlapHotspot?.label || 'n/a'} ${capitalGuardBreakdown.topOverlapHotspot?.count || 0}건`,
      },
      {
        active: Boolean(capitalGuardBreakdown.actionHints?.length),
        level: 'low',
        reason: `crypto gate action hint — ${capitalGuardBreakdown.actionHints?.[0] || 'n/a'}`,
      },
      {
        active: Boolean(capitalGuardBreakdown.actionCandidates?.length),
        level: 'low',
        reason: `crypto gate next action — ${capitalGuardBreakdown.actionCandidates?.[0]?.summary || 'n/a'}`,
      },
      {
        active: cryptoValidationBudgetPolicyHealth?.decision === 'consider_policy_split',
        level: 'medium',
        reason: `crypto validation budget 정책 판단 — ${cryptoValidationBudgetPolicyHealth?.decisionLabel || '현 구조 유지'}`,
      },
      {
        active: stalePositionHealth.warnCount > 0,
        level: 'medium',
        reason: `장기 미결 LIVE 포지션 ${stalePositionHealth.warnCount}건 — 즉시 실행 ${stalePositionHealth.readinessSummary?.executeNow || 0}건 / 관찰 우선 ${stalePositionHealth.readinessSummary?.observeFirst || 0}건 / capability 제약 ${stalePositionHealth.readinessSummary?.blockedByCapability || 0}건`,
      },
      {
        active: cryptoLiveGateHealth.warnCount > 0,
        level: 'medium',
        reason: `암호화폐 LIVE 게이트 ${cryptoLiveGateHealth.review?.liveGate?.decision || 'blocked'} — ${cryptoLiveGateHealth.review?.liveGate?.reason || 'PAPER/LIVE 전환 데이터 부족'}`,
      },
    ],
    okReason: '핵심 서비스와 trade_review 정합성이 현재는 안정 구간입니다.',
  });
}

function buildCryptoGateActionPlan(capitalGuardBreakdown) {
  const candidates = capitalGuardBreakdown?.actionCandidates || [];
  const now = candidates.filter((candidate) => candidate.priority === 'high');
  const next = candidates.filter((candidate) => candidate.priority === 'medium');
  const later = candidates.filter((candidate) => candidate.priority !== 'high' && candidate.priority !== 'medium');

  return {
    now,
    next,
    later,
    summary: now[0]?.summary || next[0]?.summary || later[0]?.summary || '추가 action candidate 없음',
  };
}

function formatText(report) {
  const sections = [
    {
      title: '■ AI 요약',
      lines: [`  ${report.aiSummary || buildHealthFallbackInsight(report)}`],
    },
    buildHealthCountSection('■ 서비스 상태', report.serviceHealth),
    {
      title: '■ trade_review 정합성',
      lines: [
        `  종료 거래 ${report.tradeReview.closedTrades}건`,
        `  점검 필요 ${report.tradeReview.findings}건`,
      ],
    },
    buildHealthCountSection('■ 투자 LLM guard', report.guardHealth, { okLimit: 1 }),
    {
      title: '■ 신호 차단 코드(오늘)',
      lines: report.signalBlockHealth.total > 0
        ? [
            `  총 ${report.signalBlockHealth.total}건`,
            ...report.signalBlockHealth.top.map((row) => `  ${row.code}: ${row.count}건`),
          ]
        : ['  오늘 차단/거부 신호 없음'],
    },
    {
      title: '■ 자본/가드 차단 세부(오늘)',
      lines: report.signalBlockHealth.topReasonGroups?.length > 0
        ? report.signalBlockHealth.topReasonGroups.map((row) => `  ${row.group}: ${row.count}건`)
        : ['  세부 차단 그룹 없음'],
    },
    {
      title: `■ 최근 ${report.recentSignalBlockHealth.windowMinutes}분 차단 세부`,
      lines: report.recentSignalBlockHealth.total > 0
        ? [
            `  총 ${report.recentSignalBlockHealth.total}건`,
            ...report.recentSignalBlockHealth.topReasonGroups.map((row) => `  ${row.group}: ${row.count}건`),
          ]
        : ['  최근 차단/거부 신호 없음'],
    },
    {
      title: `■ crypto capital guard 분해(최근 ${report.capitalGuardBreakdown.periodDays}일)`,
      lines: report.capitalGuardBreakdown.total > 0
        ? [
            `  총 ${report.capitalGuardBreakdown.total}건`,
            `  validation ${report.capitalGuardBreakdown.laneSnapshot?.validationCount || 0}건 (${report.capitalGuardBreakdown.laneSnapshot?.validationRatio || 0}%) / normal ${report.capitalGuardBreakdown.laneSnapshot?.normalCount || 0}건`,
            `  dominant guard: ${report.capitalGuardBreakdown.laneSnapshot?.topReason?.label || 'n/a'} ${report.capitalGuardBreakdown.laneSnapshot?.topReason?.count || 0}건`,
            ...(report.capitalGuardBreakdown.topHotspot
              ? [`  top hotspot: ${report.capitalGuardBreakdown.topHotspot.label} ${report.capitalGuardBreakdown.topHotspot.count}건`]
              : []),
            ...(report.capitalGuardBreakdown.topOverlapHotspot
              ? [`  top overlap hotspot: ${report.capitalGuardBreakdown.topOverlapHotspot.label} ${report.capitalGuardBreakdown.topOverlapHotspot.count}건`]
              : []),
            ...(report.capitalGuardBreakdown.actionHints?.length
              ? [
                  '  action hints:',
                  ...report.capitalGuardBreakdown.actionHints.map((hint) => `    ${hint}`),
                ]
              : []),
            ...(report.capitalGuardBreakdown.actionCandidates?.length
              ? [
                  '  next actions:',
                  ...report.capitalGuardBreakdown.actionCandidates.map((candidate) => `    [${candidate.priority}] ${candidate.label}: ${candidate.summary}`),
                ]
              : []),
            ...report.capitalGuardBreakdown.byReasonGroup.map((row) => `  ${row.label}: ${row.count}건`),
            ...report.capitalGuardBreakdown.byTradeMode.map((row) => `  mode ${row.tradeMode}: ${row.count}건`),
            ...(report.capitalGuardBreakdown.hotspots?.length
              ? [
                  '  hotspot:',
                  ...report.capitalGuardBreakdown.hotspots.map((row) => `    ${row.label}: ${row.count}건`),
                ]
              : []),
            ...(report.capitalGuardBreakdown.overlapHotspots?.length
              ? [
                  '  validation/live overlap hotspot:',
                  ...report.capitalGuardBreakdown.overlapHotspots.map((row) => `    ${row.label}: ${row.count}건`),
                ]
              : []),
          ]
        : ['  최근 crypto capital guard 차단 없음'],
    },
    {
      title: '■ crypto gate action plan',
      lines: [
        ...(report.cryptoGateActionPlan?.now?.length
          ? [
              '  지금:',
              ...report.cryptoGateActionPlan.now.map((candidate) => `    ${candidate.label}: ${candidate.summary}`),
            ]
          : ['  지금: 즉시 실행 후보 없음']),
        ...(report.cryptoGateActionPlan?.next?.length
          ? [
              '  다음:',
              ...report.cryptoGateActionPlan.next.map((candidate) => `    ${candidate.label}: ${candidate.summary}`),
            ]
          : []),
        ...(report.cryptoGateActionPlan?.later?.length
          ? [
              '  보류:',
              ...report.cryptoGateActionPlan.later.map((candidate) => `    ${candidate.label}: ${candidate.summary}`),
            ]
          : []),
        ...(report.capitalGuardBreakdown.actionCandidateDetails?.length
          ? [
              '  심볼 근거:',
              ...report.capitalGuardBreakdown.actionCandidateDetails.map(
                (detail) =>
                  `    ${detail.symbol}: guard ${detail.capitalGuardCount}건 / overlap ${detail.overlapCount}건 / trades ${detail.tradeCount}건 (LIVE ${detail.liveTradeCount} / PAPER ${detail.paperTradeCount}) / ${detail.recommendation}`,
              ),
            ]
          : []),
      ],
    },
    {
      title: `■ 최근 ${report.recentLaneBlockPressure.windowMinutes}분 rail 압력`,
      lines: report.recentLaneBlockPressure.total > 0
        ? report.recentLaneBlockPressure.lanes.map((lane) => `  ${lane.label}: ${lane.count}건`)
        : ['  최근 일간 한도 rail 압력 없음'],
    },
    buildHealthCountSection(`■ KIS mock 주문 불가 종목(최근 ${Math.round(report.mockUntradableSymbolHealth.windowMinutes / 60)}시간)`, report.mockUntradableSymbolHealth, { okLimit: 1, warnLimit: 8 }),
    buildHealthCountSection(`■ 국내장 수집 압력(최신 cycle / 로그 ${report.domesticCollectPressure.windowLines}줄, tail ${report.domesticCollectPressure.logLines}줄)`, report.domesticCollectPressure, { okLimit: 1, warnLimit: 8 }),
    buildHealthCountSection(`■ 국내장 주문 실패 분해(최근 ${Math.round(report.domesticRejectBreakdown.windowMinutes / 60)}시간)`, report.domesticRejectBreakdown, { okLimit: 1, warnLimit: 10 }),
    buildHealthCountSection('■ crypto validation soft budget(오늘)', report.cryptoValidationSoftBudgetHealth, { okLimit: 1, warnLimit: 1 }),
    buildHealthCountSection(`■ crypto validation soft cap 차단(최근 ${Math.round(report.cryptoValidationBudgetBlockHealth.windowMinutes / 60)}시간)`, report.cryptoValidationBudgetBlockHealth, { okLimit: 1, warnLimit: 8 }),
    buildHealthCountSection(`■ 센티널 부분 폴백(최근 ${Math.round(report.cryptoSentinelFallbackHealth.windowMinutes / 60)}시간)`, report.cryptoSentinelFallbackHealth, { okLimit: 1, warnLimit: 8 }),
    buildHealthCountSection('■ crypto validation budget 정책 판단', report.cryptoValidationBudgetPolicyHealth, { okLimit: 1, warnLimit: 8 }),
    {
      title: '■ 장기 미결 LIVE 포지션',
      lines: report.stalePositionHealth.warnCount > 0
        ? [
            `  총 ${report.stalePositionHealth.warnCount}건`,
            `  즉시 실행 ${report.stalePositionHealth.readinessSummary?.executeNow || 0}건 / 관찰 우선 ${report.stalePositionHealth.readinessSummary?.observeFirst || 0}건 / capability 제약 ${report.stalePositionHealth.readinessSummary?.blockedByCapability || 0}건 / 장중 대기 ${report.stalePositionHealth.readinessSummary?.waitMarketOpen || 0}건`,
            ...report.stalePositionHealth.warn.slice(0, 8),
          ]
        : ['  장기 미결 LIVE 포지션 없음'],
    },
    buildHealthCountSection(`■ 암호화폐 LIVE 게이트(최근 ${report.cryptoLiveGateHealth?.periodDays || 7}일)`, report.cryptoLiveGateHealth, { okLimit: 1, warnLimit: 1 }),
    buildHealthCountSection('■ KIS 실행 capability', report.kisCapabilityHealth, { okLimit: 1, warnLimit: 2 }),
    buildHealthCountSection('■ rail별 신규 진입 한도(오늘)', report.tradeLaneHealth, { okLimit: 6, warnLimit: 6 }),
    {
      title: null,
      lines: buildHealthDecisionSection({
        title: '■ 운영 판단',
        recommended: report.decision.recommended,
        level: report.decision.level,
        reasons: report.decision.reasons,
        okText: '현재는 추가 조치보다 관찰 유지',
      }),
    },
  ];

  const sampleSection = buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth);
  if (sampleSection) sections.splice(1, 0, sampleSection);

  return buildHealthReport({
    title: '📊 루나 운영 헬스 리포트',
    sections,
    footer: ['실행: node bots/investment/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus();
  const scheduledDeploymentState = buildScheduledDeploymentState(SCHEDULED_SERVICE_DEPLOYMENTS);
  const capitalPolicy = loadCapitalPolicySnapshot(path.resolve(__dirname, '..', 'config.yaml'));
  const launchdOwnedLabels = ALL_SERVICES.filter((label) => !isElixirOwnedService(label) && !isRetiredService(label));
  const elixirOwnedLabels = ALL_SERVICES.filter((label) => isElixirOwnedService(label));

  const launchdServiceRows = buildServiceRows(status, {
    labels: launchdOwnedLabels,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => hsm.shortLabel(label),
    isExpectedExit: (label, exitCode, svc) => {
      if (svc?.running) return false;
      if (NORMAL_EXIT_CODES.has(exitCode)) return true;
      return scheduledDeploymentState[label]?.staleFailure === true;
    },
  });
  const elixirOwnedRows = await loadElixirOwnedInvestmentRows(elixirOwnedLabels);
  const serviceRows = {
    ok: [...launchdServiceRows.ok, ...elixirOwnedRows.ok],
    warn: [...launchdServiceRows.warn, ...elixirOwnedRows.warn],
  };
  const tradeReview = await loadTradeReviewHealth();
  const guardHealth = buildGuardHealth(billingGuard);
  const signalBlockHealth = await loadSignalBlockHealth(pgPool);
  const recentSignalBlockHealth = await loadRecentSignalBlockHealth(pgPool);
  const recentLaneBlockPressure = await loadRecentLaneBlockPressure(pgPool);
  const mockUntradableSymbolHealth = await loadMockUntradableSymbolHealth(pgPool);
  const domesticCollectPressure = await loadDomesticCollectPressure(SCHEDULED_SERVICE_DEPLOYMENTS);
  const domesticRejectBreakdown = await loadDomesticRejectBreakdown(pgPool);
  const tradeLaneHealth = await loadTradeLaneHealth(pgPool, capitalPolicy);
  const cryptoValidationSoftBudgetHealth = await loadCryptoValidationSoftBudgetHealth(
    pgPool,
    capitalPolicy,
    getValidationSoftBudgetConfig('binance'),
  );
  const cryptoValidationBudgetBlockHealth = await loadCryptoValidationBudgetBlockHealth(pgPool);
  const cryptoSentinelFallbackHealth = await loadCryptoSentinelFallbackHealth(pgPool);
  const stalePositionHealth = await loadStalePositionHealth();
  const cryptoLiveGateHealth = await loadCryptoLiveGateHealth();
  const capitalGuardBreakdown = await loadCapitalGuardBreakdown(pgPool);
  const cryptoValidationBudgetPolicyHealth = loadCryptoValidationBudgetPolicyHealth(
    cryptoValidationBudgetBlockHealth,
    cryptoLiveGateHealth,
    capitalGuardBreakdown,
  );
  const cryptoGateActionPlan = buildCryptoGateActionPlan(capitalGuardBreakdown);
  const kisCapabilityHealth = await loadKisCapabilityHealth();
  const decision = buildDecision(
    serviceRows,
    tradeReview,
    guardHealth,
    signalBlockHealth,
    recentSignalBlockHealth,
    recentLaneBlockPressure,
    mockUntradableSymbolHealth,
    domesticCollectPressure,
    domesticRejectBreakdown,
    tradeLaneHealth,
    cryptoValidationSoftBudgetHealth,
    cryptoValidationBudgetBlockHealth,
    cryptoSentinelFallbackHealth,
    stalePositionHealth,
    cryptoLiveGateHealth,
    capitalGuardBreakdown,
    cryptoValidationBudgetPolicyHealth,
  );

  const report = {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    tradeReview,
    guardHealth,
    signalBlockHealth,
    recentSignalBlockHealth,
    recentLaneBlockPressure,
    mockUntradableSymbolHealth,
    domesticCollectPressure,
    domesticRejectBreakdown,
    tradeLaneHealth,
    cryptoValidationSoftBudgetHealth,
    cryptoValidationBudgetBlockHealth,
    cryptoSentinelFallbackHealth,
    stalePositionHealth,
    cryptoLiveGateHealth,
    capitalGuardBreakdown,
    cryptoGateActionPlan,
    cryptoValidationBudgetPolicyHealth,
    kisCapabilityHealth,
    decision,
  };
  report.aiSummary = await buildHealthInsight(report);
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[루나 운영 헬스 리포트]',
});
