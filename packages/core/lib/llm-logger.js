'use strict';
const kst = require('./kst');

/**
 * packages/core/lib/llm-logger.js — 전체 팀 통합 LLM 사용 추적
 *
 * PostgreSQL reservation 스키마 llm_usage_log 테이블에 기록.
 * 스카팀/클로드팀/루나팀 모든 LLM 호출을 DB에 기록.
 * 기존 cost-tracker.js (루나팀 전용, 파일 기반)와 독립 — 건드리지 않음.
 *
 * 사용법:
 *   const logger = require('../../../packages/core/lib/llm-logger');
 *   logger.logLLMCall({ team: 'ska', bot: 'ska', model: 'groq/llama-4-scout', ... });
 */

const pgPool        = require('./pg-pool');
const billingGuard  = require('./billing-guard');

// ── 긴급 차단 한도 ─────────────────────────────────────────────────────
const EMERGENCY_LIMITS = {
  daily:      parseFloat(process.env.BILLING_LIMIT_DAILY    || '10'),
  hourly:     parseFloat(process.env.BILLING_LIMIT_HOURLY   || '3'),
  perCall:    parseFloat(process.env.BILLING_LIMIT_PER_CALL || '1'),
  spikeRatio: parseFloat(process.env.BILLING_SPIKE_RATIO    || '5'),
};

// ── 스키마 초기화 플래그 ───────────────────────────────────────────────
let _initialized = false;

async function _ensureTable() {
  if (_initialized) return;
  await pgPool.run('reservation', `
    CREATE TABLE IF NOT EXISTS llm_usage_log (
      id            SERIAL PRIMARY KEY,
      timestamp     TEXT NOT NULL,
      team          TEXT NOT NULL,
      bot           TEXT NOT NULL,
      model         TEXT NOT NULL,
      market        TEXT,
      symbol        TEXT,
      guard_scope   TEXT,
      request_type  TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      cache_hit     INTEGER NOT NULL DEFAULT 0,
      latency_ms    INTEGER,
      success       INTEGER NOT NULL DEFAULT 1,
      error_msg     TEXT,
      created_at    TEXT NOT NULL
    )
  `);
  await pgPool.run('reservation', `
    ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS market TEXT
  `);
  await pgPool.run('reservation', `
    ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS symbol TEXT
  `);
  await pgPool.run('reservation', `
    ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS guard_scope TEXT
  `);
  await pgPool.run('reservation', `
    CREATE INDEX IF NOT EXISTS idx_llm_log_team ON llm_usage_log(team, created_at)
  `);
  await pgPool.run('reservation', `
    CREATE INDEX IF NOT EXISTS idx_llm_log_bot ON llm_usage_log(team, bot, created_at)
  `);
  await pgPool.run('reservation', `
    CREATE INDEX IF NOT EXISTS idx_llm_log_market_symbol ON llm_usage_log(team, market, symbol, created_at)
  `);
  _initialized = true;
}

// ── 모델별 단가 ($ per 1M tokens) ─────────────────────────────────────

