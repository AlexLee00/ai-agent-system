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

async function loadTradeReviewHealth() {
  const modulePath = path.resolve(__dirname, './validate-trade-review.js');
  const mod = await import(pathToFileURL(modulePath).href);
  const result = await mod.validateTradeReview({ days: 90, fix: false });
  return {
    findings: result.findings || 0,
    closedTrades: result.closedTrades || 0,
  };
}

function buildDecision(serviceRows, tradeReview) {
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
  const decision = buildDecision(serviceRows, tradeReview);

  const report = {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    tradeReview,
    decision,
  };
  return report;
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[루나 운영 헬스 리포트]',
});
