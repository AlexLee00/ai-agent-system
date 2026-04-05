'use strict';

/**
 * packages/core/lib/llm-fallback.js — 공통 LLM 폴백 체인 실행기
 *
 * 여러 provider를 순서대로 시도하여 첫 번째 성공 응답을 반환.
 * 실패 시 다음 provider로 자동 넘어감.
 *
 * 지원 provider:
 *   anthropic — claude-sonnet-4-6 등 (Anthropic SDK)
 *   openai    — gpt-4o
 *   claude-code — Claude Code CLI 비대화식 실행
 *   groq      — llama-4-scout 등 (Groq SDK / OpenAI-compat)
 *   gemini    — gemini-2.5-flash (Google Generative AI SDK)
 *
 * 사용법:
 *   const { callWithFallback } = require('../../../packages/core/lib/llm-fallback');
 *   const result = await callWithFallback({
 *     chain: [
 *       { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 300, temperature: 0.1 },
 *       { provider: 'openai',    model: 'gpt-4o',            maxTokens: 300 },
 *       { provider: 'groq',      model: 'openai/gpt-oss-20b', maxTokens: 300 },
 *     ],
 *     systemPrompt,
 *     userPrompt,
 *     logMeta: { team: 'claude', bot: 'lead-brain', requestType: 'system_issue_triage' },
 *   });
 *   // result: { text: string, provider, model, attempt }
 */

const {
  initHubConfig,
  getAnthropicKey,
  getOpenAIKey,
  getGeminiKey,
  getGroqAccounts,
} = require('./llm-keys');
const { logLLMCall } = require('./llm-logger');
const traceCollector = require('./trace-collector');
const billingGuard = require('./billing-guard');
const { trackTokens } = require('./token-tracker');
const { fetchHubSecrets } = require('./hub-client');
const { selectRuntime } = require('./runtime-selector');
const env = require('./env');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// ── 그루크 계정 라운드로빈 인덱스 ────────────────────────────────────
let _groqIdx = 0;
let _oauthToken = null;
let _oauthTokenExpiry = 0;
let _evalTableReady = false;
const OAUTH_CACHE_TTL = 300_000;
const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const EVAL_EXCLUDED_PROVIDERS = new Set(['openai-oauth', 'openai', 'anthropic']);
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 60_000;
const _providerFailures = new Map();

function _isProviderCoolingDown(provider) {
  const entry = _providerFailures.get(provider);
  if (!entry || entry.count < MAX_CONSECUTIVE_FAILURES) return false;
  if (Date.now() - entry.lastFailAt > FAILURE_COOLDOWN_MS) {
    _providerFailures.delete(provider);
    return false;
  }
  return true;
}

function _recordProviderFailure(provider) {
  const key = String(provider || '').trim();
  if (!key) return;
  const entry = _providerFailures.get(key) || { count: 0, lastFailAt: 0 };
  entry.count += 1;
  entry.lastFailAt = Date.now();
  _providerFailures.set(key, entry);
}

function _recordProviderSuccess(provider) {
  const key = String(provider || '').trim();
  if (!key) return;
  _providerFailures.delete(key);
}

// ── 응답 텍스트 정규화 ────────────────────────────────────────────────
function _extractText(resp, provider) {
  if (provider === 'anthropic') {
    return resp?.content?.[0]?.text?.trim() || '';
  }
  if (provider === 'openai' || provider === 'groq') {
    return resp?.choices?.[0]?.message?.content?.trim() || '';
  }
  if (provider === 'claude-code') {
    return resp?.result?.trim() || '';
  }
  if (provider === 'gemini') {
    // SDK v0.21+ 응답 구조: resp.response.text()
    return resp?.response?.text?.()?.trim()
      || resp?.text?.()?.trim()
      || resp?.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
      || '';
  }
  return '';
}

// ── provider별 단건 호출 ─────────────────────────────────────────────

async function _callAnthropic({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt }) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error('Anthropic API 키 없음');
  const Anthropic = require('@anthropic-ai/sdk');
  const { getTimeout } = require('./llm-timeouts');
  const client = new Anthropic({ apiKey, timeout: getTimeout(model), maxRetries: 1 });
  return client.messages.create({
    model,
    max_tokens:  maxTokens,
    temperature,
    system:      systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });
}