const PRICING = {
  'groq/llama-4-scout-17b-16e-instruct':      { input: 0,     output: 0     },
  'meta-llama/llama-4-scout-17b-16e-instruct':{ input: 0,     output: 0     },
  'claude-haiku-4-5-20251001':                { input: 1.00,  output: 5.00  },
  'claude-haiku-4-5':                         { input: 1.00,  output: 5.00  },
  'claude-sonnet-4-6':                        { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':                          { input: 15.00, output: 75.00 },
  'google-gemini-cli/gemini-2.5-flash':       { input: 0,     output: 0     },
  'gemini-2.5-flash':                         { input: 0,     output: 0     },
  'gpt-4o':                                   { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                              { input: 0.15,  output: 0.60  },
  'openai/gpt-oss-20b':                       { input: 0,     output: 0     },  // OpenAI 오픈소스, Groq 경유
  'gpt-oss-20b':                              { input: 0,     output: 0     },  // OpenAI 오픈소스, Groq 경유
  'qwen/qwen3-32b':                           { input: 0.29,  output: 0.59  },  // Groq 유료
  'qwen3-32b':                                { input: 0.29,  output: 0.59  },  // Groq 유료
  'meta-llama/llama-4-maverick-17b-128e-instruct': { input: 0, output: 0   },  // Groq 무료
  'llama-3.3-70b-versatile':                  { input: 0,     output: 0     },  // Groq 무료
};

// ── 헬퍼 ──────────────────────────────────────────────────────────────

function _kstNow() {
  return kst.datetimeStr();
}

function _kstDate() {
  return kst.today();
}

function _normalizeModel(model) {
  if (!model) return '';
  // gpt-4o-2024-08-06 → gpt-4o
  if (model.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
  if (model.startsWith('gpt-4o'))     return 'gpt-4o';
  // claude-sonnet-4-6-20251001 → claude-sonnet-4-6
  const claudeMatch = model.match(/^(claude-(?:haiku|sonnet|opus)-[\d.-]+)/);
  if (claudeMatch) return claudeMatch[1];
  return model;
}

function _calcCost(model, inputTokens, outputTokens) {
  const p = PRICING[_normalizeModel(model)] || PRICING[model] || { input: 0, output: 0 };
  return ((inputTokens * p.input) + (outputTokens * p.output)) / 1_000_000;
}

// ── 핵심 함수 ─────────────────────────────────────────────────────────

/**
 * LLM 호출 기록
 * @param {object} opts
 * @param {string}  opts.team          'ska' | 'claude' | 'luna'
 * @param {string}  opts.bot           봇명 (ska, aria, dexter, luna, archer ...)
 * @param {string}  opts.model         모델 ID
 * @param {string}  [opts.requestType] 요청 유형 (reservation_check, trade_signal ...)
 * @param {number}  [opts.inputTokens]
 * @param {number}  [opts.outputTokens]
 * @param {number}  [opts.costUsd]     미제공 시 단가표로 자동 계산
 * @param {boolean} [opts.cacheHit]    캐시 히트 여부
 * @param {number}  [opts.latencyMs]   응답 소요 시간
 * @param {boolean} [opts.success]     성공 여부 (기본 true)
 * @param {string}  [opts.errorMsg]    실패 시 에러 메시지
 */
async function logLLMCall({
  team, bot, model,
  market       = null,
  symbol       = null,
  guardScope   = null,
  requestType  = 'unknown',
  inputTokens  = 0,
  outputTokens = 0,
  costUsd,
  cacheHit     = false,
  latencyMs    = null,
  success      = true,
  errorMsg     = null,
}) {
  try {
    await _ensureTable();
    const cost = costUsd !== undefined ? costUsd : _calcCost(model, inputTokens, outputTokens);
    const now  = _kstNow();
    const effectiveGuardScope = guardScope || resolveTeamEmergencyScope(team, { market, symbol });

    await pgPool.run('reservation', `
      INSERT INTO llm_usage_log
        (timestamp, team, bot, model, market, symbol, guard_scope, request_type,
         input_tokens, output_tokens, cost_usd,
         cache_hit, latency_ms, success, error_msg, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [
      now, team, bot, model, market, symbol, effectiveGuardScope, requestType,
      inputTokens, outputTokens, cost,
      cacheHit ? 1 : 0, latencyMs,
      success ? 1 : 0, errorMsg, now,
    ]);

    // ★ 실시간 긴급 한도 체크 (성공 호출 + 비용 있을 때만, 비동기)
    if (success && cost > 0) {
      _checkEmergencyLimits(cost, team, { market, symbol, guardScope: effectiveGuardScope }).catch(() => {});
    }
  } catch (e) {
    console.warn(`[llm-logger] 기록 실패 (${bot}): ${e.message}`);
  }
}

// ── 긴급 한도 체크 ────────────────────────────────────────────────────

// 배치성 팀 — 하루 1회 실행이라 10분 급등이 정상. 스파이크 감지 제외
const BATCH_TEAMS = new Set(['blog']);
const INVESTMENT_TEAMS = new Set(['luna', 'nemesis', 'oracle', 'argos', 'hermes', 'sophia', 'athena', 'zeus', 'investment']);

function normalizeScopeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveTeamEmergencyScope(team, meta = {}) {
  const normalized = String(team || '').trim().toLowerCase();
  if (INVESTMENT_TEAMS.has(normalized)) {
    const mode = String(process.env.INVESTMENT_TRADE_MODE || 'normal').trim().toLowerCase();
    const rail = `investment.${mode === 'validation' ? 'validation' : 'normal'}`;
    const market = String(meta.market || process.env.INVESTMENT_MARKET || '').trim().toLowerCase();
    if (['crypto', 'domestic', 'overseas'].includes(market)) {
      const symbolToken = normalizeScopeToken(meta.symbol || '');
      if (symbolToken) return `${rail}.${market}.${symbolToken}`;
      return `${rail}.${market}`;
    }
    return rail;
  }
  return normalized || 'global';
}

async function _checkEmergencyLimits(cost, team, meta = {}) {
  const scopedGuard = resolveTeamEmergencyScope(team, meta);
  if (billingGuard.isBlocked(scopedGuard) || billingGuard.isBlocked('global')) return;

  try {
    // 단건 한도
    if (cost > EMERGENCY_LIMITS.perCall) {
      return _triggerEmergency(`단건 $${cost.toFixed(4)} > 한도 $${EMERGENCY_LIMITS.perCall}`, cost);
    }

    // 시간당 누적 (전체)
    const hrRow = await pgPool.get('reservation',
      `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log WHERE created_at::timestamptz > NOW() - INTERVAL '1 hour'`
    );
    const hourlyCost = parseFloat(hrRow?.t || 0);
    if (hourlyCost > EMERGENCY_LIMITS.hourly) {
      return _triggerEmergency(`시간당 $${hourlyCost.toFixed(4)} > 한도 $${EMERGENCY_LIMITS.hourly}`, hourlyCost);
    }

    // 일일 누적 (전체)
    const dyRow = await pgPool.get('reservation',
      `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log WHERE created_at::date = CURRENT_DATE`
    );
    const dailyCost = parseFloat(dyRow?.t || 0);
    if (dailyCost > EMERGENCY_LIMITS.daily) {
      return _triggerEmergency(`일일 $${dailyCost.toFixed(4)} > 한도 $${EMERGENCY_LIMITS.daily}`, dailyCost);
    }

    // 10분 급등 — 팀별 독립 감지 (배치 팀 제외)
    if (!BATCH_TEAMS.has(team)) {
      const hasScopedSymbol = Boolean(meta.symbol && meta.market);
      if (!hasScopedSymbol) {
        const r10 = await pgPool.get('reservation',
          `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log
           WHERE team = $1 AND created_at::timestamptz > NOW() - INTERVAL '10 minutes'`,
          [team]
        );
        const p10 = await pgPool.get('reservation',
          `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log
           WHERE team = $1 AND created_at::timestamptz BETWEEN NOW() - INTERVAL '20 minutes' AND NOW() - INTERVAL '10 minutes'`,
          [team]
        );
        const recent = parseFloat(r10?.t || 0);
        const prev   = parseFloat(p10?.t || 0);
        if (prev > 0.01 && recent / prev >= EMERGENCY_LIMITS.spikeRatio) {
          _triggerEmergency(`[${team}] 10분 급등 ${(recent / prev).toFixed(1)}배 ($${recent.toFixed(4)})`, recent, scopedGuard);
        }
      }

      if (hasScopedSymbol) {
        const sr10 = await pgPool.get('reservation',
          `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log
           WHERE team = $1 AND market = $2 AND symbol = $3
             AND created_at::timestamptz > NOW() - INTERVAL '10 minutes'`,
          [team, meta.market, meta.symbol]
        );
        const sp10 = await pgPool.get('reservation',
          `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log
           WHERE team = $1 AND market = $2 AND symbol = $3
             AND created_at::timestamptz BETWEEN NOW() - INTERVAL '20 minutes' AND NOW() - INTERVAL '10 minutes'`,
          [team, meta.market, meta.symbol]
        );
        const recentSymbol = parseFloat(sr10?.t || 0);
        const prevSymbol = parseFloat(sp10?.t || 0);
        if (prevSymbol > 0.01 && recentSymbol / prevSymbol >= EMERGENCY_LIMITS.spikeRatio) {
          _triggerEmergency(
            `[${team}:${meta.market}:${meta.symbol}] 10분 급등 ${(recentSymbol / prevSymbol).toFixed(1)}배 ($${recentSymbol.toFixed(4)})`,
            recentSymbol,
            scopedGuard,
          );
        }
      }
    }
  } catch (e) {
    console.warn(`[llm-logger] 긴급 한도 체크 실패 (무시): ${e.message}`);
  }
}

function resolveEmergencyTtlMs(scope = 'global') {
  return billingGuard.getDefaultAutoTtlMs?.(scope) || 0;
}

function _triggerEmergency(reason, cost, scope = 'global', options = {}) {
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : resolveEmergencyTtlMs(scope);
  const stopData = billingGuard.activate(reason, cost, 'llm-logger', scope, { ttlMs });

  // 텔레그램 CRITICAL 알림 (실패해도 차단 유지)
  try {
    const mainbotClient = require('../../bots/claude/lib/mainbot-client');
    const pub = mainbotClient.publishToMainBot || mainbotClient.default?.publishToMainBot;
    if (pub) {
      pub({
        from_bot:   'dexter',
        event_type: 'billing_emergency',
        alert_level: 3,
        message: [
          '🚨 *LLM 긴급 차단 발동!*',
          '',
          `사유: ${reason}`,
          `비용: $${cost.toFixed(4)}`,
          `시각: ${kst.datetimeStr()} KST`,
          ttlMs > 0 && stopData?.expires_at ? `자동 해제: ${String(stopData.expires_at).replace('T', ' ').replace('Z', ' UTC')}` : null,
          '',
          '⚠️ 모든 LLM 호출 즉시 중단됨',
          `해제: \`rm ${scope === 'global' ? '.llm-emergency-stop' : `.llm-emergency-stop.${billingGuard.normalizeScope(scope)}`}\` (마스터만)`,
        ].filter(Boolean).join('\n'),
      }).catch(() => {});
    }
  } catch { /* 알림 실패해도 차단 유지 */ }
}

