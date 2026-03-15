'use strict';

const path = require('path');
const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthCountSection,
  buildHealthSampleSection,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  buildHttpChecks,
  buildFileActivityHealth,
  checkHttp,
  checkWebhookRegistration,
} = require('../../../packages/core/lib/health-provider');
const { resolveProductionWebhookUrl } = require('../../../packages/core/lib/n8n-webhook-registry');

const CONTINUOUS = ['ai.blog.node-server'];
const ALL_SERVICES = ['ai.blog.daily', 'ai.blog.node-server'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const BLOG_ROOT = path.join(__dirname, '..');
const DAILY_LOG = path.join(BLOG_ROOT, 'blog-daily.log');
const DAILY_LOG_STALE_MS = 36 * 60 * 60 * 1000;
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || 'http://127.0.0.1:5678/healthz';
const DEFAULT_BLOG_WEBHOOK_URL = process.env.N8N_BLOG_WEBHOOK || 'http://127.0.0.1:5678/webhook/blog-pipeline';

async function buildNodeHealth() {
  const checks = await buildHttpChecks([
    {
      label: 'nodeServer',
      url: 'http://127.0.0.1:3100/health',
      expectJson: true,
      isOk: (data) => Boolean(data?.ok),
      okText: (data) => `  node-server API: 정상 (port ${data.port || 3100})`,
      warnText: '  node-server API: 응답 없음',
    },
    {
      label: 'n8n',
      url: 'http://127.0.0.1:5678/healthz',
      expectJson: true,
      timeoutMs: 2500,
      isOk: (data) => data?.status === 'ok',
      okText: '  n8n healthz: 정상',
      warnText: '  n8n healthz: 응답 없음',
    },
  ]);

  return {
    ok: checks.ok,
    warn: checks.warn,
    nodeServerOk: Boolean(checks.results.nodeServer?.ok),
    n8nOk: checks.results.n8n?.status === 'ok',
  };
}

function buildDailyRunHealth() {
  return buildFileActivityHealth({
    label: 'daily log',
    filePath: DAILY_LOG,
    staleMs: DAILY_LOG_STALE_MS,
    missingText: '  daily log: 파일 없음',
    staleText: (state) => `  daily log: ${state.minutesAgo}분 무활동`,
    okText: (state) => `  daily log: 최근 ${state.minutesAgo}분 이내 활동`,
  });
}

async function buildN8nPipelineHealth() {
  const ok = [];
  const warn = [];
  const n8nHealthy = await checkHttp(N8N_HEALTH_URL, 2500);
  const resolvedWebhookUrl = await resolveProductionWebhookUrl({
    workflowName: '블로그팀 동적 포스팅',
    method: 'POST',
    pathSuffix: 'blog-pipeline',
  });
  const webhookUrl = resolvedWebhookUrl || DEFAULT_BLOG_WEBHOOK_URL;
  const webhook = await checkWebhookRegistration(webhookUrl, {
    postType: 'general',
    sessionId: 'n8n-blog-health-probe',
    pipeline: ['weather'],
    variations: {},
  }, {
    timeoutMs: 5000,
  });

  if (n8nHealthy) ok.push('  n8n healthz: 정상');
  else warn.push('  n8n healthz: 응답 없음');

  if (!webhook.healthy) {
    warn.push(`  blog pipeline webhook: 미도달 (${webhook.error || webhook.reason})`);
  } else if (!webhook.registered) {
    warn.push(`  blog pipeline webhook: 미등록 (${webhook.reason}, status ${webhook.status})`);
  } else {
    ok.push(`  blog pipeline webhook: 등록됨 (${webhook.reason}, status ${webhook.status})`);
  }

  return {
    ok,
    warn,
    n8nHealthy,
    webhookRegistered: webhook.registered,
    webhookReason: webhook.reason,
    webhookStatus: webhook.status,
    webhookUrl,
    resolvedWebhookUrl,
  };
}

function buildDecision(serviceRows, nodeHealth, dailyRunHealth, n8nPipelineHealth) {
  return buildHealthDecision({
    warnings: [
      {
        active: serviceRows.warn.length > 0,
        level: 'high',
        reason: `launchd 경고 ${serviceRows.warn.length}건이 있어 블로팀 서비스 점검이 필요합니다.`,
      },
      {
        active: nodeHealth.warn.length > 0,
        level: 'medium',
        reason: `node-server/n8n 경고 ${nodeHealth.warn.length}건이 있어 실행 백엔드 상태 확인이 필요합니다.`,
      },
      {
        active: dailyRunHealth.warn.length > 0,
        level: 'medium',
        reason: 'daily run 로그 활동성이 오래돼 최근 자동 실행 상태 확인이 필요합니다.',
      },
      {
        active: !n8nPipelineHealth.n8nHealthy,
        level: 'medium',
        reason: 'n8n healthz 응답이 없어 블로 pipeline 워크플로우 경로를 사용할 수 없습니다.',
      },
      {
        active: n8nPipelineHealth.n8nHealthy && !n8nPipelineHealth.webhookRegistered,
        level: 'medium',
        reason: `n8n은 살아 있지만 blog pipeline webhook이 미등록 상태입니다 (${n8nPipelineHealth.webhookReason}).`,
      },
    ],
    okReason: '블로팀 실행기와 daily run 상태가 현재는 안정 구간입니다.',
  });
}

function formatText(report) {
  return buildHealthReport({
    title: '📰 블로 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 서비스 상태', report.serviceHealth),
      buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth),
      buildHealthCountSection('■ 실행 백엔드 상태', report.nodeHealth, { okLimit: 3 }),
      buildHealthCountSection('■ n8n pipeline 경로', report.n8nPipelineHealth, { okLimit: 2 }),
      buildHealthCountSection('■ daily run 상태', report.dailyRunHealth, { warnLimit: 4, okLimit: 2 }),
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
    ].filter(Boolean),
    footer: ['실행: node bots/blog/scripts/health-report.js --json'],
  });
}