async function _callOpenAI({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt, baseURL }) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OpenAI API 키 없음');
  const OpenAI = require('openai');
  const opts = { apiKey };
  if (baseURL) opts.baseURL = baseURL;
  const client = new OpenAI(opts);
  return client.chat.completions.create({
    model,
    max_tokens:  maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  });
}

async function _getOAuthToken() {
  if (_oauthToken && Date.now() < _oauthTokenExpiry) return _oauthToken;

  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (store?.openai_oauth?.access_token) {
      _oauthToken = store.openai_oauth.access_token;
      _oauthTokenExpiry = Date.now() + OAUTH_CACHE_TTL;
      return _oauthToken;
    }
  } catch { /* DEV나 미동기화 상태면 Hub 경유 */ }

  const data = await fetchHubSecrets('openai_oauth');
  if (data?.access_token) {
    _oauthToken = data.access_token;
    _oauthTokenExpiry = Date.now() + OAUTH_CACHE_TTL;
    return _oauthToken;
  }

  return null;
}

async function _callOpenAIOAuth({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt, timeoutMs = 30000, local = false, runtimeProfile = null }) {
  const openclawAgent = String(runtimeProfile?.openclaw_agent || process.env.OPENCLAW_AGENT || 'main').trim() || 'main';
  const prompt = [
    '[SYSTEM]',
    systemPrompt || '',
    '',
    '[USER]',
    userPrompt || '',
  ].join('\n');

  const args = [
    'agent',
    '--agent', openclawAgent,
    '--json',
    '--message', prompt,
    '--timeout', String(Math.max(10, Math.ceil(timeoutMs / 1000))),
  ];
  if (local) args.push('--local');

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('openclaw', args, {
      timeout: timeoutMs + 5000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        OPENCLAW_AGENT: openclawAgent,
      },
    });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (error) {
    const exitCode = error?.code ?? 'unknown';
    const signal = error?.signal || '';
    stdout = error?.stdout || '';
    stderr = error?.stderr || error?.message || '';
    const detail = [
      `exit=${exitCode}`,
      signal ? `signal=${signal}` : null,
      stderr ? `stderr=${String(stderr).trim().slice(0, 400)}` : null,
      stdout ? `stdout=${String(stdout).trim().slice(0, 240)}` : null,
    ].filter(Boolean).join(' | ');
    throw new Error(`OpenClaw agent 실행 실패: ${detail}`);
  }

  const output = String(stdout || '').trim();
  if (!output) {
    throw new Error(`OpenClaw agent 빈 응답${stderr ? `: ${String(stderr).slice(0, 160)}` : ''}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`OpenClaw agent JSON 파싱 실패: ${output.slice(0, 160)}`);
  }

  if (parsed?.status !== 'ok') {
    throw new Error(`OpenClaw agent 실패: ${parsed?.summary || parsed?.status || 'unknown'}`);
  }

  const text = parsed?.result?.payloads?.[0]?.text || '';
  const usage = parsed?.result?.meta?.agentMeta?.lastCallUsage || parsed?.result?.meta?.agentMeta?.usage || null;
  const provider = parsed?.result?.meta?.agentMeta?.provider || 'openai-codex';
  const usedModel = parsed?.result?.meta?.agentMeta?.model || model || 'gpt-5.4';

  return {
    choices: [{ message: { content: text } }],
    usage: usage ? {
      prompt_tokens: usage.input || 0,
      completion_tokens: usage.output || 0,
      total_tokens: usage.total || ((usage.input || 0) + (usage.output || 0)),
    } : null,
    _openclaw: {
      provider,
      model: usedModel,
      runId: parsed?.runId || null,
      durationMs: parsed?.result?.meta?.durationMs || null,
    },
  };
}

async function _callClaudeCode({ model, maxTokens, systemPrompt, userPrompt, timeoutMs = 45000, runtimeProfile = null }) {
  const resolvedModel = String(model || 'sonnet').replace(/^claude-code\//, '') || 'sonnet';
  const claudeSessionName = String(runtimeProfile?.claude_code_name || process.env.CLAUDE_CODE_NAME || '').trim();
  const claudeSettingsFile = String(runtimeProfile?.claude_code_settings || process.env.CLAUDE_CODE_SETTINGS || '').trim();
  const claudeAgent = String(process.env.CLAUDE_CODE_AGENT || '').trim();
  const args = [
    '-p',
    '--output-format', 'json',
    '--max-turns', '1',
    '--model', resolvedModel,
    '--tools', '',
    '--permission-mode', 'default',
    '--no-session-persistence',
  ];
  if (claudeAgent) args.push('--agent', claudeAgent);
  if (claudeSessionName) args.push('--name', claudeSessionName);
  if (claudeSettingsFile) args.push('--settings', claudeSettingsFile);
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  args.push(userPrompt || '');

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync('/opt/homebrew/bin/claude', args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        CLAUDE_CODE_NAME: claudeSessionName || process.env.CLAUDE_CODE_NAME,
        CLAUDE_CODE_SETTINGS: claudeSettingsFile || process.env.CLAUDE_CODE_SETTINGS,
      },
    });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (error) {
    stdout = error?.stdout || '';
    stderr = error?.stderr || error?.message || '';
  }

  const output = String(stdout || '').trim();
  if (!output) {
    throw new Error(`Claude Code 빈 응답${stderr ? `: ${String(stderr).slice(0, 160)}` : ''}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`Claude Code JSON 파싱 실패: ${output.slice(0, 160)}`);
  }

  if (parsed?.is_error || parsed?.result?.includes?.('Not logged in')) {
    throw new Error(parsed?.result || 'Claude Code 실행 실패');
  }

  return {
    result: parsed?.result || '',
    usage: parsed?.usage ? {
      input_tokens: parsed.usage.input_tokens || 0,
      output_tokens: parsed.usage.output_tokens || 0,
    } : null,
    _claudeCode: {
      model: Object.keys(parsed?.modelUsage || {})[0] || resolvedModel,
      sessionId: parsed?.session_id || null,
      durationMs: parsed?.duration_ms || null,
    },
  };
}