/**
 * 팀별 일간 비용 집계
 * @param {string} [team]    생략 시 전체 팀 배열 반환
 * @param {string} [dateKst] 'YYYY-MM-DD', 생략 시 오늘
 */
async function getDailyCost(team, dateKst) {
  await _ensureTable();
  const date = dateKst || _kstDate();

  if (team) {
    const row = await pgPool.get('reservation', `
      SELECT SUM(cost_usd)::float   AS total,
             SUM(cache_hit)         AS cache_hits,
             COUNT(*)               AS calls
      FROM llm_usage_log
      WHERE team = $1 AND created_at::date = $2::date
    `, [team, date]);
    return {
      team,
      date,
      total:      parseFloat(row?.total      || 0),
      cacheHits:  parseInt(row?.cache_hits   || 0),
      calls:      parseInt(row?.calls        || 0),
    };
  }

  return pgPool.query('reservation', `
    SELECT team,
           SUM(cost_usd)::float AS total,
           SUM(cache_hit)       AS cache_hits,
           COUNT(*)             AS calls
    FROM llm_usage_log
    WHERE created_at::date = $1::date
    GROUP BY team
    ORDER BY total DESC
  `, [date]);
}

/**
 * 팀별/봇별 비용 상세 (최근 N일)
 * @param {string} [team] 생략 시 전체
 * @param {number} [days] 기간 (기본 7일)
 */
