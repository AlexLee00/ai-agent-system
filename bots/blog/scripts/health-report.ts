#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
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
const { getInstagramConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-graph.ts'));
const { getInstagramImageHostConfig } = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/instagram-image-host.ts'));
const { buildMarketingDigest } = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/marketing-digest.ts'));

const CONTINUOUS = ['ai.blog.node-server'];
const ALL_SERVICES = ['ai.blog.daily', 'ai.blog.node-server'];
const NORMAL_EXIT_CODES = DEFAULT_NORMAL_EXIT_CODES;
const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');
const BLOG_STRATEGY_PATH = path.join(BLOG_ROOT, 'output', 'strategy', 'latest-strategy.json');
const DAILY_LOG = path.join(BLOG_ROOT, 'blog-daily.log');
const runtimeConfig = getBlogHealthRuntimeConfig();
const DAILY_LOG_STALE_MS = Number(runtimeConfig.dailyLogStaleMs || (36 * 60 * 60 * 1000));
const NODE_SERVER_HEALTH_URL = runtimeConfig.nodeServerHealthUrl || 'http://127.0.0.1:3100/health';
const N8N_HEALTH_URL = process.env.N8N_HEALTH_URL || runtimeConfig.n8nHealthUrl || 'http://127.0.0.1:5678/healthz';
const DEFAULT_BLOG_WEBHOOK_URL = process.env.N8N_BLOG_WEBHOOK || runtimeConfig.blogWebhookUrl || 'http://127.0.0.1:5678/webhook/blog-pipeline';
const TEAM_JAY_ROOT = path.join(env.PROJECT_ROOT, 'elixir', 'team_jay');

function extractJsonObjectText(output = '') {
  const text = String(output || '').trim();
  if (!text) return '';
  if (text.startsWith('{')) return text;

  const jsonLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('{') && line.endsWith('}'));
  if (jsonLine) return jsonLine;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

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

async function buildAutonomyHealth() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT
        COALESCE(count(*), 0)::int AS total_count,
        COALESCE(count(*) FILTER (WHERE decision = 'auto_publish'), 0)::int AS auto_publish_count,
        COALESCE(count(*) FILTER (WHERE decision = 'master_review'), 0)::int AS master_review_count,
        COALESCE(max(autonomy_phase), 1)::int AS max_phase
      FROM blog.autonomy_decisions
      WHERE created_at >= NOW() - INTERVAL '14 days'
        AND COALESCE(metadata->>'smoke_test', 'false') <> 'true'
        AND title NOT LIKE '[Smoke]%'
    `);
    const latest = await pgPool.get('blog', `
      SELECT post_type, category, title, decision, autonomy_phase, score, threshold, created_at
      FROM blog.autonomy_decisions
      WHERE COALESCE(metadata->>'smoke_test', 'false') <> 'true'
        AND title NOT LIKE '[Smoke]%'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = rows?.[0] || {
      total_count: 0,
      auto_publish_count: 0,
      master_review_count: 0,
      max_phase: 1,
    };

    const ok = [
      `  recent decisions: ${row.total_count}건`,
      `  auto publish: ${row.auto_publish_count}건`,
      `  master review: ${row.master_review_count}건`,
      `  max phase: ${row.max_phase}`,
    ];

    if (latest?.title) {
      ok.push(
        `  latest: ${latest.post_type}/${latest.decision} (${String(latest.title).slice(0, 60)})`,
      );
    }

    const warn = [];
    if (Number(row.total_count || 0) === 0) {
      warn.push('  autonomy decisions: 아직 축적 전');
    }

    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      totalCount: Number(row.total_count || 0),
      autoPublishCount: Number(row.auto_publish_count || 0),
      masterReviewCount: Number(row.master_review_count || 0),
      maxPhase: Number(row.max_phase || 1),
      latestDecision: latest || null,
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  autonomy: 확인 실패 (${error.message.slice(0, 120)})`],
      totalCount: 0,
      autoPublishCount: 0,
      masterReviewCount: 0,
      maxPhase: 1,
      latestDecision: null,
    };
  }
}

async function buildInstagramHealth() {
  try {
    const config = await getInstagramConfig();
    const host = getInstagramImageHostConfig();
    const hostReady = Boolean(host.publicBaseUrl || host.githubPagesBaseUrl || host.opsStaticBaseUrl);
    const health = config.tokenHealth || {};
    const ok = [
      `  instagram token: ${health.hasAccessToken && health.hasIgUserId ? '준비됨' : '누락'}`,
      `  token expires: ${health.tokenExpiresAt || '미설정'}`,
      `  public host: ${hostReady ? `${host.mode || 'configured'} 준비됨` : '미설정'}`,
    ];
    const warn = [];
    if (health.critical) warn.push(`  인스타 토큰 만료 임박: ${health.daysLeft}일 남음`);
    else if (health.needsRefresh) warn.push(`  인스타 토큰 갱신 권장: ${health.daysLeft}일 남음`);
    if (!hostReady) warn.push('  공개 미디어 호스팅 URL이 없어 릴스 업로드를 진행할 수 없습니다');
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      needsRefresh: Boolean(health.needsRefresh),
      critical: Boolean(health.critical),
      hostReady,
    };
  } catch (error) {
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  instagram: 확인 실패 (${error.message.slice(0, 120)})`],
      needsRefresh: false,
      critical: false,
      hostReady: false,
    };
  }
}

