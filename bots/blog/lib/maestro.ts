'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * bots/blog/lib/maestro.ts — 블로그팀 컨트롤타워
 *
 * 역할:
 *   1. 오늘의 파이프라인 동적 결정 (노드 순서/구조/변형 매번 다르게)
 *   2. 최근 7일 이력 조회 → 패턴 회피
 *   3. n8n 웹훅 트리거 (실패 시 blo.js 직접 실행 폴백)
 *   4. sectionVariation 결정 → pos-writer/gems-writer에 전달
 */

const crypto = require('crypto');
const pgPool = require('../../../packages/core/lib/pg-pool');
const env = require('../../../packages/core/lib/env');
const { buildWebhookCandidates } = require('../../../packages/core/lib/n8n-webhook-registry');
const { getBlogGenerationRuntimeConfig, getBlogCompetitionRuntimeConfig } = require('./runtime-config.ts');
const { generateGemmaPilotText } = require('../../../packages/core/lib/gemma-pilot');
const { buildDynamicVariation } = require('./section-variation.ts');
const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

const RESEARCH_NODES = ['weather', 'it-news', 'nodejs-updates'];
const generationRuntimeConfig = getBlogGenerationRuntimeConfig();
const competitionRuntimeConfig = getBlogCompetitionRuntimeConfig();
const N8N_PIPELINE_ENABLED = generationRuntimeConfig.useN8nPipeline === true;
const N8N_WEBHOOK_TIMEOUT_MS = Number(process.env.N8N_BLOG_TIMEOUT_MS || generationRuntimeConfig.maestroWebhookTimeoutMs || 180000);
const N8N_HEALTH_TIMEOUT_MS = Number(process.env.N8N_BLOG_HEALTH_TIMEOUT_MS || generationRuntimeConfig.maestroHealthTimeoutMs || 2500);
const N8N_CIRCUIT_COOLDOWN_MS = Number(generationRuntimeConfig.maestroCircuitCooldownMs || (30 * 60 * 1000));
const COMPETITION_ENABLED = competitionRuntimeConfig.enabled === true;
const COMPETITION_DAYS = Array.isArray(competitionRuntimeConfig.days) && competitionRuntimeConfig.days.length
  ? competitionRuntimeConfig.days
  : [1, 3, 5];

const _n8nCircuit = {
  disabledUntil: 0,
  reason: '',
};

let _competitionEngine = null;
function _getCompetitionEngine() {
  if (_competitionEngine) return _competitionEngine;
  try {
    _competitionEngine = require('../../../packages/core/lib/competition-engine.ts');
  } catch (error) {
    _competitionEngine = { __loadError: error };
  }
  return _competitionEngine;
}