async function getCostBreakdown(team, days = 7) {
  await _ensureTable();
  const cutoff = new Date(Date.now() - days * 86400 * 1000)
    .toISOString().split('T')[0];

  if (team) {
    return pgPool.query('reservation', `
      SELECT team, bot, model, request_type,
             SUM(cost_usd)::float                AS total_cost,
             SUM(input_tokens + output_tokens)   AS total_tokens,
             SUM(cache_hit)                      AS cache_hits,
             COUNT(*)                            AS calls,
             AVG(latency_ms)::integer            AS avg_latency_ms
      FROM llm_usage_log
      WHERE team = $1 AND created_at::date >= $2::date
      GROUP BY team, bot, model, request_type
      ORDER BY total_cost DESC, total_tokens DESC
    `, [team, cutoff]);
  }

  return pgPool.query('reservation', `
    SELECT team, bot, model, request_type,
           SUM(cost_usd)::float                AS total_cost,
           SUM(input_tokens + output_tokens)   AS total_tokens,
           SUM(cache_hit)                      AS cache_hits,
           COUNT(*)                            AS calls,
           AVG(latency_ms)::integer            AS avg_latency_ms
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY team, bot, model, request_type
    ORDER BY total_cost DESC, total_tokens DESC
  `, [cutoff]);
}

