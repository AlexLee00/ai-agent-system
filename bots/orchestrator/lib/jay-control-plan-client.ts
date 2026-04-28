'use strict';

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function buildBaseUrl() {
  return normalizeText(
    process.env.HUB_BASE_URL
      || process.env.HUB_RESOURCE_API_URL
      || process.env.HUB_URL
      || 'http://127.0.0.1:7788',
    'http://127.0.0.1:7788',
  ).replace(/\/+$/, '');
}

function buildAuthToken() {
  return normalizeText(
    process.env.HUB_AUTH_TOKEN
      || process.env.ORCHESTRATOR_HUB_AUTH_TOKEN
      || '',
  );
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function requestWithRetry(input) {
  const baseUrl = normalizeText(input.baseUrl, buildBaseUrl());
  const token = normalizeText(input.token, buildAuthToken());
  const method = normalizeText(input.method, 'POST').toUpperCase();
  const endpoint = normalizeText(input.endpoint);
  const body = input.body || {};
  const timeoutMs = Math.max(1000, Number(input.timeoutMs || 15_000) || 15_000);
  const retries = Math.max(0, Number(input.retries || 2) || 0);
  const retryDelayMs = Math.max(100, Number(input.retryDelayMs || 800) || 800);
  const extraHeaders = input?.extraHeaders && typeof input.extraHeaders === 'object'
    ? input.extraHeaders
    : {};

  if (!endpoint) {
    return { ok: false, error: 'hub_endpoint_required' };
  }
  if (!token) {
    return { ok: false, error: 'hub_auth_token_missing' };
  }

  const url = `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...extraHeaders,
        },
        body: method === 'GET' ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      const durationMs = Date.now() - startedAt;
      if (response.ok && payload?.ok === true) {
        return {
          ok: true,
          status: response.status,
          durationMs,
          payload,
          url,
          attempt,
        };
      }
      const structuredError = {
        ok: false,
        status: response.status,
        durationMs,
        payload,
        error: normalizeText(payload?.error || payload?.message || `http_${response.status}`),
        url,
        attempt,
      };
      lastError = structuredError;
      if (attempt < retries && isRetryableStatus(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        continue;
      }
      return structuredError;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      lastError = {
        ok: false,
        status: 0,
        durationMs,
        error: normalizeText(error?.message || error, 'hub_request_failed'),
        detail: String(error?.stack || error || ''),
        url,
        attempt,
      };
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        continue;
      }
      return lastError;
    }
  }
  return lastError || { ok: false, error: 'hub_request_failed' };
}

async function createControlPlanDraft(input) {
  const incidentKey = normalizeText(input?.incidentKey, '');
  const traceId = normalizeText(input?.traceId, incidentKey || '');
  const request = {
    message: normalizeText(input?.message, ''),
    goal: normalizeText(input?.goal, ''),
    team: normalizeText(input?.team, 'general'),
    dryRun: input?.dryRun !== false,
    context: {
      ...(input?.context && typeof input.context === 'object' ? input.context : {}),
      incidentKey: incidentKey || undefined,
      traceId: traceId || undefined,
    },
  };
  if (!request.message && !request.goal) {
    return { ok: false, error: 'message_or_goal_required' };
  }
  return requestWithRetry({
    endpoint: '/hub/control/plan',
    body: request,
    timeoutMs: Number(input?.timeoutMs || 20_000),
    retries: Number(input?.retries ?? 2),
    retryDelayMs: Number(input?.retryDelayMs ?? 800),
    baseUrl: input?.baseUrl,
    token: input?.token,
    extraHeaders: {
      ...(traceId ? { 'x-trace-id': traceId } : {}),
      'x-caller-team': request.team,
      'x-agent': 'jay-orchestrator',
    },
  });
}

async function executeControlPlan(input) {
  const runId = normalizeText(input?.runId);
  const plan = input?.plan;
  if (!runId && !plan) return { ok: false, error: 'run_id_or_plan_required' };
  return requestWithRetry({
    endpoint: '/hub/control/execute',
    body: {
      run_id: runId || undefined,
      plan: plan || undefined,
    },
    timeoutMs: Number(input?.timeoutMs || 20_000),
    retries: Number(input?.retries ?? 1),
    retryDelayMs: Number(input?.retryDelayMs ?? 1000),
    baseUrl: input?.baseUrl,
    token: input?.token,
  });
}

async function submitControlCallback(input) {
  const callbackData = normalizeText(input?.callbackData);
  if (!callbackData) return { ok: false, error: 'callback_data_required' };
  const fromId = normalizeText(input?.fromId, '0');
  const username = normalizeText(input?.username, 'system');
  const chatId = normalizeText(input?.chatId, '');
  const threadId = normalizeText(input?.threadId, '');
  const trustedSecret = normalizeText(
    input?.callbackSecret || process.env.HUB_CONTROL_CALLBACK_SECRET,
    '',
  );
  if (!trustedSecret) {
    return { ok: false, error: 'hub_control_callback_secret_missing' };
  }
  return requestWithRetry({
    endpoint: '/hub/control/callback',
    body: {
      callback_data: callbackData,
      from: { id: fromId, username },
      message: {
        chat: { id: chatId },
        message_thread_id: threadId,
      },
    },
    timeoutMs: Number(input?.timeoutMs || 20_000),
    retries: Number(input?.retries ?? 1),
    retryDelayMs: Number(input?.retryDelayMs ?? 1000),
    baseUrl: input?.baseUrl,
    token: input?.token,
    method: 'POST',
    extraHeaders: {
      'x-hub-control-callback-secret': trustedSecret,
    },
  });
}

module.exports = {
  createControlPlanDraft,
  executeControlPlan,
  submitControlCallback,
  requestWithRetry,
  _testOnly: {
    isRetryableStatus,
    buildBaseUrl,
    buildAuthToken,
  },
};
