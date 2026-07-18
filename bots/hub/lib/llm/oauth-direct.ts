'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { getProviderRecord } = require('../oauth/token-store');
const { recordHubTelemetry } = require('../telemetry');
const { parseSseJsonEvents, summarizeSseGuard } = require('../../../../packages/core/lib/sse-event-guard');

const execFileAsync = promisify(execFile);

type AnyRecord = Record<string, any>;
type OAuthInput = AnyRecord;
type ImagePart = {
  mimeType: string;
  data: string;
};
type ProviderHttpError = Error & {
  upstreamStatus?: number;
  retryAfterMs?: number;
};

const SSE_GUARD_UNTRUSTED_DEBUG_INTERVAL_MS = 300_000;
let sseGuardUntrustedLastDebugAt = 0;
let sseGuardUntrustedSuppressed = 0;

function parseExpiryMs(value: unknown): number {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Date.parse(String(value));
}

function isExpiredOrNearExpiry(token: AnyRecord | null | undefined): boolean {
  const expiresMs = parseExpiryMs(token?.expires_at || token?.expiresAt || token?.expires);
  return Number.isFinite(expiresMs) && expiresMs <= Date.now() + 60_000;
}

function getUsableToken(record: AnyRecord | null | undefined): AnyRecord | null {
  const token = record?.token || null;
  const accessToken = String(token?.access_token || '').trim();
  if (!accessToken || isExpiredOrNearExpiry(token)) return null;
  return token;
}

function decodeJwtPayload(token: unknown): AnyRecord | null {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function extractOpenAiCodexAccountId(accessToken: string, fallback: unknown): string | null {
  const direct = String(fallback || '').trim();
  if (direct) return direct;
  const payload = decodeJwtPayload(accessToken);
  const claim = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return typeof claim === 'string' && claim.trim() ? claim.trim() : null;
}

function normalizeOpenAiCodexOAuthError(error: any): string {
  const name = String(error?.name || '').trim();
  const message = String(error?.message || error || 'unknown').trim();
  if (
    name === 'AbortError'
    || name === 'TimeoutError'
    || /aborted|abort|timeout|timed out/i.test(message)
  ) {
    return `openai_codex_oauth_timeout_or_abort:${message || name || 'aborted'}`.slice(0, 400);
  }
  return message || 'openai_codex_oauth_unknown_error';
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

function isGeminiProModel(model: unknown): boolean {
  return /(^|\/)gemini-2\.5-pro$/i.test(String(model || '').trim());
}

function isGeminiDisabled() {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.HUB_LLM_GEMINI_DISABLED || '').trim().toLowerCase());
}

function geminiDisabledResult(model: string, started: number): AnyRecord {
  return {
    ok: false,
    provider: 'failed',
    model,
    durationMs: Date.now() - started,
    error: 'gemini_provider_disabled',
  };
}

function getGeminiOAuthProjectId(record: AnyRecord | null | undefined, model = ''): string {
  const proProjectId = isGeminiProModel(model)
    ? (process.env.GEMINI_OAUTH_PRO_PROJECT_ID || process.env.GEMINI_PRO_OAUTH_PROJECT_ID || '')
    : '';
  return String(
    proProjectId
      || process.env.GEMINI_CLI_OAUTH_PROJECT_ID
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

function createTimeoutSignal(timeoutMs: unknown, parentSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs || 30_000)));
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function readJsonResponse(response: Response): Promise<AnyRecord> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function parseRetryAfterMs(response: Response): number | undefined {
  const raw = String(response.headers.get('retry-after') || '').trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now()) || undefined;
}

function createProviderHttpError(message: string, response: Response): ProviderHttpError {
  const error = new Error(message) as ProviderHttpError;
  error.upstreamStatus = response.status;
  const retryAfterMs = parseRetryAfterMs(response);
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

function providerHttpFailureMetadata(error: ProviderHttpError | null | undefined): AnyRecord {
  const upstreamStatus = Number(error?.upstreamStatus || 0);
  const retryAfterMs = Number(error?.retryAfterMs || 0);
  return {
    ...(upstreamStatus >= 100 && upstreamStatus <= 599 ? { upstreamStatus } : {}),
    ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
  };
}

function extractErrorMessage(payload: AnyRecord, status: number): string {
  const detail = payload?.detail;
  if (typeof payload?.error?.message === 'string' && payload.error.message.trim()) return payload.error.message;
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail) && detail.length > 0) return JSON.stringify(detail).slice(0, 500);
  return `HTTP ${status}`;
}

