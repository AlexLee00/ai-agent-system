const env = require('./env.legacy.js');
const { execFileSync } = require('child_process');

type CacheEntry = {
  value: any;
  expiresAt: number;
};

type HubFetchResponse = {
  data?: any;
  profile?: any;
};

type HubLlmCallRequest = {
  callerTeam: string;
  agent: string;
  selectorKey?: string;
  taskType?: string;
  abstractModel?: 'anthropic_haiku' | 'anthropic_sonnet' | 'anthropic_opus';
  prompt: string;
  systemPrompt?: string;
  jsonSchema?: any;
  timeoutMs?: number;
  maxTokens?: number;
  maxBudgetUsd?: number;
  preferredApi?: string;
  groqModel?: string;
  configuredProviders?: string[];
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  priority?: 'low' | 'normal' | 'high' | 'critical';
  cacheEnabled?: boolean;
  cacheType?: string;
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
    case 'openclaw':
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
    case 'openclaw':
    case 'reservation':
    case 'reservation-shared':
      return 10000;
    default:
      return 5000;
  }
}

function warnOnce(key: string, message: string, ttlMs = 30000): void {
  const last = warnCache.get(key) || 0;
  if ((Date.now() - last) < ttlMs) return;
  warnCache.set(key, Date.now());
  console.warn(message);
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

export async function fetchHubSecrets(category: string, timeoutMs = 3000): Promise<any | null> {
  if (!env.USE_HUB_SECRETS || !env.HUB_BASE_URL) return null;
  if (!env.HUB_AUTH_TOKEN) {
    warnOnce('hub-auth-missing:secrets', '[hub-client] HUB_AUTH_TOKEN 없음 — hub secrets 조회 생략');
    return null;
  }

  const cacheKey = getCacheKey('secret', category);
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${env.HUB_BASE_URL}/hub/secrets/${category}`;
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
      warnOnce(`hub-secrets:${category}:${res.status}`, `[hub-client] ${category}: HTTP ${res.status}`);
      if (res.status === 429) setCached(cacheKey, null, getSecretsRateLimitTtl(category));
      if (res.status === 401) setCached(cacheKey, null, 30000);
      return null;
    }

    const json = await res.json() as HubFetchResponse;
    const data = json.data || null;
    setCached(cacheKey, data, getSecretsSuccessTtl(category));
    return data;
  } catch (error) {
    const err = error as Error & { name?: string };
    if (shouldUseCurlFallback(error, url)) {
      const json = fetchJsonViaCurl(url, env.HUB_AUTH_TOKEN, timeoutMs);
      if (json) {
        const data = json.data || null;
        setCached(cacheKey, data, getSecretsSuccessTtl(category));
        return data;
      }
    }
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
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

  const timeoutMs = Math.max(1000, Number(request.timeoutMs || 30000) || 30000);
  const payload = {
    ...request,
    callerTeam,
    agent,
    prompt,
    abstractModel: request.abstractModel || 'anthropic_sonnet',
    taskType: request.taskType || 'default',
  };
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
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      const reason = String(body?.error || body?.reason || `HTTP ${res.status}`).trim();
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
      const body = postJsonViaCurl(url, env.HUB_AUTH_TOKEN, payload, timeoutMs);
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
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    throw new Error(`hub_llm_call_failed:${message}`);
  } finally {
    clearTimeout(timer);
  }
}
