#!/usr/bin/env tsx
// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const env = require('../../../packages/core/lib/env');

const ROOT = env.PROJECT_ROOT;
const BLOG_DIR = path.join(ROOT, 'bots/blog');

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

async function main() {
  const json = process.argv.includes('--json');
  const {
    buildTrendTopicFusionClusters,
    calculateTrendFusionScore,
    buildNaverTrendTopics,
    topicSimilarity,
  } = require('../lib/blog-v3-unified.ts');
  const { generateHomeFeedReport } = require('../lib/naver-home-feed-optimizer.ts');
  const { detectAiSignals, scoreSentenceNaturalness } = require('../lib/humanize-agent.ts');

  const redditOut = execFileSync('python3', [
    path.join(BLOG_DIR, 'python/reddit_trend_analyzer.py'),
    '--fixture',
    '--dry-run',
    '--json',
    '--max-llm-calls=0',
  ], { encoding: 'utf8' });
  const reddit = JSON.parse(redditOut);
  assert.equal(reddit.ok, true, 'reddit fixture should be ok');
  assert.ok((reddit.topics || []).length >= 1, 'reddit fixture should return topics');

  const fusion = calculateTrendFusionScore({
    source: 'naver',
    trend_score: 82,
    korea_relevance: 90,
    meta: { source_count: 3, sources: ['naver', 'reddit', 'bestseller'] },
    date: new Date().toISOString(),
  });
  assert.ok(fusion.score >= 70, 'fusion score should prioritize Naver+multi-source');
  assert.ok(buildNaverTrendTopics().length >= 1, 'naver fixture topics should exist');
  assert.ok(
    topicSimilarity('AI 도구 자동화 흐름에서 지금 확인할 실행 기준', 'AI 개발 자동화 도구 선택 기준') >= 0.34,
    'semantic topic similarity should cluster related V3 sources',
  );
  const semanticClusters = buildTrendTopicFusionClusters([
    { source: 'reddit', topic_ko: 'AI 도구 자동화 흐름에서 지금 확인할 실행 기준', trend_score: 84, korea_relevance: 78 },
    { source: 'naver', topic_ko: 'AI 개발 자동화 도구 선택 기준', trend_score: 80, korea_relevance: 90 },
  ]);
  assert.ok(
    semanticClusters.some((cluster) => cluster.sourceCount >= 2 && cluster.sources.includes('reddit') && cluster.sources.includes('naver')),
    'V3 fusion should merge semantically related Reddit/Naver rows',
  );

  const sampleText = '제가 직접 써보니 생각보다 기준이 중요했습니다. 오늘 오전 30분 동안 확인한 내용만 정리합니다. 어떻게 적용하면 좋을까요?';
  const homeFeed = await generateHomeFeedReport({
    title: 'AI 도구 자동화 흐름에서 확인할 기준 3가지',
    content: sampleText.repeat(20),
    category: '최신IT트렌드',
    hasImages: false,
  });
  assert.ok(homeFeed.channels.length === 8, 'home-feed audit should include 8 channels');
  assert.ok(Number.isFinite(homeFeed.overallScore), 'home-feed score should be numeric');

  const humanize = detectAiSignals(sampleText);
  const sentence = scoreSentenceNaturalness(sampleText);
  assert.ok(Number.isFinite(humanize.humanizeScore), 'humanize score should be numeric');
  assert.ok(Number.isFinite(sentence.score), 'sentence naturalness score should be numeric');

  const crankScript = read('scripts/run-crank-tracker.ts');
  const crankLib = read('lib/crank-score-tracker.ts');
  assert.ok(crankScript.includes('runCrankTracker(14, { dryRun })'), 'crank dry-run must be passed to library');
  assert.ok(crankLib.includes('if (!dryRun)') && crankLib.includes('upsertCrankScore'), 'crank dry-run must gate DB writes');

  const card = JSON.parse(read('a2a/blog-card.json'));
  assert.ok(card.skills.some((skill) => skill.id === 'blog-v3-audit'), 'A2A blog-v3-audit skill should be advertised');

  const routeAudit = auditHubLlmRoutes();
  assert.equal(routeAudit.ok, true, `Blog direct LLM routes remain: ${JSON.stringify(routeAudit)}`);

  const config = JSON.parse(read('config.json'));
  const registry = config.runtime_config?.blogV3AgentRegistry || config.blogV3AgentRegistry || config.blog?.blogV3AgentRegistry;
  assert.equal(registry?.hubGatewayRequired, true, 'Blog V3 registry must require Hub Gateway');
  assert.deepEqual(registry?.nonLlmAgents, ['publ', 'maestro'], 'publ/maestro must be non-LLM');

  const result = {
    ok: true,
    shadowMode: true,
    checks: {
      redditFixtureTopics: reddit.topics.length,
      fusionScore: fusion.score,
      semanticFusionClusters: semanticClusters.length,
      homeFeedChannels: homeFeed.channels.length,
      humanizeScore: humanize.humanizeScore,
      routeAudit,
    },
  };
  if (json) console.log(JSON.stringify(result));
  else console.log('[blog-v3-unified] ok', result.checks);
}

main().catch((error) => {
  const result = { ok: false, error: error?.message || String(error) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else console.error('[blog-v3-unified] failed:', result.error);
  process.exit(1);
});