function _inferErrorType(err) {
  const message = String(err?.message || '').toLowerCase();
  if (!message) return null;
  if (message.includes('429') || message.includes('rate limit') || message.includes('quota')) return 'rate_limit';
  if (message.includes('timeout') || message.includes('timed out') || message.includes('abort')) return 'timeout';
  if (message.includes('401') || message.includes('403') || message.includes('auth')) return 'auth';
  if (message.includes('network') || message.includes('fetch failed') || message.includes('ehostunreach') || message.includes('etimedout')) return 'network';
  return 'unknown';
}

async function _ensureEvalTable() {
  if (_evalTableReady || !env.IS_OPS) return;
  try {
    const pgPool = require('./pg-pool');
    await pgPool.run('claude', `
      CREATE TABLE IF NOT EXISTS llm_model_eval (
        id            SERIAL PRIMARY KEY,
        selector_key  VARCHAR(100) NOT NULL,
        agent_name    VARCHAR(50)  NOT NULL,
        team          VARCHAR(20)  NOT NULL,
        provider      VARCHAR(30)  NOT NULL,
        model         VARCHAR(60)  NOT NULL,
        is_primary    BOOLEAN DEFAULT false,
        is_fallback   BOOLEAN DEFAULT false,
        latency_ms    INTEGER,
        success       BOOLEAN NOT NULL,
        error_type    VARCHAR(50),
        token_input   INTEGER,
        token_output  INTEGER,
        quality_score REAL,
        created_at    TIMESTAMP DEFAULT NOW()
      )
    `);
    await pgPool.run('claude', 'CREATE INDEX IF NOT EXISTS idx_llm_eval_selector ON llm_model_eval(selector_key, created_at DESC)');
    await pgPool.run('claude', 'CREATE INDEX IF NOT EXISTS idx_llm_eval_model ON llm_model_eval(provider, model, created_at DESC)');
    _evalTableReady = true;
  } catch { /* 평가 테이블 생성 실패는 메인 로직에 영향 없음 */ }
}

