'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { getProviderRecord } = require('../oauth/token-store');
const { parseSseJsonEvents, summarizeSseGuard } = require('../../../../packages/core/lib/sse-event-guard');

const execFileAsync = promisify(execFile);

function parseExpiryMs(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Date.parse(String(value));
}

function isExpiredOrNearExpiry(token) {
  const expiresMs = parseExpiryMs(token?.expires_at || token?.expiresAt || token?.expires);
  return Number.isFinite(expiresMs) && expiresMs <= Date.now() + 60_000;
}

function getUsableToken(record) {
  const token = record?.token || null;
  const accessToken = String(token?.access_token || '').trim();
  if (!accessToken || isExpiredOrNearExpiry(token)) return null;
  return token;
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function extractOpenAiCodexAccountId(accessToken, fallback) {
  const direct = String(fallback || '').trim();
  if (direct) return direct;
  const payload = decodeJwtPayload(accessToken);
  const claim = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return typeof claim === 'string' && claim.trim() ? claim.trim() : null;
}

function resolveOpenAiCodexCredential() {
  const records = [
    getProviderRecord('openai-codex-oauth'),
    getProviderRecord('openai-oauth'),
    getProviderRecord('openai_oauth'),
  ];
  for (const record of records) {
    const token = getUsableToken(record);
    if (!token) continue;
    const accessToken = String(token.access_token || '').trim();
    return {
      accessToken,
      accountId: extractOpenAiCodexAccountId(
        accessToken,
        token.account_id || record?.metadata?.account_id || null,
      ),
    };
  }
  return null;
}

function isGeminiProModel(model) {
  return /(^|\/)gemini-2\.5-pro$/i.test(String(model || '').trim());
}

function getGeminiOAuthProjectId(record, model = '') {
  const proProjectId = isGeminiProModel(model)
    ? (process.env.GEMINI_OAUTH_PRO_PROJECT_ID || process.env.GEMINI_PRO_OAUTH_PROJECT_ID || '')
    : '';
  return String(
    proProjectId
      || process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || record?.metadata?.quota_project_id
      || record?.metadata?.project_id
      || record?.token?.quota_project_id
      || record?.token?.project_id
      || '',
  ).trim();
}

function resolveGeminiCredential() {
  const record = getProviderRecord('gemini-oauth');
  const token = getUsableToken(record);
  if (!token) return null;
  return {
    accessToken: String(token.access_token || '').trim(),
    projectId: getGeminiOAuthProjectId(record),
    record,
  };
}

function resolveGeminiCodeAssistCredential() {
  const records = [
    getProviderRecord('gemini-codeassist-oauth'),
    getProviderRecord('gemini-code-assist-oauth'),
    getProviderRecord('google-gemini-cli'),
    getProviderRecord('gemini-oauth'),
  ];
  for (const record of records) {
    const token = getUsableToken(record);
    if (!token) continue;
    return {
      accessToken: String(token.access_token || '').trim(),
      projectId: getGeminiOAuthProjectId(record, 'gemini-2.5-pro'),
      record,
    };
  }
  return null;
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs || 30_000)));
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}

function getOpenAiCodexBackendBaseUrl() {
  return String(
    process.env.OPENAI_CODEX_BACKEND_BASE_URL
      || process.env.OPENAI_CODEX_OAUTH_BACKEND_BASE_URL
      || 'https://chatgpt.com/backend-api',
  ).replace(/\/+$/, '');
}

function resolveOpenAiCodexResponsesUrl() {
  const baseUrl = getOpenAiCodexBackendBaseUrl();
  if (baseUrl.endsWith('/codex/responses')) return baseUrl;
  if (baseUrl.endsWith('/codex')) return `${baseUrl}/responses`;
  return `${baseUrl}/codex/responses`;
}

function buildOpenAiCodexBody({ model, systemPrompt, prompt, temperature }) {
  const body = {
    model: String(model || 'gpt-5.4').replace(/^openai-oauth\//, '').replace(/^openai-codex\//, ''),
    store: false,
    stream: true,
    instructions: systemPrompt || '',
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt || '' }],
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

async function readSseEvents(response) {
  const parsed = await parseSseJsonEvents(response, { source: 'hub-oauth-direct-openai-codex' });
  if (
    parsed.summary.malformed_fragments > 0
    || parsed.summary.oversized_fragments > 0
    || parsed.summary.untrusted_events.length > 0
  ) {
    console.warn(`[hub/oauth-direct] guarded SSE fragments: ${summarizeSseGuard(parsed.summary)}`);
  }
  return parsed.events;
}

function extractResponseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const pieces = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      const text = typeof content?.text === 'string'
        ? content.text
        : (typeof content?.content === 'string' ? content.content : '');
      if (text.trim()) pieces.push(text.trim());
    }
  }
  return pieces.join('\n').trim();
}

