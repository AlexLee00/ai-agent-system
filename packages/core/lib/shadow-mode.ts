import path from 'node:path';
import fs from 'node:fs';

const pgPool = require('./pg-pool');
const cache = require('./llm-cache');
const llmLog = require('./llm-logger');
const { getTimeout } = require('./llm-timeouts');
const { callLocalLLMJSON } = require('./local-llm-client');

type ShadowResult = Record<string, unknown> | null;
type RuleEngine = (input: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;
type ShadowMode = 'shadow' | 'confirmation' | 'llm_primary' | 'off';

const SCHEMA = 'reservation';

const TEAM_MODE: Record<string, ShadowMode> = {
  ska: 'shadow',
  claude: 'off',
  luna: 'off',
};

const SHADOW_PRIMARY = 'meta-llama/llama-4-scout-17b-16e-instruct';
const SHADOW_FALLBACK = 'qwen2.5-7b';
const GROQ_MODEL = SHADOW_PRIMARY;

let _tableReady = false;

async function _ensureTable(): Promise<void> {
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

let _groqClients: any[] | null = null;
let _groqIdx = 0;

function _getGroqClients(): any[] {
  if (_groqClients !== null) return _groqClients;
  try {
    const Groq = require('groq-sdk');
    const yaml = require('js-yaml');
    const cfgPath = path.join(__dirname, '../../../bots/investment/config.yaml');
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) as { groq?: { accounts?: Array<{ api_key?: string }> } };
    _groqClients = (cfg.groq?.accounts || [])
      .filter((account) => account.api_key)
      .map((account) => new Groq({ apiKey: account.api_key, timeout: getTimeout('groq') }));
  } catch {
    _groqClients = [];
  }
  return _groqClients;
}

async function _callGroq(systemPrompt: string, userContent: string): Promise<Record<string, unknown>> {
  const clients = _getGroqClients();
  if (clients.length === 0) throw new Error('Groq API 키 없음 (bots/investment/config.yaml 확인)');

  const sysPrompt = /json/i.test(systemPrompt)
    ? systemPrompt
    : systemPrompt + '\nJSON 형식으로만 답하세요.';

  let lastErr: unknown;
  for (let attempt = 0; attempt < Math.min(3, clients.length); attempt++) {
    const groq = clients[(_groqIdx + attempt) % clients.length];
    try {
      const res = await groq.chat.completions.create({
        model: SHADOW_PRIMARY,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 400,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      _groqIdx = (_groqIdx + attempt + 1) % clients.length;
      const text = res.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(text) as Record<string, unknown> & { _in?: number; _out?: number };
      parsed._in = res.usage?.prompt_tokens || 0;
      parsed._out = res.usage?.completion_tokens || 0;
      return parsed;
    } catch (error) {
      lastErr = error;
      if ((error as { status?: number } | null)?.status !== 429) throw error;
    }
  }
  throw lastErr;
}

async function _callLocal(systemPrompt: string, userContent: string): Promise<Record<string, unknown>> {
  const parsed = await callLocalLLMJSON(SHADOW_FALLBACK, [
    {
      role: 'system',
      content: /json/i.test(systemPrompt)
        ? systemPrompt
        : `${systemPrompt}\nJSON 형식으로만 답하세요.`,
    },
    { role: 'user', content: userContent },
  ], {
    maxTokens: 400,
    temperature: 0.1,
    timeoutMs: 30000,
  });

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('local shadow JSON 응답 없음');
  }

  return {
    ...(parsed as Record<string, unknown>),
    _in: 0,
    _out: 0,
  };
}

function _extractDecision(obj: ShadowResult): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const val = (obj as Record<string, unknown>).decision
    ?? (obj as Record<string, unknown>).action
    ?? (obj as Record<string, unknown>).classification
    ?? (obj as Record<string, unknown>).result
    ?? null;
  return val !== null ? String(val).toLowerCase().trim() : null;
}

function _compareResults(ruleResult: ShadowResult, llmResult: ShadowResult): boolean {
  if (!ruleResult || !llmResult) return false;
  const r = _extractDecision(ruleResult);
  const l = _extractDecision(llmResult);
  if (!r || !l) return false;
  return r === l;
}

function _validateWithRule(llmResult: ShadowResult, ruleResult: ShadowResult): boolean {
  const llmDec = _extractDecision(llmResult) || '';
  const ruleDec = _extractDecision(ruleResult) || '';
  return llmDec === ruleDec || llmDec === 'reject';
}

function _isDangerous(llmResult: ShadowResult): boolean {
  const dec = _extractDecision(llmResult) || '';
  return dec.includes('delete') || dec.includes('삭제') || dec.includes('force');
}

async function _logShadowResult({
  team, context, inputSummary, ruleResult, llmResult,
  llmError, match, mode, fallback, elapsedMs,
}: {
  team: string;
  context: string;
  inputSummary?: string | null;
  ruleResult: Record<string, unknown>;
  llmResult: ShadowResult;
  llmError: string | null;
  match: boolean;
  mode: string;
  fallback?: boolean;
  elapsedMs?: number | null;
}): Promise<void> {
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
    llmResult ? JSON.stringify(llmResult) : null,
    llmError || null,
    match,
    mode,
    fallback || false,
    elapsedMs || null,
  ]);
}