async function buildReport() {
  const status = getLaunchctlStatus();
  const serviceRows = buildServiceRows(status, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace('ai.blog.', ''),
  });
  const nodeHealth = await buildNodeHealth();
  const dailyRunHealth = buildDailyRunHealth();
  const n8nPipelineHealth = await buildN8nPipelineHealth();
  const decision = buildDecision(serviceRows, nodeHealth, dailyRunHealth, n8nPipelineHealth);

  return {
    serviceHealth: {
      okCount: serviceRows.ok.length,
      warnCount: serviceRows.warn.length,
      ok: serviceRows.ok,
      warn: serviceRows.warn,
    },
    nodeHealth: {
      okCount: nodeHealth.ok.length,
      warnCount: nodeHealth.warn.length,
      ok: nodeHealth.ok,
      warn: nodeHealth.warn,
    },
    dailyRunHealth: {
      okCount: dailyRunHealth.ok.length,
      warnCount: dailyRunHealth.warn.length,
      ok: dailyRunHealth.ok,
      warn: dailyRunHealth.warn,
      minutesAgo: dailyRunHealth.minutesAgo,
    },
    n8nPipelineHealth: {
      okCount: n8nPipelineHealth.ok.length,
      warnCount: n8nPipelineHealth.warn.length,
      ok: n8nPipelineHealth.ok,
      warn: n8nPipelineHealth.warn,
      webhookRegistered: n8nPipelineHealth.webhookRegistered,
      webhookReason: n8nPipelineHealth.webhookReason,
      webhookStatus: n8nPipelineHealth.webhookStatus,
      webhookUrl: n8nPipelineHealth.webhookUrl,
      resolvedWebhookUrl: n8nPipelineHealth.resolvedWebhookUrl,
    },
    decision,
  };
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[블로 운영 헬스 리포트]',
});