/**
 * 텔레그램 일간 비용 리포트 텍스트 생성
 */
async function buildDailyCostReport() {
  const today = _kstDate();
  const rows  = await getDailyCost(null, today);

  if (!Array.isArray(rows) || rows.length === 0) {
    return `💰 LLM 일간 비용 리포트 (${today})\n  데이터 없음`;
  }

  const totalCost   = rows.reduce((s, r) => s + (parseFloat(r.total)      || 0), 0);
  const totalCalls  = rows.reduce((s, r) => s + (parseInt(r.calls)        || 0), 0);
  const totalCached = rows.reduce((s, r) => s + (parseInt(r.cache_hits)   || 0), 0);
  const savedPct    = totalCalls > 0 ? Math.round(totalCached / totalCalls * 100) : 0;

  const TEAM_LABEL = { ska: '스카팀', claude: '클로드팀', luna: '루나팀', blog: '블로팀', worker: '워커팀' };

  const teamLines = rows.map(r => {
    const label = TEAM_LABEL[r.team] || r.team;
    const tag   = parseFloat(r.total) < 0.0001 ? '무료' : `$${parseFloat(r.total).toFixed(4)}`;
    return `  ${label}: ${tag} (${r.calls}회)`;
  });

  return [
    `💰 팀 제이 LLM 일간 비용 (${today})`,
    `──────────────────────`,
    ...teamLines,
    `──────────────────────`,
    `총계: $${totalCost.toFixed(4)}`,
    `캐시 절감: ${totalCached}회 (${savedPct}%)`,
  ].join('\n');
}

/**
 * 비용 트렌드 분석 (최근 N일)
 * @param {number} [days] 분석 기간 (기본 14일)
 */
async function analyzeCostTrend(days = 14) {
  await _ensureTable();
  const half   = Math.floor(days / 2);
  const cutoff = new Date(Date.now() - days * 86400 * 1000)
    .toISOString().split('T')[0];
  const midDate = new Date(Date.now() - half * 86400 * 1000)
    .toISOString().split('T')[0];

  const rows = await pgPool.query('reservation', `
    SELECT created_at::date AS day, SUM(cost_usd)::float AS daily_cost
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY day ORDER BY day
  `, [cutoff]);

  const thisWeekRows = rows.filter(r => r.day >= midDate);
  const lastWeekRows = rows.filter(r => r.day <  midDate);

  const thisWeekCost = thisWeekRows.reduce((s, r) => s + r.daily_cost, 0);
  const lastWeekCost = lastWeekRows.reduce((s, r) => s + r.daily_cost, 0);
  const weekOverWeek = lastWeekCost > 0
    ? ((thisWeekCost - lastWeekCost) / lastWeekCost * 100)
    : null;

  const avgDaily = rows.length > 0
    ? rows.reduce((s, r) => s + r.daily_cost, 0) / rows.length
    : 0;

  return { thisWeekCost, lastWeekCost, weekOverWeek, avgDaily, dailyRows: rows };
}