async function evaluate({
  team,
  context,
  input,
  ruleEngine,
  llmPrompt,
  mode,
}: {
  team: string;
  context: string;
  input: unknown;
  ruleEngine: RuleEngine;
  llmPrompt: string;
  mode?: ShadowMode;
}): Promise<{
  action: Record<string, unknown>;
  shadow: ShadowResult;
  match: boolean | null;
  mode: string;
  fallback?: boolean;
}> {
  const effectiveMode = mode || TEAM_MODE[team] || 'shadow';

  if (effectiveMode === 'off') {
    const ruleResult = await Promise.resolve(ruleEngine(input));
    return { action: ruleResult, shadow: null, match: null, mode: 'off' };
  }

  const startTime = Date.now();
  const ruleResult = await Promise.resolve(ruleEngine(input));

  let llmResult: ShadowResult = null;
  let llmError: string | null = null;
  let cacheHit = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let usedFallback = false;
  let usedModel = SHADOW_PRIMARY;

  const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
  const cacheType = `shadow_${context}`;

  try {
    const hit = await cache.getCached(team, cacheType, inputStr);
    if (hit) {
      llmResult = JSON.parse(hit.response);
      cacheHit = true;
    } else {
      let raw: Record<string, unknown>;
      try {
        raw = await _callGroq(llmPrompt, inputStr);
      } catch {
        raw = await _callLocal(llmPrompt, inputStr);
        usedFallback = true;
        usedModel = SHADOW_FALLBACK;
      }
      inputTokens = Number(raw._in || 0);
      outputTokens = Number(raw._out || 0);
      delete raw._in;
      delete raw._out;
      llmResult = raw;
      await cache.setCache(team, cacheType, inputStr, JSON.stringify(llmResult), usedModel);
    }
  } catch (error) {
    llmError = String((error as { message?: string } | null)?.message || error);
  }

  const elapsed = Date.now() - startTime;
  const match = _compareResults(ruleResult, llmResult);

  llmLog.logLLMCall({
    team,
    bot: `shadow_${team}_${context}`,
    model: usedModel,
    requestType: cacheType,
    inputTokens,
    outputTokens,
    cacheHit,
    latencyMs: elapsed,
    success: llmError === null,
    errorMsg: llmError,
  }).catch(() => {});

  const inputSummary = inputStr.slice(0, 200).replace(/\d{6,}/g, '***');
  _logShadowResult({
    team, context, inputSummary, ruleResult, llmResult,
    llmError, match, mode: effectiveMode, fallback: usedFallback, elapsedMs: elapsed,
  }).catch((error) => { console.warn('[shadow-mode] shadow_log 기록 실패 (메인 로직에 영향 없음):', error.message); });

  if (effectiveMode === 'confirmation') {
    if (llmResult && _validateWithRule(llmResult, ruleResult)) {
      return { action: llmResult as Record<string, unknown>, shadow: ruleResult, match, mode: effectiveMode };
    }
    return { action: ruleResult, shadow: llmResult, match, mode: effectiveMode, fallback: true };
  }

  if (effectiveMode === 'llm_primary') {
    if (llmResult && !_isDangerous(llmResult)) {
      return { action: llmResult as Record<string, unknown>, shadow: ruleResult, match, mode: effectiveMode };
    }
    return { action: ruleResult, shadow: llmResult, match, mode: effectiveMode, fallback: true };
  }

  return { action: ruleResult, shadow: llmResult, match, mode: effectiveMode };
}

async function getMatchRate(team: string, context: string | null = null, days = 7): Promise<{
  total: number;
  matched: number;
  matchRate: number | null;
  llmErrors: number;
  avgElapsedMs: number;
}> {
  await _ensureTable();
  const params: unknown[] = [team, days];
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

  const total = row?.total || 0;
  const matched = row?.matched || 0;
  const matchRate = total > 0 ? Math.round((matched / total) * 1000) / 10 : null;

  return {
    total,
    matched,
    matchRate,
    llmErrors: row?.llm_errors || 0,
    avgElapsedMs: row?.avg_elapsed_ms || 0,
  };
}

async function getMismatches(team: string, context: string | null = null, days = 7): Promise<any[]> {
  await _ensureTable();
  const params: unknown[] = [team, days];
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

async function buildShadowReport(team: string, days = 1): Promise<string> {
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
        ` (현재 ${stats.matchRate}% → ${achieved ? '✅ 달성' : '미달'})`,
      );
    }
  } else {
    lines.push('(데이터 없음)');
  }

  return lines.join('\n');
}

let _teamModeTableReady = false;
const _teamModeCache: Record<string, { mode: string; expiresAt: number }> = {};

async function _ensureTeamModeTable(): Promise<void> {
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

async function getTeamMode(team: string): Promise<string> {
  const cached = _teamModeCache[team];
  if (cached && cached.expiresAt > Date.now()) return cached.mode;
  try {
    await _ensureTeamModeTable();
    const row = await pgPool.get('claude', `SELECT mode FROM team_modes WHERE team = $1`, [team]);
    const mode = row?.mode ?? 'shadow';
    _teamModeCache[team] = { mode, expiresAt: Date.now() + 60_000 };
    return mode;
  } catch {
    return 'shadow';
  }
}

async function setTeamMode(team: string, mode: ShadowMode, updatedBy = 'master'): Promise<{ team: string; mode: string; updatedBy: string }> {
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

async function pruneOldLogs(keepDays = 30): Promise<number> {
  try {
    await _ensureTable();
    const { rowCount } = await pgPool.run(SCHEMA, `
      DELETE FROM shadow_log
      WHERE created_at < NOW() - ($1 * INTERVAL '1 day')
    `, [keepDays]);
    return rowCount || 0;
  } catch {
    return 0;
  }
}

export = {
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
