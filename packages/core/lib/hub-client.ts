const env = require('./env.legacy.js');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cycleTrace = require('./cycle-trace');

type CacheEntry = {
  value: any;
  expiresAt: number;
};

type HubFetchResponse = {
  data?: any;
  profile?: any;
};

type LegacyHubAbstractModel = 'anthropic_haiku' | 'anthropic_sonnet' | 'anthropic_opus';
type OAuth4HubAbstractModel = 'claude_code_haiku' | 'claude_code_sonnet' | 'claude_code_opus';
type HubAbstractModel = LegacyHubAbstractModel | OAuth4HubAbstractModel | 'claude-code/haiku' | 'claude-code/sonnet' | 'claude-code/opus';

type HubLlmCallRequest = {
  callerTeam: string;
  agent: string;
  selectorKey?: string;
  taskType?: string;
  abstractModel?: HubAbstractModel;
  prompt: string;
  systemPrompt?: string;
  jsonSchema?: any;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  maxBudgetUsd?: number;
  tokenBudgetProfile?: string;
  preferredApi?: string;
  groqModel?: string;
  configuredProviders?: string[];
  avoidProviders?: string[];
  chain?: any[];
  policyOverride?: any;
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  priority?: 'low' | 'normal' | 'high' | 'critical';
  cacheEnabled?: boolean;
  cacheType?: string;
  traceId?: string | null;
  trace_id?: string | null;
  cycleId?: string | null;
  cycle_id?: string | null;
};

type HubLlmCallResponse = {
  ok: boolean;
  text: string;
  result?: string;
  provider?: string;
  model?: string;
  selected_route?: string;
  fallbackCount?: number;
  attempted_providers?: string[];
  durationMs?: number;
  traceId?: string | null;
  admission?: {
    queued?: boolean;
  };
  error?: string;
  raw?: any;
};

type HubVisionRequest = {
  callerTeam: string;
  agent: string;
  selectorKey?: string;
  taskType?: string;
  prompt: string;
  systemPrompt?: string;
  imageBase64?: string;
  imageDataUrl?: string;
  mimeType?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  maxBudgetUsd?: number;
  model?: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  traceId?: string | null;
  trace_id?: string | null;
  cycleId?: string | null;
  cycle_id?: string | null;
};

type HubEmbeddingRequest = {
  callerTeam: string;
  agent: string;
  selectorKey?: string;
  taskType?: string;
  input: string | string[];
  timeoutMs?: number;
  expectedDimensions?: number;
  traceId?: string | null;
  trace_id?: string | null;
  cycleId?: string | null;
  cycle_id?: string | null;
};

type HubSelectorRequest = {
  key?: string;
  selectorKey?: string;
  callerTeam?: string;
  team?: string;
  agent?: string;
  agentName?: string;
  taskType?: string;
  task_type?: string;
  runtimePurpose?: string;
  runtime_purpose?: string;
  selectorVersion?: string;
  rolloutPercent?: number;
  rolloutKey?: string;
  timeoutMs?: number;
};

const cache = new Map<string, CacheEntry>();
const warnCache = new Map<string, number>();

function getCacheKey(kind: string, value: string): string {
  return `${kind}:${value}`;
}

function getCached(cacheKey: string): any {
  const entry = cache.get(cacheKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(cacheKey);
    return undefined;
  }
  return entry.value;
}