function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function _ensureHistoryTable() {
  if (DEV_HUB_READONLY) return;
  try {
    await pgPool.run('blog', `
      CREATE TABLE IF NOT EXISTS blog.execution_history (
        id          SERIAL PRIMARY KEY,
        run_date    DATE        NOT NULL,
        post_type   TEXT        NOT NULL,
        pipeline    JSONB       DEFAULT '[]',
        variations  JSONB       DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pgPool.run('blog', `
      CREATE INDEX IF NOT EXISTS idx_beh_date_type
        ON blog.execution_history(run_date DESC, post_type)
    `);
  } catch (e) {
    console.warn('[마에스트로] execution_history 테이블 확인 실패 (무시):', e.message);
  }
}

async function getRecentHistory(postType, days = 7) {
  try {
    const rows = await pgPool.query('blog', `
      SELECT run_date, pipeline, variations
        FROM blog.execution_history
       WHERE post_type  = $1
         AND run_date  >= CURRENT_DATE - INTERVAL '${days} days'
       ORDER BY run_date DESC
    `, [postType]);
    return rows || [];
  } catch {
    return [];
  }
}

async function saveExecutionHistory(date, postType, pipeline, variations) {
  if (DEV_HUB_READONLY) return;
  try {
    await pgPool.run('blog', `
      INSERT INTO blog.execution_history (run_date, post_type, pipeline, variations)
      VALUES ($1, $2, $3, $4)
    `, [date, postType, JSON.stringify(pipeline), JSON.stringify(variations)]);
  } catch (e) {
    console.warn('[마에스트로] 이력 저장 실패 (무시):', e.message);
  }
}

function buildDynamicPipeline(postType, history) {
  const nodes = [...RESEARCH_NODES, 'rag-experiences', 'related-posts'];

  const writeNode = postType === 'lecture' ? 'write-lecture' : 'write-general';
  nodes.push(writeNode, 'quality-check');

  const variations = buildDynamicVariation(postType, history);

  return { pipeline: nodes, variations };
}

function _buildMarketingContext(payload = {}) {
  const senseState = payload?.daily?.senseState || payload?.senseState || null;
  const revenueCorrelation = payload?.daily?.revenueCorrelation || payload?.revenueCorrelation || null;
  const signals = Array.isArray(senseState?.signals) ? senseState.signals.map((signal) => String(signal?.type || '')).filter(Boolean) : [];
  const notes = [];
  let ctaMode = 'soft';

  if (signals.includes('revenue_anomaly') || signals.includes('revenue_decline') || Number(revenueCorrelation?.revenueImpactPct || 0) < 0) {
    notes.push('매출 하락/이상 신호가 있어 전환형 CTA를 자연스럽게 강화');
    ctaMode = 'conversion';
  }
  if (signals.includes('exam_period') || Number(senseState?.skaEnvironment?.exam_score || 0) > 0) {
    notes.push('시험기간 신호가 있어 학습 효율/몰입 환경 내용을 본문에 포함');
  }
  if (signals.includes('holiday') || !!senseState?.skaEnvironment?.holiday_flag) {
    notes.push('공휴일 맥락이 있어 가볍고 빠르게 읽히는 구성 선호');
  }

  return {
    signalTypes: signals,
    notes,
    ctaMode,
  };
}

async function _getDefaultWebhookCandidates() {
  const configured = process.env.N8N_BLOG_WEBHOOK;
  return buildWebhookCandidates({
    workflowName: '블로그팀 동적 포스팅',
    method: 'POST',
    pathSuffix: 'blog-pipeline',
    configured: configured ? [configured] : [],
    defaults: [
      'http://localhost:5678/webhook/blog-pipeline',
      'http://localhost:5678/webhook-test/blog-pipeline',
    ],
  });
}

async function _probeN8nHealth() {
  try {
    const res = await fetch('http://localhost:5678/healthz', {
      method: 'GET',
      signal: AbortSignal.timeout(N8N_HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function _isCircuitOpen() {
  return _n8nCircuit.disabledUntil > Date.now();
}

function _openCircuit(reason) {
  _n8nCircuit.disabledUntil = Date.now() + N8N_CIRCUIT_COOLDOWN_MS;
  _n8nCircuit.reason = reason;
}

function _resetCircuit() {
  _n8nCircuit.disabledUntil = 0;
  _n8nCircuit.reason = '';
}

function _shouldRunCompetition() {
  if (!COMPETITION_ENABLED) return false;
  return COMPETITION_DAYS.includes(new Date().getDay());
}

function _logMaestroSession(postType, sessionId, pipeline, variations, gemmaRecommendation) {
  console.log(`[마에스트로] ${postType} — 세션: ${sessionId}`);
  console.log(`  노드: ${pipeline.join(' → ')}`);
  console.log(`  인사말: ${variations.greetingStyle}, 이미지: ${variations.imageCount}장`);
  if (gemmaRecommendation) console.log(`  gemma4 추천 반영 후보:\n${gemmaRecommendation}`);
}

function _buildMaestroPayload(postType, sessionId, pipeline, variations, gemmaRecommendation, payload) {
  return JSON.stringify({ postType, sessionId, pipeline, variations, gemmaRecommendation, ...payload });
}

function _buildMaestroResult(sessionId, pipeline, variations, gemmaRecommendation, n8nTriggered) {
  return { sessionId, pipeline, variations, gemmaRecommendation, n8nTriggered };
}

async function runCompetition(topic, postType) {
  if (!_shouldRunCompetition()) return null;

  console.log(`[경쟁] 그룹 경쟁 시작: ${topic} (${postType})`);
  try {
    const competitionEngine = _getCompetitionEngine();
    if (competitionEngine?.__loadError || !competitionEngine?.startCompetition) {
      throw competitionEngine?.__loadError || new Error('competition-engine unavailable');
    }
    const competition = await competitionEngine.startCompetition(topic, 'blog');
    console.log(`[경쟁] 그룹 A: ${competition.groupA.join(',')} / B: ${competition.groupB.join(',')}`);
    return competition;
  } catch (error) {
    console.error('[경쟁] 시작 실패:', error.message);
    return null;
  }
}

function _buildTopicRecommendationPrompt(postType, historyTopics, weatherContext) {
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const today = dayNames[new Date().getDay()];

  return `당신은 네이버 블로그 주제 추천 전문가입니다.
오늘은 ${today}요일입니다.
포스팅 유형: ${postType}
최근 주제: ${historyTopics.join(', ') || '없음'}
날씨/상황: ${weatherContext}

겹치지 않는 새로운 추천 주제 3개를 한국어로 간결하게 작성하세요.
번호 없이 한 줄씩만 작성하세요.`;
}

async function _generateTopicRecommendation(postType, history, payload) {
  const historyTopics = history
    .map((entry) => entry?.variations?.selectedTopic || entry?.variations?.seedTopic || entry?.variations?.theme)
    .filter(Boolean)
    .slice(0, 10);
  const weatherContext = payload?.weather?.summary || payload?.weatherContext || '날씨 정보 없음';
  const prompt = _buildTopicRecommendationPrompt(postType, historyTopics, weatherContext);

  const recResult = await generateGemmaPilotText({
    team: 'blog',
    purpose: 'gemma-topic',
    bot: 'maestro',
    requestType: 'topic-recommendation',
    prompt,
    maxTokens: 200,
    temperature: 0.8,
    timeoutMs: 10000,
  });

  if (!recResult?.ok || !recResult.content) return null;
  return recResult.content.trim();
}

async function _triggerN8nPipeline(body, dryRun) {
  if (!N8N_PIPELINE_ENABLED) {
    console.log('  ↳ n8n 파이프라인 비활성화 — 로컬 생성 경로 사용');
    return false;
  }

  if (dryRun) {
    console.log('  ↳ dry-run: n8n 웹훅 트리거 생략');
    return false;
  }

  if (_isCircuitOpen()) {
    console.log(`  ↳ n8n 우회 중 (${_n8nCircuit.reason})`);
    return false;
  }

  if (!(await _probeN8nHealth())) {
    _openCircuit('health_unreachable');
    console.warn('  ⚠️ n8n 헬스체크 실패 — 직접 실행 폴백');
    return false;
  }

  for (const n8nUrl of await _getDefaultWebhookCandidates()) {
    try {
      const res = await fetch(n8nUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(N8N_WEBHOOK_TIMEOUT_MS),
      });

      if (res.ok) {
        _resetCircuit();
        console.log(`  ↳ n8n 트리거 성공 (${n8nUrl})`);
        return true;
      }

      if (res.status === 404) {
        console.warn(`  ⚠️ n8n 웹훅 없음 (${n8nUrl}) — 다음 후보 확인`);
        continue;
      }

      console.warn(`  ⚠️ n8n 응답 오류 (${res.status}, ${n8nUrl}) — 직접 실행 폴백`);
      _openCircuit(`http_${res.status}`);
      return false;
    } catch (e) {
      console.warn(`  ⚠️ n8n 트리거 실패 (${e.message}, ${n8nUrl})`);
    }
  }

  if (!_isCircuitOpen()) {
    _openCircuit('webhook_unavailable');
    console.warn('  ⚠️ n8n 유효 웹훅 미확인 — 직접 실행 폴백');
  }

  return false;
}

async function run(postType, directRunner = null, payload = {}) {
  await _ensureHistoryTable();

  const sessionId = `${kst.today()}_${postType}_${crypto.randomBytes(4).toString('hex')}`;
  const history = await getRecentHistory(postType, 7);
  let gemmaRecommendation = null;

  try {
    gemmaRecommendation = await _generateTopicRecommendation(postType, history, payload);
    if (gemmaRecommendation) console.log(`[마에스트로] gemma4 주제 추천:\n${gemmaRecommendation}`);
  } catch (error) {
    console.warn(`[maestro] gemma4 추천 생략: ${error.message}`);
  }

  const { pipeline, variations } = buildDynamicPipeline(postType, history);
  variations.marketingContext = _buildMarketingContext(payload);
  _logMaestroSession(postType, sessionId, pipeline, variations, gemmaRecommendation);

  const body = _buildMaestroPayload(postType, sessionId, pipeline, variations, gemmaRecommendation, payload);
  const dryRun = !!payload?.dryRun;
  const n8nOk = await _triggerN8nPipeline(body, dryRun);

  if (!dryRun) {
    await saveExecutionHistory(
      kst.today(),
      postType,
      pipeline,
      variations
    );
  } else {
    console.log('  ↳ dry-run: execution_history 저장 생략');
  }

  if ((!N8N_PIPELINE_ENABLED || !n8nOk) && directRunner) {
    console.log('  ↳ directRunner 실행');
    return await directRunner(variations, { ...payload, gemmaRecommendation });
  }

  return _buildMaestroResult(sessionId, pipeline, variations, gemmaRecommendation, n8nOk);
}

module.exports = { run, runCompetition, buildDynamicPipeline, buildDynamicVariation };
