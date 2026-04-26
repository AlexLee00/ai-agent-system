/**
 * packages/core/lib/llm-fallback.js — 공통 LLM 폴백 체인 실행기
 *
 * 여러 provider를 순서대로 시도하여 첫 번째 성공 응답을 반환.
 * 실패 시 다음 provider로 자동 넘어감.
 *
 * 지원 provider:
 *   anthropic — claude-sonnet-4-6 등 (Anthropic SDK)
 *   openai    — gpt-4o
 *   openai-oauth — Hub에 수집된 OpenAI Codex OAuth 토큰으로 ChatGPT Codex backend 직접 호출
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
const { spawn } = require('child_process');

type FallbackChainEntry = {
  provider: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
  local?: boolean;
};

type FallbackLogMeta = {
  team?: string;
  bot?: string;
  requestType?: string;
  purpose?: string;
  selectorKey?: string;
  agentName?: string;
  [key: string]: any;
};

type AttemptTraceEntry = {
  provider: string;
  model: string;
  status: 'success' | 'error' | 'skipped';
  reason?: string | null;
};

type ProviderFailureState = {
  count: number;
  lastFailAt: number;
};

type RuntimeProfile = {
  runtime_agent?: string;
  claude_code_name?: string;
  claude_code_settings?: string;
  local_llm_base_url?: string;
} | null;

type ProviderCallOptions = {
  model: string;
  maxTokens: number;
  temperature?: number;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number | null;
  local?: boolean;
  runtimeProfile?: RuntimeProfile;
};

type ProviderUsage = {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
};

type ProviderCallResult = {
  raw: unknown;
  text: string;
  usage: ProviderUsage | null;
  provider?: string | null;
  model?: string | null;
};

type OAuthStore = {
  openai_oauth?: {
    access_token?: string;
    expires?: number | string;
    expires_at?: string;
    account_id?: string;
  };
};

type OAuthProviderToken = {
  access_token?: string;
  expires?: number | string;
  expires_at?: string;
  account_id?: string;
};

type OAuthProviderStore = {
  providers?: Record<string, {
    token?: OAuthProviderToken | null;
  } | null>;
};

type OAuthSecretPayload = {
  access_token?: string;
  expires?: number | string;
  expires_at?: string;
  account_id?: string;
};

type ExecFileErrorLike = {
  code?: string | number;
  signal?: string;
  stdout?: string;
  stderr?: string;
  message?: string;
};

type ClaudeCodeResponse = {
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  session_id?: string;
  duration_ms?: number;
  is_error?: boolean;
};

// ── 그루크 계정 라운드로빈 인덱스 ────────────────────────────────────
let _groqIdx = 0;
let _oauthToken: string | null = null;
let _oauthAccountId: string | null = null;
let _oauthTokenExpiry = 0;
let _evalTableReady = false;
const OAUTH_CACHE_TTL = 300_000;
const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const OAUTH_PROVIDER_STORE_PATH = process.env.HUB_OAUTH_STORE_FILE
  || path.join(env.PROJECT_ROOT, 'bots', 'hub', 'output', 'oauth', 'token-store.json');
const EVAL_EXCLUDED_PROVIDERS = new Set(['openai-oauth', 'openai', 'anthropic']);
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 60_000;
const _providerFailures = new Map<string, ProviderFailureState>();
let _localCircuitBreaker: {
  isCircuitOpen?: (baseUrl: string) => boolean;
} | null = null;

function _getLocalCircuitBreaker() {
  if (_localCircuitBreaker) return _localCircuitBreaker;
  try {
    _localCircuitBreaker = require('./local-circuit-breaker');
  } catch {
    _localCircuitBreaker = {};
  }
  return _localCircuitBreaker;
}

function _isProviderCoolingDown(provider: string): boolean {
  const entry = _providerFailures.get(provider);
  if (!entry || entry.count < MAX_CONSECUTIVE_FAILURES) return false;
  if (Date.now() - entry.lastFailAt > FAILURE_COOLDOWN_MS) {
    _providerFailures.delete(provider);
    return false;
  }
  return true;
}

function _recordProviderFailure(provider: string): void {
  const key = String(provider || '').trim();
  if (!key) return;
  const entry = _providerFailures.get(key) || { count: 0, lastFailAt: 0 };
  entry.count += 1;
  entry.lastFailAt = Date.now();
  _providerFailures.set(key, entry);
}

function _recordProviderSuccess(provider: string): void {
  const key = String(provider || '').trim();
  if (!key) return;
  _providerFailures.delete(key);
}

// ── 응답 텍스트 정규화 ────────────────────────────────────────────────
function _extractText(resp: any, provider: string): string {
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

async function _callAnthropic({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt }: ProviderCallOptions) {
  const apiKey = getAnthropicKey();
  if (!apiKey) throw new Error('Anthropic API 키 없음');
  const anthropicModule = require('@anthropic-ai/sdk');
  const Anthropic = /** @type {any} */ (anthropicModule.default || anthropicModule);
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

