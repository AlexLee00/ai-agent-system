import fs from 'node:fs';
import { execSync } from 'node:child_process';

const hsm = require('./health-state-manager') as {
  shortLabel: (label: string) => string;
};

const { resolveProductionWebhookUrl } = require('./n8n-webhook-registry') as {
  resolveProductionWebhookUrl: (input?: {
    workflowName?: string;
    method?: string;
    pathSuffix?: string;
  }) => Promise<string | null>;
};

type LaunchctlServiceStatus = {
  running: boolean;
  pid: number | null;
  exitCode: number;
  loaded?: boolean;
  state?: string;
  stdoutPath?: string | null;
  stderrPath?: string | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  launchctlDetail?: string | null;
};

type LaunchctlStatusMap = Record<string, LaunchctlServiceStatus>;

type ServiceRowsOptions = {
  labels?: string[];
  continuous?: string[];
  normalExitCodes?: Set<number>;
  shortLabel?: (label: string) => string;
  isExpectedExit?: (label: string, exitCode: number, svc: LaunchctlServiceStatus) => boolean;
  treatMissingAsOk?: boolean | ((label: string, svc?: LaunchctlServiceStatus | null) => boolean);
  missingOkText?: (name: string, label: string) => string;
};

type HttpCheck = {
  label: string;
  url: string;
  timeoutMs?: number;
  expectJson?: boolean;
  isOk?: (data: unknown) => boolean;
  okText?: string | ((data: unknown) => string);
  warnText?: string | ((data: unknown) => string);
};

type FileStaleness = {
  exists: boolean;
  ageMs: number | null;
  stale: boolean;
  minutesAgo: number | null;
};

type FileActivityInput = {
  label: string;
  filePath: string;
  staleMs: number;
  missingText?: string;
  staleText?: string | ((state: FileStaleness) => string);
  okText?: string | ((state: FileStaleness) => string);
};

type ResolvedWebhookHealthInput = {
  workflowName?: string;
  pathSuffix?: string;
  method?: string;
  healthUrl?: string;
  defaultWebhookUrl?: string;
  probeBody?: Record<string, unknown>;
  timeoutMs?: number;
  okLabel?: string;
  warnLabel?: string;
};

type WebhookRegistrationResult = {
  healthy: boolean;
  registered: boolean;
  status: number;
  reason: string;
  error?: string;
  body?: unknown;
};

const DEFAULT_NORMAL_EXIT_CODES = new Set([0, -9, -15]);

function truncateText(text: string, max = 360): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function extractLaunchctlPath(printText: string, field: 'stdout' | 'stderr'): string | null {
  const match = String(printText || '').match(new RegExp(`\\b${field} path\\s*=\\s*(.+)$`, 'm'));
  return match ? String(match[1]).trim() : null;
}

function readLogTail(filePath: string | null, maxLines = 8, maxChars = 360): string | null {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const text = String(fs.readFileSync(filePath, 'utf8') || '').trim();
    if (!text) return null;
    return truncateText(text.split(/\r?\n/).slice(-maxLines).join('\n'), maxChars);
  } catch {
    return null;
  }
}

function classifyExitContext(svc: LaunchctlServiceStatus | undefined): {
  classification: 'operational_warning' | 'runtime_error';
  reason: string | null;
} {
  const text = [
    svc?.stderrTail || '',
    svc?.stdoutTail || '',
    svc?.launchctlDetail || '',
  ].join('\n').toLowerCase();
  if (
    text.includes('empty_screening_result') ||
    text.includes('유동성 필터 통과 후보 없음') ||
    text.includes('스크리닝 실패') ||
    text.includes('bridge 실패') && text.includes('direct fallback')
  ) {
    return { classification: 'operational_warning', reason: 'screening_or_bridge_fallback' };
  }
  return { classification: 'runtime_error', reason: null };
}

