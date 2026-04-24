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
import { buildRuntimeLearningLoopReport } from './runtime-learning-loop-report.ts';
import { runCollectionAudit } from './runtime-collection-audit.ts';
import { runExecutionAttachAudit } from './runtime-execution-attach-audit.ts';
import { runExecutionAttachBackfill } from './runtime-execution-attach-backfill.ts';
import { buildRuntimePositionStrategyAudit } from './runtime-position-strategy-audit.ts';
import { buildPositionStrategyHygieneRemediationPlan, runPositionStrategyHygiene } from './runtime-position-strategy-hygiene.ts';
import { runPositionStrategyRemediation } from './runtime-position-strategy-remediation.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import { runPositionRuntimeTuning } from './runtime-position-runtime-tuning.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';
import { normalizeDuplicateStrategyProfiles } from './normalize-duplicate-strategy-profiles.ts';
import { retireOrphanStrategyProfiles } from './retire-orphan-strategy-profiles.ts';
import { backfillTradeIncidentLinks } from './backfill-trade-incident-links.ts';
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
  loadExecutionRiskApprovalGuardHealth,
  loadMockUntradableSymbolHealth,
  loadRecentLaneBlockPressure,
  loadRecentSignalBlockHealth,
  loadSignalBlockHealth,
  loadTradeLaneHealth,
} from './health-report-support.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
const localLlmClient = require('../../../packages/core/lib/local-llm-client.js');
const env = require('../../../packages/core/lib/env');
const { selectRuntime } = require('../../../packages/core/lib/runtime-selector');
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

const localCircuitBreaker = {
  getCircuitStatus(_baseUrl) {
    return {
      state: 'CLOSED',
      failures: 0,
      openSinceMs: undefined,
      remainingMs: undefined,
    };
  },
};

const LATEST_OPS_SNAPSHOT_FILE = path.resolve(__dirname, '..', 'output', 'ops', 'parallel-ops-snapshot.json');