async function _recordModelEval({
  selectorKey,
  agentName,
  team,
  provider,
  model,
  isPrimary,
  latencyMs,
  success,
  errorType,
  tokenInput,
  tokenOutput,
}) {
  if (EVAL_EXCLUDED_PROVIDERS.has(provider)) return;
  if (!env.IS_OPS) return;
  if (!selectorKey || !agentName || !team) return;

  try {
    await _ensureEvalTable();
    const pgPool = require('./pg-pool');
    await pgPool.run('claude', `
      INSERT INTO llm_model_eval
        (selector_key, agent_name, team, provider, model,
         is_primary, is_fallback, latency_ms, success, error_type,
         token_input, token_output)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      selectorKey,
      agentName,
      team,
      provider,
      model,
      isPrimary,
      !isPrimary,
      latencyMs,
      success,
      errorType || null,
      tokenInput || null,
      tokenOutput || null,
    ]);
  } catch { /* 기록 실패 무시 */ }
}

async function _groqSingleCall(apiKey, groqModel, maxTokens, temperature, systemPrompt, userPrompt) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
  // gpt-oss-20b는 추론(reasoning) 모델 — reasoning_effort:low로 내부 추론 토큰 최소화
  const isReasoning = groqModel.includes('gpt-oss-20b');
  const params = {
    model:      groqModel,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
  };
  if (isReasoning) params.reasoning_effort = 'low';
  return client.chat.completions.create(params);
}

async function _callGroq({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt }) {
  // groq/ 외부 네임스페이스만 제거
  const groqModel  = model.replace(/^groq\//, '');
  const accounts   = getGroqAccounts();

  // 계정 목록 없으면 환경변수 키로 1회 시도
  if (!accounts.length) {
    const envKey = process.env.GROQ_API_KEY;
    if (!envKey) throw new Error('Groq API 키 없음');
    return _groqSingleCall(envKey, groqModel, maxTokens, temperature, systemPrompt, userPrompt);
  }

  // 최대 3개 키 순회하며 429 retry
  const maxRetry = Math.min(accounts.length, 3);
  let lastError;

  for (let i = 0; i < maxRetry; i++) {
    const apiKey = accounts[(_groqIdx + i) % accounts.length]?.api_key;
    if (!apiKey) continue;
    try {
      const result = await _groqSingleCall(apiKey, groqModel, maxTokens, temperature, systemPrompt, userPrompt);
      _groqIdx = (_groqIdx + i + 1) % accounts.length;  // 성공 키 다음부터 시작
      return result;
    } catch (e) {
      lastError = e;
      const is429 = e.status === 429 || e.message?.includes('429') || e.message?.includes('rate_limit');
      if (is429) {
        console.warn(`  ⚠️ [Groq] 429 rate limit → 키 ${i + 1}/${maxRetry} 실패, 다음 키 시도...`);
        continue;
      }
      throw e;  // 429 외 오류는 즉시 throw
    }
  }

  throw lastError || new Error('Groq 전체 키 소진 (429)');
}

async function _callGemini({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt }) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error('Gemini API 키 없음');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genai  = new GoogleGenerativeAI(apiKey);
  const gemini = genai.getGenerativeModel({
    model: model.replace(/^google-gemini-cli\//, ''),
    systemInstruction: systemPrompt,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },  // thinking 비활성 (단순 생성 태스크)
    },
  });
  return gemini.generateContent(userPrompt);
}

// ── provider 디스패처 ─────────────────────────────────────────────────

async function _callProvider(cfg, systemPrompt, userPrompt, timeoutMs, runtimeProfile = null) {
  const { provider, model, maxTokens, temperature } = cfg;
  const opts = {
    model,
    maxTokens,
    temperature,
    systemPrompt,
    userPrompt,
    timeoutMs: cfg.timeoutMs || timeoutMs,
    local: cfg.local === true,
    runtimeProfile,
  };

  switch (provider) {
    case 'anthropic': {
      const resp = await _callAnthropic(opts);
      return { raw: resp, text: _extractText(resp, 'anthropic'), usage: resp.usage };
    }
    case 'openai': {
      const resp = await _callOpenAI(opts);
      return { raw: resp, text: _extractText(resp, 'openai'), usage: resp.usage };
    }
    case 'openai-oauth': {
      const resp = await _callOpenAIOAuth(opts);
      return { raw: resp, text: _extractText(resp, 'openai'), usage: resp.usage };
    }
    case 'claude-code': {
      const resp = await _callClaudeCode(opts);
      return { raw: resp, text: _extractText(resp, 'claude-code'), usage: resp.usage };
    }
    case 'groq': {
      const resp = await _callGroq(opts);
      return { raw: resp, text: _extractText(resp, 'groq'), usage: resp.usage };
    }
    case 'gemini': {
      const resp = await _callGemini(opts);
      return { raw: resp, text: _extractText(resp, 'gemini'), usage: null };
    }
    case 'local': {
      const localLLM = require('./local-llm-client');
      const result = await localLLM.callLocalLLM(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        maxTokens,
        temperature,
        baseUrl: runtimeProfile?.local_llm_base_url || null,
      });
      if (!result) throw new Error('로컬 LLM 응답 없음');
      return { raw: null, text: result.trim(), usage: null };
    }
    case 'ollama': {
      const localLLM = require('./local-llm-client');
      const result = await localLLM.callLocalLLM(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        maxTokens,
        temperature,
        baseUrl: env.OLLAMA_BASE_URL,
        timeoutMs: cfg.timeoutMs || 10000,
      });
      if (!result) throw new Error('Ollama LLM 응답 없음');
      return { raw: null, text: result.trim(), usage: null };
    }
    default:
      throw new Error(`알 수 없는 provider: ${provider}`);
  }
}

function _inferRuntimePurpose(logMeta = {}) {
  const explicit = String(logMeta.purpose || '').trim();
  if (explicit) return explicit;

  const requestType = String(logMeta.requestType || '').trim().toLowerCase();
  const team = String(logMeta.team || '').trim().toLowerCase();

  if (team === 'blog') {
    if (requestType.includes('curriculum')) return 'curriculum';
    if (requestType.includes('insta') || requestType.includes('social')) return 'social';
    if (requestType.includes('lecture') || requestType.includes('general')) return 'writer';
  }

  if (team === 'investment' || team === 'luna') {
    if (requestType.includes('valid')) return 'validator';
    if (requestType.includes('command')) return 'commander';
    return 'analyst';
  }

  return 'default';
}

// ── 메인 폴백 체인 실행 ───────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array<{provider, model, maxTokens, temperature}>} opts.chain
 * @param {string}   opts.systemPrompt
 * @param {string}   opts.userPrompt
 * @param {object}   [opts.logMeta]  { team, bot, requestType }
 * @returns {Promise<{text, provider, model, attempt}>}
 * @throws 모든 체인 실패 시 마지막 오류를 throw
 */
async function callWithFallback({ chain, systemPrompt, userPrompt, logMeta = {}, timeoutMs = null, team = null, purpose = null }) {
  await initHubConfig();

  // ★ 긴급 차단 체크
  const guardScope = logMeta.team || 'global';
  if (billingGuard.isBlocked(guardScope)) {
    const r = billingGuard.getBlockReason(guardScope);
    throw new Error(`🚨 LLM 긴급 차단 중: ${r?.reason || '알 수 없음'} — 마스터 해제 필요`);
  }
  if (!chain || chain.length === 0) throw new Error('폴백 체인이 비어 있음');
  const runtimeTeam = String(team || logMeta.team || '').trim() || null;
  const runtimePurpose = String(purpose || _inferRuntimePurpose(logMeta)).trim() || 'default';
  const runtimeProfile = runtimeTeam ? await selectRuntime(runtimeTeam, runtimePurpose) : null;
  const runtimeOpenClawAgent = String(runtimeProfile?.openclaw_agent || '').trim() || null;
  const runtimeClaudeCodeName = String(runtimeProfile?.claude_code_name || '').trim() || null;
  const runtimeSelectionReason = runtimeProfile ? 'team-runtime-profile' : 'env-fallback';
  const traceRoute = logMeta.selectorKey || logMeta.requestType || null;
  const trace = traceCollector.startTrace(logMeta.agentName || logMeta.bot || null, logMeta.team || null, traceRoute);

  let lastError;
  for (let i = 0; i < chain.length; i++) {
    const cfg     = chain[i];
    if (_isProviderCoolingDown(cfg.provider)) {
      console.warn(`[llm-fallback] ${cfg.provider} 연속 ${MAX_CONSECUTIVE_FAILURES}회 실패 → 쿨다운 중, 건너뜀`);
      continue;
    }
    const t0      = Date.now();
    const attempt = i + 1;
    try {
      const { text, usage } = await _callProvider(cfg, systemPrompt, userPrompt, timeoutMs, runtimeProfile);
      const latencyMs = Date.now() - t0;
      _recordProviderSuccess(cfg.provider);
      const tokensIn  = usage?.input_tokens  || usage?.prompt_tokens     || 0;
      const tokensOut = usage?.output_tokens || usage?.completion_tokens || 0;

      // LLM 사용 로깅
      if (logMeta.team) {
        try {
          logLLMCall({
            team:         logMeta.team,
            bot:          logMeta.bot  || logMeta.team,
            model:        cfg.model,
            requestType:  logMeta.requestType,
            inputTokens:  tokensIn,
            outputTokens: tokensOut,
            latencyMs,
            success: true,
            runtimeTeam,
            runtimePurpose,
            runtimeOpenClawAgent,
            runtimeClaudeCodeName,
            runtimeSelectionReason,
          });
        } catch { /* 로깅 실패 무시 */ }
        // 토큰 트래커 (비용 통계)
        trackTokens({
          bot:       logMeta.bot  || logMeta.team,
          team:      logMeta.team,
          model:     cfg.model,
          provider:  cfg.provider,
          taskType:  logMeta.requestType || 'unknown',
          tokensIn,
          tokensOut,
          durationMs: latencyMs,
        }).catch(() => {});
      }

      _recordModelEval({
        selectorKey: logMeta.selectorKey,
        agentName: logMeta.agentName,
        team: logMeta.team,
        provider: cfg.provider,
        model: cfg.model,
        isPrimary: i === 0,
        latencyMs,
        success: true,
        errorType: null,
        tokenInput: tokensIn,
        tokenOutput: tokensOut,
      }).catch(() => {});

      traceCollector.recordGeneration(trace, {
        model: cfg.model,
        provider: cfg.provider,
        route: traceRoute,
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        latencyMs,
        status: i > 0 ? 'fallback' : 'success',
        fallbackUsed: i > 0,
        fallbackProvider: i > 0 ? cfg.provider : null,
        confidence: null,
        qualityScore: null,
      });

      if (i > 0) {
        console.log(`  ↳ [폴백] ${cfg.provider}/${cfg.model} (시도 ${attempt}) 성공`);
      }

      return { text, provider: cfg.provider, model: cfg.model, attempt };

    } catch (e) {
      lastError = e;
      _recordProviderFailure(cfg.provider);
      const latencyMs = Date.now() - t0;

      if (logMeta.team) {
        try {
          logLLMCall({
            team:        logMeta.team,
            bot:         logMeta.bot || logMeta.team,
            model:       cfg.model,
            requestType: logMeta.requestType,
            latencyMs,
            success:     false,
            errorMsg:    e.message?.slice(0, 200),
            runtimeTeam,
            runtimePurpose,
            runtimeOpenClawAgent,
            runtimeClaudeCodeName,
            runtimeSelectionReason,
          });
        } catch { /* 로깅 실패 무시 */ }
      }

      _recordModelEval({
        selectorKey: logMeta.selectorKey,
        agentName: logMeta.agentName,
        team: logMeta.team,
        provider: cfg.provider,
        model: cfg.model,
        isPrimary: i === 0,
        latencyMs,
        success: false,
        errorType: _inferErrorType(e),
        tokenInput: null,
        tokenOutput: null,
      }).catch(() => {});

      traceCollector.recordGeneration(trace, {
        model: cfg.model,
        provider: cfg.provider,
        route: traceRoute,
        latencyMs,
        status: 'error',
        errorMessage: e.message,
        fallbackUsed: i > 0,
        fallbackProvider: i > 0 ? cfg.provider : null,
      });

      const isLast = i === chain.length - 1;
      console.warn(`  ⚠️ [폴백] ${cfg.provider}/${cfg.model} (시도 ${attempt}) 실패: ${e.message?.slice(0, 80)}${isLast ? ' — 모든 폴백 소진' : ' → 다음 시도...'}`);
    }
  }

  if (!lastError) {
    const coolingProviders = chain
      .filter((c) => _isProviderCoolingDown(c.provider))
      .map((c) => c.provider);
    lastError = new Error(
      `모든 LLM provider가 연속 실패로 쿨다운 중: [${coolingProviders.join(', ')}]. ` +
      `${FAILURE_COOLDOWN_MS / 1000}초 후 자동 재시도됩니다.`
    );
  }
  throw lastError;
}

module.exports = { callWithFallback };
