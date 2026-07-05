#!/usr/bin/env tsx
// @ts-nocheck
'use strict';

/**
 * Blog V3 shadow evidence runner.
 *
 * This performs read-only/deterministic checks and optionally persists shadow-only
 * evidence for the promotion gate. It never publishes posts or changes external
 * accounts. Default mode is dry-run; pass --persist to record DB evidence.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');
const env = require('../../../packages/core/lib/env');

const ROOT = env.PROJECT_ROOT;
const BLOG_DIR = path.join(ROOT, 'bots/blog');
const OUT_PATH = path.join(BLOG_DIR, 'output/blog-v3-shadow-evidence-latest.json');

const {
  buildNaverTrendTopics,
  buildTrendTopicFusionClusters,
  evaluateBlogV3PromotionGate,
  recordShadowEvidence,
} = require(path.join(BLOG_DIR, 'lib/blog-v3-unified.ts'));
const { buildItTrendTopics, runItTrendsCollector } = require(path.join(BLOG_DIR, 'lib/it-trends-collector.ts'));
const { detectAiSignals, recordHumanizeAudit } = require(path.join(BLOG_DIR, 'lib/humanize-agent.ts'));
const { generateHomeFeedReport, recordHomeFeedAudit } = require(path.join(BLOG_DIR, 'lib/naver-home-feed-optimizer.ts'));

function read(rel) {
  return fs.readFileSync(path.join(BLOG_DIR, rel), 'utf8');
}

function rgFiles(dir) {
  const out = execSync(`find ${JSON.stringify(dir)} -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.py' \\)`, { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function auditHubLlmRoutes() {
  const files = rgFiles(BLOG_DIR).filter((file) => {
    if (file.includes('/__tests__/')) return false;
    if (file.includes('/output/')) return false;
    if (file.endsWith('/scripts/check-blog-v3-unified.ts')) return false;
    if (file.endsWith('/scripts/runtime-blog-v3-shadow-evidence.ts')) return false;
    return /\.(ts|js|py)$/.test(file);
  });
  const directLocal = [];
  const directProvider = [];
  for (const file of files) {
    const rel = path.relative(BLOG_DIR, file);
    const src = fs.readFileSync(file, 'utf8');
    if (rel !== 'lib/blog-llm-gateway.ts' && /local-llm-client|callLocalLlm|callLocalFast/.test(src)) {
      directLocal.push(rel);
    }
    if (/require\(['"]openai['"]\)|from ['"]openai['"]|@anthropic-ai|google-generative-ai/.test(src)) {
      directProvider.push(rel);
    }
  }
  return {
    ok: directLocal.length === 0 && directProvider.length === 0,
    directLocal,
    directProvider,
  };
}

async function persistEvidence(type, evidence, persist) {
  const result = await recordShadowEvidence(type, evidence, { dryRun: !persist });
  return {
    type,
    ok: evidence?.ok !== false,
    persisted: persist && result?.inserted > 0,
    dryRun: !persist,
    inserted: result?.inserted || 0,
  };
}

async function main() {
  const persist = process.argv.includes('--persist') || process.argv.includes('--write');
  const json = process.argv.includes('--json');
  const evidence = [];

  const itTrends = await runItTrendsCollector({ fixture: true, dryRun: true });
  assert.equal(itTrends.ok, true, 'IT trend fixture should be ok');
  const itTopics = itTrends.topics || buildItTrendTopics(itTrends.items || []);

  const semanticRows = [
    { source: 'hn', topic_ko: 'AI 도구 자동화 흐름에서 지금 확인할 실행 기준', trend_score: 84, korea_relevance: 78 },
    { source: 'naver_it', topic_ko: 'AI 개발 자동화 도구 선택 기준', trend_score: 80, korea_relevance: 90 },
    { source: 'bestseller', topic_ko: '자동화 시대에 다시 읽는 실무 생산성', category: '자기계발', trend_score: 70, korea_relevance: 85, is_book_topic: true },
  ];
  const topicRows = [
    ...itTopics,
    ...buildNaverTrendTopics().map((topic) => ({ ...topic, source: 'naver_it' })),
    ...semanticRows,
  ];
  const clusters = buildTrendTopicFusionClusters(topicRows);
  const topCluster = clusters[0] || null;
  const multiSourceCluster = clusters.find((cluster) => cluster.sourceCount >= 2 && cluster.fusion.score >= 70);
  const topicFusion = {
    ok: !!multiSourceCluster,
    source: 'runtime-blog-v3-shadow-evidence',
    itFixtureTopics: itTopics.length,
    naverFixtureTopics: buildNaverTrendTopics().length,
    clusterCount: clusters.length,
    topCluster: topCluster ? {
      sourceCount: topCluster.sourceCount,
      sources: topCluster.sources,
      fusionScore: topCluster.fusion.score,
      titles: topCluster.titles,
    } : null,
    multiSourceCluster: multiSourceCluster ? {
      sourceCount: multiSourceCluster.sourceCount,
      sources: multiSourceCluster.sources,
      fusionScore: multiSourceCluster.fusion.score,
      titles: multiSourceCluster.titles,
    } : null,
  };
  evidence.push(await persistEvidence('topic_fusion', topicFusion, persist));

  const routeAudit = auditHubLlmRoutes();
  evidence.push(await persistEvidence('hub_llm_route_audit', routeAudit, persist));

  const humanizeText = '지난주 화요일에 팀 작업 5건을 자동화 도구로 옮겨봤습니다. 빠른 도구가 항상 좋은 건 아니었습니다. 저는 15분 안에 동료가 이해할 수 있는 로그가 남는지, 실패했을 때 버튼 하나로 되돌릴 수 있는지를 먼저 봅니다. 이 두 가지가 맞으면 도입 속도는 자연스럽게 따라옵니다. 실제로 체크리스트를 바꾼 뒤 재작업 시간이 40분에서 12분으로 줄었습니다.';
  const humanize = detectAiSignals(humanizeText);
  await recordHumanizeAudit({
    title: 'Blog V3 shadow humanize sample',
    result: humanize,
    dryRun: !persist,
    shadowOnly: true,
  });
  evidence.push(await persistEvidence('humanize_audit', {
    ok: humanize.humanizeScore >= 90,
    humanizeScore: humanize.humanizeScore,
    sentenceScore: humanize.sentenceNaturalness?.score || 0,
    signalCount: humanize.signalCount,
  }, persist));

  const exposure = await generateHomeFeedReport({
    title: 'AI 자동화 도구 선택 기준 3가지',
    category: '최신IT트렌드',
    content: `${humanizeText}\n\n#AI자동화 #업무자동화 #생산성`.repeat(8),
    hasImages: false,
  });
  await recordHomeFeedAudit({
    title: 'Blog V3 shadow exposure sample',
    category: '최신IT트렌드',
    report: exposure,
    dryRun: !persist,
    shadowOnly: true,
  });
  evidence.push(await persistEvidence('exposure_audit', {
    ok: exposure.channels.length === 8 && Number.isFinite(exposure.overallScore),
    overallScore: exposure.overallScore,
    channels: exposure.channels.length,
    topActions: exposure.topActions,
  }, persist));

  const mcpModule = await import(pathToFileURL(path.join(BLOG_DIR, 'mcp/blog-naver-mcp/src/server.ts')).href);
  const mcpSeo = await mcpModule.callBlogNaverTool('naver_seo_score', {
    title: 'AI 자동화 도구 선택 기준 3가지',
    category: '최신IT트렌드',
    content: humanizeText.repeat(6),
  });
  const mcpExposure = await mcpModule.callBlogNaverTool('naver_exposure_audit', {
    title: 'AI 자동화 도구 선택 기준 3가지',
    category: '최신IT트렌드',
    content: humanizeText.repeat(6),
  });
  evidence.push(await persistEvidence('mcp_readonly_audit', {
    ok: mcpSeo.ok === true && mcpSeo.readOnly === true && mcpExposure.ok === true && mcpExposure.readOnly === true,
    tools: mcpModule.BLOG_NAVER_MCP_TOOLS.map((tool) => tool.name),
    exposureChannels: mcpExposure.result?.channels?.length || 0,
  }, persist));

  const dryRunGuard = {
    ok: read('scripts/run-daily.ts').includes('--dry-run')
      && read('lib/topic-selector.ts').includes('if (!dryRun)')
      && read('lib/crank-score-tracker.ts').includes('if (!dryRun)'),
    runDailyDryRunFlag: read('scripts/run-daily.ts').includes('--dry-run'),
    trendSelectionDryRunGuard: read('lib/topic-selector.ts').includes('if (!dryRun)'),
    crankDryRunGuard: read('lib/crank-score-tracker.ts').includes('if (!dryRun)'),
  };
  evidence.push(await persistEvidence('dry_run_guard', dryRunGuard, persist));

  const allOk = evidence.every((item) => item.ok);
  const gate = await evaluateBlogV3PromotionGate();
  const report = {
    ok: allOk,
    shadowMode: true,
    dryRun: !persist,
    persisted: persist,
    evidence,
    gate,
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);

  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`[blog-v3-shadow-evidence] ok=${report.ok} persisted=${report.persisted}`);
    console.log(`[blog-v3-shadow-evidence] promotionReady=${gate.promotionReady}`);
    console.log(`report=${OUT_PATH}`);
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  const result = { ok: false, error: error?.message || String(error), generatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  } catch {}
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else console.error('[blog-v3-shadow-evidence] failed:', result.error);
  process.exit(1);
});