function loadLatestOpsSnapshot() {
  try {
    if (!fs.existsSync(LATEST_OPS_SNAPSHOT_FILE)) return null;
    return JSON.parse(fs.readFileSync(LATEST_OPS_SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function getWeakestRegimeSummary(runtimeLearningLoop) {
  const weakest = runtimeLearningLoop?.sections?.regimeLaneSummary?.weakestRegime
    || runtimeLearningLoop?.sections?.collect?.regimePerformance?.weakestRegime
    || null;
  const weakestMode = weakest?.tradeMode || weakest?.worstMode?.tradeMode || weakest?.bestMode?.tradeMode || 'n/a';
  return { weakest, weakestMode };
}

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

const LOCAL_LLM_HEALTH_HISTORY_FILE = '/tmp/investment-local-llm-health-history.jsonl';

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

function safeReadJsonLines(filePath, limit = 12) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonLine(filePath, payload) {
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[health-report] local LLM history append 실패: ${error?.message || error}`);
  }
}

function summarizeLocalLlmFlapping(history = []) {
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  if (recent.length < 2) {
    return {
      status: 'warming_up',
      transitionCount: 0,
      okCount: recent.filter((row) => row?.probeOk).length,
      failCount: recent.filter((row) => row && !row.probeOk).length,
      lastError: recent.slice().reverse().find((row) => row && !row.probeOk)?.probeError || null,
    };
  }

  let transitionCount = 0;
  for (let i = 1; i < recent.length; i += 1) {
    if (Boolean(recent[i - 1]?.probeOk) !== Boolean(recent[i]?.probeOk)) transitionCount += 1;
  }

  const okCount = recent.filter((row) => row?.probeOk).length;
  const failCount = recent.filter((row) => row && !row.probeOk).length;
  const lastError = recent.slice().reverse().find((row) => row && !row.probeOk)?.probeError || null;

  let status = 'stable';
  if (failCount > 0 && transitionCount >= 2) status = 'flapping';
  else if (failCount > 0) status = 'degraded';

  return { status, transitionCount, okCount, failCount, lastError };
}

function summarizeLocalLlmRedundancy(circuits = [], launchctlStatus = {}) {
  const primary = circuits.find((entry) => entry?.role === 'primary') || null;
  return {
    status: 'groq_primary',
    summary: 'local chat 비활성화 — Groq 우선 / 11434 embeddings 전용',
    primaryBaseUrl: primary?.baseUrl || null,
    templatePath: null,
    launchdSummary: 'local chat standby 제거됨',
  };
}

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
    const routeTop = review?.metrics?.pipeline?.strategyRouteTop || 'none';
    const routeQualityTop = review?.metrics?.pipeline?.strategyRouteQualityTop || 'none';
    const routeReadiness = review?.metrics?.pipeline?.strategyRouteAvgReadiness;
    const lines = [
      `  게이트: ${decision}`,
      `  사유: ${String(review?.liveGate?.reason || 'n/a')}`,
      `  체결: ${Number(review?.metrics?.trades?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.paper || 0)})`,
      `  mode 체결: NORMAL ${Number(review?.metrics?.trades?.byMode?.NORMAL?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.byMode?.NORMAL?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.byMode?.NORMAL?.paper || 0)}), VALIDATION ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.total || 0)}건 (LIVE ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.live || 0)} / PAPER ${Number(review?.metrics?.trades?.byMode?.VALIDATION?.paper || 0)})`,
      `  퍼널: decision ${Number(review?.metrics?.pipeline?.decision || 0)} / BUY ${Number(review?.metrics?.pipeline?.buy || 0)} / approved ${Number(review?.metrics?.pipeline?.approved || 0)} / executed ${Number(review?.metrics?.pipeline?.executed || 0)}`,
      `  weak: ${Number(review?.metrics?.pipeline?.weak || 0)}${review?.metrics?.pipeline?.weakTop ? ` (top ${review.metrics.pipeline.weakTop})` : ''}`,
      `  전략 라우팅: top ${routeTop} / quality ${routeQualityTop}${routeReadiness == null ? '' : ` / readiness ${routeReadiness}`}`,
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

async function loadLocalLlmHealth(launchctlStatus = {}) {
  const runtimeProfile = await selectRuntime('luna', 'analyst').catch(() => null);
  const primaryBaseUrl = String(runtimeProfile?.local_llm_base_url || env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:11434').trim();
  const urls = [...new Set([primaryBaseUrl].filter(Boolean))];

  const circuits = [];
  for (const baseUrl of urls) {
    const status = localCircuitBreaker.getCircuitStatus(baseUrl);
    const probe = await localLlmClient.checkLocalLLMHealth({
      baseUrl,
      timeoutMs: baseUrl === primaryBaseUrl ? 2500 : 1500,
      embeddingsOnly: true,
    }).catch((error) => ({
      available: false,
      models: [],
      fastModelOk: false,
      embedModelOk: false,
      responseMs: null,
      mode: 'embeddings',
      error: error?.message || String(error),
    }));
    const remainingSec = Number.isFinite(Number(status.remainingMs))
      ? Math.ceil(Number(status.remainingMs) / 1000)
      : 0;
    const probeModeSuffix = probe?.mode === 'embeddings' ? ' (embeddings-only)' : '';
    const probeSummary = probe?.available
      ? `probe ${probe.error ? `warn:${probe.error}` : 'ok'}${probeModeSuffix}${Number.isFinite(Number(probe.responseMs)) ? ` / ${Number(probe.responseMs)}ms` : ''}`
      : `probe fail${probeModeSuffix}${probe?.error ? `:${probe.error}` : ''}`;

    circuits.push({
      baseUrl,
      role: baseUrl === primaryBaseUrl ? 'primary' : 'secondary',
      status,
      probe,
      line: `  [${baseUrl === primaryBaseUrl ? 'primary' : 'secondary'}] ${baseUrl} / state ${status.state} / failures ${status.failures}${status.state === 'OPEN' ? ` / retry ${remainingSec}s` : ''} / ${probeSummary}`,
    });
  }

  const primary = circuits.find((entry) => entry.baseUrl === primaryBaseUrl) || circuits[0] || {
    baseUrl: primaryBaseUrl,
    role: 'primary',
    status: { state: 'CLOSED', failures: 0 },
    probe: { available: false, models: [], fastModelOk: false, embedModelOk: false, responseMs: null, error: 'probe unavailable' },
    line: `  [primary] ${primaryBaseUrl} / state CLOSED / failures 0 / probe unavailable`,
  };
  const primaryProbeFailed = !primary?.probe?.available || !!primary?.probe?.error;
  const warnCount = primary.status.state === 'CLOSED' && !primaryProbeFailed ? 0 : 1;
  const historyEntry = {
    checkedAt: new Date().toISOString(),
    baseUrl: primary.baseUrl,
    probeOk: !primaryProbeFailed,
    probeError: primary?.probe?.error || null,
    responseMs: primary?.probe?.responseMs ?? null,
    circuitState: primary?.status?.state || 'UNKNOWN',
  };
  appendJsonLine(LOCAL_LLM_HEALTH_HISTORY_FILE, historyEntry);
  const probeHistory = safeReadJsonLines(LOCAL_LLM_HEALTH_HISTORY_FILE, 24)
    .filter((entry) => String(entry?.baseUrl || '').trim() === primary.baseUrl)
    .slice(-12);
  const flapping = summarizeLocalLlmFlapping(probeHistory);
  const redundancy = summarizeLocalLlmRedundancy(circuits, launchctlStatus);

  return {
    okCount: warnCount === 0 ? 1 : 0,
    warnCount,
    ok: warnCount === 0 ? circuits.map((entry) => entry.line) : [],
    warn: warnCount === 0 ? [] : circuits.map((entry) => entry.line),
    baseUrl: primary.baseUrl,
    status: primary.status,
    probe: primary.probe,
    probeHistory,
    flapping,
    redundancy,
    circuits,
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
  localLlmHealth,
  runtimeLearningLoop,
  latestOpsSnapshot,
  collectionAudit,
  incidentLinkAudit,
  executionAttachAudit,
  executionAttachBackfill,
  positionStrategyAudit,
  positionStrategyHygiene,
  positionStrategyRemediation,
  positionStrategyRemediationHistory,
  duplicateStrategyNormalization,
  orphanStrategyRetirement,
  executionRiskApprovalGuardHealth,
  positionRuntimeReport,
  positionRuntimeTuning,
  positionRuntimeDispatch,
) {
  const topBlock = signalBlockHealth.top[0] || null;
  const topReasonGroup = signalBlockHealth.topReasonGroups?.[0] || null;
  const recentTopReasonGroup = recentSignalBlockHealth.topReasonGroups?.[0] || null;
  const saturatedLane = tradeLaneHealth.lanes.find((lane) => lane.atLimit);
  const nearLimitLane = tradeLaneHealth.lanes.find((lane) => lane.nearLimit);
  const pressureLane = recentLaneBlockPressure.topLane || null;
  const collectionInsufficient = collectionAudit?.markets?.find((item) => item?.collectQuality?.status === 'insufficient') || null;
  const collectionDegraded = collectionAudit?.markets?.find((item) => item?.collectQuality?.status === 'degraded') || null;
  const strategyFeedbackOutcomes = runtimeLearningLoop?.sections?.collect?.strategyFeedbackOutcomes || null;
  const riskApproval = runtimeLearningLoop?.sections?.collect?.riskApproval || null;
  const riskApprovalOutcome = riskApproval?.outcome || null;
  const riskApprovalOutcomeMode = riskApproval?.outcomeByMode?.[0] || null;
  const riskApprovalOutcomeWorst = riskApproval?.outcomeSamples?.worst?.[0] || null;
  const riskApprovalReadiness = runtimeLearningLoop?.sections?.collect?.riskApprovalReadiness || null;
  const riskApprovalReadinessDelta = riskApprovalReadiness?.trend?.delta || {};
  const riskApprovalModeAudit = runtimeLearningLoop?.sections?.collect?.riskApprovalModeAudit || null;
  const riskApprovalModeAuditDelta = riskApprovalModeAudit?.trend?.delta || {};
  const executionRiskApprovalTop = executionRiskApprovalGuardHealth?.rows?.[0] || null;
  const executionAttachView = buildExecutionAttachSnapshot(executionAttachAudit, executionAttachBackfill);
  const positionStrategyDuplicateScopes = Number(positionStrategyAudit?.duplicateManagedProfileScopes || positionStrategyAudit?.duplicateActiveProfileScopes || 0);
  const positionStrategyOrphans = Number(positionStrategyAudit?.orphanProfiles || 0);
  const positionStrategyHygieneStatus = positionStrategyHygiene?.decision?.status || 'unknown';
  const duplicateNormalizationSummary = duplicateStrategyNormalization?.summary || {};
  const orphanRetirementSummary = orphanStrategyRetirement?.summary || {};
  const remediationView = buildFlatRemediationSnapshot(positionStrategyRemediation);
  const runtimeView = buildPositionRuntimeSnapshot(
    positionRuntimeReport,
    positionRuntimeTuning,
    positionRuntimeDispatch,
  );
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
        active: Number(executionRiskApprovalGuardHealth?.total || 0) > 0,
        level: Number(executionRiskApprovalGuardHealth?.staleCount || 0) > 0 ? 'medium' : 'low',
        reason: `execution risk approval guard — 최근 ${executionRiskApprovalGuardHealth?.periodHours || 24}시간 ${executionRiskApprovalGuardHealth?.total || 0}건 차단 / stale ${executionRiskApprovalGuardHealth?.staleCount || 0} / bypass ${executionRiskApprovalGuardHealth?.bypassCount || 0} / top ${executionRiskApprovalTop?.exchange || 'n/a'} ${executionRiskApprovalTop?.blockCode || 'n/a'} ${executionRiskApprovalTop?.count || 0}건`,
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
      {
        active: localLlmHealth.warnCount > 0 || localLlmHealth.flapping?.status === 'flapping' || localLlmHealth.redundancy?.status === 'primary_only',
        level: 'medium',
        reason: `local LLM ${localLlmHealth.flapping?.status === 'flapping' ? `flapping(${localLlmHealth.flapping.transitionCount}회 전환)` : localLlmHealth.probe?.error ? `probe 실패(${localLlmHealth.probe.error})` : `circuit ${localLlmHealth.status?.state || 'OPEN'}`} — ${localLlmHealth.baseUrl}${localLlmHealth.status?.state === 'OPEN' ? ` / ${Math.ceil(Number(localLlmHealth.status?.remainingMs || 0) / 1000)}초 후 재시도` : ''}${localLlmHealth.redundancy?.status === 'primary_only' ? ` / standby 없음(${localLlmHealth.redundancy.summary})` : ''}`,
      },
      {
        active: ['regime_strategy_tuning_needed', 'regime_strategy_monitor'].includes(runtimeLearningLoop?.decision?.status),
        level: runtimeLearningLoop?.decision?.status === 'regime_strategy_monitor' ? 'low' : 'medium',
        reason: `learning loop — ${runtimeLearningLoop?.decision?.headline || '레짐별 전략 튜닝 필요'} / top suggestion ${runtimeLearningLoop?.sections?.strategy?.runtimeSuggestionTop?.key || 'n/a'} ${runtimeLearningLoop?.decision?.status === 'regime_strategy_monitor' ? `current ${runtimeLearningLoop?.sections?.strategy?.runtimeSuggestionTop?.current ?? runtimeLearningLoop?.sections?.strategy?.runtimeSuggestionTop?.governance?.current ?? 'n/a'} (already applied)` : `-> ${runtimeLearningLoop?.sections?.strategy?.runtimeSuggestionTop?.suggested ?? 'n/a'}`} / next command npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime-suggest -- --json${latestOpsSnapshot?.capturedAt ? ` / latest snapshot ${latestOpsSnapshot.capturedAt}` : ''}`,
      },
      {
        active: Number(runtimeView.metrics?.exitReady || 0) > 0 || Number(runtimeView.metrics?.adjustReady || 0) > 0 || runtimeView.tuningStatus === 'position_runtime_tuning_attention',
        level: Number(runtimeView.metrics?.exitReady || 0) > 0 ? 'high' : 'medium',
        reason: `position runtime — ${runtimeView.headline} / tuning ${runtimeView.tuningStatus}${runtimeView.tuningSuggestion ? ` ${runtimeView.tuningSuggestion.exchange} ${runtimeView.tuningSuggestion.status}` : ''} / dispatch ${runtimeView.dispatchStatus} ${runtimeView.dispatchCandidates || 0}건 / next command ${runtimeView.dispatchCommand}`,
      },
      {
        active: strategyFeedbackOutcomes?.status === 'strategy_feedback_outcome_attention',
        level: 'medium',
        reason: `strategy feedback outcomes — ${strategyFeedbackOutcomes?.headline || '전략 피드백 적용 결과 점검 필요'} / tagged ${strategyFeedbackOutcomes?.total || strategyFeedbackOutcomes?.totalTagged || 0} / closed ${strategyFeedbackOutcomes?.closed || strategyFeedbackOutcomes?.closedTagged || 0} / pnl ${strategyFeedbackOutcomes?.pnlNet ?? 0} / trend tagged Δ${strategyFeedbackOutcomes?.trend?.delta?.total ?? 0} closed Δ${strategyFeedbackOutcomes?.trend?.delta?.closed ?? 0} / weakest ${(strategyFeedbackOutcomes?.weak || strategyFeedbackOutcomes?.weakest)?.familyBias || 'n/a'} ${(strategyFeedbackOutcomes?.weak || strategyFeedbackOutcomes?.weakest)?.family || 'n/a'} avg ${(strategyFeedbackOutcomes?.weak || strategyFeedbackOutcomes?.weakest)?.avgPnlPercent ?? 'n/a'}%`,
      },
      {
        active: Number(riskApprovalOutcome?.closed || 0) >= 3 && (
          Number(riskApprovalOutcome?.avgPnlPercent ?? 0) < 0 ||
          Number(riskApprovalOutcome?.pnlNet ?? 0) < 0 ||
          Number(riskApprovalOutcomeMode?.avgPnlPercent ?? 0) < 0
        ),
        level: 'medium',
        reason: `risk approval outcome — closed ${riskApprovalOutcome?.closed || 0}/${riskApprovalOutcome?.total || 0} / win ${riskApprovalOutcome?.winRate ?? 'n/a'}% / avg ${riskApprovalOutcome?.avgPnlPercent ?? 'n/a'}% / pnl ${riskApprovalOutcome?.pnlNet ?? 0} / mode ${riskApprovalOutcomeMode?.mode || 'n/a'} avg ${riskApprovalOutcomeMode?.avgPnlPercent ?? 'n/a'}%${riskApprovalOutcomeWorst ? ` / worst ${riskApprovalOutcomeWorst.exchange || 'n/a'}/${riskApprovalOutcomeWorst.symbol || 'n/a'} pnl ${riskApprovalOutcomeWorst.pnlNet ?? 'n/a'}` : ''} / next command npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime-suggest -- --json`,
      },
      {
        active: riskApproval?.status === 'risk_approval_preview_divergence',
        level: 'medium',
        reason: `risk approval preview divergence — ${riskApproval?.headline || '리스크 승인 preview와 기존 승인 결과 차이 점검 필요'} / preview ${riskApproval?.total || 0} / rejects ${riskApproval?.previewRejects || 0} / divergence ${riskApproval?.divergence || 0} / trend divergence Δ${riskApproval?.trend?.delta?.legacyApprovedPreviewRejected ?? 0} / amount delta ${riskApproval?.previewVsApprovedDelta ?? 0} / next command npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:risk-approval -- --json`,
      },
      {
        active: riskApprovalReadiness?.status === 'risk_approval_readiness_blocked',
        level: 'medium',
        reason: `risk approval mode readiness — ${riskApprovalReadiness?.headline || '전환 blocker 점검 필요'} / mode ${riskApprovalReadiness?.currentMode || 'n/a'} -> ${riskApprovalReadiness?.targetMode || 'n/a'} / blockers ${(riskApprovalReadiness?.blockers || []).join(', ') || 'n/a'} / trend blocker Δ${riskApprovalReadinessDelta.blockerCount ?? 0} preview Δ${riskApprovalReadinessDelta.previewTotal ?? 0} / next command npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:risk-approval-readiness-history -- --json`,
      },
      {
        active: riskApprovalReadiness?.status === 'risk_approval_readiness_assist_ready' || riskApprovalReadiness?.status === 'risk_approval_readiness_enforce_candidate',
        level: 'low',
        reason: `risk approval mode candidate — ${riskApprovalReadiness?.headline || '전환 후보 관찰'} / mode ${riskApprovalReadiness?.currentMode || 'n/a'} -> ${riskApprovalReadiness?.targetMode || 'n/a'} / trend blocker Δ${riskApprovalReadinessDelta.blockerCount ?? 0} preview Δ${riskApprovalReadinessDelta.previewTotal ?? 0} / next command npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:risk-approval-readiness-history -- --json`,
      },
      {
        active: ['risk_approval_mode_audit_attention', 'risk_approval_mode_audit_mode_watch'].includes(riskApprovalModeAudit?.status),
        level: riskApprovalModeAudit?.status === 'risk_approval_mode_audit_attention' ? 'medium' : 'low',
        reason: `risk approval mode audit — ${riskApprovalModeAudit?.headline || 'mode/readiness 적용 상태 점검'} / mode ${riskApprovalModeAudit?.metrics?.currentMode || 'n/a'} / non-shadow ${riskApprovalModeAudit?.metrics?.nonShadowApplications || 0} Δ${riskApprovalModeAuditDelta.nonShadowApplications ?? 0} / unavailable ${riskApprovalModeAudit?.metrics?.unavailablePreviewCount || 0} Δ${riskApprovalModeAuditDelta.unavailablePreviewCount ?? 0} / outcome pnl ${riskApprovalModeAudit?.metrics?.outcomePnlNet ?? 0} Δ${riskApprovalModeAuditDelta.outcomePnlNet ?? 0} / next command npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:risk-approval-mode-audit-history -- --json`,
      },
      {
        active: Boolean(collectionInsufficient || collectionDegraded),
        level: collectionInsufficient ? 'medium' : 'low',
        reason: collectionInsufficient
          ? `collection audit — ${collectionInsufficient.market} collect quality insufficient / screening ${collectionInsufficient.screeningUniverseCount} / maintenance ${collectionInsufficient.maintenanceUniverseCount}`
          : `collection audit — ${collectionDegraded?.market || 'n/a'} collect quality degraded / screening ${collectionDegraded?.screeningUniverseCount || 0} / maintenance ${collectionDegraded?.maintenanceUniverseCount || 0}`,
      },
      {
        active: Number(incidentLinkAudit?.updated || 0) > 0,
        level: 'medium',
        reason: `trade incident link audit — journal 누락 후보 ${incidentLinkAudit?.updated || 0}건 / scanned ${incidentLinkAudit?.scanned || 0} / next command npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run journal:backfill-incident-links -- --dry-run --json`,
      },
      {
        active: executionAttachView.needsRepair,
        level: ['execution_attach_error', 'execution_attach_weak'].includes(executionAttachView.status) ? 'medium' : 'low',
        reason: buildExecutionAttachDecisionReason(executionAttachAudit, executionAttachBackfill),
      },
      {
        active: Number(executionAttachView.backfillCandidates || 0) > 0,
        level: 'low',
        reason: `execution attach backfill candidates — ${executionAttachView.backfillHeadline || '백필 후보 확인'} / candidates ${executionAttachView.backfillCandidates || 0} / writeEligible ${executionAttachView.backfillWriteEligible || 0} / missingSignalId ${executionAttachView.backfillMissingSignalId || 0} / next command ${executionAttachView.repairDryRunCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:execution-attach-backfill -- --days=14 --limit=50 --json'}`,
      },
      {
        active: executionAttachView.needsRepair
          && Number(executionAttachView.backfillOpenPositionBlocked || 0) > 0
          && Number(executionAttachView.backfillCandidates || 0) === 0,
        level: 'low',
        reason: `execution attach backfill blocked — open position 조건으로 ${executionAttachView.backfillOpenPositionBlocked || 0}건 제외 / 실제 포지션 동기화 확인 필요`,
      },
      {
        active: positionStrategyHygieneStatus === 'position_strategy_hygiene_attention',
        level: remediationView.trendStale
          ? 'medium'
          : (Number(positionStrategyAudit?.duplicateManagedProfileScopes || 0) > 0 || Number(positionStrategyAudit?.unmatchedManagedPositions || 0) > 0 ? 'medium' : 'low'),
        reason: buildPositionStrategyRemediationDecisionReason({
          remediationView,
          positionStrategyRemediation,
          positionStrategyHygiene,
          positionStrategyAudit,
          positionStrategyRemediationHistory,
          duplicateStrategyNormalization,
          orphanStrategyRetirement,
          positionStrategyOrphans,
        }),
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

function buildFlatRemediationSnapshot(positionStrategyRemediation) {
  const flat = positionStrategyRemediation?.remediationFlat || null;
  const summary = positionStrategyRemediation?.remediationSummary || null;
  const counts = positionStrategyRemediation?.remediationCounts || flat?.counts || summary?.counts || null;
  const commandsBase = positionStrategyRemediation?.remediationCommands || flat?.commands || summary?.commands || null;
  const trend = positionStrategyRemediation?.remediationTrend
    || (flat?.trendHistoryCount !== undefined
      ? {
        historyCount: flat?.trendHistoryCount,
        statusChanged: flat?.trendChanged,
        nextCommandChanged: flat?.trendNextChanged ?? flat?.nextCommandChanged,
        nextCommandTransition: positionStrategyRemediation?.remediationNextCommandTransition || flat?.nextCommandTransition || summary?.nextCommandTransition || null,
        ageMinutes: flat?.trendAgeMinutes,
        stale: flat?.trendStale,
        duplicateDelta: flat?.trendDuplicateDelta,
        orphanDelta: flat?.trendOrphanDelta,
        unmatchedDelta: flat?.trendUnmatchedDelta,
      }
      : null)
    || flat?.trend
    || summary?.trend
    || null;
  const refreshState = positionStrategyRemediation?.remediationRefreshState || flat?.refresh || summary?.refreshState || null;
  const actionReportCommand = positionStrategyRemediation?.remediationActionReportCommand || flat?.actionReportCommand || commandsBase?.report || null;
  const actionHistoryCommand = positionStrategyRemediation?.remediationActionHistoryCommand || flat?.actionHistoryCommand || commandsBase?.history || null;
  const refreshCommand = positionStrategyRemediation?.remediationRefreshCommand || flat?.refreshCommand || commandsBase?.refresh || refreshState?.command || null;
  const actionRefreshCommand = positionStrategyRemediation?.remediationActionRefreshCommand || flat?.actionRefreshCommand || flat?.refreshCommand || commandsBase?.refresh || null;
  const actionHygieneCommand = positionStrategyRemediation?.remediationActionHygieneCommand || flat?.actionHygieneCommand || commandsBase?.hygiene || null;
  const actionNormalizeDryRunCommand = positionStrategyRemediation?.remediationActionNormalizeDryRunCommand || flat?.actionNormalizeDryRunCommand || commandsBase?.normalizeDryRun || null;
  const actionNormalizeApplyCommand = positionStrategyRemediation?.remediationActionNormalizeApplyCommand || flat?.actionNormalizeApplyCommand || commandsBase?.normalizeApply || null;
  const actionRetireDryRunCommand = positionStrategyRemediation?.remediationActionRetireDryRunCommand || flat?.actionRetireDryRunCommand || commandsBase?.retireDryRun || null;
  const actionRetireApplyCommand = positionStrategyRemediation?.remediationActionRetireApplyCommand || flat?.actionRetireApplyCommand || commandsBase?.retireApply || null;
  const commands = {
    report: actionReportCommand || null,
    history: actionHistoryCommand || null,
    refresh: refreshCommand || actionRefreshCommand || null,
    hygiene: actionHygieneCommand || null,
    normalizeDryRun: actionNormalizeDryRunCommand || null,
    normalizeApply: actionNormalizeApplyCommand || null,
    retireDryRun: actionRetireDryRunCommand || null,
    retireApply: actionRetireApplyCommand || null,
  };
  const actions = {
    reportCommand: actionReportCommand || null,
    historyCommand: actionHistoryCommand || null,
    refreshCommand: actionRefreshCommand || refreshCommand || null,
    hygieneCommand: actionHygieneCommand || null,
    normalizeDryRunCommand: actionNormalizeDryRunCommand || null,
    normalizeApplyCommand: actionNormalizeApplyCommand || null,
    retireDryRunCommand: actionRetireDryRunCommand || null,
    retireApplyCommand: actionRetireApplyCommand || null,
  };
  return {
    flat,
    summary,
    counts,
    trend,
    refreshState,
    commands,
    actions,
    status: positionStrategyRemediation?.remediationStatus || flat?.status || summary?.status || null,
    headline: positionStrategyRemediation?.remediationHeadline || flat?.headline || summary?.headline || null,
    recommendedExchange: positionStrategyRemediation?.remediationRecommendedExchange || flat?.recommendedExchange || summary?.recommendedExchange || null,
    duplicateManaged: positionStrategyRemediation?.remediationDuplicateManaged ?? flat?.duplicateManaged ?? counts?.duplicateManaged ?? null,
    orphanProfiles: positionStrategyRemediation?.remediationOrphanProfiles ?? flat?.orphanProfiles ?? counts?.orphanProfiles ?? null,
    unmatchedManaged: positionStrategyRemediation?.remediationUnmatchedManaged ?? flat?.unmatchedManaged ?? counts?.unmatchedManaged ?? null,
    trendHistoryCount: positionStrategyRemediation?.remediationTrendHistoryCount ?? flat?.trendHistoryCount ?? trend?.historyCount ?? null,
    trendChanged: positionStrategyRemediation?.remediationTrendChanged ?? flat?.trendChanged ?? trend?.statusChanged ?? null,
    trendNextChanged: positionStrategyRemediation?.remediationTrendNextChanged ?? flat?.trendNextChanged ?? flat?.nextCommandChanged ?? trend?.nextCommandChanged ?? null,
    trendAgeMinutes: positionStrategyRemediation?.remediationTrendAgeMinutes ?? flat?.trendAgeMinutes ?? trend?.ageMinutes ?? null,
    trendStale: positionStrategyRemediation?.remediationTrendStale ?? flat?.trendStale ?? trend?.stale ?? null,
    trendLastRecordedAt: positionStrategyRemediation?.remediationTrendLastRecordedAt || flat?.trendLastRecordedAt || null,
    trendDuplicateDelta: positionStrategyRemediation?.remediationTrendDuplicateDelta ?? flat?.trendDuplicateDelta ?? trend?.duplicateDelta ?? null,
    trendOrphanDelta: positionStrategyRemediation?.remediationTrendOrphanDelta ?? flat?.trendOrphanDelta ?? trend?.orphanDelta ?? null,
    trendUnmatchedDelta: positionStrategyRemediation?.remediationTrendUnmatchedDelta ?? flat?.trendUnmatchedDelta ?? trend?.unmatchedDelta ?? null,
    refreshNeeded: positionStrategyRemediation?.remediationRefreshNeeded ?? flat?.refreshNeeded ?? refreshState?.needed ?? null,
    refreshStale: positionStrategyRemediation?.remediationRefreshStale ?? flat?.refreshStale ?? refreshState?.stale ?? null,
    refreshReason: positionStrategyRemediation?.remediationRefreshReason || flat?.refreshReason || refreshState?.reason || null,
    refreshCommand,
    reportCommand: commands.report,
    historyCommand: commands.history,
    normalizeDryRunCommand: commands.normalizeDryRun,
    normalizeApplyCommand: commands.normalizeApply,
    retireDryRunCommand: commands.retireDryRun,
    retireApplyCommand: commands.retireApply,
    nextCommand: positionStrategyRemediation?.remediationNextCommand || flat?.nextCommand || null,
    nextCommandTransition: positionStrategyRemediation?.remediationNextCommandTransition || flat?.nextCommandTransition || summary?.nextCommandTransition || trend?.nextCommandTransition || null,
    nextCommandChanged: positionStrategyRemediation?.remediationNextCommandChanged ?? flat?.nextCommandChanged ?? trend?.nextCommandChanged ?? null,
    nextCommandPrevious: positionStrategyRemediation?.remediationNextCommandPrevious || flat?.nextCommandPrevious || summary?.nextCommandTransition?.previous || trend?.nextCommandTransition?.previous || null,
    nextCommandCurrent: positionStrategyRemediation?.remediationNextCommandCurrent || flat?.nextCommandCurrent || summary?.nextCommandTransition?.current || trend?.nextCommandTransition?.current || null,
    actionReportCommand,
    actionHistoryCommand,
    actionRefreshCommand,
    actionHygieneCommand,
    actionNormalizeDryRunCommand,
    actionNormalizeApplyCommand,
    actionRetireDryRunCommand,
    actionRetireApplyCommand,
  };
}

function buildExecutionAttachSnapshot(executionAttachAudit, executionAttachBackfill) {
  const view = executionAttachAudit?.view || null;
  const summary = executionAttachAudit?.summary || {};
  const decision = executionAttachAudit?.decision || {};
  const backfillSummary = executionAttachBackfill?.summary || {};
  const backfillDecision = executionAttachBackfill?.decision || {};
  return {
    status: view?.status || decision.status || 'unknown',
    headline: view?.headline || decision.headline || null,
    avgAttachScore: view?.avgAttachScore ?? summary.avgAttachScore ?? null,
    completeCount: view?.completeCount ?? Number(summary.completeCount || 0),
    recoveredPartialCount: view?.recoveredPartialCount ?? Number(summary.recoveredPartialCount || 0),
    actionableCount: view?.actionableCount ?? (Number(summary.actionableWeakCount || 0) + Number(summary.actionablePartialCount || 0)),
    attachTrackedCount: view?.attachTrackedCount ?? Number(summary.attachTrackedCount || 0),
    attachErrorCount: view?.attachErrorCount ?? Number(summary.attachErrorCount || 0),
    actionItems: view?.actionItems || decision.actionItems || [],
    auditCommand: view?.auditCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:execution-attach-audit -- --json',
    repairDryRunCommand: view?.repairDryRunCommand || decision.backfillDryRunCommand || null,
    repairWriteCommand: view?.repairWriteCommand || decision.backfillWriteCommand || null,
    backfillStatus: view?.backfillStatus || backfillDecision.status || null,
    backfillHeadline: view?.backfillHeadline || backfillDecision.headline || null,
    backfillCandidates: view?.backfillCandidates ?? Number(backfillSummary.attachCandidates || 0),
    backfillWriteEligible: view?.backfillWriteEligible ?? Number(backfillSummary.writeEligible || 0),
    backfillMissingSignalId: view?.backfillMissingSignalId ?? Number(backfillSummary.missingSignalId || 0),
    backfillOpenPositionBlocked: view?.backfillOpenPositionBlocked ?? Number(backfillSummary.openPositionBlocked || 0),
    needsRepair: view?.needsRepair ?? ['execution_attach_error', 'execution_attach_weak', 'execution_attach_partial'].includes(decision.status),
  };
}

function buildExecutionAttachAuditLines(report) {
  const executionAttachView = buildExecutionAttachSnapshot(report.executionAttachAudit, report.executionAttachBackfill);
  return [
    `  status: ${executionAttachView.status || 'unknown'}`,
    `  summary: score ${executionAttachView.avgAttachScore ?? 'n/a'} / complete ${executionAttachView.completeCount || 0} / recovered ${executionAttachView.recoveredPartialCount || 0} / actionable ${executionAttachView.actionableCount || 0} / tracked ${executionAttachView.attachTrackedCount || 0} / errors ${executionAttachView.attachErrorCount || 0}`,
    `  headline: ${executionAttachView.headline || 'n/a'}`,
    ...(report.executionAttachBackfill
      ? [
        `  backfill status: ${executionAttachView.backfillStatus || 'unknown'}`,
        `  backfill summary: candidates ${executionAttachView.backfillCandidates || 0} / writeEligible ${executionAttachView.backfillWriteEligible || 0} / missingSignalId ${executionAttachView.backfillMissingSignalId || 0} / openBlocked ${executionAttachView.backfillOpenPositionBlocked || 0}`,
        `  backfill headline: ${executionAttachView.backfillHeadline || 'n/a'}`,
      ]
      : []),
    ...((executionAttachView.actionItems || []).slice(0, 3).map((item) => `  next: ${item}`)),
    ...(executionAttachView.repairDryRunCommand ? [`  repair dry-run: ${executionAttachView.repairDryRunCommand}`] : []),
    ...(executionAttachView.repairWriteCommand ? [`  repair write: ${executionAttachView.repairWriteCommand}`] : []),
    `  next command: ${executionAttachView.auditCommand}`,
  ];
}

function buildExecutionAttachDecisionReason(executionAttachAudit, executionAttachBackfill) {
  const executionAttachView = buildExecutionAttachSnapshot(executionAttachAudit, executionAttachBackfill);
  return `execution attach audit — ${executionAttachView.headline || '체결 envelope 연결 점검'} / score ${executionAttachView.avgAttachScore ?? 'n/a'} / complete ${executionAttachView.completeCount || 0} / recovered ${executionAttachView.recoveredPartialCount || 0} / actionable ${executionAttachView.actionableCount || 0} / tracked ${executionAttachView.attachTrackedCount || 0} / errors ${executionAttachView.attachErrorCount || 0} / next command ${executionAttachView.auditCommand}`;
}

function buildPositionStrategyAuditRemediationLines(report) {
  return [
    ...(report.positionStrategyRemediation
      ? [
        `  remediation status: ${report.positionStrategyRemediationStatus || report.positionStrategyRemediation.decision?.status || 'unknown'}`,
        `  remediation headline: ${report.positionStrategyRemediationHeadline || report.positionStrategyRemediation.decision?.headline || 'n/a'}`,
        `  remediation next: ${report.positionStrategyRemediationNextCommand || 'n/a'}`,
        `  remediation refresh state: needed ${report.positionStrategyRemediationRefreshNeeded ? 'yes' : 'no'} / stale ${report.positionStrategyRemediationRefreshStale ? 'yes' : 'no'} / command ${report.positionStrategyRemediationRefreshCommand || report.positionStrategyRemediationRefresh?.command || 'n/a'}`,
        ...(report.positionStrategyRemediationRefreshReason || report.positionStrategyRemediationRefresh?.reason
          ? [`  remediation refresh: ${report.positionStrategyRemediationRefreshReason || report.positionStrategyRemediationRefresh?.reason}`]
          : []),
      ]
      : []),
    ...(report.positionStrategyRemediationHistory
      ? [
        `  remediation history: count ${(report.positionStrategyRemediationTrendHistoryCount ?? report.positionStrategyRemediationHistory.historyCount ?? 0)} / changed ${report.positionStrategyRemediationTrendChanged ? 'yes' : 'no'} / next changed ${report.positionStrategyRemediationTrendNextChanged ? 'yes' : 'no'}${report.positionStrategyRemediationTrendNextChanged ? ` (${report.positionStrategyRemediationNextCommandPrevious || 'none'} -> ${report.positionStrategyRemediationNextCommandCurrent || 'none'})` : ''} / age ${(report.positionStrategyRemediationTrendAgeMinutes ?? report.positionStrategyRemediationHistory.ageMinutes ?? 'n/a')}m / stale ${report.positionStrategyRemediationTrendStale ? 'yes' : 'no'}`,
        `  remediation delta: duplicate ${((report.positionStrategyRemediationTrendDuplicateDelta ?? report.positionStrategyRemediationHistory.delta?.duplicateManaged ?? 0) >= 0) ? '+' : ''}${(report.positionStrategyRemediationTrendDuplicateDelta ?? report.positionStrategyRemediationHistory.delta?.duplicateManaged ?? 0)} / orphan ${((report.positionStrategyRemediationTrendOrphanDelta ?? report.positionStrategyRemediationHistory.delta?.orphanProfiles ?? 0) >= 0) ? '+' : ''}${(report.positionStrategyRemediationTrendOrphanDelta ?? report.positionStrategyRemediationHistory.delta?.orphanProfiles ?? 0)} / unmatched ${((report.positionStrategyRemediationTrendUnmatchedDelta ?? report.positionStrategyRemediationHistory.delta?.unmatchedManaged ?? 0) >= 0) ? '+' : ''}${(report.positionStrategyRemediationTrendUnmatchedDelta ?? report.positionStrategyRemediationHistory.delta?.unmatchedManaged ?? 0)}`,
      ]
      : []),
    `  remediation report: ${report.positionStrategyRemediationActionReportCommand || report.positionStrategyRemediationReportCommand || report.positionStrategyHygiene?.remediationPlan?.remediationReportCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation -- --json'}`,
    `  remediation history: ${report.positionStrategyRemediationActionHistoryCommand || report.positionStrategyRemediationHistoryCommand || report.positionStrategyHygiene?.remediationPlan?.remediationHistoryCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation-history -- --json'}`,
    `  remediation refresh: ${report.positionStrategyRemediationActionRefreshCommand || report.positionStrategyRemediationRefreshCommand || report.positionStrategyHygiene?.remediationPlan?.remediationRefreshCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation-refresh -- --if-stale --json'}`,
    `  hygiene report: ${report.positionStrategyRemediationActionHygieneCommand || report.positionStrategyHygiene?.remediationPlan?.hygieneReportCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-hygiene -- --json'}`,
    `  normalize dry-run: ${report.positionStrategyRemediationActionNormalizeDryRunCommand || report.positionStrategyRemediationNormalizeDryRunCommand || report.positionStrategyHygiene?.remediationPlan?.normalizeDryRunCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:normalize-duplicate-strategy-profiles -- --json'}`,
    `  normalize apply: ${report.positionStrategyRemediationActionNormalizeApplyCommand || report.positionStrategyRemediationNormalizeApplyCommand || report.positionStrategyHygiene?.remediationPlan?.normalizeApplyCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:normalize-duplicate-strategy-profiles -- --apply --json'}`,
    `  retire orphan dry-run: ${report.positionStrategyRemediationActionRetireDryRunCommand || report.positionStrategyRemediationRetireDryRunCommand || report.positionStrategyHygiene?.remediationPlan?.retireDryRunCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:retire-orphan-strategy-profiles -- --json'}`,
    `  retire orphan apply: ${report.positionStrategyRemediationActionRetireApplyCommand || report.positionStrategyRemediationRetireApplyCommand || report.positionStrategyHygiene?.remediationPlan?.retireApplyCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:retire-orphan-strategy-profiles -- --apply --json'}`,
  ];
}

function buildPositionStrategyRemediationDecisionReason({
  remediationView,
  positionStrategyRemediation,
  positionStrategyHygiene,
  positionStrategyAudit,
  positionStrategyRemediationHistory,
  duplicateStrategyNormalization,
  orphanStrategyRetirement,
  positionStrategyOrphans,
}) {
  return `position strategy remediation — ${remediationView.headline || positionStrategyRemediation?.decision?.headline || positionStrategyHygiene?.decision?.headline || '포지션 전략 위생 점검 필요'} / duplicate managed ${remediationView.duplicateManaged ?? positionStrategyAudit?.duplicateManagedProfileScopes ?? 0} / orphan ${remediationView.orphanProfiles ?? positionStrategyOrphans ?? 0} / unmatched managed ${remediationView.unmatchedManaged ?? positionStrategyAudit?.unmatchedManagedPositions ?? 0}${(remediationView.trendHistoryCount !== undefined || positionStrategyRemediationHistory) ? ` / history changed ${remediationView.trendChanged ? 'yes' : 'no'} / next changed ${remediationView.trendNextChanged ? 'yes' : 'no'}${remediationView.trendNextChanged ? ` (${remediationView.nextCommandPrevious || positionStrategyRemediationHistory?.nextCommandTransition?.previous || 'none'} -> ${remediationView.nextCommandCurrent || positionStrategyRemediationHistory?.nextCommandTransition?.current || 'none'})` : ''} / history age ${remediationView.trendAgeMinutes ?? positionStrategyRemediationHistory?.ageMinutes ?? 'n/a'}m / history stale ${remediationView.trendStale ? 'yes' : 'no'} / duplicate delta ${((remediationView.trendDuplicateDelta ?? positionStrategyRemediationHistory?.delta?.duplicateManaged ?? 0) >= 0) ? '+' : ''}${(remediationView.trendDuplicateDelta ?? positionStrategyRemediationHistory?.delta?.duplicateManaged) || 0} / orphan delta ${((remediationView.trendOrphanDelta ?? positionStrategyRemediationHistory?.delta?.orphanProfiles ?? 0) >= 0) ? '+' : ''}${(remediationView.trendOrphanDelta ?? positionStrategyRemediationHistory?.delta?.orphanProfiles) || 0}` : ''}${remediationView.refreshReason ? ` / ${remediationView.refreshReason}` : ''} / duplicate apply ${duplicateStrategyNormalization?.decision?.safeToApply === true ? 'yes' : 'no'} / orphan apply ${orphanStrategyRetirement?.decision?.safeToApply === true ? 'yes' : 'no'} / next command ${remediationView.nextCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation -- --json'}`;
}

function buildPositionRuntimeSnapshot(runtimeReport, runtimeTuning, runtimeDispatch) {
  const decision = runtimeReport?.decision || {};
  const metrics = decision.metrics || {};
  const suggestions = Array.isArray(runtimeTuning?.suggestions) ? runtimeTuning.suggestions : [];
  const topSuggestion = suggestions[0] || null;
  const candidates = Array.isArray(runtimeDispatch?.candidates) ? runtimeDispatch.candidates : [];
  return {
    status: decision.status || 'position_runtime_unknown',
    headline: decision.headline || 'runtime state unavailable',
    metrics: {
      total: Number(metrics.total || 0),
      active: Number(metrics.active || 0),
      exitReady: Number(metrics.exitReady || 0),
      adjustReady: Number(metrics.adjustReady || 0),
      staleValidation: Number(metrics.staleValidation || 0),
      fastLane: Number(metrics.fastLane || 0),
    },
    tuningStatus: runtimeTuning?.status || 'position_runtime_tuning_unknown',
    tuningSuggestion: topSuggestion,
    dispatchStatus: runtimeDispatch?.status || 'position_runtime_dispatch_unknown',
    dispatchCandidates: candidates.length,
    dispatchTopCandidate: candidates[0] || null,
    reportCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime -- --json',
    tuningCommand: topSuggestion?.exchange
      ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-tuning -- --exchange=${topSuggestion.exchange} --json`
      : 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-tuning -- --json',
    dispatchCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-dispatch -- --json',
  };
}

function buildPositionRuntimeLines(report) {
  const runtimeView = report.positionRuntimeView || {};
  const suggestion = runtimeView.tuningSuggestion || null;
  const topCandidate = runtimeView.dispatchTopCandidate || null;
  return [
    `  runtime status: ${runtimeView.status || 'unknown'}`,
    `  runtime headline: ${runtimeView.headline || 'n/a'}`,
    `  active ${runtimeView.metrics?.active || 0} / fast-lane ${runtimeView.metrics?.fastLane || 0} / adjust ${runtimeView.metrics?.adjustReady || 0} / exit ${runtimeView.metrics?.exitReady || 0} / critical validation ${runtimeView.metrics?.staleValidation || 0}`,
    `  tuning: ${runtimeView.tuningStatus || 'unknown'}${suggestion ? ` / ${suggestion.exchange} ${suggestion.status} ${suggestion.currentAverageCadenceMs || 'n/a'} -> ${suggestion.recommendedCadenceMs || 'n/a'}` : ''}`,
    `  dispatch: ${runtimeView.dispatchStatus || 'unknown'} / candidates ${runtimeView.dispatchCandidates || 0}${topCandidate ? ` / top ${topCandidate.exchange}/${topCandidate.symbol} ${topCandidate.action} ${topCandidate.urgency}` : ''}`,
    `  runtime report: ${runtimeView.reportCommand}`,
    `  runtime tuning: ${runtimeView.tuningCommand}`,
    `  runtime dispatch: ${runtimeView.dispatchCommand}`,
  ];
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
      title: `■ 실행 직전 리스크 승인 가드(최근 ${report.executionRiskApprovalGuardHealth?.periodHours || 24}시간)`,
      lines: report.executionRiskApprovalGuardHealth?.total > 0
        ? [
            `  총 ${report.executionRiskApprovalGuardHealth.total}건 / stale ${report.executionRiskApprovalGuardHealth.staleCount} / bypass ${report.executionRiskApprovalGuardHealth.bypassCount}`,
            ...((report.executionRiskApprovalGuardHealth.rows || []).slice(0, 5).map((row) => `  ${row.exchange} ${row.blockCode}: ${row.count}건 (${row.blockedBy})`)),
            ...((report.executionRiskApprovalGuardHealth.samples || []).slice(0, 3).map((row) => `  sample ${row.exchange}/${row.symbol}: ${row.blockCode} / ${String(row.blockReason || '').slice(0, 80)}`)),
          ]
        : ['  실행 직전 리스크 승인 차단 없음'],
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
    buildHealthCountSection('■ local LLM circuit', report.localLlmHealth, { okLimit: 1, warnLimit: 1 }),
    {
      title: '■ local LLM probe trend',
      lines: report.localLlmHealth?.flapping
        ? [
            `  status: ${report.localLlmHealth.flapping.status}`,
            `  recent ok ${report.localLlmHealth.flapping.okCount} / fail ${report.localLlmHealth.flapping.failCount} / transitions ${report.localLlmHealth.flapping.transitionCount}`,
            ...(report.localLlmHealth.flapping.lastError ? [`  last error: ${report.localLlmHealth.flapping.lastError}`] : []),
          ]
        : ['  probe history 없음'],
    },
    {
      title: '■ local LLM redundancy',
      lines: report.localLlmHealth?.redundancy
        ? [
            `  status: ${report.localLlmHealth.redundancy.status}`,
            `  summary: ${report.localLlmHealth.redundancy.summary}`,
            report.localLlmHealth.redundancy.launchdSummary ? `  launchd: ${report.localLlmHealth.redundancy.launchdSummary}` : '',
            report.localLlmHealth.redundancy.templatePath ? `  template: ${report.localLlmHealth.redundancy.templatePath}` : '',
          ]
            .filter(Boolean)
        : ['  redundancy 정보 없음'],
    },
    buildHealthCountSection('■ KIS 실행 capability', report.kisCapabilityHealth, { okLimit: 1, warnLimit: 2 }),
    buildHealthCountSection('■ rail별 신규 진입 한도(오늘)', report.tradeLaneHealth, { okLimit: 6, warnLimit: 6 }),
    {
      title: '■ learning loop / regime tuning',
      lines: report.runtimeLearningLoop
        ? (() => {
          const { weakest: latestWeakest, weakestMode: latestWeakestMode } = getWeakestRegimeSummary(report.latestOpsSnapshot?.health?.runtimeLearningLoop);
          const strategyFeedbackOutcomes = report.runtimeLearningLoop.sections?.collect?.strategyFeedbackOutcomes || null;
          const strategyFeedbackWeak = strategyFeedbackOutcomes?.weak || strategyFeedbackOutcomes?.weakest || null;
          const strategyFeedbackTrend = strategyFeedbackOutcomes?.trend || null;
          const riskApproval = report.runtimeLearningLoop.sections?.collect?.riskApproval || null;
          const riskApprovalReadiness = report.runtimeLearningLoop.sections?.collect?.riskApprovalReadiness || null;
          const riskApprovalModeAudit = report.runtimeLearningLoop.sections?.collect?.riskApprovalModeAudit || null;
          const riskApprovalModeAuditTrend = riskApprovalModeAudit?.trend || null;
          const riskApprovalTopModel = riskApproval?.topModels?.[0] || null;
          const riskApprovalTrend = riskApproval?.trend || null;
          const riskApprovalOutcome = riskApproval?.outcome || null;
          const riskApprovalOutcomeMode = riskApproval?.outcomeByMode?.[0] || null;
          const riskApprovalOutcomeWorst = riskApproval?.outcomeSamples?.worst?.[0] || null;
          const riskApprovalReadinessTrend = riskApprovalReadiness?.trend || null;
          return [
            `  status: ${report.runtimeLearningLoop.decision?.status || 'unknown'}`,
            `  headline: ${report.runtimeLearningLoop.decision?.headline || 'n/a'}`,
            `  weakest: ${report.runtimeLearningLoop.sections?.collect?.regimePerformance?.weakestRegime?.regime || 'n/a'} / ${report.runtimeLearningLoop.sections?.collect?.regimePerformance?.weakestRegime?.worstMode?.tradeMode || 'n/a'} / avg ${report.runtimeLearningLoop.sections?.collect?.regimePerformance?.weakestRegime?.worstMode?.avgPnlPercent ?? 'n/a'}%`,
            `  strongest: ${report.runtimeLearningLoop.sections?.collect?.regimePerformance?.strongestRegime?.regime || 'n/a'} / ${report.runtimeLearningLoop.sections?.collect?.regimePerformance?.strongestRegime?.bestMode?.tradeMode || 'n/a'} / avg ${report.runtimeLearningLoop.sections?.collect?.regimePerformance?.strongestRegime?.bestMode?.avgPnlPercent ?? 'n/a'}%`,
            `  top suggestion: ${report.runtimeLearningLoop.sections?.strategy?.runtimeSuggestionTop?.key || 'n/a'} -> ${report.runtimeLearningLoop.sections?.strategy?.runtimeSuggestionTop?.suggested ?? 'n/a'} (${report.runtimeLearningLoop.sections?.strategy?.runtimeSuggestionTop?.action || 'n/a'})`,
            `  strategy feedback outcomes: ${strategyFeedbackOutcomes?.status || 'unknown'} / tagged ${strategyFeedbackOutcomes?.total || strategyFeedbackOutcomes?.totalTagged || 0} / closed ${strategyFeedbackOutcomes?.closed || strategyFeedbackOutcomes?.closedTagged || 0} / pnl ${strategyFeedbackOutcomes?.pnlNet ?? 0}`,
            `  risk approval: ${riskApproval?.status || 'unknown'} / preview ${riskApproval?.total || 0} / rejects ${riskApproval?.previewRejects || 0} / divergence ${riskApproval?.divergence || 0} / amount delta ${riskApproval?.previewVsApprovedDelta ?? 0}`,
            ...(riskApprovalOutcome ? [`  risk approval outcome: closed ${riskApprovalOutcome.closed || 0}/${riskApprovalOutcome.total || 0} / win ${riskApprovalOutcome.winRate ?? 'n/a'}% / avg ${riskApprovalOutcome.avgPnlPercent ?? 'n/a'}% / pnl ${riskApprovalOutcome.pnlNet ?? 0}`] : []),
            ...(riskApprovalOutcomeMode ? [`  risk approval outcome mode: ${riskApprovalOutcomeMode.mode || 'n/a'} / closed ${riskApprovalOutcomeMode.closed || 0}/${riskApprovalOutcomeMode.total || 0} / avg ${riskApprovalOutcomeMode.avgPnlPercent ?? 'n/a'}%`] : []),
            ...(riskApprovalOutcomeWorst ? [`  risk approval worst sample: ${riskApprovalOutcomeWorst.exchange || 'n/a'}/${riskApprovalOutcomeWorst.symbol || 'n/a'} ${riskApprovalOutcomeWorst.mode || 'n/a'} / pnl ${riskApprovalOutcomeWorst.pnlNet ?? 'n/a'} (${riskApprovalOutcomeWorst.pnlPercent ?? 'n/a'}%) / models ${(riskApprovalOutcomeWorst.models || []).join(',') || 'n/a'}`] : []),
            `  risk approval readiness: ${riskApprovalReadiness?.status || 'unknown'} / mode ${riskApprovalReadiness?.currentMode || 'n/a'} -> ${riskApprovalReadiness?.targetMode || 'n/a'} / blockers ${(riskApprovalReadiness?.blockers || []).length}`,
            ...(riskApprovalReadiness?.dryRun ? [`  risk approval dry-run: assist applied ${riskApprovalReadiness.dryRun.assist?.applied ?? 0} / enforce rejected ${riskApprovalReadiness.dryRun.enforce?.rejected ?? 0}`] : []),
            ...(riskApprovalReadinessTrend ? [`  risk approval readiness trend: history ${riskApprovalReadinessTrend.historyCount || 0} / blocker Δ${riskApprovalReadinessTrend.delta?.blockerCount ?? 0} / preview Δ${riskApprovalReadinessTrend.delta?.previewTotal ?? 0} / reject Δ${riskApprovalReadinessTrend.delta?.previewRejects ?? 0} / divergence Δ${riskApprovalReadinessTrend.delta?.divergence ?? 0}`] : []),
            `  risk approval mode audit: ${riskApprovalModeAudit?.status || 'unknown'} / mode ${riskApprovalModeAudit?.metrics?.currentMode || 'n/a'} / non-shadow ${riskApprovalModeAudit?.metrics?.nonShadowApplications || 0} / unavailable ${riskApprovalModeAudit?.metrics?.unavailablePreviewCount || 0}`,
            ...(riskApprovalModeAuditTrend ? [`  risk approval mode audit trend: history ${riskApprovalModeAuditTrend.historyCount || 0} / non-shadow Δ${riskApprovalModeAuditTrend.delta?.nonShadowApplications ?? 0} / unavailable Δ${riskApprovalModeAuditTrend.delta?.unavailablePreviewCount ?? 0} / blocker Δ${riskApprovalModeAuditTrend.delta?.blockerCount ?? 0} / outcome pnl Δ${riskApprovalModeAuditTrend.delta?.outcomePnlNet ?? 0}`] : []),
            ...(riskApprovalTrend ? [`  risk approval trend: history ${riskApprovalTrend.historyCount || 0} / preview Δ${riskApprovalTrend.delta?.total ?? 0} / reject Δ${riskApprovalTrend.delta?.previewRejects ?? 0} / divergence Δ${riskApprovalTrend.delta?.legacyApprovedPreviewRejected ?? 0} / amount Δ${riskApprovalTrend.delta?.previewVsApprovedDelta ?? 0}`] : []),
            `  risk approval ops suite: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run risk:approval-ops-suite -- --json`,
            ...(strategyFeedbackTrend ? [`  feedback trend: history ${strategyFeedbackTrend.historyCount || 0} / tagged Δ${strategyFeedbackTrend.delta?.total ?? 0} / closed Δ${strategyFeedbackTrend.delta?.closed ?? 0} / pnl Δ${strategyFeedbackTrend.delta?.pnlNet ?? 0}`] : []),
            ...(strategyFeedbackWeak ? [`  feedback weakest: ${strategyFeedbackWeak.familyBias || 'n/a'} / ${strategyFeedbackWeak.family || 'n/a'} / ${strategyFeedbackWeak.executionKind || 'n/a'} / avg ${strategyFeedbackWeak.avgPnlPercent ?? 'n/a'}%`] : []),
            ...(riskApprovalTopModel ? [`  risk top model: ${riskApprovalTopModel.model || 'n/a'} / adjust ${riskApprovalTopModel.adjust || 0} / reject ${riskApprovalTopModel.reject || 0} / pass ${riskApprovalTopModel.pass || 0}`] : []),
            ...(report.latestOpsSnapshot?.capturedAt ? [`  latest snapshot: ${report.latestOpsSnapshot.capturedAt} / ${latestWeakest?.regime || 'n/a'} / ${latestWeakestMode}`] : []),
            `  next command: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime-suggest -- --json`,
            ...((report.runtimeLearningLoop.decision?.nextActions || []).slice(0, 3).map((item) => `  next: ${item}`)),
          ];
        })()
        : ['  learning loop 정보 없음'],
    },
    {
      title: '■ collection audit',
      lines: report.collectionAudit
        ? [
            `  status: ${report.collectionAudit.status || 'unknown'}`,
            `  summary: recent runs ${report.collectionAudit.summary?.withRecentRuns || 0}/${report.collectionAudit.summary?.markets || 0} / ready ${report.collectionAudit.summary?.qualityReady || 0} / degraded ${report.collectionAudit.summary?.qualityDegraded || 0} / insufficient ${report.collectionAudit.summary?.qualityInsufficient || 0}`,
            ...((report.collectionAudit.markets || []).map((item) => {
              const maintenanceStage = item?.stages?.maintenanceCollect;
              const remediation = item?.remediation?.status && item.remediation.status !== 'none'
                ? ` / remediation ${item.remediation.status}`
                : '';
              return `  ${item.market}: quality ${item.collectQuality?.status || 'unknown'} / screening ${item.screeningUniverseCount} / maintenance ${item.maintenanceUniverseCount} / profiled ${item.maintenanceProfiledCount} / dust ${item.dustSkippedCount} / maintenance stage ${maintenanceStage?.implemented ? 'on' : 'off'}${remediation}`;
            })),
          ]
        : ['  collection audit 정보 없음'],
    },
    {
      title: '■ trade incident link audit',
      lines: report.incidentLinkAudit
        ? [
            `  scanned: ${report.incidentLinkAudit.scanned || 0}`,
            `  missing candidates: ${report.incidentLinkAudit.updated || 0}`,
            `  unresolved: ${report.incidentLinkAudit.unresolved || 0}`,
            `  next command: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run journal:backfill-incident-links -- --dry-run --json`,
            ...((report.incidentLinkAudit.samples || []).slice(0, 5).map((sample) => `  sample: ${sample.exchange}/${sample.symbol} ${sample.tradeId} <- ${sample.incidentLink}`)),
          ]
        : ['  incident link audit 정보 없음'],
    },
    {
      title: '■ execution attach audit',
      lines: report.executionAttachAudit
        ? buildExecutionAttachAuditLines(report)
        : ['  execution attach audit 정보 없음'],
    },
    {
      title: '■ position strategy audit',
      lines: report.positionStrategyAudit
        ? [
            `  managed: ${report.positionStrategyAudit.managedPositions || 0} / profiles ${report.positionStrategyAudit.managedProfiles || 0} / dust ${report.positionStrategyAudit.dustPositions || 0}`,
            `  unmatched managed: ${report.positionStrategyAudit.unmatchedManagedPositions || 0} / orphan ${report.positionStrategyAudit.orphanProfiles || 0} / duplicate active scopes ${report.positionStrategyAudit.duplicateActiveProfileScopes || 0} / duplicate managed scopes ${report.positionStrategyAudit.duplicateManagedProfileScopes || 0}`,
            ...(report.positionStrategyHygiene
              ? [
                `  hygiene status: ${report.positionStrategyHygiene.decision?.status || 'unknown'}`,
                `  hygiene headline: ${report.positionStrategyHygiene.decision?.headline || 'n/a'}`,
                `  hygiene focus: ${report.positionStrategyHygiene.recommendedExchange?.exchange || 'all'}${report.positionStrategyHygiene.recommendedExchange?.count ? ` (${report.positionStrategyHygiene.recommendedExchange.count})` : ''}`,
              ]
              : []),
            ...buildPositionStrategyAuditRemediationLines(report),
            ...(report.duplicateStrategyNormalization
              ? [
                `  normalize status: ${report.duplicateStrategyNormalization.decision?.status || 'unknown'} / safeToApply ${report.duplicateStrategyNormalization.decision?.safeToApply === true ? 'yes' : 'no'}`,
                `  normalize summary: managedScopes ${report.duplicateStrategyNormalization.summary?.managedScopes || 0} / duplicateScopes ${report.duplicateStrategyNormalization.summary?.duplicateScopes || 0} / duplicateProfiles ${report.duplicateStrategyNormalization.summary?.duplicateProfiles || 0}`,
                `  normalize headline: ${report.duplicateStrategyNormalization.decision?.headline || 'n/a'}`,
              ]
              : []),
            ...(report.orphanStrategyRetirement
              ? [
                `  orphan retire status: ${report.orphanStrategyRetirement.decision?.status || 'unknown'} / safeToApply ${report.orphanStrategyRetirement.decision?.safeToApply === true ? 'yes' : 'no'}`,
                `  orphan retire summary: orphanProfiles ${report.orphanStrategyRetirement.summary?.orphanProfiles || 0} / orphanSymbols ${report.orphanStrategyRetirement.summary?.orphanSymbols || 0}`,
                `  orphan retire headline: ${report.orphanStrategyRetirement.decision?.headline || 'n/a'}`,
              ]
              : []),
            ...(report.positionStrategyAudit.duplicateProfileScopes || []).slice(0, 3).map((scope) => `  duplicate: ${scope.exchange}/${scope.symbol} count ${scope.count} keeper ${scope.keeperProfileId}`),
            `  next command: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-audit`,
          ]
        : ['  position strategy audit 정보 없음'],
    },
    {
      title: '■ position runtime',
      lines: report.positionRuntimeReport
        ? buildPositionRuntimeLines(report)
        : ['  position runtime 정보 없음'],
    },
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
  const executionRiskApprovalGuardHealth = await loadExecutionRiskApprovalGuardHealth(pgPool);
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
  const localLlmHealth = await loadLocalLlmHealth(status);
  const runtimeLearningLoop = await buildRuntimeLearningLoopReport({ days: 14, json: true }).catch(() => null);
  const collectionAudit = await runCollectionAudit({ markets: ['binance', 'kis', 'kis_overseas'], hours: 24 }).catch(() => null);
  const executionAttachAudit = await runExecutionAttachAudit({ days: 14, limit: 50 }).catch(() => null);
  const executionAttachBackfill = await runExecutionAttachBackfill({ days: 14, limit: 50, dryRun: true }).catch(() => null);
  const positionStrategyAudit = await buildRuntimePositionStrategyAudit({ json: true }).catch(() => null);
  const positionStrategyHygiene = await runPositionStrategyHygiene({ json: true }).catch(() => null);
  const positionStrategyRemediation = await runPositionStrategyRemediation({ json: true }).catch(() => null);
  const positionRuntimeReport = await runPositionRuntimeReport({ json: true, limit: 200 }).catch(() => null);
  const positionRuntimeTuning = await runPositionRuntimeTuning({ json: true }).catch(() => null);
  const positionRuntimeDispatch = await runPositionRuntimeDispatch({ json: true, limit: 20 }).catch(() => null);
  const positionStrategyRemediationHistory = positionStrategyRemediation?.remediationHistory || null;
  const hygieneRecommendedExchange = positionStrategyHygiene?.recommendedExchange?.exchange || null;
  const duplicateStrategyNormalization = await normalizeDuplicateStrategyProfiles({ apply: false, exchange: hygieneRecommendedExchange }).catch(() => null);
  const orphanStrategyRetirement = await retireOrphanStrategyProfiles({ apply: false, exchange: hygieneRecommendedExchange }).catch(() => null);
  const incidentLinkAudit = await backfillTradeIncidentLinks({
    dryRun: true,
    json: true,
    onlyFamilyBias: false,
    limit: 500,
  }).catch(() => null);
  const latestOpsSnapshot = loadLatestOpsSnapshot();
  const cryptoGateActionPlan = buildCryptoGateActionPlan(capitalGuardBreakdown);
  const executionAttachView = buildExecutionAttachSnapshot(executionAttachAudit, executionAttachBackfill);
  const remediationView = buildFlatRemediationSnapshot(positionStrategyRemediation);
  const positionRuntimeView = buildPositionRuntimeSnapshot(positionRuntimeReport, positionRuntimeTuning, positionRuntimeDispatch);
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
    localLlmHealth,
    runtimeLearningLoop,
    latestOpsSnapshot,
    collectionAudit,
    incidentLinkAudit,
    executionAttachAudit,
    executionAttachBackfill,
    positionStrategyAudit,
    positionStrategyHygiene,
    positionStrategyRemediation,
    positionStrategyRemediationHistory,
    duplicateStrategyNormalization,
    orphanStrategyRetirement,
    executionRiskApprovalGuardHealth,
    positionRuntimeReport,
    positionRuntimeTuning,
    positionRuntimeDispatch,
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
    executionRiskApprovalGuardHealth,
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
    localLlmHealth,
    runtimeLearningLoop,
    collectionAudit,
    incidentLinkAudit,
    executionAttachAudit,
    executionAttachBackfill,
    executionAttachView,
    executionAttachStatus: executionAttachView.status,
    executionAttachHeadline: executionAttachView.headline,
    executionAttachAvgAttachScore: executionAttachView.avgAttachScore,
    executionAttachCompleteCount: executionAttachView.completeCount,
    executionAttachRecoveredPartialCount: executionAttachView.recoveredPartialCount,
    executionAttachActionableCount: executionAttachView.actionableCount,
    executionAttachTrackedCount: executionAttachView.attachTrackedCount,
    executionAttachErrorCount: executionAttachView.attachErrorCount,
    executionAttachAuditCommand: executionAttachView.auditCommand,
    executionAttachRepairDryRunCommand: executionAttachView.repairDryRunCommand,
    executionAttachRepairWriteCommand: executionAttachView.repairWriteCommand,
    executionAttachBackfillStatus: executionAttachView.backfillStatus,
    executionAttachBackfillHeadline: executionAttachView.backfillHeadline,
    executionAttachBackfillCandidates: executionAttachView.backfillCandidates,
    executionAttachBackfillWriteEligible: executionAttachView.backfillWriteEligible,
    executionAttachBackfillMissingSignalId: executionAttachView.backfillMissingSignalId,
    executionAttachBackfillOpenPositionBlocked: executionAttachView.backfillOpenPositionBlocked,
    positionStrategyAudit,
    positionStrategyHygiene,
    positionStrategyRemediation,
    positionStrategyRemediationFlat: remediationView.flat,
    positionStrategyRemediationSummary: remediationView.summary,
    positionStrategyRemediationStatus: remediationView.status,
    positionStrategyRemediationHeadline: remediationView.headline,
    positionStrategyRemediationCounts: remediationView.counts,
    positionStrategyRemediationRecommendedExchange: remediationView.recommendedExchange,
    positionStrategyRemediationDuplicateManaged: remediationView.duplicateManaged,
    positionStrategyRemediationOrphanProfiles: remediationView.orphanProfiles,
    positionStrategyRemediationUnmatchedManaged: remediationView.unmatchedManaged,
    positionStrategyRemediationHistory,
    positionStrategyRemediationTrend: remediationView.trend,
    positionStrategyRemediationTrendHistoryCount: remediationView.trendHistoryCount,
    positionStrategyRemediationTrendChanged: remediationView.trendChanged,
    positionStrategyRemediationTrendNextChanged: remediationView.trendNextChanged,
    positionStrategyRemediationTrendAgeMinutes: remediationView.trendAgeMinutes,
    positionStrategyRemediationTrendStale: remediationView.trendStale,
    positionStrategyRemediationTrendLastRecordedAt: remediationView.trendLastRecordedAt,
    positionStrategyRemediationTrendDuplicateDelta: remediationView.trendDuplicateDelta,
    positionStrategyRemediationTrendOrphanDelta: remediationView.trendOrphanDelta,
    positionStrategyRemediationTrendUnmatchedDelta: remediationView.trendUnmatchedDelta,
    positionStrategyRemediationRefresh: remediationView.refreshState,
    positionStrategyRemediationRefreshNeeded: remediationView.refreshNeeded,
    positionStrategyRemediationRefreshStale: remediationView.refreshStale,
    positionStrategyRemediationRefreshReason: remediationView.refreshReason,
    positionStrategyRemediationRefreshCommand: remediationView.refreshCommand,
    positionStrategyRemediationCommands: remediationView.commands,
    positionStrategyRemediationActionReportCommand: remediationView.actionReportCommand,
    positionStrategyRemediationActionHistoryCommand: remediationView.actionHistoryCommand,
    positionStrategyRemediationActionRefreshCommand: remediationView.actionRefreshCommand,
    positionStrategyRemediationActionHygieneCommand: remediationView.actionHygieneCommand,
    positionStrategyRemediationActionNormalizeDryRunCommand: remediationView.actionNormalizeDryRunCommand,
    positionStrategyRemediationActionNormalizeApplyCommand: remediationView.actionNormalizeApplyCommand,
    positionStrategyRemediationActionRetireDryRunCommand: remediationView.actionRetireDryRunCommand,
    positionStrategyRemediationActionRetireApplyCommand: remediationView.actionRetireApplyCommand,
    positionStrategyRemediationReportCommand: remediationView.reportCommand,
    positionStrategyRemediationHistoryCommand: remediationView.historyCommand,
    positionStrategyRemediationRefreshCommand: remediationView.refreshCommand,
    positionStrategyRemediationNormalizeDryRunCommand: remediationView.normalizeDryRunCommand,
    positionStrategyRemediationNormalizeApplyCommand: remediationView.normalizeApplyCommand,
    positionStrategyRemediationRetireDryRunCommand: remediationView.retireDryRunCommand,
    positionStrategyRemediationRetireApplyCommand: remediationView.retireApplyCommand,
    positionStrategyRemediationNextCommand: remediationView.nextCommand,
    positionStrategyRemediationActions: remediationView.actions,
    positionStrategyRemediationNextCommandTransition: remediationView.nextCommandTransition,
    positionStrategyRemediationNextCommandChanged: remediationView.nextCommandChanged,
    positionStrategyRemediationNextCommandPrevious: remediationView.nextCommandPrevious,
    positionStrategyRemediationNextCommandCurrent: remediationView.nextCommandCurrent,
    positionRuntimeReport,
    positionRuntimeTuning,
    positionRuntimeDispatch,
    positionRuntimeView,
    positionRuntimeStatus: positionRuntimeView.status,
    positionRuntimeHeadline: positionRuntimeView.headline,
    positionRuntimeMetrics: positionRuntimeView.metrics,
    positionRuntimeTuningStatus: positionRuntimeView.tuningStatus,
    positionRuntimeTuningSuggestion: positionRuntimeView.tuningSuggestion,
    positionRuntimeDispatchStatus: positionRuntimeView.dispatchStatus,
    positionRuntimeDispatchCandidates: positionRuntimeView.dispatchCandidates,
    positionRuntimeDispatchTopCandidate: positionRuntimeView.dispatchTopCandidate,
    positionRuntimeReportCommand: positionRuntimeView.reportCommand,
    positionRuntimeTuningCommand: positionRuntimeView.tuningCommand,
    positionRuntimeDispatchCommand: positionRuntimeView.dispatchCommand,
    duplicateStrategyNormalization,
    orphanStrategyRetirement,
    latestOpsSnapshot,
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
