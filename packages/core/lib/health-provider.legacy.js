'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const hsm = require('./health-state-manager');
const { resolveProductionWebhookUrl } = require('./n8n-webhook-registry');

const DEFAULT_NORMAL_EXIT_CODES = new Set([0, -9, -15]);

function getLaunchctlPrintStatus(label) {
  try {
    const raw = execSync(`launchctl print gui/$(id -u)/${label} 2>/dev/null`, { encoding: 'utf-8' });
    const running = /^\s*state = running$/m.test(raw);
    const pidMatch = raw.match(/^\s*pid = (\d+)$/m);
    const exitMatch = raw.match(/^\s*last exit code = (?:\((?:never exited)\)|(-?\d+))/m);
    return {
      running,
      pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
      exitCode: exitMatch && exitMatch[1] ? Number.parseInt(exitMatch[1], 10) : 0,
      loaded: true,
    };
  } catch {
    return null;
  }
}

function getLaunchctlStatus(labels = []) {
  let raw = '';
  try {
    raw = execSync('launchctl list', { encoding: 'utf-8' });
  } catch {
    raw = '';
  }
  const services = {};
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, exitCode, label] = parts;
    services[label] = {
      running: pid !== '-',
      pid: pid !== '-' ? parseInt(pid, 10) : null,
      exitCode: Number.parseInt(exitCode, 10) || 0,
    };
  }
  for (const label of labels) {
    if (!label || services[label]) continue;
    const detailed = getLaunchctlPrintStatus(label);
    if (detailed) {
      services[label] = detailed;
    }
  }
  return services;
}

function buildServiceRows(status, {
  labels = [],
  continuous = [],
  normalExitCodes = DEFAULT_NORMAL_EXIT_CODES,
  shortLabel = (label) => hsm.shortLabel(label),
  isExpectedExit = (label, exitCode, svc) => false,
  treatMissingAsOk = false,
  missingOkText = (name, label) => `  ${name}: 대기`,
} = {}) {
  const ok = [];
  const warn = [];

  for (const label of labels) {
    const svc = status[label];
    const name = shortLabel(label);
    if (!svc) {
      if (treatMissingAsOk) ok.push(missingOkText(name, label));
      else warn.push(`  ${name}: 미로드`);
      continue;
    }
    if (continuous.includes(label) && !svc.running) {
      warn.push(`  ${name}: 다운 (PID 없음)`);
      continue;
    }
    if (
      !normalExitCodes.has(svc.exitCode) &&
      !isExpectedExit(label, svc.exitCode, svc) &&
      !(continuous.includes(label) && svc.running)
    ) {
      warn.push(`  ${name}: exit ${svc.exitCode}`);
      continue;
    }
    if (svc.running && svc.pid) {
      ok.push(`  ${name}: 정상 (PID ${svc.pid})`);
    } else if (isExpectedExit(label, svc.exitCode, svc)) {
      ok.push(`  ${name}: 점검 완료 (exit ${svc.exitCode})`);
    } else {
      ok.push(`  ${name}: 정상`);
    }
  }

  return { ok, warn };
}

async function checkHttp(url, timeoutMs = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchJson(url, timeoutMs = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function postJson(url, body = {}, {
  timeoutMs = 5000,
  headers = {},
} = {}) {
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
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: res.ok,
      status: res.status,
      text,
      json,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      json: null,
      error: String(error?.message || 'request_failed'),
    };
  }
}

async function checkWebhookRegistration(url, body = {}, options = {}) {
  if (!url) {
    return {
      healthy: false,
      registered: false,
      status: 0,
      reason: 'missing_url',
    };
  }

  const probeBody = {
    _healthProbe: true,
    ...body,
  };
  const result = await postJson(url, probeBody, {
    ...options,
    headers: {
      'x-health-probe': '1',
      ...(options.headers || {}),
    },
  });
  if (result.error) {
    return {
      healthy: false,
      registered: false,
      status: 0,
      reason: 'unreachable',
      error: result.error,
    };
  }

  const text = String(result.text || '').toLowerCase();
  if (result.status === 404 && text.includes('not registered')) {
    return {
      healthy: true,
      registered: false,
      status: result.status,
      reason: 'not_registered',
    };
  }

  if (result.status === 404) {
    return {
      healthy: true,
      registered: false,
      status: result.status,
      reason: 'missing_route',
    };
  }

  if (result.status === 403) {
    return {
      healthy: true,
      registered: true,
      status: result.status,
      reason: 'forbidden',
    };
  }

  if (result.status >= 500) {
    return {
      healthy: true,
      registered: true,
      status: result.status,
      reason: 'handler_failed',
    };
  }

  return {
    healthy: true,
    registered: result.ok,
    status: result.status,
    reason: result.ok ? 'ok' : `http_${result.status}`,
    body: result.json,
  };
}

