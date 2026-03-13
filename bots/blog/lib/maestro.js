'use strict';
const kst = require('../../../packages/core/lib/kst');

/**
 * bots/blog/lib/maestro.js — 블로그팀 컨트롤타워
 *
 * 역할:
 *   1. 오늘의 파이프라인 동적 결정 (노드 순서/구조/변형 매번 다르게)
 *   2. 최근 7일 이력 조회 → 패턴 회피
 *   3. n8n 웹훅 트리거 (실패 시 blo.js 직접 실행 폴백)
 *   4. sectionVariation 결정 → pos-writer/gems-writer에 전달
 */

const crypto = require('crypto');
const pgPool = require('../../../packages/core/lib/pg-pool');

// ─── 상수 ─────────────────────────────────────────────────────────────

// 인사말 스타일 선택지
const GREETING_STYLES  = ['formal', 'casual', 'question', 'story'];

// 카페 위치 선택지
const CAFE_POSITIONS   = ['after_theory', 'after_code', 'before_faq', 'last'];

// 리스트 스타일 선택지
const LIST_STYLES      = ['number', 'bullet', 'mixed'];

// 브릿지 간격 선택지 (자)
const BRIDGE_INTERVALS = [800, 1000, 1200, 1500];

// 수집 노드 목록 (셔플 대상)
const RESEARCH_NODES = ['weather', 'it-news', 'nodejs-updates'];
const N8N_WEBHOOK_TIMEOUT_MS = Number(process.env.N8N_BLOG_TIMEOUT_MS || 180000);

// ─── 랜덤 헬퍼 ────────────────────────────────────────────────────────

/** 정수 범위 [min, max] 내 랜덤값 */
function _randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** 배열에서 랜덤 원소 1개 선택 */
function _pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 배열 셔플 (Fisher-Yates) */
function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── 스키마 초기화 ────────────────────────────────────────────────────

async function _ensureHistoryTable() {
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
    // 스키마 미초기화 시 무시 — 빈 이력으로 폴백
    console.warn('[마에스트로] execution_history 테이블 확인 실패 (무시):', e.message);
  }
}

// ─── 이력 조회/저장 ───────────────────────────────────────────────────

/**
 * 최근 N일 이력 조회.
 * 테이블 없거나 조회 실패 시 빈 배열 반환.
 *
 * @param {'lecture'|'general'} postType
 * @param {number} days
 * @returns {Promise<Array>}
 */
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

/**
 * 실행 이력 저장.
 * 저장 실패 시 경고만 출력하고 계속 진행.
 *
 * @param {string} date       - 'YYYY-MM-DD'
 * @param {string} postType
 * @param {string[]} pipeline
 * @param {object} variations
 */
async function saveExecutionHistory(date, postType, pipeline, variations) {
  try {
    await pgPool.run('blog', `
      INSERT INTO blog.execution_history (run_date, post_type, pipeline, variations)
      VALUES ($1, $2, $3, $4)
    `, [date, postType, JSON.stringify(pipeline), JSON.stringify(variations)]);
  } catch (e) {
    console.warn('[마에스트로] 이력 저장 실패 (무시):', e.message);
  }
}

// ─── 변형 빌더 ────────────────────────────────────────────────────────

/**
 * 오늘의 섹션 변형(sectionVariation)을 동적으로 결정.
 * 최근 7일 이력의 greetingStyle과 cafePosition을 회피하여 다양성 확보.
 *
 * @param {'lecture'|'general'} postType
 * @param {Array} history - getRecentHistory() 결과
 * @returns {object} sectionVariation
 */