async function buildPhase1Health() {
  try {
    const output = execFileSync(
      'mix',
      ['blog.phase1.report', '--brief'],
      {
        cwd: TEAM_JAY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const summary = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((line) => line.startsWith('phase1=')) || output;

    return {
      okCount: 1,
      warnCount: 0,
      ok: [`  ${summary}`],
      warn: [],
      summary,
    };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  phase1 report: 확인 실패 (${reason})`],
      summary: null,
    };
  }
}


async function buildPhase2BriefingHealthFor(type) {
  try {
    const output = execFileSync(
      'node',
      [path.join(BLOG_ROOT, 'scripts/check-ai-briefing-structure.ts'), '--json', '--latest', '--type', type],
      {
        cwd: BLOG_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const jsonText = extractJsonObjectText(output);
    const payload = JSON.parse(jsonText);
    const briefingIssues = Array.isArray(payload?.briefingIssues) ? payload.briefingIssues : [];
    const qualityIssues = Array.isArray(payload?.quality?.issues) ? payload.quality.issues : [];
    const ok = [
      `  briefing file: ${payload?.file || 'unknown'}`,
      `  briefing passed: ${payload?.briefingPassed ? 'yes' : 'no'}`,
      `  faq count: ${payload?.briefing?.questionFaqCount ?? 0}`,
      `  answered faq: ${payload?.briefing?.answeredFaqCount ?? 0}`,
    ];
    const warn = [];
    if (!payload?.briefingPassed) warn.push(`  briefing issues: ${briefingIssues.join(', ') || 'unknown'}`);
    for (const issue of qualityIssues.slice(0, 3)) {
      warn.push(`  ${issue.severity}: ${issue.msg}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      type,
      briefingPassed: Boolean(payload?.briefingPassed),
      questionFaqCount: Number(payload?.briefing?.questionFaqCount || 0),
      answeredFaqCount: Number(payload?.briefing?.answeredFaqCount || 0),
      file: payload?.file || null,
    };
  } catch (error) {
    const stdout = String(error?.stdout || '').trim();
    try {
      const jsonText = extractJsonObjectText(stdout);
      const payload = JSON.parse(jsonText);
      const briefingIssues = Array.isArray(payload?.briefingIssues) ? payload.briefingIssues : [];
      const qualityIssues = Array.isArray(payload?.quality?.issues) ? payload.quality.issues : [];
      const ok = [
        `  briefing file: ${payload?.file || 'unknown'}`,
        `  briefing passed: ${payload?.briefingPassed ? 'yes' : 'no'}`,
        `  faq count: ${payload?.briefing?.questionFaqCount ?? 0}`,
        `  answered faq: ${payload?.briefing?.answeredFaqCount ?? 0}`,
      ];
      const warn = [];
      if (!payload?.briefingPassed) warn.push(`  briefing issues: ${briefingIssues.join(', ') || 'unknown'}`);
      for (const issue of qualityIssues.slice(0, 3)) {
        warn.push(`  ${issue.severity}: ${issue.msg}`);
      }
      return {
        okCount: ok.length,
        warnCount: warn.length,
        ok,
        warn,
        type,
        briefingPassed: Boolean(payload?.briefingPassed),
        questionFaqCount: Number(payload?.briefing?.questionFaqCount || 0),
        answeredFaqCount: Number(payload?.briefing?.answeredFaqCount || 0),
        file: payload?.file || null,
      };
    } catch {
      const reason = String(error?.message || error).slice(0, 160);
      return {
        okCount: 0,
        warnCount: 1,
        ok: [],
        warn: [`  phase2 briefing ${type}: 확인 실패 (${reason})`],
        type,
        briefingPassed: false,
        questionFaqCount: 0,
        answeredFaqCount: 0,
        file: null,
      };
    }
  }
}

async function buildPhase2BriefingHealth() {
  const [lecture, general] = await Promise.all([
    buildPhase2BriefingHealthFor('lecture'),
    buildPhase2BriefingHealthFor('general'),
  ]);

  const ok = [
    ...lecture.ok.map((line) => line.replace(/^  /, '  lecture: ')),
    ...general.ok.map((line) => line.replace(/^  /, '  general: ')),
  ];
  const warn = [
    ...lecture.warn.map((line) => line.replace(/^  /, '  lecture: ')),
    ...general.warn.map((line) => line.replace(/^  /, '  general: ')),
  ];

  return {
    okCount: ok.length,
    warnCount: warn.length,
    ok,
    warn,
    briefingPassed: Boolean(lecture.briefingPassed && general.briefingPassed),
    lecture,
    general,
  };
}

async function buildPhase3FeedbackHealth() {
  try {
    const output = execFileSync(
      'mix',
      ['blog.phase3.feedback', '--json'],
      {
        cwd: TEAM_JAY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const jsonText = extractJsonObjectText(output);
    const payload = JSON.parse(jsonText);
    const ok = [
      `  status: ${payload?.health?.status || 'unknown'}`,
      `  feedback count: ${payload?.feedback?.feedback_count ?? 0}`,
      `  node failures: ${payload?.execution?.failed_count ?? 0}`,
      `  social failures: ${payload?.social?.failed_count ?? 0}`,
    ];
    const warn = [];
    const recommendations = Array.isArray(payload?.recommendations) ? payload.recommendations : [];
    if (payload?.health?.status && payload.health.status !== 'ok') {
      warn.push(`  phase3 status: ${payload.health.status}`);
    }
    for (const item of recommendations.slice(0, 2)) {
      warn.push(`  reco: ${item}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      status: payload?.health?.status || 'unknown',
      feedbackCount: Number(payload?.feedback?.feedback_count || 0),
      nodeFailures: Number(payload?.execution?.failed_count || 0),
      socialFailures: Number(payload?.social?.failed_count || 0),
    };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  phase3 feedback: 확인 실패 (${reason})`],
      status: 'error',
      feedbackCount: 0,
      nodeFailures: 0,
      socialFailures: 0,
    };
  }
}

async function buildPhase4CompetitionHealth() {
  try {
    const output = execFileSync(
      'mix',
      ['blog.phase4.competition', '--json'],
      {
        cwd: TEAM_JAY_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    ).trim();
    const jsonText = extractJsonObjectText(output);
    const payload = JSON.parse(jsonText || '{}');
    const health = payload?.health || {};
    const quality = payload?.quality || {};
    const recommendations = Array.isArray(payload?.recommendations) ? payload.recommendations : [];
    const ok = [
      `  status: ${health.status || 'unknown'}`,
      `  competitions: ${health.total_count ?? 0}`,
      `  completed: ${health.completed_count ?? 0}`,
      `  timeout: ${health.timeout_count ?? 0}`,
      `  avg quality diff: ${quality.avg_quality_diff ?? 'n/a'}`,
    ];
    const warn = [];
    if (health.status === 'warn' || health.status === 'error') {
      warn.push(`  phase4 status: ${health.status}`);
    }
    if ((health.status === 'warn' || health.status === 'error') && Number(health.timeout_count || 0) > 0) {
      warn.push(`  timeout competitions: ${Number(health.timeout_count || 0)}건`);
    }
    if (recommendations[0]) {
      warn.push(`  reco: ${recommendations[0]}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      status: health.status || 'unknown',
      totalCount: Number(health.total_count || 0),
      completedCount: Number(health.completed_count || 0),
      runningCount: Number(health.running_count || 0),
      pendingCount: Number(health.pending_count || 0),
      timeoutCount: Number(health.timeout_count || 0),
      avgQualityDiff: quality.avg_quality_diff ?? null,
    };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  phase4 competition: 확인 실패 (${reason})`],
      status: 'error',
      totalCount: 0,
      completedCount: 0,
      runningCount: 0,
      pendingCount: 0,
      timeoutCount: 0,
      avgQualityDiff: null,
    };
  }
}

async function buildMarketingExpansionHealth() {
  try {
    const digest = await buildMarketingDigest();
    let strategy = digest?.strategy || null;
    if (!strategy) {
      try {
        if (fs.existsSync(BLOG_STRATEGY_PATH)) {
          const parsed = JSON.parse(fs.readFileSync(BLOG_STRATEGY_PATH, 'utf8'));
          strategy = parsed?.plan || null;
        }
      } catch {
        strategy = null;
      }
    }
    const ok = [
      `  status: ${digest?.health?.status || 'unknown'}`,
      `  reason: ${digest?.health?.reason || '없음'}`,
      `  sense signals: ${digest?.senseSummary?.signalCount ?? 0}`,
      `  revenue impact: ${((Number(digest?.revenueCorrelation?.revenueImpactPct || 0)) * 100).toFixed(1)}%`,
      `  snapshots(7d): ${digest?.snapshotTrend?.totalCount ?? 0}`,
      `  avg snapshot impact: ${((Number(digest?.snapshotTrend?.avgRevenueImpactPct || 0)) * 100).toFixed(1)}%`,
      `  autonomy decisions: ${digest?.autonomySummary?.totalCount ?? 0}`,
    ];
    if (strategy?.preferredCategory || strategy?.preferredTitlePattern) {
      ok.push(
        `  strategy: ${strategy?.preferredCategory || 'none'} / ${strategy?.preferredTitlePattern || 'none'}`,
      );
    }
    const adoption = digest?.strategyAdoption || null;
    if (adoption?.status) {
      ok.push(
        `  strategy adoption: ${adoption.status} (${Number(adoption?.preferredCategoryPatternCount || 0)}/${Number(adoption?.preferredCategoryCount || 0)})`,
      );
      ok.push(
        `  alignment coverage: ${Number(adoption?.alignmentCoverageCount || 0)}/${Number(adoption?.recentCount || 0)} (${(Number(adoption?.alignmentCoverageRatio || 0) * 100).toFixed(0)}%, measured ${Number(adoption?.metadataCoverageCount || 0)}, inferred ${Number(adoption?.inferredCoverageCount || 0)})`,
      );
      if (typeof adoption?.latestPreviewOverlap === 'number') {
        ok.push(
          `  latest title overlap: ${Number(adoption.latestPreviewOverlap || 0).toFixed(2)} (${adoption?.latestPreviewAligned ? 'preview aligned' : 'preview drift'})`,
        );
      }
    }
    const nextPreview = digest?.nextGeneralPreview || null;
    if (nextPreview?.category || nextPreview?.pattern) {
      ok.push(
        `  next preview: ${nextPreview?.category || 'none'} / ${nextPreview?.pattern || 'none'} / ${nextPreview?.predictedAdoption || 'warming_up'}`,
      );
    }
    if (nextPreview?.title) {
      ok.push(`  next title: ${nextPreview.title}`);
    }
    const hotspotCategory = strategy?.categoryPatternHotspot?.category || null;
    const hotspotPattern = strategy?.categoryPatternHotspot?.topPattern || null;
    if (hotspotCategory || hotspotPattern) {
      ok.push(
        `  pattern hotspot: ${hotspotCategory || 'none'} / ${hotspotPattern || 'none'}`,
      );
    }
    const hotspotTrendStatus = strategy?.hotspotTrend?.status || null;
    if (hotspotTrendStatus) {
      ok.push(
        `  hotspot trend: ${hotspotTrendStatus} (${Number(strategy?.hotspotTrend?.previousRatio || 0).toFixed(2)} -> ${Number(strategy?.hotspotTrend?.currentRatio || 0).toFixed(2)})`,
      );
    }
    if (digest?.channelPerformance?.latestDate) {
      ok.push(
        `  channels: ${digest?.channelPerformance?.totalChannels ?? 0}개 / watch ${digest?.channelPerformance?.watchChannels ?? 0}개`,
      );
    }
    const warn = [];
    if (digest?.senseSummary?.topSignal?.message) {
      warn.push(`  top signal: ${digest.senseSummary.topSignal.message}`);
    }
    if (digest?.channelPerformance?.primaryWatchHint) {
      warn.push(`  channel watch: ${digest.channelPerformance.primaryWatchHint}`);
    }
    if (Number(digest?.snapshotTrend?.watchCount || 0) > 0) {
      warn.push(`  snapshot watch: 최근 7일 ${Number(digest.snapshotTrend.watchCount || 0)}건`);
    }
    if (digest?.snapshotTrend?.latestWeakness) {
      warn.push(`  snapshot weakness: ${digest.snapshotTrend.latestWeakness}`);
    }
    if (digest?.diagnosis?.primaryWeakness?.message && digest.diagnosis.primaryWeakness.code !== 'stable') {
      warn.push(`  weakness: ${digest.diagnosis.primaryWeakness.message}`);
    }
    for (const item of (digest?.recommendations || []).slice(0, 2)) {
      warn.push(`  reco: ${item}`);
    }
    return {
      okCount: ok.length,
      warnCount: warn.length,
      ok,
      warn,
      status: digest?.health?.status || 'unknown',
      signalCount: Number(digest?.senseSummary?.signalCount || 0),
      revenueImpactPct: Number(digest?.revenueCorrelation?.revenueImpactPct || 0),
      snapshotCount: Number(digest?.snapshotTrend?.totalCount || 0),
      snapshotWatchCount: Number(digest?.snapshotTrend?.watchCount || 0),
      snapshotAvgRevenueImpactPct: Number(digest?.snapshotTrend?.avgRevenueImpactPct || 0),
      channelWatchCount: Number(digest?.channelPerformance?.watchChannels || 0),
      primaryChannelWatchHint: digest?.channelPerformance?.primaryWatchHint || null,
      autonomyDecisionCount: Number(digest?.autonomySummary?.totalCount || 0),
      preferredCategory: strategy?.preferredCategory || null,
      preferredTitlePattern: strategy?.preferredTitlePattern || null,
      suppressedTitlePattern: strategy?.suppressedTitlePattern || null,
      categoryPatternHotspot: strategy?.categoryPatternHotspot || null,
      hotspotTrend: strategy?.hotspotTrend || null,
      strategyAdoption: digest?.strategyAdoption || null,
      nextGeneralPreview: digest?.nextGeneralPreview || null,
    };
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    return {
      okCount: 0,
      warnCount: 1,
      ok: [],
      warn: [`  marketing digest: 확인 실패 (${reason})`],
      status: 'error',
      signalCount: 0,
      revenueImpactPct: 0,
      snapshotCount: 0,
      snapshotWatchCount: 0,
      snapshotAvgRevenueImpactPct: 0,
      channelWatchCount: 0,
      primaryChannelWatchHint: null,
      autonomyDecisionCount: 0,
      preferredCategory: null,
      preferredTitlePattern: null,
      suppressedTitlePattern: null,
      categoryPatternHotspot: null,
      hotspotTrend: null,
      strategyAdoption: null,
      nextGeneralPreview: null,
    };
  }
}

function buildDecision(serviceRows, nodeHealth, dailyRunHealth, n8nPipelineHealth, instagramHealth, phase2BriefingHealth, phase3FeedbackHealth, phase4CompetitionHealth, autonomyHealth, marketingExpansionHealth) {
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
      {
        active: instagramHealth.critical,
        level: 'high',
        reason: '인스타 토큰 만료가 임박해 릴스 업로드가 중단될 수 있습니다.',
      },
      {
        active: !instagramHealth.hostReady,
        level: 'medium',
        reason: '인스타 공개 미디어 호스팅이 준비되지 않아 릴스 업로드를 진행할 수 없습니다.',
      },
      {
        active: !phase2BriefingHealth.briefingPassed,
        level: 'medium',
        reason: '최신 포스팅의 AI Briefing 구조가 부족해 Phase 2 SEO 규칙 보강이 필요합니다.',
      },
      {
        active: phase3FeedbackHealth.status === 'warn' || phase3FeedbackHealth.status === 'error',
        level: 'medium',
        reason: 'Phase 3 피드백 신호에 실패나 경고가 있어 회고/재학습 입력을 확인할 필요가 있습니다.',
      },
      {
        active:
          phase4CompetitionHealth.status === 'warn' ||
          phase4CompetitionHealth.runningCount > 0 ||
          phase4CompetitionHealth.pendingCount > 0,
        level: 'medium',
        reason: 'Phase 4 경쟁 실험에 timeout 또는 경고가 있어 competition collector 흐름을 점검할 필요가 있습니다.',
      },
      {
        active: phase4CompetitionHealth.status === 'error',
        level: 'medium',
        reason: 'Phase 4 경쟁 실험 요약을 읽지 못해 competition 상태 확인이 필요합니다.',
      },
      {
        active: autonomyHealth.totalCount === 0,
        level: 'low',
        reason: '자율 판단 로그가 아직 쌓이지 않아 autonomy 루프는 warming-up 상태입니다.',
      },
      {
        active: marketingExpansionHealth.status === 'watch' || marketingExpansionHealth.status === 'error',
        level: 'low',
        reason: '마케팅 확장 신호에 변동이 있어 sense/correlation/diagnosis 흐름을 한 번 더 보는 편이 좋습니다.',
      },
    ],
    okReason: '블로팀 실행기와 daily run 상태가 현재는 안정 구간입니다.',
  });
}

function buildRemodelProgress(instagramHealth, phase1Health, phase2BriefingHealth, phase3FeedbackHealth, phase4CompetitionHealth, autonomyHealth) {
  const phase0Status =
    instagramHealth.hostReady && !instagramHealth.critical ? 'completed' : 'in_progress';

  const phase1Status = phase1Health.summary ? 'completed' : 'in_progress';
  const phase2Status = phase2BriefingHealth.briefingPassed ? 'completed' : 'in_progress';
  const phase3Status = phase3FeedbackHealth.feedbackCount > 0 ? 'completed' : 'in_progress';
  const phase4Status = phase4CompetitionHealth.timeoutCount === 0 && phase4CompetitionHealth.status === 'ok'
    ? 'completed'
    : 'in_progress';
  const autonomyStatus = autonomyHealth.totalCount > 0 ? 'completed' : 'in_progress';

  const ok = [
    `  phase0 instagram: ${phase0Status === 'completed' ? '운영 준비 완료' : '운영 검증 진행중'}`,
    `  phase1 pipeline: ${phase1Status === 'completed' ? '완료' : '진행중'}`,
    `  phase2 briefing: ${phase2Status === 'completed' ? '완료' : '진행중'}`,
    `  phase3 feedback: ${phase3Status === 'completed' ? '실데이터 축적 시작' : 'warming_up'}`,
    `  phase4 competition: ${phase4Status === 'completed' ? '정상화 완료' : '정리중'}`,
    `  autonomy: ${autonomyStatus === 'completed' ? '실데이터 축적 중' : 'warming_up'}`,
  ];

  const warn = [];
  if (phase3Status !== 'completed') {
    warn.push('  phase3 feedback: published 이후 후속 피드백 수집이 더 쌓여야 합니다');
  }
  if (phase0Status !== 'completed') {
    warn.push('  phase0 instagram: 실업로드 운영 검증이 아직 남아 있습니다');
  }

  return {
    okCount: ok.length,
    warnCount: warn.length,
    ok,
    warn,
    phase0: phase0Status,
    phase1: phase1Status,
    phase2: phase2Status,
    phase3: phase3Status,
    phase4: phase4Status,
    autonomy: autonomyStatus,
  };
}

function formatText(report) {
  return buildHealthReport({
    title: '📰 블로 운영 헬스 리포트',
    sections: [
      buildHealthCountSection('■ 서비스 상태', report.serviceHealth),
      buildHealthSampleSection('■ 정상 서비스 샘플', report.serviceHealth),
      buildHealthCountSection('■ 리모델링 진행 요약', report.remodelProgress, { okLimit: 6, warnLimit: 3 }),
      buildHealthCountSection('■ 실행 백엔드 상태', report.nodeHealth, { okLimit: 3 }),
      buildHealthCountSection('■ n8n pipeline 경로', report.n8nPipelineHealth, { okLimit: 2 }),
      buildHealthCountSection('■ 인스타 업로드 상태', report.instagramHealth, { okLimit: 3 }),
      buildHealthCountSection('■ Elixir Phase 1 상태', report.phase1Health, { okLimit: 1, warnLimit: 2 }),
      buildHealthCountSection('■ Phase 2 Briefing 상태', report.phase2BriefingHealth, { okLimit: 3, warnLimit: 4 }),
      buildHealthCountSection('■ Phase 3 Feedback 상태', report.phase3FeedbackHealth, { okLimit: 4, warnLimit: 3 }),
      buildHealthCountSection('■ Phase 4 Competition 상태', report.phase4CompetitionHealth, { okLimit: 5, warnLimit: 3 }),
      buildHealthCountSection('■ Autonomy 상태', report.autonomyHealth, { okLimit: 5, warnLimit: 2 }),
      buildHealthCountSection('■ Marketing 확장 상태', report.marketingExpansionHealth, { okLimit: 5, warnLimit: 4 }),
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
  const instagramHealth = await buildInstagramHealth();
  const phase1Health = await buildPhase1Health();
  const phase2BriefingHealth = await buildPhase2BriefingHealth();
  const phase3FeedbackHealth = await buildPhase3FeedbackHealth();
  const phase4CompetitionHealth = await buildPhase4CompetitionHealth();
  const autonomyHealth = await buildAutonomyHealth();
  const marketingExpansionHealth = await buildMarketingExpansionHealth();
  const bookCatalogHealth = await buildBookCatalogHealth();
  const bookReviewQueueHealth = await buildBookReviewQueueHealth();
  const decision = buildDecision(serviceRows, nodeHealth, dailyRunHealth, n8nPipelineHealth, instagramHealth, phase2BriefingHealth, phase3FeedbackHealth, phase4CompetitionHealth, autonomyHealth, marketingExpansionHealth);
  const remodelProgress = buildRemodelProgress(instagramHealth, phase1Health, phase2BriefingHealth, phase3FeedbackHealth, phase4CompetitionHealth, autonomyHealth);

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
    instagramHealth,
    phase1Health,
    phase2BriefingHealth,
    phase3FeedbackHealth,
    phase4CompetitionHealth,
    autonomyHealth,
    marketingExpansionHealth,
    remodelProgress,
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
