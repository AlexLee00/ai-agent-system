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
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

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

function formatGuardScope(scope = '') {
  const normalized = String(scope || '').trim().toLowerCase();
  if (normalized === 'investment.normal.crypto') return '암호화폐';
  if (normalized === 'investment.normal.domestic') return '국내주식';
  if (normalized === 'investment.normal.overseas') return '해외주식';
  if (normalized.startsWith('investment.normal.crypto.')) return `암호화폐/${normalized.split('.').pop()}`;
  if (normalized.startsWith('investment.normal.domestic.')) return `국내주식/${normalized.split('.').pop()}`;
  if (normalized.startsWith('investment.normal.overseas.')) return `해외주식/${normalized.split('.').pop()}`;
  return normalized || 'unknown';
}

function formatGuardExpiry(expiresAt) {
  if (!expiresAt) return '수동 해제';
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '수동 해제';
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function formatGuardReason(reason = '') {
  const text = String(reason || '').trim();
  if (!text) return '';
  return text
    .replace(/^\[(.*?)\]\s*/i, '$1 ')
    .replace(/10분 급등\s*/g, '급등 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildGuardHealth() {
  const rows = billingGuard.listActiveGuards('investment.normal');
  if (rows.length === 0) {
    return {
      okCount: 1,
      warnCount: 0,
      ok: ['  투자 LLM guard 없음'],
      warn: [],
    };
  }
  return {
    okCount: 0,
    warnCount: rows.length,
    ok: [],
    warn: rows.flatMap((row) => {
      const expires = formatGuardExpiry(row.expires_at);
      const lines = [`  ${formatGuardScope(row.scope)} 차단 / 해제 ${expires}`];
      const reason = formatGuardReason(row.reason);
      if (reason) lines.push(`    사유: ${reason}`);
      return lines;
    }),
  };
}

async function loadTradeReviewHealth() {
  const modulePath = path.resolve(__dirname, './validate-trade-review.js');
  const mod = await import(pathToFileURL(modulePath).href);
  const result = await mod.validateTradeReview({ days: 90, fix: false });
  return {
    findings: result.findings || 0,
    closedTrades: result.closedTrades || 0,
  };
}

async function loadSignalBlockHealth() {
  const rows = await pgPool.query(
    'investment',
    `
      SELECT
        COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
        COUNT(*)::int AS cnt
      FROM investment.signals
      WHERE created_at::date = CURRENT_DATE
        AND status IN ('failed', 'blocked', 'rejected')
      GROUP BY 1
      ORDER BY cnt DESC, block_code ASC
      LIMIT 5
    `,
  ).catch(() => []);

  const total = rows.reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  return {
    total,
    top: rows.map((row) => ({
      code: row.block_code,
      count: Number(row.cnt || 0),
    })),
  };
}

function buildDecision(serviceRows, tradeReview, guardHealth, signalBlockHealth) {
  const topBlock = signalBlockHealth.top[0] || null;
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
        level: topBlock?.code === 'same_day_reentry_blocked' ? 'medium' : 'low',
        reason: `오늘 차단/거부 신호 ${signalBlockHealth.total}건 — 최다 사유 ${topBlock?.code || 'n/a'} ${topBlock?.count || 0}건`,
      },
    ],
    okReason: '핵심 서비스와 trade_review 정합성이 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  const sections = [
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
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => hsm.shortLabel(label),
  });
  const tradeReview = await loadTradeReviewHealth();
  const guardHealth = buildGuardHealth();
  const signalBlockHealth = await loadSignalBlockHealth();
  const decision = buildDecision(serviceRows, tradeReview, guardHealth, signalBlockHealth);

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
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[루나 운영 헬스 리포트]',
});