function normalizeUsage(usage: AnyRecord | null | undefined): AnyRecord | null {
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

function normalizeImageParts(input: OAuthInput): ImagePart[] {
  const images: ImagePart[] = [];
  const appendImage = (item: AnyRecord | null | undefined) => {
    if (!item) return;
    let data = String(item.dataBase64 || item.base64 || item.data || '').trim();
    let mimeType = String(item.mimeType || item.mime_type || 'image/png').trim() || 'image/png';
    const dataUrl = String(item.dataUrl || item.imageDataUrl || item.image_data_url || '').trim();
    if (!data && dataUrl) {
      const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
      if (match) {
        mimeType = match[1] || mimeType;
        data = match[2] || '';
      }
    }
    if (data) images.push({ mimeType, data });
  };

  if (Array.isArray(input?.images)) {
    for (const item of input.images) appendImage(item);
  }
  appendImage({
    dataBase64: input?.imageBase64,
    dataUrl: input?.imageDataUrl,
    mimeType: input?.mimeType,
  });
  return images.slice(0, 4);
}

function buildOpenAiCodexContent(input: OAuthInput): AnyRecord[] {
  const content: AnyRecord[] = [{ type: 'input_text', text: input?.prompt || '' }];
  for (const image of normalizeImageParts(input)) {
    content.push({
      type: 'input_image',
      image_url: `data:${image.mimeType};base64,${image.data}`,
      detail: input?.imageDetail || 'low',
    });
  }
  return content;
}

function buildGeminiParts(input: OAuthInput): AnyRecord[] {
  const parts: AnyRecord[] = [{ text: input?.prompt || '' }];
  for (const image of normalizeImageParts(input)) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }
  return parts;
}

function resolveOpenAiCodexMaxOutputTokens(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(8192, Math.max(16, Math.floor(parsed)));
}

function shouldSendOpenAiCodexMaxOutputTokens() {
  return ['1', 'true', 'yes', 'y', 'on'].includes(
    String(process.env.OPENAI_CODEX_BACKEND_ENABLE_MAX_OUTPUT_TOKENS || '').trim().toLowerCase(),
  );
}

function withOutputBudgetInstruction(systemPrompt: unknown, maxTokens: unknown): string {
  const budget = resolveOpenAiCodexMaxOutputTokens(maxTokens);
  const base = String(systemPrompt || '').trim();
  if (!budget || shouldSendOpenAiCodexMaxOutputTokens()) return base;
  const instruction = `Keep the final answer within about ${budget} output tokens.`;
  return base ? `${base}\n\n${instruction}` : instruction;
}