function checkFileStaleness(filePath, staleMs) {
  try {
    const stat = fs.statSync(filePath);
    const ageMs = Date.now() - stat.mtimeMs;
    return {
      exists: true,
      ageMs,
      stale: ageMs > staleMs,
      minutesAgo: Math.floor(ageMs / 60000),
    };
  } catch {
    return { exists: false, ageMs: null, stale: false, minutesAgo: null };
  }
}

async function buildHttpChecks(checks = []) {
  const ok = [];
  const warn = [];
  const results = {};

  for (const check of checks) {
    if (!check || !check.label || !check.url) continue;
    const timeoutMs = check.timeoutMs || 5000;
    const data = check.expectJson ? await fetchJson(check.url, timeoutMs) : await checkHttp(check.url, timeoutMs);
    const isOk = typeof check.isOk === 'function' ? Boolean(check.isOk(data)) : Boolean(data);
    results[check.label] = data;
    if (isOk) ok.push(typeof check.okText === 'function' ? check.okText(data) : (check.okText || `  ${check.label}: 정상`));
    else warn.push(typeof check.warnText === 'function' ? check.warnText(data) : (check.warnText || `  ${check.label}: 응답 없음`));
  }

  return { ok, warn, results };
}

function buildFileActivityHealth({
  label,
  filePath,
  staleMs,
  missingText,
  staleText,
  okText,
}) {
  const logState = checkFileStaleness(filePath, staleMs);
  const ok = [];
  const warn = [];

  if (!logState.exists) {
    warn.push(missingText || `  ${label}: 파일 없음`);
  } else if (logState.stale) {
    warn.push(typeof staleText === 'function' ? staleText(logState) : (staleText || `  ${label}: ${logState.minutesAgo}분 무활동`));
  } else {
    ok.push(typeof okText === 'function' ? okText(logState) : (okText || `  ${label}: 최근 ${logState.minutesAgo}분 이내 활동`));
  }

  return {
    ok,
    warn,
    minutesAgo: logState.minutesAgo,
    exists: logState.exists,
    stale: logState.stale,
  };
}

async function buildResolvedWebhookHealth({
  workflowName,
  pathSuffix,
  method = 'POST',
  healthUrl = 'http://127.0.0.1:5678/healthz',
  defaultWebhookUrl = '',
  probeBody = {},
  timeoutMs = 5000,
  okLabel = 'webhook',
  warnLabel = 'webhook',
} = {}) {
  const ok = [];
  const warn = [];
  const n8nHealthy = await checkHttp(healthUrl, 2500);
  const resolvedWebhookUrl = await resolveProductionWebhookUrl({
    workflowName,
    method,
    pathSuffix,
  });
  const webhookUrl = resolvedWebhookUrl || defaultWebhookUrl;
  const webhook = await checkWebhookRegistration(webhookUrl, probeBody, { timeoutMs });

  if (n8nHealthy) ok.push('  n8n healthz: 정상');
  else warn.push('  n8n healthz: 응답 없음');

  if (!webhook.healthy) {
    warn.push(`  ${warnLabel}: 미도달 (${webhook.error || webhook.reason})`);
  } else if (!webhook.registered) {
    warn.push(`  ${warnLabel}: 미등록 (${webhook.reason}, status ${webhook.status})`);
  } else {
    ok.push(`  ${okLabel}: 등록됨 (${webhook.reason}, status ${webhook.status})`);
  }

  return {
    ok,
    warn,
    n8nHealthy,
    webhookRegistered: webhook.registered,
    webhookReason: webhook.reason,
    webhookStatus: webhook.status,
    webhookHealthy: webhook.healthy,
    webhookUrl,
    resolvedWebhookUrl,
  };
}

module.exports = {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
  checkHttp,
  fetchJson,
  postJson,
  checkWebhookRegistration,
  checkFileStaleness,
  buildHttpChecks,
  buildFileActivityHealth,
  buildResolvedWebhookHealth,
};
