#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool.js');
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
  buildResolvedWebhookHealth,
} = require('../../../packages/core/lib/health-provider');
const { getBlogHealthRuntimeConfig } = require('../lib/runtime-config.ts');

const CONTINUOUS = ['ai.blog.node-server'];
const ALL_SERVICES = ['ai.blog.daily', 'ai.blog.node-server'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');
const DAILY_LOG = path.join(BLOG_ROOT, 'blog-daily.log');
const runtimeConfig = getBlogHealthRuntimeConfig();
const DAILY_LOG_STALE_MS = Number(runtimeConfig.dailyLogStaleMs || (36 * 60 * 60 * 1000));
const NODE_SERVER_HEALTH_URL = runtimeConfig.nodeServerHealthUrl || 'http://127.0.0.1:3100/health';
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || runtimeConfig.n8nHealthUrl || 'http://127.0.0.1:5678/healthz';
const DEFAULT_BLOG_WEBHOOK_URL = process.env.N8N_BLOG_WEBHOOK || runtimeConfig.blogWebhookUrl || 'http://127.0.0.1:5678/webhook/blog-pipeline';

async function buildNodeHealth() {
  const checks = await buildHttpChecks([
    {
      label: 'nodeServer',
      url: NODE_SERVER_HEALTH_URL,
      expectJson: true,
      timeoutMs: Number(runtimeConfig.nodeServerTimeoutMs || 3000),
      isOk: (data) => Boolean(data?.ok),
      okText: (data) => `  node-server API: 정상 (port ${data.port || 3100})`,
      warnText: '  node-server API: 응답 없음',
    },
    {
      label: 'n8n',
      url: N8N_HEALTH_URL,
      expectJson: true,
      timeoutMs: Number(runtimeConfig.n8nHealthTimeoutMs || 2500),
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
  return buildResolvedWebhookHealth({
    workflowName: '블로그팀 동적 포스팅',
    pathSuffix: 'blog-pipeline',
    healthUrl: N8N_HEALTH_URL,
    defaultWebhookUrl: DEFAULT_BLOG_WEBHOOK_URL,
    probeBody: {
      postType: 'general',
      sessionId: 'n8n-blog-health-probe',
      pipeline: ['weather'],
      variations: {},
    },
    okLabel: 'blog pipeline webhook',
    warnLabel: 'blog pipeline webhook',
    timeoutMs: Number(runtimeConfig.webhookTimeoutMs || 5000),
  });
}

async function buildBookCatalogHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(count(*), 0)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE source = 'canonical'), 0)::int AS canonical_count,
        COALESCE(count(*) FILTER (WHERE source = 'data4library'), 0)::int AS popular_count
      FROM blog.book_catalog
    `);
    const row = rows?.[0] || { total_count: 0, canonical_count: 0, popular_count: 0 };
    const ok = [
      `  book_catalog: ${row.total_count}권`,
      `  canonical: ${row.canonical_count}권`,
      `  data4library popular: ${row.popular_count}권`,
      '  note: 정보나루 승인 전에는 popular 0건이 자연스러울 수 있음',
    ];
    return {
      okCount: ok.length,
      warnCount: 0,
      ok,
      warn: [],
      totalCount: Number(row.total_count || 0),
      canonicalCount: Number(row.canonical_count || 0),
      popularCount: Number(row.popular_count || 0),
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  book_catalog: 확인 실패 (${error.message.slice(0, 120)})`],
      totalCount: 0,
      canonicalCount: 0,
      popularCount: 0,
    };
  } finally {
    await pgPool.closeAll().catch(() => {});
  }
}

async function buildBookReviewQueueHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(count(*), 0)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE status = 'queued'), 0)::int AS queued_count,
        COALESCE(count(*) FILTER (WHERE queue_date = CURRENT_DATE), 0)::int AS today_count
      FROM blog.book_review_queue
    `);
    const row = rows?.[0] || { total_count: 0, queued_count: 0, today_count: 0 };
    const ok = [
      `  book_review_queue: ${row.total_count}건`,
      `  queued: ${row.queued_count}건`,
      `  today: ${row.today_count}건`,
    ];
    return {
      okCount: ok.length,
      warnCount: 0,
      ok,
      warn: [],
      totalCount: Number(row.total_count || 0),
      queuedCount: Number(row.queued_count || 0),
      todayCount: Number(row.today_count || 0),
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  book_review_queue: 확인 실패 (${error.message.slice(0, 120)})`],
      totalCount: 0,
      queuedCount: 0,
      todayCount: 0,
    };
  }
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
      buildHealthCountSection('■ 도서 카탈로그 상태', report.bookCatalogHealth, { okLimit: 4 }),
      buildHealthCountSection('■ 도서리뷰 큐 상태', report.bookReviewQueueHealth, { okLimit: 3 }),
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
    footer: ['실행: node bots/blog/scripts/health-report.ts --json'],
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
  const bookCatalogHealth = await buildBookCatalogHealth();
  const bookReviewQueueHealth = await buildBookReviewQueueHealth();
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
    bookCatalogHealth,
    bookReviewQueueHealth,
    decision,
  };
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[블로 운영 헬스 리포트]',
});