function _parseOAuthExpiry(value: number | string | undefined | null): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function _decodeJwtPayload(token: string): Record<string, any> | null {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function _extractOpenAICodexAccountId(token: string, fallback?: string | null): string | null {
  const direct = String(fallback || '').trim();
  if (direct) return direct;
  const payload = _decodeJwtPayload(token);
  const claim = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return typeof claim === 'string' && claim.trim() ? claim.trim() : null;
}

function _cacheOpenAIOAuthToken(token: string, expiresAt: number | null = null, accountId: string | null = null): string {
  _oauthToken = token;
  _oauthAccountId = accountId;
  const safeExpiry = expiresAt && expiresAt > Date.now()
    ? Math.min(expiresAt - 30_000, Date.now() + OAUTH_CACHE_TTL)
    : Date.now() + OAUTH_CACHE_TTL;
  _oauthTokenExpiry = Math.max(Date.now() + 1_000, safeExpiry);
  return _oauthToken;
}

function _extractUsableOpenAIOAuthToken(
  token: OAuthProviderToken | OAuthStore['openai_oauth'] | OAuthSecretPayload | null | undefined,
): { token: string; expiresAt: number | null; accountId: string | null } | null {
  const accessToken = String(token?.access_token || '').trim();
  if (!accessToken) return null;

  const expiresAt = _parseOAuthExpiry(token?.expires_at || token?.expires);
  if (expiresAt && expiresAt <= Date.now() + 60_000) return null;
  return {
    token: accessToken,
    expiresAt,
    accountId: _extractOpenAICodexAccountId(accessToken, token?.account_id || null),
  };
}

function _readOpenAIOAuthTokenStore(): { token: string; expiresAt: number | null; accountId: string | null } | null {
  try {
    const store = JSON.parse(fs.readFileSync(OAUTH_PROVIDER_STORE_PATH, 'utf8')) as OAuthProviderStore;
    const providers = store?.providers || {};
    const candidates = [
      providers['openai-codex-oauth']?.token,
      providers['openai-oauth']?.token,
      providers['openai_oauth']?.token,
    ];
    for (const candidate of candidates) {
      const usable = _extractUsableOpenAIOAuthToken(candidate || null);
      if (usable) return usable;
    }
  } catch { /* token-store 미생성/미동기화 상태면 legacy/Hub 경로로 폴백 */ }
  return null;
}

/** @param {{ model: string, maxTokens: number, temperature?: number, systemPrompt: string, userPrompt: string, baseURL?: string|null }} input */
async function _callOpenAI({
  model,
  maxTokens,
  temperature = 0.1,
  systemPrompt,
  userPrompt,
  baseURL = null,
}: {
  model: string;
  maxTokens: number;
  temperature?: number;
  systemPrompt: string;
  userPrompt: string;
  baseURL?: string | null;
}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OpenAI API 키 없음');
  const openaiModule = require('openai');
  const OpenAI = /** @type {any} */ (openaiModule.default || openaiModule);
  const opts: any = { apiKey };
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

async function _getOAuthToken(): Promise<string | null> {
  const credential = await _getOAuthCredential();
  return credential?.token || null;
}

async function _getOAuthCredential(): Promise<{ token: string; accountId: string | null } | null> {
  if (_oauthToken && Date.now() < _oauthTokenExpiry) {
    return { token: _oauthToken, accountId: _oauthAccountId };
  }

  const envToken = String(process.env.OPENAI_OAUTH_ACCESS_TOKEN || process.env.OPENAI_CODEX_ACCESS_TOKEN || '').trim();
  if (envToken) {
    const accountId = _extractOpenAICodexAccountId(envToken, process.env.OPENAI_CODEX_ACCOUNT_ID || process.env.OPENAI_OAUTH_ACCOUNT_ID || null);
    return { token: _cacheOpenAIOAuthToken(envToken, null, accountId), accountId };
  }

  const providerStoreToken = _readOpenAIOAuthTokenStore();
  if (providerStoreToken) {
    return {
      token: _cacheOpenAIOAuthToken(providerStoreToken.token, providerStoreToken.expiresAt, providerStoreToken.accountId),
      accountId: providerStoreToken.accountId,
    };
  }

  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as OAuthStore;
    const legacyToken = _extractUsableOpenAIOAuthToken(store?.openai_oauth || null);
    if (legacyToken) {
      return {
        token: _cacheOpenAIOAuthToken(legacyToken.token, legacyToken.expiresAt, legacyToken.accountId),
        accountId: legacyToken.accountId,
      };
    }
  } catch { /* DEV나 미동기화 상태면 Hub 경유 */ }

  const data = await fetchHubSecrets('openai_oauth') as OAuthSecretPayload | null;
  const hubToken = _extractUsableOpenAIOAuthToken(data);
  if (hubToken) {
    return {
      token: _cacheOpenAIOAuthToken(hubToken.token, hubToken.expiresAt, hubToken.accountId),
      accountId: hubToken.accountId,
    };
  }

  return null;
}

function _getOpenAIOAuthBaseUrl(): string {
  return String(process.env.OPENAI_OAUTH_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function _getOpenAICodexBackendBaseUrl(): string {
  return String(process.env.OPENAI_CODEX_BACKEND_BASE_URL || process.env.OPENAI_CODEX_OAUTH_BACKEND_BASE_URL || 'https://chatgpt.com/backend-api').replace(/\/+$/, '');
}

function _resolveOpenAICodexResponsesUrl(): string {
  const baseUrl = _getOpenAICodexBackendBaseUrl();
  if (baseUrl.endsWith('/codex/responses')) return baseUrl;
  if (baseUrl.endsWith('/codex')) return `${baseUrl}/responses`;
  return `${baseUrl}/codex/responses`;
}

function _createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function _readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function _extractResponsesText(resp: any): string {
  if (typeof resp?.output_text === 'string' && resp.output_text.trim()) {
    return resp.output_text.trim();
  }
  const pieces: string[] = [];
  for (const item of Array.isArray(resp?.output) ? resp.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      const text = typeof content?.text === 'string'
        ? content.text
        : (typeof content?.content === 'string' ? content.content : '');
      if (text.trim()) pieces.push(text.trim());
    }
  }
  return pieces.join('\n').trim();
}

function _normalizeResponsesUsage(usage: any): ProviderUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    input_tokens: input,
    output_tokens: output,
  };
}

