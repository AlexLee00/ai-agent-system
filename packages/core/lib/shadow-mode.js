'use strict';

/**
 * packages/core/lib/shadow-mode.js — LLM Shadow Mode 엔진
 *
 * 기존 규칙 기반 판단과 LLM 판단을 동시에 실행하되,
 * LLM 결과는 로그에만 기록하고 실제 동작에는 영향 없음.
 *
 * 3단계 전환:
 *   1단계 Shadow:       규칙=실행, LLM=로그만 (현재)
 *   2단계 Confirmation: LLM=1차 판단, 규칙=검증(폴백)
 *   3단계 LLM Primary:  LLM=실행, 규칙=안전망만
 *
 * 전환 조건: Shadow 일치율 95%+ 2주 연속 → Confirmation 전환 가능
 *
 * DB: PostgreSQL (reservation 스키마 shadow_log 테이블)
 *     pg-pool.js 사용 (⚠️ SQLite 아님, $1,$2 파라미터)
 */

const path    = require('path');
const fs      = require('fs');
const pgPool  = require('./pg-pool');
const cache   = require('./llm-cache');
const llmLog  = require('./llm-logger');
const { getTimeout } = require('./llm-timeouts');

const SCHEMA = 'reservation';

// ── 팀별 Shadow Mode 기본 설정 ──────────────────────────────────────
const TEAM_MODE = {
  ska:    'shadow',
  claude: 'off',
  luna:   'off',
};

// ── Groq 모델 ────────────────────────────────────────────────────────
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// ── 테이블 초기화 ─────────────────────────────────────────────────────
let _tableReady = false;

