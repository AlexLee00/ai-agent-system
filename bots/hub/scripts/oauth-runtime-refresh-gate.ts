#!/usr/bin/env tsx
// @ts-nocheck

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { cleanupOAuthRefreshLocks } = require('../lib/oauth/refresh-lock.ts');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(hubRoot, '..', '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const defaultReportPath = path.join(hubRoot, 'output', 'oauth', 'runtime-refresh-gate-latest.json');

function flag(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function arg(name: string): string | boolean | null {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((item) => item === name || item.startsWith(prefix));
  if (!found) return null;
  if (found === name) return true;
  return found.slice(prefix.length);
}

function parseJsonFromOutput(value: string): any {
  const text = String(value || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runOAuthMonitor() {
  const result = spawnSync(tsxBin, [path.join(scriptDir, 'run-oauth-monitor.ts')], {
    cwd: hubRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HUB_OAUTH_MONITOR_SEND_ALARM: 'false',
    },
    maxBuffer: 1024 * 1024 * 8,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return {
    exitCode: Number(result.status ?? 1),
    parsed: parseJsonFromOutput(output),
    outputPreview: output.split('\n').filter(Boolean).slice(-8),
  };
}

function thresholdHours(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function refreshWindowCovered(provider: any, warnHours: number) {
  const expires = Number(provider?.expires_in_hours);
  const inWindow = Number.isFinite(expires) && expires <= warnHours;
  const refreshOk = provider?.refresh_ok === true;
  const reimportOk = provider?.reimport_ok === true;
  return {
    in_window: inWindow,
    covered: !inWindow || refreshOk || reimportOk,
    refresh_ok: provider?.refresh_ok ?? null,
    reimport_ok: provider?.reimport_ok ?? null,
    expires_in_hours: Number.isFinite(expires) ? expires : null,
    warn_hours: warnHours,
  };
}

function providerOk(report: any) {
  const claude = report?.claude_code_oauth || {};
  const openai = report?.openai_oauth || {};
  const gemini = report?.gemini_oauth || {};
  const geminiCli = report?.gemini_cli_oauth || {};
  const claudeRefresh = refreshWindowCovered(claude, thresholdHours('HUB_CLAUDE_OAUTH_WARN_HOURS', 4));
  const openaiRefresh = refreshWindowCovered(openai, thresholdHours('HUB_OPENAI_OAUTH_WARN_HOURS', 24));
  const geminiRefresh = gemini.skipped
    ? { in_window: false, covered: true, refresh_ok: null, reimport_ok: null, expires_in_hours: null, warn_hours: thresholdHours('HUB_GEMINI_OAUTH_WARN_HOURS', 0.25) }
    : refreshWindowCovered(gemini, thresholdHours('HUB_GEMINI_OAUTH_WARN_HOURS', 0.25));
  const geminiCliNearExpiry = Boolean(geminiCli.local_credential_needs_refresh);
  const geminiCliRefreshCovered = !geminiCliNearExpiry
    || (geminiCli.live_refresh_ok === true && geminiCli.post_probe_reimport_ok === true);

  return {
    claude_code_oauth: Boolean(claude.healthy && claudeRefresh.covered),
    openai_oauth: Boolean(openai.healthy && openaiRefresh.covered),
    gemini_oauth: Boolean(gemini.skipped || (gemini.healthy && geminiRefresh.covered)),
    gemini_cli_oauth: Boolean(geminiCli.skipped || (geminiCli.healthy && geminiCliRefreshCovered)),
    claude_refresh_covered: claudeRefresh.covered,
    openai_refresh_covered: openaiRefresh.covered,
    gemini_refresh_covered: geminiRefresh.covered,
    gemini_cli_refresh_covered: geminiCliRefreshCovered,
    refresh_windows: {
      claude_code_oauth: claudeRefresh,
      openai_oauth: openaiRefresh,
      gemini_oauth: geminiRefresh,
    },
  };
}

function main() {
  const monitor = runOAuthMonitor();
  const report = monitor.parsed || {};
  const locks = cleanupOAuthRefreshLocks({ apply: false });
  const providers = providerOk(report);
  const providerChecks = {
    claude_code_oauth: providers.claude_code_oauth,
    openai_oauth: providers.openai_oauth,
    gemini_oauth: providers.gemini_oauth,
    gemini_cli_oauth: providers.gemini_cli_oauth,
    claude_refresh_covered: providers.claude_refresh_covered,
    openai_refresh_covered: providers.openai_refresh_covered,
    gemini_refresh_covered: providers.gemini_refresh_covered,
    gemini_cli_refresh_covered: providers.gemini_cli_refresh_covered,
  };
  const failures = Object.entries(providerChecks)
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);
  const staleLocks = Number(locks.stale_count || 0);
  const ok = monitor.exitCode === 0
    && report.ok === true
    && failures.length === 0
    && staleLocks === 0;

  const payload = {
    ok,
    generated_at: new Date().toISOString(),
    monitor_exit_code: monitor.exitCode,
    providers,
    oauth_monitor: {
      claude_code_oauth: {
        healthy: Boolean(report.claude_code_oauth?.healthy),
        needs_refresh: Boolean(report.claude_code_oauth?.needs_refresh),
        expires_in_hours: report.claude_code_oauth?.expires_in_hours ?? null,
        refresh_ok: report.claude_code_oauth?.refresh_ok ?? null,
        reimport_ok: report.claude_code_oauth?.reimport_ok ?? null,
      },
      openai_oauth: {
        healthy: Boolean(report.openai_oauth?.healthy),
        needs_refresh: Boolean(report.openai_oauth?.needs_refresh),
        expires_in_hours: report.openai_oauth?.expires_in_hours ?? null,
        refresh_ok: report.openai_oauth?.refresh_ok ?? null,
        reimport_ok: report.openai_oauth?.reimport_ok ?? null,
      },
      gemini_cli_oauth: {
        healthy: Boolean(report.gemini_cli_oauth?.healthy),
        needs_refresh: Boolean(report.gemini_cli_oauth?.needs_refresh),
        local_credential_needs_refresh: Boolean(report.gemini_cli_oauth?.local_credential_needs_refresh),
        live_refresh_ok: report.gemini_cli_oauth?.live_refresh_ok ?? null,
        post_probe_reimport_ok: report.gemini_cli_oauth?.post_probe_reimport_ok ?? null,
        expires_in_hours: report.gemini_cli_oauth?.expires_in_hours ?? null,
      },
      gemini_oauth: {
        healthy: Boolean(report.gemini_oauth?.healthy),
        skipped: Boolean(report.gemini_oauth?.skipped),
        refresh_ok: report.gemini_oauth?.refresh_ok ?? null,
      },
    },
    lock_janitor: {
      ok: Boolean(locks.ok),
      dry_run: Boolean(locks.dry_run),
      stale_count: staleLocks,
      stale_locks: Array.isArray(locks.stale_locks)
        ? locks.stale_locks.map((lock: any) => ({
          lock_name: lock.lock_name,
          age_ms: lock.age_ms,
          stale: Boolean(lock.stale),
          provider: lock.provider,
          profile_id: lock.profile_id,
          reason: lock.reason,
          pid: lock.pid,
          created_at: lock.created_at,
        }))
        : [],
    },
    failures,
    notes: [
      'No provider token, account id, or raw secret is included in this report.',
      'Near-expiry OAuth providers are accepted only when refresh/reimport coverage is verified or the final token is outside the monitor warn window.',
      'Near-expiry Gemini CLI OAuth is accepted only when live refresh probe and token-store reimport both succeed.',
    ],
    ...(ok ? {} : { monitor_output_preview: monitor.outputPreview }),
  };

  const writeReport = arg('--write-report') === true || flag('HUB_OAUTH_RUNTIME_GATE_WRITE_REPORT');
  if (writeReport) {
    const reportPath = String(arg('--output') || process.env.HUB_OAUTH_RUNTIME_GATE_OUTPUT || defaultReportPath);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    payload.report_path = reportPath;
  }

  console.log(JSON.stringify(payload, null, 2));

  process.exitCode = ok ? 0 : 1;
}

main();
