'use strict';

const DEFAULT_HEALTH_TIMEOUT_MS = Number(process.env.N8N_HEALTH_TIMEOUT_MS || 2500);
const DEFAULT_WEBHOOK_TIMEOUT_MS = Number(process.env.N8N_WEBHOOK_TIMEOUT_MS || 30000);
const DEFAULT_BACKOFF_MS = 30 * 60 * 1000;

const _circuits = new Map();

function _getCircuit(name) {
  if (!_circuits.has(name)) {
    _circuits.set(name, { disabledUntil: 0, reason: '' });
  }
  return _circuits.get(name);
}

function isCircuitOpen(name) {
  return _getCircuit(name).disabledUntil > Date.now();
}

function openCircuit(name, reason, backoffMs = DEFAULT_BACKOFF_MS) {
  const circuit = _getCircuit(name);
  circuit.disabledUntil = Date.now() + backoffMs;
  circuit.reason = reason;
}

function resetCircuit(name) {
  const circuit = _getCircuit(name);
  circuit.disabledUntil = 0;
  circuit.reason = '';
}

function getCircuitState(name) {
  const circuit = _getCircuit(name);
  return {
    open: circuit.disabledUntil > Date.now(),
    disabledUntil: circuit.disabledUntil,
    reason: circuit.reason,
  };
}

async function probeN8nHealth(healthUrl, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
  if (!healthUrl) return false;
  try {
    const res = await fetch(healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function triggerWebhookCandidates({
  candidates,
  body,
  timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
  headers = {},
}) {
  const failures = [];
  for (const url of [...new Set((candidates || []).filter(Boolean))]) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        return { ok: true, url, status: res.status, body: parsed };
      }

      if (res.status === 404) {
        failures.push({ url, status: res.status, reason: 'not_registered' });
        continue;
      }

      failures.push({ url, status: res.status, reason: `http_${res.status}` });
      return { ok: false, url, status: res.status, reason: `http_${res.status}`, failures };
    } catch (e) {
      failures.push({ url, reason: String(e?.message || 'request_failed') });
      // 다음 후보로 진행
    }
  }

  const onlyNotRegistered = failures.length > 0 && failures.every(item => item.reason === 'not_registered');
  return {
    ok: false,
    reason: onlyNotRegistered ? 'webhook_not_registered' : 'webhook_unavailable',
    failures,
  };
}

async function runWithN8nFallback({
  circuitName,
  webhookCandidates,
  healthUrl,
  body,
  directRunner,
  headers = {},
  webhookTimeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  backoffMs = DEFAULT_BACKOFF_MS,
  logger = console,
}) {
  const state = getCircuitState(circuitName);
  if (state.open) {
    logger.log(`[n8n] 우회 중 (${circuitName}: ${state.reason})`);
    return directRunner();
  }

  const healthy = await probeN8nHealth(healthUrl, healthTimeoutMs);
  if (!healthy) {
    openCircuit(circuitName, 'health_unreachable', backoffMs);
    logger.warn(`[n8n] 헬스체크 실패 (${circuitName}) — direct fallback`);
    return directRunner();
  }

  const triggered = await triggerWebhookCandidates({
    candidates: webhookCandidates,
    body,
    timeoutMs: webhookTimeoutMs,
    headers,
  });

  if (triggered.ok) {
    resetCircuit(circuitName);
    return {
      ok: true,
      source: 'n8n',
      webhookUrl: triggered.url,
      statusCode: triggered.status,
      ...(triggered.body && typeof triggered.body === 'object' ? triggered.body : {}),
    };
  }

  openCircuit(circuitName, triggered.reason || 'webhook_failed', backoffMs);
  const detail = Array.isArray(triggered.failures) && triggered.failures.length > 0
    ? ` [${triggered.failures.map(item => `${item.url}:${item.reason}`).join(', ')}]`
    : '';
  logger.warn(`[n8n] 웹훅 실패 (${circuitName}: ${triggered.reason || 'unknown'})${detail} — direct fallback`);
  return directRunner();
}

module.exports = {
  probeN8nHealth,
  triggerWebhookCandidates,
  runWithN8nFallback,
  getCircuitState,
  isCircuitOpen,
  openCircuit,
  resetCircuit,
};