function buildDynamicVariation(postType, history) {
  const { selectBonusInsights } = require('./bonus-insights');

  // 최근 이력에서 사용된 스타일 추출
  const usedGreetings  = new Set(history.map(h => h.variations?.greetingStyle).filter(Boolean));
  const usedCafePos    = new Set(history.map(h => h.variations?.cafePosition).filter(Boolean));

  // 패턴 회피: 최근 사용되지 않은 스타일 선택
  const availableGreetings = GREETING_STYLES.filter(s => !usedGreetings.has(s));
  const greetingStyle      = availableGreetings.length > 0
    ? _pick(availableGreetings)
    : _pick(GREETING_STYLES); // 모두 사용됐으면 전체 중 랜덤

  const availableCafePos = CAFE_POSITIONS.filter(p => !usedCafePos.has(p));
  const cafePosition     = availableCafePos.length > 0
    ? _pick(availableCafePos)
    : _pick(CAFE_POSITIONS);

  // 보너스 인사이트 선택 (0~2개, 최근 이력 중복 회피)
  const botType        = postType === 'lecture' ? 'pos' : 'gems';
  const recentBonusIds = history.flatMap(h => (h.variations?.bonusInsights || []).map(b => b.id));
  const bonusInsights  = selectBonusInsights(botType, recentBonusIds);

  const variation = {
    greetingStyle,
    faqCount:       _randInt(3, 6),
    listStyle:      _pick(LIST_STYLES),
    bridgeInterval: _pick(BRIDGE_INTERVALS),
    includeInsta:   Math.random() < 0.4,  // 40% 확률
    imageCount:     _randInt(0, 5),
    cafePosition,
    bonusInsights,                         // ★ 0~2개 보너스 인사이트
    totalInsights:  4 + bonusInsights.length,  // ★ 4~6개
  };

  if (postType === 'lecture') {
    // 강의 전용 변형
    variation.insightCount   = _randInt(2, 5);
    variation.codeBlockCount = _randInt(2, 5);
  } else {
    // 일반 전용 변형
    variation.bodyCount = _randInt(2, 4);
  }

  return variation;
}

// ─── 파이프라인 빌더 ──────────────────────────────────────────────────

/**
 * 오늘의 파이프라인 구성.
 * 현재 운영 경로(n8n/direct fallback)는 아래 고정 노드 집합을 공통으로 사용한다.
 * 변형은 노드 조합이 아니라 variations에서만 준다.
 *
 * @param {'lecture'|'general'} postType
 * @param {Array} history
 * @returns {{ pipeline: string[], variations: object }}
 */
function buildDynamicPipeline(postType, history) {
  // 아직 n8n 워크플로우가 노드별 조건 분기를 해석하지 않으므로
  // 실행 메타와 실제 수행 노드를 일치시키기 위해 고정 집합을 사용한다.
  const nodes = [...RESEARCH_NODES, 'rag-experiences', 'related-posts'];

  // 글 생성 노드
  const writeNode = postType === 'lecture' ? 'write-lecture' : 'write-general';
  nodes.push(writeNode, 'quality-check');

  const variations = buildDynamicVariation(postType, history);

  return { pipeline: nodes, variations };
}

// ─── 메인 ─────────────────────────────────────────────────────────────

/**
 * 마에스트로 메인 실행.
 * n8n 웹훅 트리거 → 실패 시 directRunner 폴백.
 *
 * @param {'lecture'|'general'} postType
 * @param {Function|null} directRunner - n8n 실패 시 직접 실행할 함수 (variations, payload) => result
 * @param {object} payload - n8n 웹훅에 함께 전달할 실행 컨텍스트
 * @returns {Promise<object>}
 */
async function run(postType, directRunner = null, payload = {}) {
  await _ensureHistoryTable();

  // 세션 ID: 날짜_타입_4바이트난수
  const sessionId = `${kst.today()}_${postType}_${crypto.randomBytes(4).toString('hex')}`;
  const history   = await getRecentHistory(postType, 7);
  const { pipeline, variations } = buildDynamicPipeline(postType, history);

  console.log(`[마에스트로] ${postType} — 세션: ${sessionId}`);
  console.log(`  노드: ${pipeline.join(' → ')}`);
  console.log(`  인사말: ${variations.greetingStyle}, 이미지: ${variations.imageCount}장`);

  // n8n 웹훅 트리거 시도
  const n8nUrl = process.env.N8N_BLOG_WEBHOOK || 'http://localhost:5678/webhook/blog-pipeline';
  let n8nOk = false;

  try {
    const res = await fetch(n8nUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ postType, sessionId, pipeline, variations, ...payload }),
      signal:  AbortSignal.timeout(N8N_WEBHOOK_TIMEOUT_MS),
    });
    n8nOk = res.ok;
    if (n8nOk) {
      console.log('  ↳ n8n 트리거 성공');
    } else {
      console.warn(`  ⚠️ n8n 응답 오류 (${res.status}) — 직접 실행 폴백`);
    }
  } catch (e) {
    console.warn(`  ⚠️ n8n 트리거 실패 (${e.message}) — 직접 실행 폴백`);
  }

  // 이력 저장 (실패 무시)
  await saveExecutionHistory(
    kst.today(),
    postType,
    pipeline,
    variations
  );

  // n8n 실패 시 directRunner 폴백
  if (!n8nOk && directRunner) {
    console.log('  ↳ directRunner 실행');
    return await directRunner(variations, payload);
  }

  return { sessionId, pipeline, variations, n8nTriggered: n8nOk };
}

module.exports = { run, buildDynamicPipeline, buildDynamicVariation };