function getLaunchctlPrintStatus(label: string): LaunchctlServiceStatus | null {
  try {
    const raw = execSync(`launchctl print gui/$(id -u)/${label} 2>/dev/null`, { encoding: 'utf-8' });
    const running = /^\s*state = running$/m.test(raw);
    const stateMatch = raw.match(/^\s*state = (.+)$/m);
    const pidMatch = raw.match(/^\s*pid = (\d+)$/m);
    const exitMatch = raw.match(/^\s*last exit code = (?:\((?:never exited)\)|(-?\d+))/m);
    const stdoutPath = extractLaunchctlPath(raw, 'stdout');
    const stderrPath = extractLaunchctlPath(raw, 'stderr');
    return {
      running,
      pid: pidMatch ? Number.parseInt(pidMatch[1], 10) : null,
      exitCode: exitMatch && exitMatch[1] ? Number.parseInt(exitMatch[1], 10) : 0,
      loaded: true,
      state: stateMatch ? stateMatch[1].trim() : undefined,
      stdoutPath,
      stderrPath,
      stdoutTail: readLogTail(stdoutPath),
      stderrTail: readLogTail(stderrPath),
      launchctlDetail: truncateText(raw, 360),
    };
  } catch {
    return null;
  }
}

function getLaunchctlStatus(labels: string[] = []): LaunchctlStatusMap {
  let raw = '';
  try {
    raw = execSync('launchctl list', { encoding: 'utf-8' });
  } catch {
    raw = '';
  }
  const services: LaunchctlStatusMap = {};
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, exitCode, label] = parts;
    services[label] = {
      running: pid !== '-',
      pid: pid !== '-' ? Number.parseInt(pid, 10) : null,
      exitCode: Number.parseInt(exitCode, 10) || 0,
    };
  }
  for (const label of labels) {
    const detailed = getLaunchctlPrintStatus(label);
    if (detailed) {
      services[label] = {
        ...services[label],
        ...detailed,
      };
    } else if (!services[label]) {
      services[label] = {
        running: false,
        pid: null,
        exitCode: 0,
        loaded: false,
      };
    }
  }
  return services;
}

function buildServiceRows(
  status: LaunchctlStatusMap,
  {
    labels = [],
    continuous = [],
    normalExitCodes = DEFAULT_NORMAL_EXIT_CODES,
    shortLabel = (label: string) => hsm.shortLabel(label),
    isExpectedExit = () => false,
    treatMissingAsOk = false,
    missingOkText = (name: string) => `  ${name}: 대기`,
  }: ServiceRowsOptions = {},
): { ok: string[]; warn: string[] } {
  const ok: string[] = [];
  const warn: string[] = [];

  for (const label of labels) {
    const svc = status[label];
    const name = shortLabel(label);
    const missing = !svc || svc.loaded === false;
    if (missing) {
      const missingAllowed = typeof treatMissingAsOk === 'function'
        ? treatMissingAsOk(label, svc)
        : treatMissingAsOk;
      if (missingAllowed) ok.push(missingOkText(name, label));
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
      const exitContext = classifyExitContext(svc);
      if (exitContext.classification === 'operational_warning') {
        ok.push(`  ${name}: 경고성 종료 (exit ${svc.exitCode} / screening_or_bridge_fallback)`);
      } else {
        warn.push(`  ${name}: exit ${svc.exitCode}`);
      }
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

async function checkHttp(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function postJson(
  url: string,
  body: Record<string, unknown> = {},
  {
    timeoutMs = 5000,
    headers = {},
  }: {
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<{ ok: boolean; status: number; text: string; json: unknown | null; error?: string }> {
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
    let json: unknown | null = null;
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
      error: String((error as Error)?.message || 'request_failed'),
    };
  }
}

async function checkWebhookRegistration(
  url: string,
  body: Record<string, unknown> = {},
  options: {
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<WebhookRegistrationResult> {
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

function checkFileStaleness(filePath: string, staleMs: number): FileStaleness {
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

async function buildHttpChecks(checks: HttpCheck[] = []): Promise<{ ok: string[]; warn: string[]; results: Record<string, unknown> }> {
  const ok: string[] = [];
  const warn: string[] = [];
  const results: Record<string, unknown> = {};

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
}: FileActivityInput): { ok: string[]; warn: string[]; minutesAgo: number | null; exists: boolean; stale: boolean } {
  const logState = checkFileStaleness(filePath, staleMs);
  const ok: string[] = [];
  const warn: string[] = [];

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
}: ResolvedWebhookHealthInput = {}): Promise<Record<string, unknown>> {
  const ok: string[] = [];
  const warn: string[] = [];
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

export = {
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