async function _ensureTable() {
  if (_tableReady) return;
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS shadow_log (
      id            SERIAL PRIMARY KEY,
      team          TEXT NOT NULL,
      context       TEXT NOT NULL,
      input_summary TEXT,
      rule_result   JSONB NOT NULL,
      llm_result    JSONB,
      llm_error     TEXT,
      match         BOOLEAN,
      mode          TEXT NOT NULL,
      fallback      BOOLEAN DEFAULT FALSE,
      elapsed_ms    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_shadow_team_ctx
      ON shadow_log(team, context, created_at)
  `);
  _tableReady = true;
}

// ── Groq 클라이언트 (라운드로빈) ────────────────────────────────────
let _groqClients = null;
let _groqIdx     = 0;

function _getGroqClients() {
  if (_groqClients !== null) return _groqClients;
  try {
    const Groq = require('groq-sdk');
    const yaml = require('js-yaml');
    const cfgPath = path.join(__dirname, '../../../bots/investment/config.yaml');
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
    _groqClients = (cfg.groq?.accounts || [])
      .filter(a => a.api_key)
      .map(a => new Groq({ apiKey: a.api_key, timeout: getTimeout('groq') }));
  } catch {
    _groqClients = [];
  }
  return _groqClients;
}

// ── LLM 호출 ─────────────────────────────────────────────────────────

/**
 * Groq 호출 (429 시 라운드로빈 재시도)
 * @returns {{ _in: number, _out: number, decision?: string, ... }}
 */
async function _callGroq(systemPrompt, userContent) {
  const clients = _getGroqClients();
  if (clients.length === 0) throw new Error('Groq API 키 없음 (bots/investment/config.yaml 확인)');

  // Groq response_format=json_object 사용 시 "JSON" 단어 필수
  const sysPrompt = /json/i.test(systemPrompt)
    ? systemPrompt
    : systemPrompt + '\nJSON 형식으로만 답하세요.';

  let lastErr;
  for (let attempt = 0; attempt < Math.min(3, clients.length); attempt++) {
    const groq = clients[(_groqIdx + attempt) % clients.length];
    try {
      const res = await groq.chat.completions.create({
        model:           GROQ_MODEL,
        messages:        [
          { role: 'system', content: sysPrompt    },
          { role: 'user',   content: userContent  },
        ],
        max_tokens:      400,
        temperature:     0.1,
        response_format: { type: 'json_object' },
      });
      _groqIdx = (_groqIdx + attempt + 1) % clients.length;
      const text   = res.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(text);
      parsed._in   = res.usage?.prompt_tokens    || 0;
      parsed._out  = res.usage?.completion_tokens || 0;
      return parsed;
    } catch (e) {
      lastErr = e;
      if (e.status !== 429) throw e;
      // 429 → 다음 키 시도
    }
  }
  throw lastErr;
}

// ── 결과 비교 ─────────────────────────────────────────────────────────

function _extractDecision(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const val = obj.decision ?? obj.action ?? obj.classification ?? obj.result ?? null;
  return val !== null ? String(val).toLowerCase().trim() : null;
}

function _compareResults(ruleResult, llmResult) {
  if (!ruleResult || !llmResult) return false;
  const r = _extractDecision(ruleResult);
  const l = _extractDecision(llmResult);
  if (!r || !l) return false;
  return r === l;
}

// ── Confirmation/LLM Primary 보조 ────────────────────────────────────

function _validateWithRule(llmResult, ruleResult) {
  const llmDec  = _extractDecision(llmResult)  || '';
  const ruleDec = _extractDecision(ruleResult) || '';
  // LLM이 규칙과 일치하거나 더 보수적(reject)이면 허용
  return llmDec === ruleDec || llmDec === 'reject';
}

function _isDangerous(llmResult) {
  const dec = _extractDecision(llmResult) || '';
  return dec.includes('delete') || dec.includes('삭제') || dec.includes('force');
}

// ── DB 기록 (비동기, 실패 무음) ──────────────────────────────────────

async function _logShadowResult({
  team, context, inputSummary, ruleResult, llmResult,
  llmError, match, mode, fallback, elapsedMs,
}) {
  await _ensureTable();
  await pgPool.run(SCHEMA, `
    INSERT INTO shadow_log
      (team, context, input_summary, rule_result, llm_result,
       llm_error, match, mode, fallback, elapsed_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [
    team, context,
    (inputSummary || null),
    JSON.stringify(ruleResult),
    llmResult  ? JSON.stringify(llmResult) : null,
    llmError   || null,
    match,
    mode,
    fallback   || false,
    elapsedMs  || null,
  ]);
}

// ── 핵심 함수 ────────────────────────────────────────────────────────

/**
 * Shadow Mode 평가 실행
 *
 * @param {object}   opts
 * @param {string}   opts.team        'ska' | 'claude' | 'luna'
 * @param {string}   opts.context     판단 컨텍스트 ID (예: 'manual_entry_severity')
 * @param {any}      opts.input       규칙 엔진 + LLM에 전달할 입력
 * @param {Function} opts.ruleEngine  (input) => {decision,...} | Promise<{decision,...}>
 * @param {string}   opts.llmPrompt   LLM 시스템 프롬프트 (JSON 판단 요청)
 * @param {string}   [opts.mode]      강제 모드 ('shadow'|'confirmation'|'llm_primary'|'off')
 *
 * @returns {Promise<{
 *   action:   object,   // 실제 실행될 결과
 *   shadow:   object|null,  // 참고용 결과 (shadow=llm, confirmation/llm_primary=rule)
 *   match:    boolean|null,
 *   mode:     string,
 *   fallback: boolean?  // Confirmation/LLM Primary에서 규칙으로 폴백 시 true
 * }>}
 */
async function evaluate({ team, context, input, ruleEngine, llmPrompt, mode }) {
  const effectiveMode = mode || TEAM_MODE[team] || 'shadow';

  // off 모드: LLM 호출 없이 규칙만 실행
  if (effectiveMode === 'off') {
    const ruleResult = await Promise.resolve(ruleEngine(input));
    return { action: ruleResult, shadow: null, match: null, mode: 'off' };
  }

  const startTime = Date.now();

  // 1. 규칙 기반 판단 (항상 실행 — 실패 시 상위로 throw)
  const ruleResult = await Promise.resolve(ruleEngine(input));

  // 2. LLM 판단 (병렬, 실패해도 규칙 결과에 영향 없음)
  let llmResult    = null;
  let llmError     = null;
  let cacheHit     = false;
  let inputTokens  = 0;
  let outputTokens = 0;

  const inputStr  = typeof input === 'string' ? input : JSON.stringify(input);
  const cacheType = `shadow_${context}`;

  try {
    // 2-a. 캐시 조회
    const hit = await cache.getCached(team, cacheType, inputStr);
    if (hit) {
      llmResult = JSON.parse(hit.response);
      cacheHit  = true;
    } else {
      // 2-b. Groq 호출
      const raw    = await _callGroq(llmPrompt, inputStr);
      inputTokens  = raw._in  || 0;
      outputTokens = raw._out || 0;
      delete raw._in;
      delete raw._out;
      llmResult    = raw;
      // 2-c. 캐시 저장
      await cache.setCache(team, cacheType, inputStr, JSON.stringify(llmResult), GROQ_MODEL);
    }
  } catch (e) {
    llmError = e.message;
  }

  const elapsed = Date.now() - startTime;

  // 3. 결과 비교
  const match = _compareResults(ruleResult, llmResult);

  // 4. LLM 사용 로그 (비동기, 실패 무음)
  llmLog.logLLMCall({
    team,
    bot:         `shadow_${team}_${context}`,
    model:       GROQ_MODEL,
    requestType: cacheType,
    inputTokens,
    outputTokens,
    cacheHit,
    latencyMs:   elapsed,
    success:     llmError === null,
    errorMsg:    llmError,
  }).catch(() => {});

  // 5. shadow_log 기록 (비동기, 실패 무음)
  const inputSummary = inputStr.slice(0, 200).replace(/\d{6,}/g, '***');
  _logShadowResult({
    team, context, inputSummary, ruleResult, llmResult,
    llmError, match, mode: effectiveMode, elapsedMs: elapsed,
  }).catch(e => { console.warn('[shadow-mode] shadow_log 기록 실패 (메인 로직에 영향 없음):', e.message); });

  // 6. 모드별 실행 결과 결정
  if (effectiveMode === 'confirmation') {
    if (llmResult && _validateWithRule(llmResult, ruleResult)) {
      return { action: llmResult, shadow: ruleResult, match, mode: effectiveMode };
    }
    return { action: ruleResult, shadow: llmResult, match, mode: effectiveMode, fallback: true };
  }

  if (effectiveMode === 'llm_primary') {
    if (llmResult && !_isDangerous(llmResult)) {
      return { action: llmResult, shadow: ruleResult, match, mode: effectiveMode };
    }
    return { action: ruleResult, shadow: llmResult, match, mode: effectiveMode, fallback: true };
  }

  // shadow (기본): 규칙 결과를 action으로 반환, LLM은 shadow에만
  return { action: ruleResult, shadow: llmResult, match, mode: effectiveMode };
}

// ── 통계 함수 ─────────────────────────────────────────────────────────

/**
 * 일치율 조회
 * @param {string}  team
 * @param {string}  [context]  null → 전체
 * @param {number}  [days=7]
 * @returns {Promise<{ total, matched, matchRate, llmErrors, avgElapsedMs }>}
 */
async function getMatchRate(team, context = null, days = 7) {
  await _ensureTable();
  const params = [team, days];
  const ctxClause = context ? 'AND context = $3' : '';
  if (context) params.push(context);

  const row = await pgPool.get(SCHEMA, `
    SELECT
      COUNT(*)::integer                                       AS total,
      SUM(CASE WHEN match = TRUE  THEN 1 ELSE 0 END)::integer AS matched,
      SUM(CASE WHEN llm_error IS NOT NULL THEN 1 ELSE 0 END)::integer AS llm_errors,
      AVG(elapsed_ms)::integer                               AS avg_elapsed_ms
    FROM shadow_log
    WHERE team = $1
      AND created_at > NOW() - ($2 * INTERVAL '1 day')
      ${ctxClause}
  `, params);

  const total    = row?.total   || 0;
  const matched  = row?.matched || 0;
  const matchRate = total > 0 ? Math.round((matched / total) * 1000) / 10 : null;

  return {
    total,
    matched,
    matchRate,
    llmErrors:    row?.llm_errors     || 0,
    avgElapsedMs: row?.avg_elapsed_ms || 0,
  };
}

/**
 * 불일치 건 조회 (수동 검토용)
 * @param {string}  team
 * @param {string}  [context]
 * @param {number}  [days=7]
 * @returns {Promise<Array>}
 */
async function getMismatches(team, context = null, days = 7) {
  await _ensureTable();
  const params = [team, days];
  const ctxClause = context ? 'AND context = $3' : '';
  if (context) params.push(context);

  return pgPool.query(SCHEMA, `
    SELECT id, context, input_summary, rule_result, llm_result,
           elapsed_ms, created_at
    FROM shadow_log
    WHERE team = $1
      AND match = FALSE
      AND llm_error IS NULL
      AND created_at > NOW() - ($2 * INTERVAL '1 day')
      ${ctxClause}
    ORDER BY created_at DESC
    LIMIT 20
  `, params);
}

/**
 * Shadow Mode 리포트 텍스트 생성
 * @param {string}  team
 * @param {number}  [days=1]
 * @returns {Promise<string>}
 */
async function buildShadowReport(team, days = 1) {
  const stats = await getMatchRate(team, null, days);
  const CONFIRM_THRESHOLD = 95;

  const lines = [
    `📊 Shadow Mode 리포트 (${team}팀, 최근 ${days}일)`,
    '════════════════════════',
    `총 판단:    ${stats.total}건`,
  ];

  if (stats.total > 0) {
    const mismatched = stats.total - stats.matched - stats.llmErrors;
    lines.push(`일치:       ${stats.matched}건 (${stats.matchRate}%)`);
    lines.push(`불일치:     ${mismatched}건`);
    lines.push(`LLM 에러:   ${stats.llmErrors}건`);
    lines.push(`평균 응답:  ${((stats.avgElapsedMs || 0) / 1000).toFixed(1)}초`);

    if (stats.matchRate !== null) {
      const achieved = stats.matchRate >= CONFIRM_THRESHOLD;
      lines.push(
        `Confirmation 전환 조건: ${CONFIRM_THRESHOLD}%+` +
        ` (현재 ${stats.matchRate}% → ${achieved ? '✅ 달성' : '미달'})`
      );
    }
  } else {
    lines.push('(데이터 없음)');
  }

  return lines.join('\n');
}

// ── 팀 모드 관리 (confirmation 전환 제어) ─────────────────────────────

let _teamModeTableReady = false;
const _teamModeCache    = {};  // { team: { mode, expiresAt } }

async function _ensureTeamModeTable() {
  if (_teamModeTableReady) return;
  await pgPool.run('claude', `
    CREATE TABLE IF NOT EXISTS team_modes (
      team        TEXT PRIMARY KEY,
      mode        TEXT NOT NULL DEFAULT 'shadow',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by  TEXT
    )
  `);
  _teamModeTableReady = true;
}

/**
 * 팀의 현재 Shadow 모드 조회 (1분 캐시)
 * @param {string} team
 * @returns {Promise<string>}  'shadow' | 'confirmation' | 'llm_primary'
 */
async function getTeamMode(team) {
  const cached = _teamModeCache[team];
  if (cached && cached.expiresAt > Date.now()) return cached.mode;
  try {
    await _ensureTeamModeTable();
    const row  = await pgPool.get('claude', `SELECT mode FROM team_modes WHERE team = $1`, [team]);
    const mode = row?.mode ?? 'shadow';
    _teamModeCache[team] = { mode, expiresAt: Date.now() + 60_000 };
    return mode;
  } catch { return 'shadow'; }
}

/**
 * 팀의 Shadow 모드 변경 (마스터 승인 전용)
 * @param {string} team
 * @param {string} mode        'shadow' | 'confirmation' | 'llm_primary'
 * @param {string} updatedBy
 * @returns {Promise<{team, mode, updatedBy}>}
 */
async function setTeamMode(team, mode, updatedBy = 'master') {
  const VALID = ['shadow', 'confirmation', 'llm_primary', 'off'];
  if (!VALID.includes(mode)) throw new Error(`유효하지 않은 모드: ${mode}`);
  await _ensureTeamModeTable();
  await pgPool.run('claude', `
    INSERT INTO team_modes (team, mode, updated_at, updated_by)
    VALUES ($1, $2, NOW(), $3)
    ON CONFLICT (team) DO UPDATE SET
      mode       = EXCLUDED.mode,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by
  `, [team, mode, updatedBy]);
  _teamModeCache[team] = { mode, expiresAt: Date.now() + 60_000 };
  return { team, mode, updatedBy };
}

// ── 오래된 로그 정리 ─────────────────────────────────────────────────

/**
 * 오래된 shadow_log 삭제
 * @param {number} keepDays  보관 일수 (기본 30일)
 * @returns {Promise<number>} 삭제 건수
 */
async function pruneOldLogs(keepDays = 30) {
  try {
    await _ensureTable();
    const { rowCount } = await pgPool.run(SCHEMA, `
      DELETE FROM shadow_log
      WHERE created_at < NOW() - ($1 * INTERVAL '1 day')
    `, [keepDays]);
    return rowCount || 0;
  } catch { return 0; }
}

module.exports = {
  evaluate,
  getMatchRate,
  getMismatches,
  buildShadowReport,
  pruneOldLogs,
  getTeamMode,
  setTeamMode,
  TEAM_MODE,
  GROQ_MODEL,
};
