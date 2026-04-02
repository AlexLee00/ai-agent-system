'use strict';
const kst = require('./kst');

/**
 * packages/core/lib/llm-cache.js — 시맨틱 캐시 (PostgreSQL 구현)
 *
 * 동일/유사 요청에 대해 이전 응답 재사용으로 LLM 비용 절감.
 * 벡터 DB 없이 키워드 해시 기반 경량 구현.
 * 벡터 시맨틱 검색이 필요하면 packages/core/lib/rag.js (pgvector) 사용.
 *
 * 캐시 키 생성:
 *   입력에서 핵심 키워드 추출 → 정렬 → SHA256(team:requestType:keywords)
 *
 * TTL (팀별 차등):
 *   ska:    30분  (예약 상황 빠르게 변함)
 *   claude: 360분 (시스템 상태 느리게 변함)
 *   luna:   5분   (시장 상황 매우 빠르게 변함)
 *
 * 민감정보 주의:
 *   request_summary에는 앞 100자만 저장 + 긴 숫자열 마스킹 처리
 *
 * 사용법:
 *   const cache = require('../../../packages/core/lib/llm-cache');
 *   const hit = await cache.getCached('ska', 'reservation_check', inputText);
 *   if (hit) return JSON.parse(hit.response);
 *   // ... LLM 호출 ...
 *   await cache.setCache('ska', 'reservation_check', inputText, response, model);
 */

const crypto  = require('crypto');
const pgPool  = require('./pg-pool');
const env     = require('./env');
const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

// ── 초기화 플래그 ─────────────────────────────────────────────────────
let _initialized = false;

async function _ensureTable() {
  if (_initialized) return;
  if (DEV_HUB_READONLY) {
    _initialized = true;
    return;
  }
  await pgPool.run('reservation', `
    CREATE TABLE IF NOT EXISTS llm_cache (
      id              SERIAL PRIMARY KEY,
      cache_key       TEXT    NOT NULL,
      team            TEXT    NOT NULL,
      request_type    TEXT,
      request_summary TEXT,
      response        TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      hit_count       INTEGER DEFAULT 0,
      ttl_minutes     INTEGER NOT NULL,
      created_at      TEXT    NOT NULL,
      expires_at      TEXT    NOT NULL,
      UNIQUE (cache_key, team)
    )
  `);
  await pgPool.run('reservation', `
    CREATE INDEX IF NOT EXISTS idx_cache_expires ON llm_cache(expires_at)
  `);
  _initialized = true;
}

// ── TTL 설정 (분) ─────────────────────────────────────────────────────

const TTL_CONFIG = {
  ska:    30,    // 30분
  claude: 360,   // 6시간
  luna:   5,     // 5분
};

// ── 불용어 (키워드 추출 시 제외) ─────────────────────────────────────

const STOP_WORDS = new Set([
  // 한국어 조사/어미
  '이', '그', '저', '은', '는', '가', '을', '를', '의', '에', '에서',
  '와', '과', '도', '로', '으로', '하다', '있다', '없다', '되다', '이다',
  '것', '수', '때', '더', '또', '및', '등', '해', '됩니다', '합니다',
  // 영어 불용어
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'do', 'does', 'in', 'on', 'at', 'to', 'for',
  'of', 'and', 'or', 'but', 'with', 'this', 'that', 'it',
]);

// ── 헬퍼 ──────────────────────────────────────────────────────────────

function _kstNow() {
  return kst.datetimeStr();
}

// ── 핵심 함수 ─────────────────────────────────────────────────────────

/**
 * 캐시 키 생성 (외부 노출 — 테스트용)
 * SHA256(team:requestType:sorted_keywords)
 */