function _shouldRetryWithoutTemperature(status: number, body: any): boolean {
  const message = String(body?.error?.message || body?.message || '').toLowerCase();
  return status === 400 && message.includes('temperature');
}

function _shouldFallbackResponsesToChat(status: number, body: any): boolean {
  const message = String(body?.error?.message || body?.message || '').toLowerCase();
  return (
    status === 404 ||
    (status === 400 && message.includes('responses') && (message.includes('not supported') || message.includes('unknown')))
  );
}

async function _postOpenAIJson({
  url,
  token,
  body,
  timeoutMs,
}: {
  url: string;
  token: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}): Promise<{ status: number; ok: boolean; body: any }> {
  const { signal, cleanup } = _createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    const parsed = await _readJsonResponse(res);
    return { status: res.status, ok: res.ok, body: parsed };
  } finally {
    cleanup();
  }
}

function _buildOpenAICodexRequestBody({
  model,
  temperature,
  systemPrompt,
  userPrompt,
}: {
  model: string;
  temperature: number;
  systemPrompt: string;
  userPrompt: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.replace(/^openai-oauth\//, '').replace(/^openai-codex\//, ''),
    store: false,
    stream: true,
    instructions: systemPrompt || '',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: userPrompt || '' }],
      },
    ],
    text: { verbosity: 'medium' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: `hub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
  if (process.env.OPENAI_CODEX_BACKEND_ENABLE_TEMPERATURE === 'true' && temperature !== undefined) {
    body.temperature = temperature;
  }
  return body;
}

async function _readSseEvents(res: Response): Promise<any[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: any[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim();
        if (data && data !== '[DONE]') {
          try {
            events.push(JSON.parse(data));
          } catch {
            // Ignore malformed SSE fragments and keep consuming the stream.
          }
        }
        idx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
  return events;
}

function _extractOpenAICodexStreamResult(events: any[]): { text: string; response: any | null } {
  const deltas: string[] = [];
  const doneTexts: string[] = [];
  let finalResponse: any | null = null;
  for (const event of events) {
    const type = String(event?.type || '');
    if (type === 'error') {
      throw new Error(`Codex error: ${String(event?.message || event?.code || 'unknown').slice(0, 400)}`);
    }
    if (type === 'response.failed') {
      throw new Error(String(event?.response?.error?.message || 'Codex response failed').slice(0, 400));
    }
    if (typeof event?.delta === 'string' && type.includes('output_text')) {
      deltas.push(event.delta);
    }
    if (type === 'response.output_text.done' && typeof event?.text === 'string') {
      doneTexts.push(event.text);
    }
    if (type === 'response.done' || type === 'response.completed' || type === 'response.incomplete') {
      finalResponse = event.response || null;
    }
  }
  const streamedText = deltas.join('').trim();
  if (streamedText) return { text: streamedText, response: finalResponse };
  const doneText = doneTexts.join('\n').trim();
  if (doneText) return { text: doneText, response: finalResponse };
  return { text: _extractResponsesText(finalResponse || {}), response: finalResponse };
}

async function _callOpenAICodexBackendResponses({
  token,
  accountId,
  model,
  temperature,
  systemPrompt,
  userPrompt,
  timeoutMs,
}: {
  token: string;
  accountId: string | null;
  model: string;
  temperature: number;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}) {
  const resolvedAccountId = _extractOpenAICodexAccountId(token, accountId);
  if (!resolvedAccountId) throw new Error('OpenAI Codex OAuth account_id 없음');
  const url = _resolveOpenAICodexResponsesUrl();
  const body = _buildOpenAICodexRequestBody({ model, temperature, systemPrompt, userPrompt });
  const { signal, cleanup } = _createTimeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'chatgpt-account-id': resolvedAccountId,
        originator: 'pi',
        'User-Agent': `pi (hub ${process.platform}; ${process.arch})`,
        'OpenAI-Beta': 'responses=experimental',
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const message = String((await _readJsonResponse(res))?.error?.message || `HTTP ${res.status}`).slice(0, 400);
      const error = new Error(`OpenAI Codex backend 호출 실패: ${message}`) as Error & { status?: number; responseBody?: any };
      error.status = res.status;
      throw error;
    }
    const events = await _readSseEvents(res);
    const { text, response } = _extractOpenAICodexStreamResult(events);
    if (!text) throw new Error('OpenAI Codex backend 빈 응답');
    const usage = _normalizeResponsesUsage(response?.usage);
    return {
      choices: [{ message: { content: text } }],
      usage: usage ? {
        prompt_tokens: usage.prompt_tokens || usage.input_tokens || 0,
        completion_tokens: usage.completion_tokens || usage.output_tokens || 0,
        total_tokens: (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
      } : null,
      _openaiOAuth: {
        provider: 'openai-oauth',
        model,
        endpoint: 'codex.responses',
        responseId: response?.id || null,
      },
    };
  } finally {
    cleanup();
  }
}

async function _callOpenAIOAuthResponses({
  token,
  model,
  maxTokens,
  temperature,
  systemPrompt,
  userPrompt,
  timeoutMs,
}: {
  token: string;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}) {
  const baseUrl = _getOpenAIOAuthBaseUrl();
  const url = `${baseUrl}/responses`;
  const baseBody: Record<string, unknown> = {
    model,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: systemPrompt || '' }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: userPrompt || '' }],
      },
    ],
    max_output_tokens: maxTokens,
  };
  const withTemperature = {
    ...baseBody,
    temperature,
  };

  let result = await _postOpenAIJson({ url, token, body: withTemperature, timeoutMs });
  if (!result.ok && _shouldRetryWithoutTemperature(result.status, result.body)) {
    result = await _postOpenAIJson({ url, token, body: baseBody, timeoutMs });
  }
  if (!result.ok) {
    const message = String(result.body?.error?.message || result.body?.message || `HTTP ${result.status}`).slice(0, 400);
    const error = new Error(`OpenAI OAuth Responses 호출 실패: ${message}`) as Error & { status?: number; responseBody?: any };
    error.status = result.status;
    error.responseBody = result.body;
    throw error;
  }

  const text = _extractResponsesText(result.body);
  if (!text) throw new Error('OpenAI OAuth Responses 빈 응답');
  const usage = _normalizeResponsesUsage(result.body?.usage);
  return {
    choices: [{ message: { content: text } }],
    usage: usage ? {
      prompt_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      completion_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
    } : null,
    _openaiOAuth: {
      provider: 'openai-oauth',
      model,
      endpoint: 'responses',
      responseId: result.body?.id || null,
    },
  };
}

async function _callOpenAIOAuthChat({
  token,
  model,
  maxTokens,
  temperature,
  systemPrompt,
  userPrompt,
  timeoutMs,
}: {
  token: string;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}) {
  const baseUrl = _getOpenAIOAuthBaseUrl();
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userPrompt || '' },
    ],
  };
  let result = await _postOpenAIJson({ url, token, body, timeoutMs });
  if (!result.ok && _shouldRetryWithoutTemperature(result.status, result.body)) {
    const { temperature: _omit, ...withoutTemperature } = body;
    result = await _postOpenAIJson({ url, token, body: withoutTemperature, timeoutMs });
  }
  if (!result.ok) {
    const message = String(result.body?.error?.message || result.body?.message || `HTTP ${result.status}`).slice(0, 400);
    throw new Error(`OpenAI OAuth Chat 호출 실패: ${message}`);
  }
  return {
    ...result.body,
    _openaiOAuth: {
      provider: 'openai-oauth',
      model,
      endpoint: 'chat.completions',
      responseId: result.body?.id || null,
    },
  };
}

async function _callOpenAIOAuth({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt, timeoutMs = 30000 }: ProviderCallOptions) {
  const resolvedTimeoutMs = timeoutMs ?? 30000;
  const credential = await _getOAuthCredential();
  if (!credential?.token) throw new Error('OpenAI OAuth 토큰 없음');
  const token = credential.token;

  const mode = String(process.env.OPENAI_OAUTH_ENDPOINT_MODE || process.env.OPENAI_OAUTH_API_MODE || 'codex_backend').trim().toLowerCase();
  if (['codex_backend', 'chatgpt_backend', 'openai-codex', 'openai_codex'].includes(mode)) {
    return _callOpenAICodexBackendResponses({ token, accountId: credential.accountId, model, temperature, systemPrompt, userPrompt, timeoutMs: resolvedTimeoutMs });
  }
  if (mode === 'chat' || mode === 'chat.completions') {
    return _callOpenAIOAuthChat({ token, model, maxTokens, temperature, systemPrompt, userPrompt, timeoutMs: resolvedTimeoutMs });
  }

  try {
    return await _callOpenAIOAuthResponses({ token, model, maxTokens, temperature, systemPrompt, userPrompt, timeoutMs: resolvedTimeoutMs });
  } catch (error) {
    const err = error as Error & { status?: number; responseBody?: any };
    if (_shouldFallbackResponsesToChat(Number(err.status || 0), err.responseBody)) {
      return _callOpenAIOAuthChat({ token, model, maxTokens, temperature, systemPrompt, userPrompt, timeoutMs: resolvedTimeoutMs });
    }
    throw error;
  }
}

async function _callClaudeCode({ model, maxTokens, systemPrompt, userPrompt, timeoutMs = 45000, runtimeProfile = null }: ProviderCallOptions) {
  const effectiveTimeoutMs = Number(timeoutMs || 45000);
  const resolvedModel = String(model || 'sonnet').replace(/^claude-code\//, '') || 'sonnet';
  const claudeSessionName = String(runtimeProfile?.claude_code_name || process.env.CLAUDE_CODE_NAME || '').trim();
  const claudeSettingsFile = String(runtimeProfile?.claude_code_settings || process.env.CLAUDE_CODE_SETTINGS || '').trim();
  const claudeAgent = String(process.env.CLAUDE_CODE_AGENT || '').trim();
  const buildArgs = () => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--max-turns', '2',
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
    return args;
  };

  const runClaudeOnce = async () => {
    const args = buildArgs();
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn('/opt/homebrew/bin/claude', args, {
        env: {
          ...process.env,
          CLAUDE_CODE_NAME: claudeSessionName || process.env.CLAUDE_CODE_NAME,
          CLAUDE_CODE_SETTINGS: claudeSettingsFile || process.env.CLAUDE_CODE_SETTINGS,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let settled = false;
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        const error = new Error(`Claude Code timeout after ${effectiveTimeoutMs}ms`) as ExecFileErrorLike;
        error.code = 'ETIMEDOUT';
        error.stdout = stdoutBuffer;
        error.stderr = stderrBuffer;
        reject(error);
      }, effectiveTimeoutMs);

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutBuffer += String(chunk || '');
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuffer += String(chunk || '');
      });
      child.on('error', (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        const execError = error as ExecFileErrorLike;
        execError.stdout = stdoutBuffer;
        execError.stderr = stderrBuffer || execError.stderr || '';
        reject(execError);
      });
      child.on('close', (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (code === 0) {
          resolve({ stdout: stdoutBuffer, stderr: stderrBuffer });
          return;
        }
        const error = new Error(`Claude Code 실행 실패: exit=${code}${signal ? ` signal=${signal}` : ''}`) as ExecFileErrorLike;
        error.code = code ?? undefined;
        error.signal = signal ?? undefined;
        error.stdout = stdoutBuffer;
        error.stderr = stderrBuffer;
        reject(error);
      });
    });
  };

  let stdout = '';
  let stderr = '';
  let output = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await runClaudeOnce();
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } catch (error) {
      const execError = error as ExecFileErrorLike;
      stdout = execError?.stdout || '';
      stderr = execError?.stderr || execError?.message || '';
    }

    output = String(stdout || '').trim();
    if (output) break;

    if (attempt < 2) {
      console.warn(`  ⚠️ [claude-code] 빈 응답 — 1회 재시도 (${String(stderr || '').trim().slice(0, 120) || 'no stderr'})`);
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }

  if (!output) {
    throw new Error(`Claude Code 빈 응답${stderr ? `: ${String(stderr).slice(0, 160)}` : ''}`);
  }

  let parsed: ClaudeCodeResponse;
  try {
    parsed = JSON.parse(output) as ClaudeCodeResponse;
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

function _inferErrorType(err: unknown): string | null {
  const message = String((err as Error | undefined)?.message || '').toLowerCase();
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
}: {
  selectorKey?: string;
  agentName?: string;
  team?: string;
  provider: string;
  model: string;
  isPrimary: boolean;
  latencyMs: number;
  success: boolean;
  errorType: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
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

async function _groqSingleCall(apiKey: string, groqModel: string, maxTokens: number, temperature: number, systemPrompt: string, userPrompt: string) {
  const openaiModule = require('openai');
  const OpenAI = /** @type {any} */ (openaiModule.default || openaiModule);
  const client = new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' });
  // gpt-oss-20b는 추론(reasoning) 모델 — reasoning_effort:low로 내부 추론 토큰 최소화
  const isReasoning = groqModel.includes('gpt-oss-20b');
  const params: any = {
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

async function _callGroq({
  model,
  maxTokens,
  temperature = 0.1,
  systemPrompt,
  userPrompt,
}: {
  model: string;
  maxTokens: number;
  temperature?: number;
  systemPrompt: string;
  userPrompt: string;
}) {
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
  let lastError: unknown;

  for (let i = 0; i < maxRetry; i++) {
    const apiKey = accounts[(_groqIdx + i) % accounts.length]?.api_key;
    if (!apiKey) continue;
    try {
      const result = await _groqSingleCall(apiKey, groqModel, maxTokens, temperature, systemPrompt, userPrompt);
      _groqIdx = (_groqIdx + i + 1) % accounts.length;  // 성공 키 다음부터 시작
      return result;
    } catch (e) {
      lastError = e;
      const error = e as { status?: number; message?: string };
      const is429 = error.status === 429 || error.message?.includes('429') || error.message?.includes('rate_limit');
      if (is429) {
        console.warn(`  ⚠️ [Groq] 429 rate limit → 키 ${i + 1}/${maxRetry} 실패, 다음 키 시도...`);
        continue;
      }
      throw e;  // 429 외 오류는 즉시 throw
    }
  }

  throw lastError || new Error('Groq 전체 키 소진 (429)');
}

async function _callGemini({ model, maxTokens, temperature = 0.1, systemPrompt, userPrompt }: ProviderCallOptions) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error('Gemini API 키 없음');
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genai  = new GoogleGenerativeAI(apiKey);
  const gemini = genai.getGenerativeModel({
    model: model.replace(/^google-gemini-cli\//, ''),
    systemInstruction: systemPrompt,
    generationConfig: /** @type {any} */ ({
      maxOutputTokens: maxTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },  // thinking 비활성 (단순 생성 태스크)
    }),
  });
  return gemini.generateContent(userPrompt);
}

// ── provider 디스패처 ─────────────────────────────────────────────────

async function _callProvider(
  cfg: FallbackChainEntry,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number | null,
  runtimeProfile: RuntimeProfile = null,
): Promise<ProviderCallResult> {
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
  const normalizedOpts: ProviderCallOptions = {
    ...opts,
    timeoutMs: opts.timeoutMs ?? undefined,
  };

  switch (provider) {
    case 'anthropic': {
      const resp = await _callAnthropic(normalizedOpts);
      return { raw: resp, text: _extractText(resp, 'anthropic'), usage: resp.usage, provider, model };
    }
    case 'openai': {
      const resp = await _callOpenAI(normalizedOpts);
      return { raw: resp, text: _extractText(resp, 'openai'), usage: resp.usage, provider, model };
    }
    case 'openai-oauth': {
      const resp = await _callOpenAIOAuth(normalizedOpts);
      return {
        raw: resp,
        text: _extractText(resp, 'openai'),
        usage: resp.usage,
        provider: resp?._openaiOAuth?.provider || provider,
        model: resp?._openaiOAuth?.model || model,
      };
    }
    case 'claude-code': {
      const resp = await _callClaudeCode(normalizedOpts);
      return {
        raw: resp,
        text: _extractText(resp, 'claude-code'),
        usage: resp.usage,
        provider,
        model: resp?._claudeCode?.model || model,
      };
    }
    case 'groq': {
      const resp = await _callGroq(normalizedOpts);
      return { raw: resp, text: _extractText(resp, 'groq'), usage: resp.usage, provider, model };
    }
    case 'gemini': {
      const resp = await _callGemini(normalizedOpts);
      return { raw: resp, text: _extractText(resp, 'gemini'), usage: null, provider, model };
    }
    case 'local': {
      const localClient = require('./local-llm-client');
      const result = await localClient.callLocalLLM(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        maxTokens,
        temperature,
        baseUrl: runtimeProfile?.local_llm_base_url || null,
      });
      if (!result) throw new Error('로컬 LLM 응답 없음');
      return { raw: null, text: result.trim(), usage: null, provider, model };
    }
    case 'ollama': {
      const ollamaClient = require('./local-llm-client');
      const result = await ollamaClient.callLocalLLM(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        maxTokens,
        temperature,
        baseUrl: null,
        timeoutMs: cfg.timeoutMs || 10000,
      });
      if (!result) throw new Error('Ollama LLM 응답 없음');
      return { raw: null, text: result.trim(), usage: null, provider, model };
    }
    default:
      throw new Error(`알 수 없는 provider: ${provider}`);
  }
}

function _inferRuntimePurpose(logMeta: FallbackLogMeta = {}) {
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
 * @param {Array<{provider, model, maxTokens, temperature, timeoutMs?: number, local?: boolean}>} opts.chain
 * @param {string}   opts.systemPrompt
 * @param {string}   opts.userPrompt
 * @param {object}   [opts.logMeta]  { team, bot, requestType }
 * @param {number|null} [opts.timeoutMs]
 * @param {string|null} [opts.team]
 * @param {string|null} [opts.purpose]
 * @returns {Promise<{text, provider, model, attempt, fallbackUsed, degradedFallback, source}>}
 * @throws 모든 체인 실패 시 마지막 오류를 throw
 */
export async function callWithFallback({ chain, systemPrompt, userPrompt, logMeta = {}, timeoutMs = null, team = null, purpose = null }: { chain: FallbackChainEntry[]; systemPrompt: string; userPrompt: string; logMeta?: FallbackLogMeta; timeoutMs?: number | null; team?: string | null; purpose?: string | null; }): Promise<{ text: string; provider: string; model: string; attempt: number; fallbackUsed: boolean; degradedFallback: boolean; source: 'selector' | 'fallback'; }> {
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
  const runtimeAgent = String(runtimeProfile?.runtime_agent || '').trim() || null;
  const runtimeClaudeCodeName = String(runtimeProfile?.claude_code_name || '').trim() || null;
  const runtimeSelectionReason = runtimeProfile ? 'team-runtime-profile' : 'env-fallback';
  const traceRoute = logMeta.selectorKey || logMeta.requestType || null;
  const trace = traceCollector.startTrace(logMeta.agentName || logMeta.bot || null, logMeta.team || null, traceRoute);
  const skippedProviders: string[] = [];
  const attemptTrace: AttemptTraceEntry[] = [];

  let lastError;
  for (let i = 0; i < chain.length; i++) {
    const cfg     = chain[i];
    if (cfg.provider === 'local') {
      if (!env.ENABLE_LOCAL_LLM_CHAT) {
        skippedProviders.push('local:chat_disabled');
        attemptTrace.push({
          provider: cfg.provider,
          model: cfg.model,
          status: 'skipped',
          reason: 'chat_disabled',
        });
        continue;
      }
      const localClient = require('./local-llm-client');
      const localCircuit = _getLocalCircuitBreaker();
      const candidateBaseUrls = typeof localClient.getBaseUrlCandidates === 'function'
        ? localClient.getBaseUrlCandidates({ baseUrl: runtimeProfile?.local_llm_base_url || null })
        : [String(runtimeProfile?.local_llm_base_url || '').trim()].filter(Boolean);
      if (candidateBaseUrls.length === 0) {
        skippedProviders.push('local:no_runtime_base_url');
        attemptTrace.push({
          provider: cfg.provider,
          model: cfg.model,
          status: 'skipped',
          reason: 'no_runtime_base_url',
        });
        continue;
      }
      const allCircuitsOpen = candidateBaseUrls.length > 0
        && typeof localCircuit.isCircuitOpen === 'function'
        && candidateBaseUrls.every((baseUrl: string) => localCircuit.isCircuitOpen(baseUrl));
      if (allCircuitsOpen) {
        console.warn(`[llm-fallback] local circuits OPEN → 체인에서 건너뜀 (${candidateBaseUrls.join(', ')})`);
        skippedProviders.push(`local:circuit_open`);
        attemptTrace.push({
          provider: cfg.provider,
          model: cfg.model,
          status: 'skipped',
          reason: 'circuit_open',
        });
        continue;
      }
    }
    if (_isProviderCoolingDown(cfg.provider)) {
      console.warn(`[llm-fallback] ${cfg.provider} 연속 ${MAX_CONSECUTIVE_FAILURES}회 실패 → 쿨다운 중, 건너뜀`);
      skippedProviders.push(`${cfg.provider}:provider_cooldown`);
      attemptTrace.push({
        provider: cfg.provider,
        model: cfg.model,
        status: 'skipped',
        reason: 'provider_cooldown',
      });
      continue;
    }
    const t0      = Date.now();
    const attempt = i + 1;
    try {
      const result = await _callProvider(cfg, systemPrompt, userPrompt, timeoutMs, runtimeProfile);
      const text = result.text;
      const usage = result.usage;
      const resolvedProvider = String(result.provider || cfg.provider || '').trim() || cfg.provider;
      const resolvedModel = String(result.model || cfg.model || '').trim() || cfg.model;
      const fallbackUsed = i > 0;
      const degradedFallback = ['local', 'groq'].includes(resolvedProvider.toLowerCase());
      const source = fallbackUsed ? 'fallback' : 'selector';
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
            model:        resolvedModel,
            requestType:  logMeta.requestType,
            inputTokens:  tokensIn,
            outputTokens: tokensOut,
            latencyMs,
            success: true,
            runtimeTeam,
            runtimePurpose,
            runtimeAgent,
            runtimeClaudeCodeName,
            runtimeSelectionReason,
          });
        } catch { /* 로깅 실패 무시 */ }
        // 토큰 트래커 (비용 통계)
        trackTokens({
          bot:       logMeta.bot  || logMeta.team,
          team:      logMeta.team,
          model:     resolvedModel,
          provider:  resolvedProvider,
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
        provider: resolvedProvider,
        model: resolvedModel,
        isPrimary: i === 0,
        latencyMs,
        success: true,
        errorType: null,
        tokenInput: tokensIn,
        tokenOutput: tokensOut,
      }).catch(() => {});

      traceCollector.recordGeneration(trace, {
        model: resolvedModel,
        provider: resolvedProvider,
        route: traceRoute,
        inputTokens: tokensIn,
        outputTokens: tokensOut,
        latencyMs,
        status: fallbackUsed ? 'fallback' : 'success',
        fallbackUsed,
        fallbackProvider: fallbackUsed ? resolvedProvider : null,
        confidence: null,
        qualityScore: null,
      });

      if (fallbackUsed) {
        console.log(`  ↳ [폴백] ${resolvedProvider}/${resolvedModel} (시도 ${attempt}) 성공`);
      }

      return {
        text,
        provider: resolvedProvider,
        model: resolvedModel,
        attempt,
        fallbackUsed,
        degradedFallback,
        source,
      };

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
            errorMsg:    (e as Error).message?.slice(0, 200),
            runtimeTeam,
            runtimePurpose,
            runtimeAgent,
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
        errorMessage: (e as Error).message,
        fallbackUsed: i > 0,
        fallbackProvider: i > 0 ? cfg.provider : null,
      });
      attemptTrace.push({
        provider: cfg.provider,
        model: cfg.model,
        status: 'error',
        reason: (e as Error).message?.slice(0, 160) || 'unknown_error',
      });

      const isLast = i === chain.length - 1;
      console.warn(`  ⚠️ [폴백] ${cfg.provider}/${cfg.model} (시도 ${attempt}) 실패: ${(e as Error).message?.slice(0, 80)}${isLast ? ' — 모든 폴백 소진' : ' → 다음 시도...'}`);
    }
  }

  if (!lastError) {
    const coolingProviders = skippedProviders.length > 0
      ? skippedProviders
      : chain
        .filter((c) => _isProviderCoolingDown(c.provider))
        .map((c) => `${c.provider}:provider_cooldown`);
    lastError = new Error(
      `사용 가능한 LLM provider가 없어 체인을 건너뜀: [${coolingProviders.join(', ')}]. ` +
      `${FAILURE_COOLDOWN_MS / 1000}초 후 자동 재시도됩니다.`
    );
  }
  if (lastError && typeof lastError === 'object') {
    lastError.llmTrace = attemptTrace;
    lastError.selectorKey = logMeta.selectorKey || null;
    lastError.agentName = logMeta.agentName || logMeta.bot || null;
    lastError.team = logMeta.team || null;
  }
  throw lastError;
}