function extractOpenAiCodexStreamResult(events) {
  const deltas = [];
  const doneTexts = [];
  let finalResponse = null;
  for (const event of events) {
    const type = String(event?.type || '');
    if (type === 'error') {
      throw new Error(`OpenAI Codex error: ${String(event?.message || event?.code || 'unknown').slice(0, 400)}`);
    }
    if (type === 'response.failed') {
      throw new Error(String(event?.response?.error?.message || 'OpenAI Codex response failed').slice(0, 400));
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
  return { text: extractResponseText(finalResponse || {}), response: finalResponse };
}

async function callOpenAiCodexOAuth(input) {
  const started = Date.now();
  const model = String(input?.model || 'gpt-5.4').replace(/^openai-oauth\//, '').replace(/^openai\//, '');
  try {
    const credential = resolveOpenAiCodexCredential();
    if (!credential?.accessToken) throw new Error('openai_codex_oauth_token_missing');
    if (!credential.accountId) throw new Error('openai_codex_oauth_account_id_missing');

    const { signal, cleanup } = createTimeoutSignal(input?.timeoutMs || 30_000);
    try {
      const response = await fetch(resolveOpenAiCodexResponsesUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          'chatgpt-account-id': credential.accountId,
          originator: 'pi',
          'User-Agent': `pi (hub ${process.platform}; ${process.arch})`,
          'OpenAI-Beta': 'responses=experimental',
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildOpenAiCodexBody({
          model,
          systemPrompt: input?.systemPrompt || '',
          prompt: input?.prompt || '',
          temperature: input?.temperature ?? 0.3,
        })),
        signal,
      });

      if (!response.ok) {
        const payload = await readJsonResponse(response);
        const message = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`).slice(0, 400);
        throw new Error(`openai_codex_oauth_call_failed:${message}`);
      }

      const events = await readSseEvents(response);
      const { text, response: finalResponse } = extractOpenAiCodexStreamResult(events);
      if (!text) throw new Error('openai_codex_oauth_empty_response');
      return {
        ok: true,
        provider: 'openai-oauth',
        model,
        result: text,
        text,
        durationMs: Date.now() - started,
        apiDurationMs: Date.now() - started,
        modelUsage: normalizeUsage(finalResponse?.usage),
        cacheHit: false,
      };
    } finally {
      cleanup();
    }
  } catch (error) {
    return {
      ok: false,
      provider: 'failed',
      model,
      durationMs: Date.now() - started,
      error: error?.message || String(error),
    };
  }
}

function getGeminiOAuthBaseUrl(model = '') {
  const proBaseUrl = isGeminiProModel(model)
    ? (process.env.GEMINI_OAUTH_PRO_BASE_URL || process.env.GEMINI_PRO_OAUTH_BASE_URL || '')
    : '';
  return String(proBaseUrl || process.env.GEMINI_OAUTH_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
}

function normalizeGeminiModel(model) {
  const requested = String(model || '').trim();
  const override = isGeminiProModel(requested)
    ? String(process.env.GEMINI_OAUTH_PRO_MODEL || process.env.GEMINI_PRO_OAUTH_MODEL || '').trim()
    : '';
  return String(override || requested || 'gemini-2.5-flash')
    .replace(/^gemini-oauth\//, '')
    .replace(/^google-gemini-cli\//, '')
    .replace(/^gemini\//, '');
}

function normalizeGeminiCodeAssistModel(model) {
  const requested = String(model || '').trim();
  const override = isGeminiProModel(requested)
    ? String(
        process.env.GEMINI_CODE_ASSIST_PRO_MODEL
        || process.env.GEMINI_CODEASSIST_PRO_MODEL
        || '',
      ).trim()
    : '';
  return String(override || requested || 'gemini-2.5-pro')
    .replace(/^gemini-codeassist-oauth\//, '')
    .replace(/^gemini-code-assist-oauth\//, '')
    .replace(/^google-gemini-cli\//, '')
    .replace(/^gemini-oauth\//, '')
    .replace(/^gemini\//, '');
}

function normalizeGeminiCliModel(model) {
  return String(model || 'gemini-2.5-flash')
    .replace(/^gemini-cli-oauth\//, '')
    .replace(/^google-gemini-cli\//, '')
    .replace(/^gemini-oauth\//, '')
    .replace(/^gemini\//, '');
}

function getGeminiCodeAssistBaseUrl() {
  return String(
    process.env.GEMINI_CODE_ASSIST_BASE_URL
      || process.env.GEMINI_CODEASSIST_BASE_URL
      || process.env.CODE_ASSIST_ENDPOINT
      || 'https://cloudcode-pa.googleapis.com',
  ).replace(/\/+$/, '');
}

function getGeminiCodeAssistApiVersion() {
  return String(
    process.env.GEMINI_CODE_ASSIST_API_VERSION
      || process.env.GEMINI_CODEASSIST_API_VERSION
      || process.env.CODE_ASSIST_API_VERSION
      || 'v1internal',
  ).replace(/^\/+|\/+$/g, '');
}

function getGeminiCliCommand() {
  return String(process.env.GEMINI_CLI_COMMAND || 'gemini').trim() || 'gemini';
}

function buildGeminiCliPrompt(input) {
  const systemPrompt = String(input?.systemPrompt || '').trim();
  const prompt = String(input?.prompt || '').trim();
  return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function parseGeminiCliJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) throw new Error('gemini_cli_empty_stdout');
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('gemini_cli_invalid_json');
  }
}

function extractGeminiCliText(payload) {
  if (typeof payload?.response === 'string' && payload.response.trim()) return payload.response.trim();
  if (typeof payload?.text === 'string' && payload.text.trim()) return payload.text.trim();
  return extractGeminiText(payload);
}

function normalizeGeminiCliUsage(payload) {
  const usage = payload?.usage || {};
  const stats = payload?.stats || {};
  const cached = Number(stats.cached ?? stats.cache_read ?? usage.cache_read ?? 0) || 0;
  const rawInput = Number(
    usage.input_tokens
      ?? usage.prompt_tokens
      ?? stats.input_tokens
      ?? stats.input
      ?? 0,
  ) || 0;
  const input = Math.max(0, rawInput - cached);
  const output = Number(
    usage.output_tokens
      ?? usage.completion_tokens
      ?? stats.output_tokens
      ?? stats.output
      ?? 0,
  ) || 0;
  if (!input && !output && !cached) return null;
  return {
    input_tokens: input,
    output_tokens: output,
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output + cached,
    ...(cached ? { cache_read: cached } : {}),
  };
}

function getGeminiCodeAssistProjectId(credential, model = '') {
  const record = credential?.record || {};
  const proProjectId = isGeminiProModel(model)
    ? String(
        process.env.GEMINI_CODE_ASSIST_PRO_PROJECT_ID
        || process.env.GEMINI_CODEASSIST_PRO_PROJECT_ID
        || process.env.GEMINI_OAUTH_PRO_PROJECT_ID
        || process.env.GEMINI_PRO_OAUTH_PROJECT_ID
        || '',
      ).trim()
    : '';
  return String(
    proProjectId
      || process.env.GEMINI_CODE_ASSIST_PROJECT_ID
      || process.env.GEMINI_CODEASSIST_PROJECT_ID
      || process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || credential?.projectId
      || record?.metadata?.quota_project_id
      || record?.metadata?.project_id
      || record?.token?.quota_project_id
      || record?.token?.project_id
      || '',
  ).trim();
}

function resolveGeminiMaxOutputTokens(value) {
  const parsed = Number(value || 1024);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1024;
  return Math.max(32, Math.floor(parsed));
}

function extractGeminiText(payload) {
  const pieces = [];
  for (const candidate of Array.isArray(payload?.candidates) ? payload.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      if (typeof part?.text === 'string' && part.text.trim()) pieces.push(part.text.trim());
    }
  }
  return pieces.join('\n').trim();
}

function extractGeminiCodeAssistText(payload) {
  return extractGeminiText(payload?.response || payload || {});
}

function buildGeminiCodeAssistBody(input, model, projectId) {
  return {
    model,
    ...(projectId ? { project: projectId } : {}),
    user_prompt_id: `hub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    request: {
      ...(input?.systemPrompt ? { systemInstruction: { role: 'user', parts: [{ text: input.systemPrompt }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: input?.prompt || '' }] }],
      generationConfig: {
        maxOutputTokens: resolveGeminiMaxOutputTokens(input?.maxTokens),
        temperature: input?.temperature ?? 0.1,
      },
    },
  };
}

async function callGeminiOAuth(input) {
  const started = Date.now();
  const model = normalizeGeminiModel(input?.model);
  try {
    const credential = resolveGeminiCredential();
    if (!credential?.accessToken) throw new Error('gemini_oauth_token_missing');
    const projectId = getGeminiOAuthProjectId(credential.record, model);
    if (!projectId) {
      throw new Error(isGeminiProModel(model)
        ? 'gemini_oauth_pro_quota_project_missing'
        : 'gemini_oauth_quota_project_missing');
    }

    const { signal, cleanup } = createTimeoutSignal(input?.timeoutMs || 30_000);
    try {
      const response = await fetch(`${getGeminiOAuthBaseUrl(model)}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-goog-user-project': projectId,
        },
        body: JSON.stringify({
          ...(input?.systemPrompt ? { systemInstruction: { parts: [{ text: input.systemPrompt }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: input?.prompt || '' }] }],
          generationConfig: {
            maxOutputTokens: resolveGeminiMaxOutputTokens(input?.maxTokens),
            temperature: input?.temperature ?? 0.1,
          },
        }),
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`).slice(0, 400);
        throw new Error(`gemini_oauth_call_failed:${message}`);
      }
      const text = extractGeminiText(payload);
      if (!text) throw new Error('gemini_oauth_empty_response');
      return {
        ok: true,
        provider: 'gemini-oauth',
        model,
        result: text,
        text,
        durationMs: Date.now() - started,
        apiDurationMs: Date.now() - started,
        modelUsage: null,
        cacheHit: false,
      };
    } finally {
      cleanup();
    }
  } catch (error) {
    return {
      ok: false,
      provider: 'failed',
      model,
      durationMs: Date.now() - started,
      error: error?.message || String(error),
    };
  }
}

async function callGeminiCliOAuth(input) {
  const started = Date.now();
  const model = normalizeGeminiCliModel(input?.model);
  try {
    const command = getGeminiCliCommand();
    const args = [
      '--skip-trust',
      '--output-format',
      'json',
      '--model',
      model,
      '--prompt',
      buildGeminiCliPrompt(input),
    ];
    const timeout = Number(input?.timeoutMs || process.env.GEMINI_CLI_TIMEOUT_MS || 60_000);
    const { stdout } = await execFileAsync(command, args, {
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
      maxBuffer: Number(process.env.GEMINI_CLI_MAX_BUFFER_BYTES || 4 * 1024 * 1024),
      env: process.env,
    });
    const payload = parseGeminiCliJson(stdout);
    const text = extractGeminiCliText(payload);
    if (!text) throw new Error('gemini_cli_oauth_empty_response');
    return {
      ok: true,
      provider: 'gemini-cli-oauth',
      model,
      result: text,
      text,
      durationMs: Date.now() - started,
      apiDurationMs: Date.now() - started,
      modelUsage: normalizeGeminiCliUsage(payload),
      cacheHit: false,
      sessionId: payload?.session_id || payload?.sessionId || null,
    };
  } catch (error) {
    const message = error?.code === 'ENOENT'
      ? 'gemini_cli_unavailable'
      : (error?.killed || error?.signal === 'SIGTERM'
          ? 'gemini_cli_timeout'
          : (error?.message || String(error)));
    return {
      ok: false,
      provider: 'failed',
      model,
      durationMs: Date.now() - started,
      error: String(message).slice(0, 400),
    };
  }
}

async function callGeminiCodeAssistOAuth(input) {
  const started = Date.now();
  const model = normalizeGeminiCodeAssistModel(input?.model);
  try {
    const credential = resolveGeminiCodeAssistCredential();
    if (!credential?.accessToken) throw new Error('gemini_codeassist_oauth_token_missing');
    const projectId = getGeminiCodeAssistProjectId(credential, model);
    const baseUrl = getGeminiCodeAssistBaseUrl();
    const version = getGeminiCodeAssistApiVersion();

    const { signal, cleanup } = createTimeoutSignal(input?.timeoutMs || 60_000);
    try {
      const response = await fetch(`${baseUrl}/${version}:generateContent`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(buildGeminiCodeAssistBody(input, model, projectId)),
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`).slice(0, 400);
        throw new Error(`gemini_codeassist_oauth_call_failed:${message}`);
      }
      const text = extractGeminiCodeAssistText(payload);
      if (!text) throw new Error('gemini_codeassist_oauth_empty_response');
      return {
        ok: true,
        provider: 'gemini-codeassist-oauth',
        model,
        result: text,
        text,
        durationMs: Date.now() - started,
        apiDurationMs: Date.now() - started,
        modelUsage: null,
        cacheHit: false,
      };
    } finally {
      cleanup();
    }
  } catch (error) {
    return {
      ok: false,
      provider: 'failed',
      model,
      durationMs: Date.now() - started,
      error: error?.message || String(error),
    };
  }
}

module.exports = {
  callOpenAiCodexOAuth,
  callGeminiOAuth,
  callGeminiCliOAuth,
  callGeminiCodeAssistOAuth,
};
