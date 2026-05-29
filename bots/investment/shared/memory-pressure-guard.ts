// @ts-nocheck

import { execFileSync } from 'node:child_process';

export const PROTECTED_MEMORY_GUARD_JOBS = [
  'ska.commander',
  'ska.naver-monitor',
  'luna.marketdata-mcp',
  'luna.tradingview-ws',
  'luna.ops-scheduler',
  'investment.commander',
  'hub.resource-api',
  'elixir.supervisor',
  'fx-refresh',
];

const LEVEL_RANK = {
  normal: 0,
  warn: 1,
  warning: 1,
  critical: 2,
};

function envValue(env, name, fallback = '') {
  return String(env?.[name] ?? fallback).trim();
}

function boolEnv(env, name, fallback = false) {
  const raw = envValue(env, name).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false;
  return fallback;
}

function normalizeLevel(level) {
  const raw = String(level || '').trim().toLowerCase();
  if (raw === 'warning') return 'warn';
  if (raw === 'warn' || raw === 'critical' || raw === 'normal') return raw;
  return 'normal';
}

export function normalizeMemoryGuardJobName(jobName) {
  return String(jobName || '')
    .trim()
    .replace(/^ai\./, '')
    .replace(/\.plist$/, '');
}

export function isProtectedMemoryGuardJob(jobName) {
  const normalized = normalizeMemoryGuardJobName(jobName);
  if (!normalized) return false;
  if (normalized.startsWith('claude.')) return true;
  return PROTECTED_MEMORY_GUARD_JOBS.some((protectedName) => {
    if (normalized === protectedName) return true;
    if (normalized.endsWith(`.${protectedName}`)) return true;
    if (protectedName === 'fx-refresh' && normalized.includes('fx-refresh')) return true;
    return false;
  });
}

function parseFreePct(text) {
  const candidates = [
    /System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i,
    /memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i,
    /free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i,
  ];
  for (const pattern of candidates) {
    const match = String(text || '').match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function parseMemoryPressureLevel(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('critical')) return 'critical';
  if (lower.includes('warn')) return 'warn';
  return 'normal';
}

function execText(command, args = [], timeout = 3000) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });
  } catch (error) {
    const stdout = error?.stdout ? String(error.stdout) : '';
    const stderr = error?.stderr ? String(error.stderr) : '';
    if (stdout || stderr) return `${stdout}\n${stderr}`;
    return '';
  }
}

function readVmStatFreePct() {
  const vm = execText('/usr/bin/vm_stat', [], 3000);
  if (!vm) return null;
  const pageSizeMatch = vm.match(/page size of\s+([0-9]+)\s+bytes/i);
  const pageSize = Number(pageSizeMatch?.[1] || 4096);
  const page = (label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = vm.match(new RegExp(`${escaped}:\\s+([0-9.]+)`, 'i'));
    return Number(String(match?.[1] || '0').replace(/\./g, ''));
  };
  const freePages = page('Pages free') + page('Pages inactive') + page('Pages speculative');
  const totalText = execText('/usr/sbin/sysctl', ['-n', 'hw.memsize'], 3000);
  const totalBytes = Number(String(totalText || '').trim());
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freePages)) return null;
  return Math.max(0, Math.min(100, (freePages * pageSize / totalBytes) * 100));
}

export function checkMemoryPressure(opts = {}) {
  const env = opts.env || process.env;
  if (boolEnv(env, 'LUNA_MEMORY_GUARD_DISABLED', false)) {
    return {
      pressured: false,
      level: 'normal',
      freePct: null,
      detail: 'disabled_by_env',
      thresholdLevel: normalizeLevel(envValue(env, 'LUNA_MEMORY_GUARD_LEVEL', 'warn')),
      thresholdFreePct: Number(envValue(env, 'LUNA_MEMORY_GUARD_FREE_PCT', '10')) || 10,
    };
  }

  const thresholdLevel = normalizeLevel(envValue(env, 'LUNA_MEMORY_GUARD_LEVEL', 'warn'));
  const thresholdFreePct = Number(envValue(env, 'LUNA_MEMORY_GUARD_FREE_PCT', '10')) || 10;
  const simulatedLevel = envValue(env, 'LUNA_MEMORY_GUARD_SIMULATE_LEVEL', '');
  const simulatedFreePct = envValue(env, 'LUNA_MEMORY_GUARD_SIMULATE_FREE_PCT', '');

  let level = simulatedLevel ? normalizeLevel(simulatedLevel) : 'normal';
  let freePct = simulatedFreePct ? Number(simulatedFreePct) : null;
  let detail = simulatedLevel || simulatedFreePct ? 'simulated' : '';

  if (!detail) {
    const pressureText = execText('/usr/bin/memory_pressure', [], 3000);
    if (pressureText) {
      level = parseMemoryPressureLevel(pressureText);
      freePct = parseFreePct(pressureText);
      detail = 'memory_pressure';
    }
  }

  if (freePct == null || !Number.isFinite(freePct)) {
    const vmFreePct = readVmStatFreePct();
    if (vmFreePct != null) {
      freePct = vmFreePct;
      detail = detail ? `${detail}+vm_stat` : 'vm_stat';
    }
  }

  const levelPressure = (LEVEL_RANK[level] ?? 0) >= (LEVEL_RANK[thresholdLevel] ?? 1);
  const pctPressure = freePct != null && Number.isFinite(freePct) && freePct < thresholdFreePct;
  return {
    pressured: Boolean(levelPressure || pctPressure),
    level,
    freePct,
    detail: detail || 'unavailable_fail_open',
    thresholdLevel,
    thresholdFreePct,
  };
}

export function memoryGuardDecision(jobName, opts = {}) {
  const env = opts.env || process.env;
  const protectedJob = Boolean(opts.protected) || isProtectedMemoryGuardJob(jobName);
  if (protectedJob) {
    return {
      skip: false,
      protected: true,
      jobName,
      check: {
        pressured: false,
        level: 'normal',
        freePct: null,
        detail: 'protected_job_fail_open',
      },
    };
  }
  const check = checkMemoryPressure({ env });
  return {
    skip: Boolean(check.pressured),
    protected: false,
    jobName,
    check,
  };
}

function logSkip(decision, json = false) {
  const payload = {
    ok: true,
    status: 'memory_guard_skipped',
    jobName: decision.jobName,
    level: decision.check.level,
    freePct: decision.check.freePct,
    detail: decision.check.detail,
    thresholdLevel: decision.check.thresholdLevel,
    thresholdFreePct: decision.check.thresholdFreePct,
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const free = payload.freePct == null ? 'n/a' : `${Number(payload.freePct).toFixed(1)}%`;
  console.log(`[MemoryGuard] skip ${payload.jobName}: level=${payload.level} freePct=${free} detail=${payload.detail}`);
}

export function shouldSkipForMemory(jobName, opts = {}) {
  const decision = memoryGuardDecision(jobName, opts);
  if (decision.skip && !opts.silent) logSkip(decision, Boolean(opts.json));
  return decision.skip;
}

export function maybeSkipForMemory(jobName, opts = {}) {
  return shouldSkipForMemory(jobName, opts);
}