/**
 * 모델별 효율 분석 + 최적화 추천
 * @param {number} [days] 분석 기간 (기본 30일)
 */
async function analyzeModelEfficiency(days = 30) {
  await _ensureTable();
  const cutoff = new Date(Date.now() - days * 86400 * 1000)
    .toISOString().split('T')[0];

  const models = await pgPool.query('reservation', `
    SELECT team, bot, model,
           COUNT(*)                            AS calls,
           SUM(cost_usd)::float                AS total_cost,
           AVG(latency_ms)::integer            AS avg_latency,
           ROUND(AVG(success) * 100)::integer  AS success_rate
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY team, bot, model
    ORDER BY total_cost DESC
  `, [cutoff]);

  // 추천 로직: gpt-4o 비용 높고 낮은 복잡도 작업 → gpt-4o-mini 추천
  const recommendations = models
    .filter(m => m.model === 'gpt-4o' && parseFloat(m.total_cost) > 0.05 && m.calls >= 5)
    .map(m => ({
      team:           m.team,
      bot:            m.bot,
      currentModel:   m.model,
      recommendModel: 'gpt-4o-mini',
      reason:         `${m.calls}회 호출, $${parseFloat(m.total_cost).toFixed(4)} 소요 — 단순 작업이라면 gpt-4o-mini로 97% 절감 가능`,
      estimatedSaving: parseFloat(m.total_cost) * 0.94,
      priority:        parseFloat(m.total_cost) > 0.5 ? 'high' : 'medium',
    }));

  return { models, recommendations };
}

/**
 * 주간 피드백 리포트 텍스트 생성
 */
async function buildWeeklyFeedbackReport() {
  const trend   = await analyzeCostTrend(14);
  const { models, recommendations } = await analyzeModelEfficiency(7);

  const today      = _kstDate();
  const totalCost  = models.reduce((s, m) => s + parseFloat(m.total_cost), 0);
  const totalCalls = models.reduce((s, m) => s + parseInt(m.calls), 0);
  const freeCalls  = models.filter(m => m.model.includes('llama') || m.model.includes('gemini'))
    .reduce((s, m) => s + parseInt(m.calls), 0);

  const lines = [
    `📊 팀 제이 LLM 주간 피드백 리포트 (${today})`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💰 비용 현황 (최근 7일)`,
    `  총 비용:   $${totalCost.toFixed(4)}`,
    `  총 호출:   ${totalCalls}회 (무료 ${freeCalls}회 포함)`,
    `  일 평균:   $${(trend.avgDaily || 0).toFixed(4)}`,
    trend.weekOverWeek != null
      ? `  전주 대비: ${trend.weekOverWeek > 0 ? '+' : ''}${trend.weekOverWeek.toFixed(1)}%`
      : `  전주 대비: 데이터 부족`,
    ``,
    `🤖 모델별 사용 TOP5`,
    ...models.slice(0, 5).map(m =>
      `  ${m.team}/${m.bot} [${m.model.slice(0, 20)}] $${parseFloat(m.total_cost).toFixed(4)} ${m.calls}회`
    ),
    ``,
  ];

  if (recommendations.length > 0) {
    lines.push(`💡 최적화 추천`);
    recommendations.forEach((r, i) => {
      lines.push(`  ${i + 1}. [${r.priority.toUpperCase()}] ${r.team}/${r.bot}`);
      lines.push(`     ${r.currentModel} → ${r.recommendModel}`);
      lines.push(`     절감 예상: $${r.estimatedSaving.toFixed(4)}`);
    });
  } else {
    lines.push(`💡 최적화 추천: 없음 (이미 최적 또는 데이터 부족)`);
  }

  return lines.join('\n');
}

module.exports = {
  logLLMCall, getDailyCost, getCostBreakdown, buildDailyCostReport,
  analyzeCostTrend, analyzeModelEfficiency, buildWeeklyFeedbackReport,
};