function generateCacheKey(team, requestType, input) {
  const keywords = _extractKeywords(input);
  const raw      = `${team}:${requestType || 'unknown'}:${keywords}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * 입력 텍스트에서 핵심 키워드 추출
 */
function _extractKeywords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s가-힣]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .sort()
    .slice(0, 30)
    .join(' ');
}

/**
 * 캐시 조회
 * @returns {Promise<{ response: string, model: string, hitCount: number } | null>}
 */
async function getCached(team, requestType, input) {
  try {
    await _ensureTable();
    const key = generateCacheKey(team, requestType, input);
    const now = _kstNow();

    const row = await pgPool.get('reservation', `
      SELECT id, response, model, hit_count
      FROM llm_cache
      WHERE cache_key = $1 AND team = $2 AND expires_at > $3
    `, [key, team, now]);

    if (!row) return null;

    if (!DEV_HUB_READONLY) {
      await pgPool.run('reservation', `
        UPDATE llm_cache SET hit_count = hit_count + 1 WHERE id = $1
      `, [row.id]);
    }

    return { response: row.response, model: row.model, hitCount: parseInt(row.hit_count) + 1 };
  } catch { return null; }
}

/**
 * 캐시 저장
 * @param {string}        team
 * @param {string}        requestType
 * @param {string}        input       원본 요청 (앞 100자만 요약 저장)
 * @param {object|string} response    LLM 응답
 * @param {string}        model       사용한 모델
 */
async function setCache(team, requestType, input, response, model) {
  if (DEV_HUB_READONLY) return;
  try {
    await _ensureTable();
    const key     = generateCacheKey(team, requestType, input);
    const ttl     = TTL_CONFIG[team] || 30;
    const now     = new Date();
    const nowStr  = now.toISOString().replace('Z', '+09:00');
    const expires = new Date(now.getTime() + ttl * 60 * 1000)
      .toISOString().replace('Z', '+09:00');

    const summary = String(input || '').slice(0, 100).replace(/\d{6,}/g, '***');
    const respStr = typeof response === 'string' ? response : JSON.stringify(response);

    await pgPool.run('reservation', `
      INSERT INTO llm_cache
        (cache_key, team, request_type, request_summary, response, model,
         hit_count, ttl_minutes, created_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9)
      ON CONFLICT (cache_key, team) DO UPDATE SET
        response        = EXCLUDED.response,
        model           = EXCLUDED.model,
        request_summary = EXCLUDED.request_summary,
        ttl_minutes     = EXCLUDED.ttl_minutes,
        created_at      = EXCLUDED.created_at,
        expires_at      = EXCLUDED.expires_at,
        hit_count       = 0
    `, [key, team, requestType, summary, respStr, model, ttl, nowStr, expires]);
  } catch (e) { console.warn('[llm-cache] 캐시 저장 실패 (메인 로직에 영향 없음):', e.message); }
}

/**
 * 캐시 통계 (최근 N일)
 * @param {number} days
 */
async function getCacheStats(days = 7) {
  await _ensureTable();
  const cutoff = new Date(Date.now() + 9 * 3600 * 1000 - days * 86400 * 1000)
    .toISOString().replace('Z', '+09:00');

  return pgPool.query('reservation', `
    SELECT team,
           COUNT(*)::integer        AS total_entries,
           SUM(hit_count)::integer  AS total_hits,
           AVG(ttl_minutes)::float  AS avg_ttl
    FROM llm_cache
    WHERE created_at >= $1
    GROUP BY team
    ORDER BY total_hits DESC
  `, [cutoff]);
}

/**
 * 만료된 캐시 정리
 * @returns {Promise<number>} 삭제 건수
 */
async function cleanExpired() {
  if (DEV_HUB_READONLY) return 0;
  try {
    await _ensureTable();
    const { rowCount } = await pgPool.run('reservation', `
      DELETE FROM llm_cache WHERE expires_at <= $1
    `, [_kstNow()]);
    return rowCount || 0;
  } catch { return 0; }
}

module.exports = {
  generateCacheKey,
  getCached,
  setCache,
  getCacheStats,
  cleanExpired,
  TTL_CONFIG,
};