function buildOpenAiCodexBody({ model, systemPrompt, prompt, temperature, maxTokens, images, imageBase64, imageDataUrl, mimeType, imageDetail }: OAuthInput): AnyRecord {
  const body: AnyRecord = {
    model: String(model || 'gpt-5.4').replace(/^openai-oauth\//, '').replace(/^openai-codex\//, ''),
    store: false,
    stream: true,
    instructions: withOutputBudgetInstruction(systemPrompt, maxTokens),
    input: [
      {
        role: 'user',
        content: buildOpenAiCodexContent({ prompt, images, imageBase64, imageDataUrl, mimeType, imageDetail }),
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
  const maxOutputTokens = resolveOpenAiCodexMaxOutputTokens(maxTokens);
  if (maxOutputTokens && shouldSendOpenAiCodexMaxOutputTokens()) body.max_output_tokens = maxOutputTokens;
  return body;
}

async function readSseEvents(response: Response): Promise<AnyRecord[]> {
  const parsed = await parseSseJsonEvents(response, { source: 'hub-oauth-direct-openai-codex' });
  recordSseGuardSummary(parsed.summary);
  return parsed.events;
}

function sseGuardLogSeverity(summary: AnyRecord): 'none' | 'debug' | 'warn' {
  if (Number(summary?.malformed_fragments || 0) > 0 || Number(summary?.oversized_fragments || 0) > 0) return 'warn';
  if (Array.isArray(summary?.untrusted_events) && summary.untrusted_events.length > 0) return 'debug';
  return 'none';
}

function recordSseGuardSummary(summary: AnyRecord): void {
  const severity = sseGuardLogSeverity(summary);
  if (severity === 'none') return;

  recordHubTelemetry('hub.oauth_direct.sse_guard', {
    severity,
    source: summary?.source || 'hub-oauth-direct-openai-codex',
    eventCount: Number(summary?.event_count || summary?.events || 0) || 0,
    malformedFragments: Number(summary?.malformed_fragments || 0) || 0,
    oversizedFragments: Number(summary?.oversized_fragments || 0) || 0,
    untrustedEventCount: Array.isArray(summary?.untrusted_events) ? summary.untrusted_events.length : 0,
  });

  if (severity === 'warn') {
    console.warn(`[hub/oauth-direct] guarded SSE fragments: ${summarizeSseGuard(summary)}`);
    return;
  }

  sseGuardUntrustedSuppressed += 1;
  const now = Date.now();
  const shouldDebug = process.env.HUB_SSE_GUARD_DEBUG === 'true'
    || now - sseGuardUntrustedLastDebugAt >= SSE_GUARD_UNTRUSTED_DEBUG_INTERVAL_MS;
  if (!shouldDebug) return;
  console.debug(`[hub/oauth-direct] guarded SSE fragments debug: ${summarizeSseGuard(summary)} suppressed=${sseGuardUntrustedSuppressed - 1}`);
  sseGuardUntrustedLastDebugAt = now;
  sseGuardUntrustedSuppressed = 0;
}

function extractResponseText(response: AnyRecord | null | undefined): string {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const pieces: string[] = [];
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

function extractOpenAiCodexStreamResult(events: AnyRecord[]): { text: string; response: AnyRecord | null } {
  const deltas: string[] = [];
  const doneTexts: string[] = [];
  let finalResponse: AnyRecord | null = null;
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

async function callOpenAiCodexOAuth(input: OAuthInput): Promise<AnyRecord> {
  const started = Date.now();
  const model = String(input?.model || 'gpt-5.4').replace(/^openai-oauth\//, '').replace(/^openai\//, '');
  try {
    const credential = resolveOpenAiCodexCredential();
    if (!credential?.accessToken) throw new Error('openai_codex_oauth_token_missing');
    if (!credential.accountId) throw new Error('openai_codex_oauth_account_id_missing');

    const { signal, cleanup } = createTimeoutSignal(input?.timeoutMs || 30_000, input?.signal);
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
          maxTokens: input?.maxTokens,
          images: input?.images,
          imageBase64: input?.imageBase64,
          imageDataUrl: input?.imageDataUrl,
          mimeType: input?.mimeType,
          imageDetail: input?.imageDetail,
        })),
        signal,
      });

      if (!response.ok) {
        const payload = await readJsonResponse(response);
        const message = String(extractErrorMessage(payload, response.status)).slice(0, 400);
        const prefix = response.status === 400
          ? 'openai_codex_oauth_bad_request'
          : 'openai_codex_oauth_call_failed';
        throw createProviderHttpError(`${prefix}:${message}`, response);
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
  } catch (error: any) {
    return {
      ok: false,
      provider: 'failed',
      model,
      durationMs: Date.now() - started,
      error: normalizeOpenAiCodexOAuthError(error),
      ...providerHttpFailureMetadata(error),
    };
  }
}

function getGeminiOAuthBaseUrl(model = ''): string {
  const proBaseUrl = isGeminiProModel(model)
    ? (process.env.GEMINI_OAUTH_PRO_BASE_URL || process.env.GEMINI_PRO_OAUTH_BASE_URL || '')
    : '';
  return String(proBaseUrl || process.env.GEMINI_OAUTH_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
}

function normalizeGeminiModel(model: unknown): string {
  const requested = String(model || '').trim();
  const override = isGeminiProModel(requested)
    ? String(process.env.GEMINI_OAUTH_PRO_MODEL || process.env.GEMINI_PRO_OAUTH_MODEL || '').trim()
    : '';
  return String(override || requested || 'gemini-2.5-flash')
    .replace(/^gemini-oauth\//, '')
    .replace(/^google-gemini-cli\//, '')
    .replace(/^gemini\//, '');
}

function normalizeGeminiCodeAssistModel(model: unknown): string {
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

function normalizeGeminiCliModel(model: unknown): string {
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

function buildGeminiCliPrompt(input: OAuthInput): string {
  const systemPrompt = String(input?.systemPrompt || '').trim();
  const prompt = String(input?.prompt || '').trim();
  return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function parseGeminiCliJson(stdout: unknown): AnyRecord {
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

function extractGeminiCliText(payload: AnyRecord): string {
  if (typeof payload?.response === 'string' && payload.response.trim()) return payload.response.trim();
  if (typeof payload?.text === 'string' && payload.text.trim()) return payload.text.trim();
  return extractGeminiText(payload);
}

function classifyGeminiCliDiagnostic(stdout: unknown, stderr: unknown): string {
  const combined = `${stderr || ''}\n${stdout || ''}`;
  if (/MODEL_CAPACITY_EXHAUSTED|No capacity available|RESOURCE_EXHAUSTED|rateLimitExceeded|status 429|\"code\"\\s*:\\s*429/i.test(combined)) {
    return 'gemini_cli_model_capacity_exhausted';
  }
  if (/UNAUTHENTICATED|invalid authentication credentials|auth login|OAuth/i.test(combined)) {
    return 'gemini_cli_auth_required';
  }
  return '';
}

function parseGeminiCliJsonWithDiagnostics(stdout: unknown, stderr: unknown): AnyRecord {
  const raw = String(stdout || '').trim();
  if (!raw) throw new Error(classifyGeminiCliDiagnostic(stdout, stderr) || 'gemini_cli_empty_stdout');
  return parseGeminiCliJson(stdout);
}

function normalizeGeminiCliError(error: any): string {
  const diagnostic = classifyGeminiCliDiagnostic(error?.stdout, error?.stderr);
  if (diagnostic) return diagnostic;
  if (error?.code === 'ENOENT') return 'gemini_cli_unavailable';
  if (error?.killed || error?.signal === 'SIGTERM') return 'gemini_cli_timeout';
  return error?.message || String(error);
}

function normalizeGeminiCliUsage(payload: AnyRecord): AnyRecord | null {
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

function getGeminiCodeAssistProjectId(credential: AnyRecord | null | undefined, model = ''): string {
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
      || process.env.GEMINI_CLI_OAUTH_PROJECT_ID
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

function resolveGeminiMaxOutputTokens(value: unknown): number {
  const parsed = Number(value || 1024);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1024;
  return Math.max(32, Math.floor(parsed));
}

function extractGeminiText(payload: AnyRecord | null | undefined): string {
  const pieces: string[] = [];
  for (const candidate of Array.isArray(payload?.candidates) ? payload.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      if (typeof part?.text === 'string' && part.text.trim()) pieces.push(part.text.trim());
    }
  }
  return pieces.join('\n').trim();
}

function extractGeminiCodeAssistText(payload: AnyRecord | null | undefined): string {
  return extractGeminiText(payload?.response || payload || {});
}

function buildGeminiCodeAssistBody(input: OAuthInput, model: string, projectId: string): AnyRecord {
  return {
    model,
    ...(projectId ? { project: projectId } : {}),
    user_prompt_id: `hub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    request: {
      ...(input?.systemPrompt ? { systemInstruction: { role: 'user', parts: [{ text: input.systemPrompt }] } } : {}),
      contents: [{ role: 'user', parts: buildGeminiParts(input) }],
      generationConfig: {
        maxOutputTokens: resolveGeminiMaxOutputTokens(input?.maxTokens),
        temperature: input?.temperature ?? 0.1,
      },
    },
  };
}

async function callGeminiOAuth(input: OAuthInput): Promise<AnyRecord> {
  const started = Date.now();
  const model = normalizeGeminiModel(input?.model);
  if (isGeminiDisabled()) return geminiDisabledResult(model, started);
  try {
    const credential = resolveGeminiCredential();
    if (!credential?.accessToken) throw new Error('gemini_oauth_token_missing');
    const projectId = getGeminiOAuthProjectId(credential.record, model);
    if (!projectId) {
      throw new Error(isGeminiProModel(model)
        ? 'gemini_oauth_pro_quota_project_missing'
        : 'gemini_oauth_quota_project_missing');
    }

    const { signal, cleanup } = createTimeoutSignal(input?.timeoutMs || 30_000, input?.signal);
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
          contents: [{ role: 'user', parts: buildGeminiParts(input) }],
          generationConfig: {
            maxOutputTokens: resolveGeminiMaxOutputTokens(input?.maxTokens),
            temperature: input?.temperature ?? 0.1,
          },
        }),
        signal,
      });
      const payload = await response.json().catch(() => ({})) as AnyRecord;
      if (!response.ok) {
        const message = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`).slice(0, 400);
        throw createProviderHttpError(`gemini_oauth_call_failed:${message}`, response);
      }
      const text = extractGeminiText(payload);
      if (!text) throw new Error('gemini_oauth_empty_response');
      return {
        ok: true,
        provider: 'gemini-cli-oauth',
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
  } catch (error: any) {
    return {
      ok: false,
      provider: 'failed',
      model,
      durationMs: Date.now() - started,
      error: error?.message || String(error),
      ...providerHttpFailureMetadata(error),
    };
  }
}

async function callGeminiCliOAuth(input: OAuthInput): Promise<AnyRecord> {
  const started = Date.now();
  const model = normalizeGeminiCliModel(input?.model);
  if (isGeminiDisabled()) return geminiDisabledResult(model, started);
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
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
      maxBuffer: Number(process.env.GEMINI_CLI_MAX_BUFFER_BYTES || 4 * 1024 * 1024),
      env: process.env,
      signal: input?.signal,
    });
    const payload = parseGeminiCliJsonWithDiagnostics(stdout, stderr);
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
  } catch (error: any) {
    const message = normalizeGeminiCliError(error);
    return {
      ok: false,
      provider: 'failed',
      model,
      durationMs: Date.now() - started,
      error: String(message).slice(0, 400),
    };
  }
}

async function callGeminiCodeAssistOAuth(input: OAuthInput): Promise<AnyRecord> {
  const started = Date.now();
  const model = normalizeGeminiCodeAssistModel(input?.model);
  if (isGeminiDisabled()) return geminiDisabledResult(model, started);
  try {
    const credential = resolveGeminiCodeAssistCredential();
    if (!credential?.accessToken) throw new Error('gemini_codeassist_oauth_token_missing');
    const projectId = getGeminiCodeAssistProjectId(credential, model);
    const baseUrl = getGeminiCodeAssistBaseUrl();
    const version = getGeminiCodeAssistApiVersion();

    const { signal, cleanup } = createTimeoutSignal(input?.timeoutMs || 60_000, input?.signal);
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
      const payload = await response.json().catch(() => ({})) as AnyRecord;
      if (!response.ok) {
        const message = String(payload?.error?.message || payload?.message || `HTTP ${response.status}`).slice(0, 400);
        throw createProviderHttpError(`gemini_codeassist_oauth_call_failed:${message}`, response);
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
  } catch (error: any) {
    return {
      ok: false,
      provider: 'failed',
      model,
      durationMs: Date.now() - started,
      error: error?.message || String(error),
      ...providerHttpFailureMetadata(error),
    };
  }
}

module.exports = {
  callOpenAiCodexOAuth,
  callGeminiOAuth,
  callGeminiCliOAuth,
  callGeminiCodeAssistOAuth,
  _testOnly: {
    isGeminiDisabled,
    sseGuardLogSeverity,
    recordSseGuardSummary,
  },
};