function setCached(cacheKey: string, value: any, ttlMs: number): void {
  cache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function getSecretsSuccessTtl(category: string): number {
  switch (category) {
    case 'llm':
    case 'openai_oauth':
      return 60000;
    case 'telegram':
    case 'reservation':
    case 'reservation-shared':
      return 30000;
    default:
      return 10000;
  }
}

function getSecretsRateLimitTtl(category: string): number {
  switch (category) {
    case 'llm':
    case 'openai_oauth':
      return 15000;
    case 'telegram':
    case 'reservation':
    case 'reservation-shared':
      return 10000;
    default:
      return 5000;
  }
}

function boolEnv(name: string, fallback = false): boolean {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function getCurrentCycleTraceFields(): Record<string, string> {
  try {
    const current = cycleTrace.getCurrentTracePropagation?.() || {};
    const traceId = String(current.traceId || current.trace_id || '').trim();
    const cycleId = String(current.cycleId || current.cycle_id || '').trim();
    const fields: Record<string, string> = {};
    if (traceId) {
      fields.traceId = traceId;
      fields.trace_id = traceId;
    }
    if (cycleId) {
      fields.cycleId = cycleId;
      fields.cycle_id = cycleId;
    }
    return fields;
  } catch {
    return {};
  }
}

function withCurrentCycleTrace(payload: any): any {
  const current = getCurrentCycleTraceFields();
  if (!current.traceId && !current.cycleId) return payload;
  const existingTraceId = payload?.traceId || payload?.trace_id;
  const existingCycleId = payload?.cycleId || payload?.cycle_id;
  const traceFields = !existingTraceId && current.traceId
    ? { traceId: current.traceId, trace_id: current.trace_id }
    : {};
  const cycleFields = !existingCycleId && current.cycleId
    ? { cycleId: current.cycleId, cycle_id: current.cycle_id }
    : {};
  return {
    ...payload,
    ...traceFields,
    ...cycleFields,
  };
}

function cycleTraceHeaders(payload: any): Record<string, string> {
  const traceId = String(payload?.traceId || payload?.trace_id || '').trim();
  const cycleId = String(payload?.cycleId || payload?.cycle_id || '').trim();
  return {
    ...(traceId ? { 'X-Hub-Trace-Id': traceId } : {}),
    ...(cycleId ? { 'X-Hub-Cycle-Id': cycleId } : {}),
  };
}

function positiveIntEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(process.env[name] || '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function resolveSharedSecretCacheDir(): string {
  const configured = String(process.env.HUB_CLIENT_SHARED_SECRET_CACHE_DIR || '').trim();
  if (configured) return configured.replace(/^~(?=$|\/)/, os.homedir());
  return path.join(os.homedir(), '.ai-agent-system', 'hub-client-cache');
}

function sharedSecretCacheEnabled(): boolean {
  return boolEnv('HUB_CLIENT_SHARED_SECRET_CACHE_ENABLED', true);
}

function sharedSecretStaleMs(): number {
  return positiveIntEnv('HUB_CLIENT_SHARED_SECRET_STALE_MS', 10 * 60_000, 0, 24 * 60 * 60_000);
}

function sharedSecretCachePath(category: string): string {
  const digest = crypto.createHash('sha256').update(String(category || '')).digest('hex').slice(0, 16);
  const safe = String(category || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48) || 'unknown';
  return path.join(resolveSharedSecretCacheDir(), `secret-${safe}-${digest}.json`);
}

function readSharedSecretCache(category: string, mode: 'fresh' | 'stale' = 'fresh'): any | undefined {
  if (!sharedSecretCacheEnabled()) return undefined;
  try {
    const file = sharedSecretCachePath(category);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const now = Date.now();
    const expiresAt = Number(parsed?.expiresAt || 0);
    const cachedAt = Number(parsed?.cachedAt || 0);
    if (mode === 'fresh' && expiresAt > now) return parsed.data ?? null;
    if (mode === 'stale' && cachedAt > 0 && now - cachedAt <= sharedSecretStaleMs()) return parsed.data ?? null;
  } catch {
    return undefined;
  }
  return undefined;
}

function writeSharedSecretCache(category: string, data: any, ttlMs: number): void {
  if (!sharedSecretCacheEnabled()) return;
  try {
    const file = sharedSecretCachePath(category);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const payload = {
      category,
      cachedAt: Date.now(),
      expiresAt: Date.now() + Math.max(0, ttlMs),
      data,
    };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch {
    // Cache write failure must never block secret reads.
  }
}

function useSharedSecretCacheFallback(category: string, cacheKey: string, reason: string): any | undefined {
  const stale = readSharedSecretCache(category, 'stale');
  if (stale === undefined) return undefined;
  setCached(cacheKey, stale, Math.min(getSecretsRateLimitTtl(category), 15_000));
  warnOnce(
    `hub-secrets:${category}:stale:${reason}`,
    `[hub-client] ${category}: ${reason} — shared stale cache 사용`,
    30000,
  );
  return stale;
}

function hubLlmClientPayloadLimitBytes(): number {
  return positiveIntEnv('HUB_CLIENT_LLM_PAYLOAD_LIMIT_BYTES', 7 * 1024 * 1024, 32 * 1024, 64 * 1024 * 1024);
}

function truncateTextToUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function jsonUtf8Bytes(value: any): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function prepareHubLlmPayload(payload: any): any {
  if (boolEnv('HUB_CLIENT_LLM_PAYLOAD_TRUNCATE_ENABLED', true) === false) return payload;
  const limitBytes = hubLlmClientPayloadLimitBytes();
  const originalPayloadBytes = jsonUtf8Bytes(payload);
  if (originalPayloadBytes <= limitBytes) return payload;
  const systemPrompt = String(payload.systemPrompt || '');
  const prompt = String(payload.prompt || '');
  const basePayload = {
    ...payload,
    systemPrompt: systemPrompt ? '' : payload.systemPrompt,
    prompt: '',
    payloadTrimmed: true,
    payloadTrimReason: 'client_payload_limit',
    originalPayloadBytes,
  };
  const baseBytes = jsonUtf8Bytes(basePayload);
  if (baseBytes > limitBytes) {
    return {
      ...basePayload,
      payloadRejected: true,
      payloadRejectReason: 'client_payload_limit_non_prompt_fields',
      finalPayloadBytes: baseBytes,
      payloadLimitBytes: limitBytes,
    };
  }

  let budget = Math.max(0, limitBytes - baseBytes - 512);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const systemBudget = systemPrompt ? Math.min(Math.floor(budget * 0.25), Buffer.byteLength(systemPrompt, 'utf8')) : 0;
    const promptBudget = Math.max(0, budget - systemBudget);
    const next = {
      ...basePayload,
      systemPrompt: systemPrompt ? truncateTextToUtf8Bytes(systemPrompt, systemBudget) : payload.systemPrompt,
      prompt: truncateTextToUtf8Bytes(prompt, promptBudget),
    };
    const finalPayloadBytes = jsonUtf8Bytes(next);
    if (finalPayloadBytes <= limitBytes) return { ...next, finalPayloadBytes, payloadLimitBytes: limitBytes };
    budget = Math.max(0, budget - (finalPayloadBytes - limitBytes) - 512);
  }

  return {
    ...basePayload,
    payloadRejected: true,
    payloadRejectReason: 'client_payload_limit_untrimmable',
    finalPayloadBytes: jsonUtf8Bytes(basePayload),
    payloadLimitBytes: limitBytes,
  };
}

function warnOnce(key: string, message: string, ttlMs = 30000): void {
  const last = warnCache.get(key) || 0;
  if ((Date.now() - last) < ttlMs) return;
  warnCache.set(key, Date.now());
  console.warn(message);
}

function normalizeHubAbstractModel(model?: HubAbstractModel | string | null): LegacyHubAbstractModel {
  const raw = String(model || '').trim().toLowerCase();
  if (raw === 'anthropic_haiku' || raw === 'claude_code_haiku' || raw === 'claude-code/haiku') return 'anthropic_haiku';
  if (raw === 'anthropic_opus' || raw === 'claude_code_opus' || raw === 'claude-code/opus') return 'anthropic_opus';
  if (raw === 'anthropic_sonnet' || raw === 'claude_code_sonnet' || raw === 'claude-code/sonnet') return 'anthropic_sonnet';
  return 'anthropic_haiku';
}

function shouldUseCurlFallback(error: unknown, url: string): boolean {
  const err = error as Error & { cause?: Error };
  const message = `${err?.message || ''} ${err?.cause?.message || ''}`.toLowerCase();
  return (
    (url.includes('localhost') || url.includes('127.0.0.1')) &&
    (message.includes('eperm') || message.includes('fetch failed') || message.includes('connect eperm'))
  );
}

function fetchJsonViaCurl(url: string, authToken: string, timeoutMs: number): HubFetchResponse | null {
  try {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const raw = execFileSync('/usr/bin/curl', [
      '-sS',
      '--max-time',
      String(seconds),
      '-H',
      `Authorization: Bearer ${authToken}`,
      '-H',
      'Content-Type: application/json',
      url,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildQueryString(params: Record<string, any>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const raw = search.toString();
  return raw ? `?${raw}` : '';
}

function postJsonViaCurl(url: string, authToken: string, payload: any, timeoutMs: number): any | null {
  try {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const raw = execFileSync('/usr/bin/curl', [
      '-sS',
      '--max-time',
      String(seconds),
      '-X',
      'POST',
      '-H',
      `Authorization: Bearer ${authToken}`,
      '-H',
      'Content-Type: application/json',
      '--data',
      JSON.stringify(payload),
      url,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readResponseReason(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const json = JSON.parse(text) as { reason?: string; error?: string };
      return String(json.reason || json.error || '').trim();
    } catch {
      return text.slice(0, 160).trim();
    }
  } catch {
    return '';
  }
}

function stringifyHubErrorReason(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (value instanceof Error) return String(value.message || '').trim();
  if (typeof value === 'object') {
    try {
      const plain = value as Record<string, unknown>;
      const direct = [
        plain.message,
        plain.error,
        plain.reason,
        plain.detail,
        plain.code,
      ]
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .find(Boolean);
      if (direct) return direct;
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).trim();
}

type FetchHubSecretsOptions = {
  silentStatuses?: number[];
};

export async function fetchHubSecrets(category: string, timeoutMs = 3000, options: FetchHubSecretsOptions = {}): Promise<any | null> {
  if (!env.USE_HUB_SECRETS || !env.HUB_BASE_URL) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:secrets', '[hub-client] HUB_AUTH_TOKEN 없음 — hub secrets 조회 생략');
    return null;
  }

  const cacheKey = getCacheKey('secret', category);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;
  const sharedFresh = readSharedSecretCache(category, 'fresh');
  if (sharedFresh !== undefined) {
    setCached(cacheKey, sharedFresh, Math.min(getSecretsSuccessTtl(category), 15000));
    return sharedFresh;
  }

  const url = `${env.HUB_BASE_URL}/hub/secrets/${category}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        ...cycleTraceHeaders(getCurrentCycleTraceFields()),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const silentStatuses = new Set(options.silentStatuses || []);
      if (!silentStatuses.has(res.status)) {
        warnOnce(`hub-secrets:${category}:${res.status}`, `[hub-client] ${category}: HTTP ${res.status}`);
      }
      if (res.status === 429 || res.status >= 500) {
        const stale = useSharedSecretCacheFallback(category, cacheKey, `HTTP ${res.status}`);
        if (stale !== undefined) return stale;
      }
      if (res.status === 429) setCached(cacheKey, null, getSecretsRateLimitTtl(category));
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json() as HubFetchResponse;
    const data = json.data || null;
    setCached(cacheKey, data, getSecretsSuccessTtl(category));
    writeSharedSecretCache(category, data, getSecretsSuccessTtl(category));
    return data;
  } catch (error) {
    const err = error as Error & { name?: string };
    if (shouldUseCurlFallback(error, url)) {
      const json = fetchJsonViaCurl(url, env.HUB_AUTH_TOKEN, timeoutMs);
      if (json) {
        const data = json.data || null;
        setCached(cacheKey, data, getSecretsSuccessTtl(category));
        writeSharedSecretCache(category, data, getSecretsSuccessTtl(category));
        return data;
      }
    }
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    const stale = useSharedSecretCacheFallback(category, cacheKey, message || 'fetch_failed');
    if (stale !== undefined) return stale;
    console.warn(`[hub-client] ${category}: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function queryOpsDb(
  sql: string,
  schema = 'investment',
  params: any[] = [],
  timeoutMs = 5000,
): Promise<any | null> {
  if (!env.HUB_BASE_URL) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:query', '[hub-client] HUB_AUTH_TOKEN 없음 — queryOpsDb 생략');
    return null;
  }

  const safeParams = Array.isArray(params) ? params : [];
  const cacheKey = getCacheKey('query', `${schema}:${sql}:${JSON.stringify(safeParams)}`);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${env.HUB_BASE_URL}/hub/pg/query`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        ...cycleTraceHeaders(getCurrentCycleTraceFields()),
      },
      body: JSON.stringify({ sql, schema, params: safeParams }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const reason = await readResponseReason(res);
      const suffix = reason ? ` (${reason})` : '';
      warnOnce(`hub-query:${res.status}:${reason || 'unknown'}`, `[hub-client] queryOpsDb: HTTP ${res.status}${suffix}`);
      if (res.status === 429) setCached(cacheKey, null, 3000);
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json();
    setCached(cacheKey, json, 3000);
    return json;
  } catch (error) {
    const err = error as Error & { name?: string };
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] queryOpsDb: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHubSecretMetadata(category?: string, timeoutMs = 3000): Promise<any | null> {
  if (!env.HUB_BASE_URL) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:secrets-meta', '[hub-client] HUB_AUTH_TOKEN 없음 — secrets-meta 조회 생략');
    return null;
  }

  const cacheKey = getCacheKey('secrets-meta', category || '*');
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const url = category
    ? `${env.HUB_BASE_URL}/hub/secrets-meta/${encodeURIComponent(category)}`
    : `${env.HUB_BASE_URL}/hub/secrets-meta`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      warnOnce(`hub-secrets-meta:${category || '*'}:${res.status}`, `[hub-client] secrets-meta${category ? ` ${category}` : ''}: HTTP ${res.status}`);
      if (res.status === 429) setCached(cacheKey, null, 5000);
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json();
    setCached(cacheKey, json, 30000);
    return json;
  } catch (error) {
    const err = error as Error & { name?: string };
    if (shouldUseCurlFallback(error, url)) {
      const json = fetchJsonViaCurl(url, env.HUB_AUTH_TOKEN, timeoutMs);
      if (json) {
        setCached(cacheKey, json, 30000);
        return json;
      }
    }
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] secrets-meta: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchOpsErrors(minutes = 60, service: string | null = null, timeoutMs = 3000): Promise<any | null> {
  if (!env.HUB_BASE_URL) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:errors', '[hub-client] HUB_AUTH_TOKEN 없음 — fetchOpsErrors 생략');
    return null;
  }

  const cacheKey = getCacheKey('errors', `${minutes}:${service || '*'}`);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  let url = `${env.HUB_BASE_URL}/hub/errors/recent?minutes=${minutes}`;
  if (service) url += `&service=${encodeURIComponent(service)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      warnOnce(`hub-errors:${res.status}`, `[hub-client] fetchOpsErrors: HTTP ${res.status}`);
      if (res.status === 429) setCached(cacheKey, null, 3000);
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json();
    setCached(cacheKey, json, 3000);
    return json;
  } catch (error) {
    const err = error as Error & { name?: string };
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] fetchOpsErrors: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHubRuntimeProfile(team: string, purpose = 'default', timeoutMs = 3000): Promise<HubFetchResponse['profile'] | null> {
  if (!env.HUB_BASE_URL || !team) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:runtime', '[hub-client] HUB_AUTH_TOKEN 없음 — runtime profile 조회 생략');
    return null;
  }

  const cacheKey = getCacheKey('runtime', `${team}:${purpose}`);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached as HubFetchResponse['profile'];

  const url = `${env.HUB_BASE_URL}/hub/runtime/select?team=${encodeURIComponent(team)}&purpose=${encodeURIComponent(purpose)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      warnOnce(`hub-runtime:${team}:${purpose}:${res.status}`, `[hub-client] runtime ${team}/${purpose}: HTTP ${res.status}`);
      if (res.status === 429) setCached(cacheKey, null, 3000);
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json() as HubFetchResponse;
    const data = json?.profile || null;
    setCached(cacheKey, data, 5000);
    return data;
  } catch (error) {
    const err = error as Error & { name?: string };
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] runtime ${team}/${purpose}: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function callHubLlm(request: HubLlmCallRequest): Promise<HubLlmCallResponse> {
  const callerTeam = String(request?.callerTeam || '').trim();
  const agent = String(request?.agent || '').trim();
  const prompt = String(request?.prompt || '').trim();
  if (!callerTeam) throw new Error('callerTeam required for Hub LLM call');
  if (!agent) throw new Error('agent required for Hub LLM call');
  if (!prompt) throw new Error('prompt required for Hub LLM call');
  if (!env.HUB_BASE_URL) throw new Error('HUB_BASE_URL required for Hub LLM call');
  if (!env.HUB_AUTH_TOKEN) throw new Error('HUB_AUTH_TOKEN required for Hub LLM call');

  const requestedTimeoutMs = Math.max(1000, Number(request.timeoutMs || 30000) || 30000);
  const timeoutMs = Math.min(requestedTimeoutMs, resolveHubLlmMaxTimeoutMs(request));
  const abstractModel = normalizeHubAbstractModel(request.abstractModel || 'claude_code_haiku');
  const payload = {
    ...request,
    callerTeam,
    agent,
    prompt,
    abstractModel,
    taskType: request.taskType || 'default',
    timeoutMs,
  };
  const tracedPayload = withCurrentCycleTrace(payload);
  const safePayload = prepareHubLlmPayload(tracedPayload);
  if (safePayload?.payloadRejected) {
    throw new Error(`hub_llm_payload_too_large:${safePayload.payloadRejectReason || 'client_payload_limit'}:${safePayload.finalPayloadBytes || 0}>${safePayload.payloadLimitBytes || 0}`);
  }
  const url = `${env.HUB_BASE_URL}/hub/llm/call`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 1000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(safePayload),
      signal: controller.signal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      const reason = stringifyHubErrorReason(body?.error || body?.reason || `HTTP ${res.status}`) || `HTTP ${res.status}`;
      throw new Error(`hub_llm_call_failed:${reason}`);
    }

    const text = String(body?.result || body?.text || '').trim();
    if (!text) throw new Error('hub_llm_call_failed:empty_response');
    return {
      ok: true,
      text,
      result: text,
      provider: body?.provider,
      model: body?.model || body?.selected_route,
      selected_route: body?.selected_route || body?.model,
      fallbackCount: Number(body?.fallbackCount || 0),
      attempted_providers: Array.isArray(body?.attempted_providers) ? body.attempted_providers : [],
      durationMs: Number(body?.durationMs || 0),
      traceId: body?.traceId || null,
      admission: body?.admission || null,
      raw: body,
    };
  } catch (error) {
    if (shouldUseCurlFallback(error, url)) {
      const body = postJsonViaCurl(url, env.HUB_AUTH_TOKEN, safePayload, timeoutMs);
      if (body?.ok !== false) {
        const text = String(body?.result || body?.text || '').trim();
        if (text) {
          return {
            ok: true,
            text,
            result: text,
            provider: body?.provider,
            model: body?.model || body?.selected_route,
            selected_route: body?.selected_route || body?.model,
            fallbackCount: Number(body?.fallbackCount || 0),
            attempted_providers: Array.isArray(body?.attempted_providers) ? body.attempted_providers : [],
            durationMs: Number(body?.durationMs || 0),
            traceId: body?.traceId || null,
            admission: body?.admission || null,
            raw: body,
          };
        }
      }
    }
    const err = error as Error & { name?: string };
    const message = err.name === 'AbortError'
      ? '타임아웃'
      : (stringifyHubErrorReason(err.message || err) || 'hub_call_error');
    throw new Error(`hub_llm_call_failed:${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function resolveHubLlmMaxTimeoutMs(request: HubLlmCallRequest): number {
  if (isArcherRequest(request)) return 300_000;
  return isLongRunningBlogWriterRequest(request) ? 600_000 : 180_000;
}

function isArcherRequest(request: HubLlmCallRequest): boolean {
  const callerTeam = String(request?.callerTeam || '').trim().toLowerCase();
  const selectorKey = String(request?.selectorKey || '').trim().toLowerCase();
  const agent = String(request?.agent || '').trim().toLowerCase();
  return callerTeam === 'claude'
    && (agent === 'archer' || selectorKey === 'claude.archer.tech_analysis');
}

function isLongRunningBlogWriterRequest(request: HubLlmCallRequest): boolean {
  const callerTeam = String(request?.callerTeam || '').trim().toLowerCase();
  const selectorKey = String(request?.selectorKey || '').trim().toLowerCase();
  const agent = String(request?.agent || '').trim().toLowerCase();
  if (callerTeam !== 'blog') return false;
  return selectorKey === 'blog.pos.writer'
    || selectorKey === 'blog.gems.writer'
    || agent === 'pos'
    || agent === 'gems';
}

export async function callHubVision(request: HubVisionRequest): Promise<HubLlmCallResponse> {
  const callerTeam = String(request?.callerTeam || '').trim();
  const agent = String(request?.agent || '').trim();
  const prompt = String(request?.prompt || '').trim();
  if (!callerTeam) throw new Error('callerTeam required for Hub vision call');
  if (!agent) throw new Error('agent required for Hub vision call');
  if (!prompt) throw new Error('prompt required for Hub vision call');
  if (!request?.imageBase64 && !request?.imageDataUrl) throw new Error('image required for Hub vision call');
  if (!env.HUB_BASE_URL) throw new Error('HUB_BASE_URL required for Hub vision call');
  if (!env.HUB_AUTH_TOKEN) throw new Error('HUB_AUTH_TOKEN required for Hub vision call');

  const timeoutMs = Math.min(Math.max(5_000, Number(request.timeoutMs || 45_000) || 45_000), 180_000);
  const payload = {
    ...request,
    callerTeam,
    agent,
    prompt,
    taskType: request.taskType || 'vision',
    timeoutMs,
  };
  const body = await postHubJson('/hub/llm/vision', payload, timeoutMs);
  const text = String(body?.result || body?.text || '').trim();
  if (!text) throw new Error('hub_vision_call_failed:empty_response');
  return {
    ok: true,
    text,
    result: text,
    provider: body?.provider,
    model: body?.model || body?.selected_route,
    selected_route: body?.selected_route || body?.model,
    fallbackCount: Number(body?.fallbackCount || 0),
    attempted_providers: [],
    durationMs: Number(body?.durationMs || 0),
    traceId: body?.traceId || null,
    raw: body,
  };
}

export async function callHubEmbedding(request: HubEmbeddingRequest): Promise<{ ok: boolean; data: Array<{ index: number; embedding: number[] }>; model?: string; dimensions?: number; traceId?: string | null; raw?: any }> {
  const callerTeam = String(request?.callerTeam || '').trim();
  const agent = String(request?.agent || '').trim();
  if (!callerTeam) throw new Error('callerTeam required for Hub embedding call');
  if (!agent) throw new Error('agent required for Hub embedding call');
  if (!env.HUB_BASE_URL) throw new Error('HUB_BASE_URL required for Hub embedding call');
  if (!env.HUB_AUTH_TOKEN) throw new Error('HUB_AUTH_TOKEN required for Hub embedding call');

  const timeoutMs = Math.min(Math.max(5_000, Number(request.timeoutMs || 30_000) || 30_000), 180_000);
  const body = await postHubJson('/hub/llm/embeddings', {
    ...request,
    callerTeam,
    agent,
    taskType: request.taskType || 'embedding',
  }, timeoutMs);
  const data = Array.isArray(body?.data) ? body.data : [];
  if (!data.length) throw new Error('hub_embedding_call_failed:empty_response');
  return {
    ok: true,
    data,
    model: body?.model,
    dimensions: Number(body?.dimensions || 0) || undefined,
    traceId: body?.traceId || null,
    raw: body,
  };
}

export async function fetchHubLlmSelector(request: HubSelectorRequest): Promise<any | null> {
  const selectorKey = String(request?.selectorKey || request?.key || '').trim();
  if (!selectorKey) throw new Error('selectorKey required for Hub selector lookup');
  if (!env.HUB_BASE_URL) throw new Error('HUB_BASE_URL required for Hub selector lookup');
  if (!env.HUB_AUTH_TOKEN) throw new Error('HUB_AUTH_TOKEN required for Hub selector lookup');
  const timeoutMs = Math.min(Math.max(1_000, Number(request.timeoutMs || 5_000) || 5_000), 30_000);
  const query = buildQueryString({
    key: selectorKey,
    callerTeam: request.callerTeam || request.team,
    team: request.team || request.callerTeam,
    agent: request.agent || request.agentName,
    agentName: request.agentName || request.agent,
    taskType: request.taskType || request.task_type,
    task_type: request.task_type || request.taskType,
    runtimePurpose: request.runtimePurpose || request.runtime_purpose,
    runtime_purpose: request.runtime_purpose || request.runtimePurpose,
    selectorVersion: request.selectorVersion || 'v3.0_oauth_4',
    rolloutPercent: request.rolloutPercent ?? 100,
    rolloutKey: request.rolloutKey || `hub-client:${selectorKey}`,
  });
  const url = `${env.HUB_BASE_URL}/hub/llm/selector${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 500);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        ...cycleTraceHeaders(getCurrentCycleTraceFields()),
      },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      const reason = stringifyHubErrorReason(body?.error || body?.reason || `HTTP ${res.status}`) || `HTTP ${res.status}`;
      throw new Error(`hub_selector_lookup_failed:${reason}`);
    }
    return body;
  } catch (error) {
    if (shouldUseCurlFallback(error, url)) {
      const body = fetchJsonViaCurl(url, env.HUB_AUTH_TOKEN, timeoutMs);
      if (body && body?.ok !== false) return body;
    }
    const err = error as Error & { name?: string };
    const message = err.name === 'AbortError'
      ? 'timeout'
      : (stringifyHubErrorReason(err.message || err) || 'hub_selector_error');
    throw new Error(`hub_selector_lookup_failed:${message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function postHubJson(path: string, payload: any, timeoutMs: number): Promise<any> {
  const url = `${env.HUB_BASE_URL}${path}`;
  const tracedPayload = withCurrentCycleTrace(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tracedPayload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      const reason = stringifyHubErrorReason(body?.error || body?.reason || `HTTP ${res.status}`) || `HTTP ${res.status}`;
      throw new Error(`hub_call_failed:${reason}`);
    }
    return body;
  } catch (error) {
    if (shouldUseCurlFallback(error, url)) {
      const body = postJsonViaCurl(url, env.HUB_AUTH_TOKEN, tracedPayload, timeoutMs);
      if (body && body?.ok !== false) return body;
    }
    const err = error as Error & { name?: string };
    const message = err.name === 'AbortError'
      ? '타임아웃'
      : (stringifyHubErrorReason(err.message || err) || 'hub_call_error');
    throw new Error(`hub_call_failed:${message}`);
  } finally {
    clearTimeout(timer);
  }
}
