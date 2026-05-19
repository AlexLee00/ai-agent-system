// @ts-nocheck
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { checkTokenHealth, checkOpenAIOAuthHealth, checkGroqAccounts } from '../lib/llm/oauth-monitor.js';
const {
  readOpenAiCodexLocalCredentials,
  readClaudeCodeLocalCredentials,
  writeOpenAiCodexLocalCredentials,
  writeClaudeCodeLocalCredentials,
  writeClaudeCodeKeychainCredentials,
} = require('../lib/oauth/local-credentials.ts');
const { getProviderRecord, setProviderCanary, setProviderToken } = require('../lib/oauth/token-store.ts');
const { cleanupOAuthRefreshLocks, withOAuthRefreshLock } = require('../lib/oauth/refresh-lock.ts');
const {
  buildOAuthProviderConfig,
  normalizeOAuthToken,
  refreshOAuthToken,
} = require('../lib/oauth/oauth-flow.ts');
const { readGeminiCliCredentials } = require('../lib/oauth/gemini-cli-credentials.ts');
const {
  checkGeminiCodeAssistServiceStatus,
  CLOUD_AI_COMPANION_SERVICE,
} = require('../lib/oauth/gemini-codeassist-service-status.ts');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');
const { publishOAuthMonitorEvents } = require('../lib/oauth/ops-events.ts');

function flag(name: string, fallback = false): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function thresholdHours(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function oauthRefreshHours(name: string): number {
  return thresholdHours(name, 3);
}

function oauthAlarmHours(name: string): number {
  return thresholdHours(name, 5);
}

function oauthCriticalHours(name: string): number {
  return thresholdHours(name, 1);
}

function tokenExpiresInHours(token: any): number | null {
  const expiresAt = token?.expires_at || token?.expiresAt || null;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresMs)) return null;
  return (expiresMs - Date.now()) / (60 * 60 * 1000);
}

function monitorStateDir(): string {
  return String(process.env.AI_AGENT_WORKSPACE || '').trim()
    || path.join(os.homedir(), '.ai-agent-system', 'workspace');
}

function oauthAlarmCachePath(): string {
  return path.join(monitorStateDir(), 'oauth-monitor-alarm-cache.json');
}

function isHealthyReauthAlarm({ title, payload }: any): boolean {
  return payload?.healthy === true && String(title || '').includes('재인증');
}

function normalizeOAuthAlarmPayload(payload: any): any {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload || {};
  const provider = String(payload.provider || '').trim();
  if (provider === 'gemini-oauth') {
    return {
      ...payload,
      provider: 'gemini-cli-oauth',
      retired_provider: provider,
    };
  }
  return { ...payload };
}

function isRetiredGeminiOAuthAlarm({ title, payload, normalizedPayload }: any): boolean {
  const rawProvider = String(payload?.provider || '').trim();
  const retiredProvider = String(normalizedPayload?.retired_provider || '').trim();
  const alarmTitle = String(title || '');
  return rawProvider === 'gemini-oauth'
    || retiredProvider === 'gemini-oauth'
    || (alarmTitle.includes('Gemini OAuth') && !alarmTitle.includes('Gemini CLI OAuth'));
}

function oauthAlarmCooldownMs(level: number, context: any = {}): number {
  const reauthAlarm = isHealthyReauthAlarm(context);
  const envKey = reauthAlarm
    ? 'HUB_OAUTH_MONITOR_REAUTH_ALARM_COOLDOWN_MINUTES'
    : level >= 3
    ? 'HUB_OAUTH_MONITOR_CRITICAL_ALARM_COOLDOWN_MINUTES'
    : 'HUB_OAUTH_MONITOR_WARN_ALARM_COOLDOWN_MINUTES';
  const fallbackMinutes = reauthAlarm ? 120 : level >= 3 ? 15 : 120;
  const minutes = Number(process.env[envKey] || fallbackMinutes);
  return Math.max(1, Number.isFinite(minutes) ? minutes : fallbackMinutes) * 60 * 1000;
}

function shouldSuppressOAuthAlarm({ level, title, payload, normalizedPayload }: any): boolean {
  const effectivePayload = normalizedPayload || payload || {};
  if (isRetiredGeminiOAuthAlarm({ title, payload, normalizedPayload: effectivePayload })) {
    console.warn('[oauth-monitor] retired gemini-oauth alarm suppressed; Gemini CLI OAuth is the active boundary');
    return true;
  }
  const cooldownMs = oauthAlarmCooldownMs(Number(level || 2), { title, payload: effectivePayload });
  const provider = String(effectivePayload?.provider || 'unknown').trim() || 'unknown';
  const signature = `${provider}|${String(title || 'oauth_alarm')}|${Number(level || 2)}`;
  try {
    const cachePath = oauthAlarmCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const now = Date.now();
    let cache = {};
    if (fs.existsSync(cachePath)) {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8') || '{}');
    }
    cache = Object.fromEntries(
      Object.entries(cache).filter(([, row]) => now - Number((row as any)?.last_seen_at || (row as any)?.emitted_at || 0) < 24 * 60 * 60 * 1000),
    );
    const prev = (cache as any)[signature];
    if (prev && now - Number(prev.emitted_at || 0) < cooldownMs) {
      (cache as any)[signature] = {
        ...prev,
        last_seen_at: now,
        count: Number(prev.count || 0) + 1,
      };
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      return true;
    }
    (cache as any)[signature] = {
      emitted_at: now,
      last_seen_at: now,
      count: 1,
    };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn(`[oauth-monitor] alarm cooldown cache failed: ${String(error?.message || error)}`);
  }
  return false;
}

function scrubClaudeProbeEnv() {
  const childEnv = { ...process.env };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_ACCESS_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]) {
    delete childEnv[key];
  }
  return childEnv;
}

function summarizeClaudeProbeOutput(stdout: string, stderr: string, status: number | null) {
  const raw = String(stdout || '').trim();
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    const statusText = parsed?.api_error_status ? `api_${parsed.api_error_status}` : null;
    const resultText = String(parsed?.result || parsed?.error || '').trim();
    return String(statusText || resultText || stderr || `exit_${status}`).slice(0, 240);
  } catch {
    return String(stderr || raw || `exit_${status}`).slice(0, 240);
  }
}

async function runClaudeCodeLiveProbe() {
  if (!flag('HUB_CLAUDE_CODE_LIVE_PROBE_ON_MONITOR', true)) {
    return { ok: false, skipped: true, error: 'live_probe_disabled' };
  }

  const bin = String(process.env.CLAUDE_CODE_BIN || '/opt/homebrew/bin/claude').trim() || 'claude';
  const timeoutMs = Number(process.env.HUB_CLAUDE_CODE_LIVE_PROBE_TIMEOUT_MS || 20_000);
  const started = Date.now();
  const result = spawnSync(bin, [
    '-p',
    'Return exactly: ok',
    '--output-format',
    'json',
    '--max-turns',
    '1',
    '--model',
    String(process.env.HUB_CLAUDE_CODE_MONITOR_PROBE_MODEL || 'sonnet'),
    '--tools',
    '',
    '--permission-mode',
    'default',
    '--no-session-persistence',
  ], {
    encoding: 'utf8',
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000,
    env: scrubClaudeProbeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const latencyMs = Date.now() - started;
  try {
    const parsed = stdout ? JSON.parse(stdout) : null;
    if (result.status === 0 && parsed && parsed.is_error !== true && String(parsed.result || '').trim()) {
      return {
        ok: true,
        latency_ms: latencyMs,
        session_id_present: Boolean(parsed.session_id),
      };
    }
    return {
      ok: false,
      latency_ms: latencyMs,
      status: result.status,
      signal: result.signal || null,
      api_error_status: parsed?.api_error_status || null,
      error: summarizeClaudeProbeOutput(stdout, stderr, result.status),
    };
  } catch {
    return {
      ok: false,
      latency_ms: latencyMs,
      status: result.status,
      signal: result.signal || null,
      error: summarizeClaudeProbeOutput(stdout, stderr, result.status),
    };
  }
}

function isClaudeProbeAuthFailure(probe: any): boolean {
  const corpus = [
    probe?.api_error_status,
    probe?.error,
    probe?.status,
  ].map((part) => String(part || '').toLowerCase()).join(' ');
  return /\b401\b|api_401|auth|authentication|not logged in|invalid credentials/.test(corpus);
}

async function withMonitorOAuthLock(provider: string, reason: string, work: () => Promise<any>) {
  try {
    return await withOAuthRefreshLock(provider, reason, work);
  } catch (error) {
    if (error?.code === 'oauth_refresh_lock_timeout') {
      const janitor = cleanupOAuthRefreshLocks({ apply: false });
      await sendOAuthAlarm({
        level: 2,
        title: '[Hub OAuth] OAuth refresh lock timeout',
        message: `OAuth refresh lock timeout이 발생했습니다. provider=${provider} reason=${reason}`,
        payload: {
          provider,
          reason,
          error: 'oauth_refresh_lock_timeout',
          lock_error_code: error.code,
          stale_lock_count: Number(janitor?.stale_count || 0),
          stale_locks: Array.isArray(janitor?.stale_locks)
            ? janitor.stale_locks.map((lock: any) => ({
              lock_name: lock.lock_name,
              age_ms: lock.age_ms,
              provider: lock.provider,
              profile_id: lock.profile_id,
              reason: lock.reason,
              pid: lock.pid,
              created_at: lock.created_at,
            }))
            : [],
          manual_repair_command: 'npm --prefix bots/hub run -s oauth:lock-janitor -- --apply --confirm=hub-oauth-lock-janitor',
        },
      });
    }
    return {
      ok: false,
      source: 'oauth_refresh_lock',
      error: String(error?.message || error).slice(0, 240),
      lock_error_code: error?.code || null,
    };
  }
}

function readGeminiCliCredentialForMonitor(record: any) {
  const imported = readGeminiCliCredentials({
    credentialsFile: record?.metadata?.credential_path || process.env.GEMINI_CLI_OAUTH_CREDS_FILE,
    projectId: geminiQuotaProject(record, null),
  });
  if (!imported.ok) {
    return {
      ok: false,
      error: imported.error || 'gemini_cli_credentials_missing',
      details: {
        path_configured: Boolean(record?.metadata?.credential_path || process.env.GEMINI_CLI_OAUTH_CREDS_FILE),
      },
    };
  }
  return imported;
}

function geminiQuotaProject(record: any, adc: any): string {
  return String(
    process.env.GEMINI_CLI_OAUTH_PROJECT_ID
      || process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || record?.metadata?.quota_project_id
      || record?.metadata?.project_id
      || record?.token?.quota_project_id
      || record?.token?.project_id
      || adc?.payload?.quota_project_id
      || '',
  ).trim();
}

async function maybeReimportClaudeCodeCredential(reason: string) {
  const allowKeychainPrompt = flag('HUB_OAUTH_MONITOR_ALLOW_KEYCHAIN', false);
  const imported = readClaudeCodeLocalCredentials({ allowKeychainPrompt });
  if (!imported.ok || !imported.token) {
    return {
      ok: false,
      source: imported.source || null,
      error: imported.error || 'local_credential_import_failed',
      details: imported.details || {},
    };
  }

  setProviderToken('claude-code-cli', imported.token, {
    ...(imported.metadata || {}),
    provider: 'claude-code-cli',
    imported_at: new Date().toISOString(),
    imported_by: 'hub_oauth_monitor',
    import_reason: reason,
    runtime_enabled: true,
  });
  setProviderCanary('claude-code-cli', {
    ok: true,
    details: {
      source: imported.source,
      expires_at: imported.token?.expires_at || null,
      imported_by: 'hub_oauth_monitor',
    },
  });
  return {
    ok: true,
    source: imported.source,
    expires_in_hours: tokenExpiresInHours(imported.token),
  };
}

async function maybeReimportOpenAiCodexCredential(reason: string) {
  const imported = readOpenAiCodexLocalCredentials({
    allowKeychainPrompt: flag('HUB_OAUTH_MONITOR_ALLOW_KEYCHAIN', false),
  });
  if (!imported.ok || !imported.token) {
    return {
      ok: false,
      source: imported.source || null,
      error: imported.error || 'local_credential_import_failed',
      details: imported.details || {},
    };
  }

  setProviderToken('openai-codex-oauth', imported.token, {
    ...(imported.metadata || {}),
    provider: 'openai-codex-oauth',
    imported_at: new Date().toISOString(),
    imported_by: 'hub_oauth_monitor',
    import_reason: reason,
    runtime_enabled: true,
  });
  setProviderCanary('openai-codex-oauth', {
    ok: true,
    details: {
      source: imported.source,
      expires_at: imported.token?.expires_at || null,
      imported_by: 'hub_oauth_monitor',
    },
  });
  return {
    ok: true,
    source: imported.source,
    expires_in_hours: tokenExpiresInHours(imported.token),
  };
}

async function maybeReimportGeminiCliCredential(reason: string, record: any) {
  const imported = readGeminiCliCredentialForMonitor(record);
  if (!imported.ok || !imported.token) {
    return {
      ok: false,
      source: imported.source || null,
      error: imported.error || 'gemini_cli_credential_import_failed',
      details: imported.details || {},
    };
  }

  const metadata = {
    ...(imported.metadata || {}),
    imported_by: 'hub_oauth_monitor',
    imported_at: new Date().toISOString(),
    import_reason: reason,
  };
  setProviderToken('gemini-cli-oauth', imported.token, metadata);
  setProviderCanary('gemini-cli-oauth', {
    ok: true,
    details: {
      source: metadata.source,
      expires_at: imported.token?.expires_at || null,
      imported_by: 'hub_oauth_monitor',
      quota_project_configured: Boolean(imported.quota_project_configured),
      identity_present: Boolean(metadata.identity_present),
    },
  });
  return {
    ok: true,
    source: imported.source,
    expires_in_hours: tokenExpiresInHours(imported.token),
    quota_project_configured: Boolean(imported.quota_project_configured),
  };
}

async function refreshClaudeCodeHubToken(reason: string) {
  const record = getProviderRecord('claude-code-cli');
  const refreshToken = String(record?.token?.refresh_token || '').trim();
  if (!refreshToken) {
    return {
      ok: false,
      source: 'hub_oauth_refresh',
      error: 'missing_refresh_token',
    };
  }

  const config = buildOAuthProviderConfig('claude-code-cli', { query: {}, body: {} });
  if (!config.ok) {
    return {
      ok: false,
      source: 'hub_oauth_refresh',
      error: config.error || 'oauth_config_missing',
      details: { missing: config.missing || [] },
    };
  }

  try {
    const { response, payload } = await refreshOAuthToken(config, refreshToken);
    if (!response.ok) {
      return {
        ok: false,
        source: 'hub_oauth_refresh',
        error: String(payload?.error_description || payload?.error?.message || payload?.error || `http_${response.status}`).slice(0, 240),
        details: { status: response.status },
      };
    }

    const normalized = normalizeOAuthToken('claude-code-cli', payload, record?.token || null);
    if (!normalized.ok) {
      return {
        ok: false,
        source: 'hub_oauth_refresh',
        error: normalized.error || 'token_normalize_failed',
      };
    }

    const metadata = {
      ...(record?.metadata || {}),
      provider: 'claude-code-cli',
      source: 'hub_oauth_refresh',
      provider_name: 'claude-code',
      oauth_flow: 'refresh_token',
      refreshed_at: new Date().toISOString(),
      refresh_reason: reason,
      runtime_enabled: true,
    };
    setProviderToken('claude-code-cli', normalized.token, metadata);
    setProviderCanary('claude-code-cli', {
      ok: true,
      details: {
        source: metadata.source,
        expires_at: normalized.token?.expires_at || null,
        refreshed_by: 'hub_oauth_monitor',
      },
    });
    const localSync = writeClaudeCodeLocalCredentials(normalized.token, {
      allowFileWrite: flag('HUB_OAUTH_MONITOR_SYNC_LOCAL_CLAUDE', true),
    });
    const keychainSync = writeClaudeCodeKeychainCredentials(normalized.token, {
      allowKeychainPrompt: flag('HUB_OAUTH_MONITOR_ALLOW_KEYCHAIN', false),
    });
    return {
      ok: true,
      source: 'hub_oauth_refresh',
      expires_in_hours: tokenExpiresInHours(normalized.token),
      local_sync: {
        ok: Boolean(localSync?.ok),
        source: localSync?.source || null,
        error: localSync?.error || null,
      },
      keychain_sync: {
        ok: Boolean(keychainSync?.ok),
        source: keychainSync?.source || null,
        error: keychainSync?.error || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      source: 'hub_oauth_refresh',
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

async function refreshOpenAiCodexHubToken(reason: string) {
  const record = getProviderRecord('openai-codex-oauth');
  const refreshToken = String(record?.token?.refresh_token || '').trim();
  if (!refreshToken) {
    return {
      ok: false,
      source: 'hub_oauth_refresh',
      error: 'missing_refresh_token',
    };
  }

  const config = buildOAuthProviderConfig('openai-codex-oauth', { query: {}, body: {} });
  if (!config.ok) {
    return {
      ok: false,
      source: 'hub_oauth_refresh',
      error: config.error || 'oauth_config_missing',
      details: { missing: config.missing || [] },
    };
  }

  try {
    const { response, payload } = await refreshOAuthToken(config, refreshToken);
    if (!response.ok) {
      return {
        ok: false,
        source: 'hub_oauth_refresh',
        error: String(payload?.error_description || payload?.error?.message || payload?.error || `http_${response.status}`).slice(0, 240),
        details: { status: response.status },
      };
    }

    const normalized = normalizeOAuthToken('openai-codex-oauth', payload, record?.token || null);
    if (!normalized.ok) {
      return {
        ok: false,
        source: 'hub_oauth_refresh',
        error: normalized.error || 'token_normalize_failed',
      };
    }

    const metadata = {
      ...(record?.metadata || {}),
      provider: 'openai-codex-oauth',
      source: 'hub_oauth_refresh',
      provider_name: 'openai-codex',
      oauth_flow: 'refresh_token',
      refreshed_at: new Date().toISOString(),
      refresh_reason: reason,
      runtime_enabled: true,
    };
    setProviderToken('openai-codex-oauth', normalized.token, metadata);
    setProviderCanary('openai-codex-oauth', {
      ok: true,
      details: {
        source: metadata.source,
        expires_at: normalized.token?.expires_at || null,
        refreshed_by: 'hub_oauth_monitor',
      },
    });
    const localSync = writeOpenAiCodexLocalCredentials(normalized.token, {
      allowFileWrite: flag('HUB_OAUTH_MONITOR_SYNC_LOCAL_CODEX', false),
    });
    return {
      ok: true,
      source: 'hub_oauth_refresh',
      expires_in_hours: tokenExpiresInHours(normalized.token),
      local_sync: {
        ok: Boolean(localSync?.ok),
        source: localSync?.source || null,
        error: localSync?.error || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      source: 'hub_oauth_refresh',
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

async function sendOAuthAlarm({ level, title, message, payload }: any) {
  if (!flag('HUB_OAUTH_MONITOR_SEND_ALARM', true)) return { ok: false, skipped: true };
  const normalizedPayload = normalizeOAuthAlarmPayload(payload);
  if (shouldSuppressOAuthAlarm({ level, title, payload, normalizedPayload })) {
    return { ok: false, skipped: true, reason: 'cooldown' };
  }
  return postAlarm({
    team: normalizedPayload?.provider === 'claude-code-oauth' ? 'claude' : 'hub',
    fromBot: 'hub-oauth-monitor',
    alertLevel: level,
    message: `${title}\n${message}`,
    payload: normalizedPayload,
  });
}

async function checkClaudeCodeOAuth() {
  const alarmHours = oauthAlarmHours('HUB_CLAUDE_OAUTH_WARN_HOURS');
  const refreshHours = oauthRefreshHours('HUB_CLAUDE_OAUTH_REFRESH_HOURS');
  const criticalHours = oauthCriticalHours('HUB_CLAUDE_OAUTH_CRITICAL_HOURS');
  let claudeOauth = await checkTokenHealth();
  let refresh = null;
  let reimport = null;
  let liveProbe = null;
  const initialExpires = Number(claudeOauth.expires_in_hours || 0);

  if (!claudeOauth.healthy || initialExpires <= refreshHours) {
    refresh = await withMonitorOAuthLock('claude-code-cli', claudeOauth.healthy ? 'refresh_window' : 'unhealthy', () =>
      refreshClaudeCodeHubToken(claudeOauth.healthy ? 'refresh_window' : 'unhealthy'));
    claudeOauth = await checkTokenHealth();
    if (!refresh?.ok && (!claudeOauth.healthy || Number(claudeOauth.expires_in_hours || 0) <= refreshHours)) {
      reimport = await withMonitorOAuthLock('claude-code-cli', claudeOauth.healthy ? 'refresh_window_after_refresh' : 'unhealthy_after_refresh', () =>
        maybeReimportClaudeCodeCredential(claudeOauth.healthy ? 'refresh_window_after_refresh' : 'unhealthy_after_refresh'));
      claudeOauth = await checkTokenHealth();
    }
  }

  if (claudeOauth.healthy && flag('HUB_CLAUDE_CODE_LIVE_PROBE_ON_MONITOR', true)) {
    liveProbe = await runClaudeCodeLiveProbe();
    if (!liveProbe?.ok && isClaudeProbeAuthFailure(liveProbe)) {
      refresh = await withMonitorOAuthLock('claude-code-cli', 'live_probe_auth_failed', () =>
        refreshClaudeCodeHubToken('live_probe_auth_failed'));
      claudeOauth = await checkTokenHealth();
      liveProbe = await runClaudeCodeLiveProbe();
      if (!liveProbe?.ok) {
        claudeOauth = {
          ...claudeOauth,
          healthy: false,
          error: `live_probe_failed:${liveProbe?.error || 'unknown'}`,
        };
      }
    } else if (!liveProbe?.ok && liveProbe?.skipped !== true) {
      claudeOauth = {
        ...claudeOauth,
        healthy: false,
        error: `live_probe_failed:${liveProbe?.error || 'unknown'}`,
      };
    }
  }

  const expires = Number(claudeOauth.expires_in_hours || 0);
  if (!claudeOauth.healthy) {
    console.error('[oauth-monitor] Claude OAuth 오류:', claudeOauth.error);
    await sendOAuthAlarm({
      level: 3,
      title: '[Hub OAuth] Claude Code OAuth 만료/오류',
      message: `Claude Code OAuth가 unhealthy 상태입니다. 브라우저 재인증이 필요합니다. error=${claudeOauth.error || 'unknown'}`,
      payload: {
        provider: 'claude-code-oauth',
        healthy: false,
        error: claudeOauth.error || null,
        refresh,
        reimport,
        live_probe: liveProbe,
      },
    });
    return { ...claudeOauth, refresh, reimport, live_probe: liveProbe };
  }

  if (expires <= alarmHours) {
    const level = expires <= criticalHours ? 3 : 2;
    console.warn(`[oauth-monitor] Claude OAuth 갱신 필요: ${expires.toFixed(1)}h 후 만료`);
    await sendOAuthAlarm({
      level,
      title: '[Hub OAuth] Claude Code OAuth 재인증 예정',
      message: `Claude Code OAuth 토큰이 ${expires.toFixed(1)}시간 후 만료됩니다. Hub는 ${refreshHours}시간 이내부터 refresh_token 갱신과 Keychain 재import를 자동 시도합니다. 만료 전 브라우저 재인증 상태를 확인해 주세요.`,
      payload: {
        provider: 'claude-code-oauth',
        healthy: true,
        needs_refresh: expires <= refreshHours,
        expires_in_hours: Math.round(expires * 10) / 10,
        alarm_window_hours: alarmHours,
        refresh_window_hours: refreshHours,
        refresh,
        reimport,
        live_probe: liveProbe,
      },
    });
  } else {
    const refreshNote = claudeOauth.needs_refresh ? ' refresh_window=true' : '';
    const liveNote = liveProbe?.ok ? ` live_probe=${liveProbe.latency_ms}ms` : '';
    console.log(`[oauth-monitor] Claude OAuth 정상: ${expires.toFixed(1)}h 남음 (${claudeOauth.account || 'unknown'})${refreshNote}${liveNote}`);
  }

  return { ...claudeOauth, refresh, reimport, live_probe: liveProbe };
}

async function checkOpenAiCodexOAuth() {
  const alarmHours = oauthAlarmHours('HUB_OPENAI_OAUTH_WARN_HOURS');
  const refreshHours = oauthRefreshHours('HUB_OPENAI_OAUTH_REFRESH_HOURS');
  const criticalHours = oauthCriticalHours('HUB_OPENAI_OAUTH_CRITICAL_HOURS');
  let openaiOauth = await checkOpenAIOAuthHealth();
  let refresh = null;
  let reimport = null;
  let manualReauthRequired = false;
  let refreshConfigMissing: string[] = [];
  const expiresInHours = tokenExpiresInHours(getProviderRecord('openai-codex-oauth')?.token || null);
  const shouldRefresh = !openaiOauth.healthy
    || (Number.isFinite(Number(expiresInHours)) && Number(expiresInHours) <= refreshHours);

  if (shouldRefresh) {
    const config = buildOAuthProviderConfig('openai-codex-oauth', { query: {}, body: {} });
    if (!config.ok) {
      refreshConfigMissing = Array.isArray(config.missing) ? config.missing : [];
      manualReauthRequired = true;
      refresh = {
        ok: false,
        skipped: true,
        source: 'hub_oauth_refresh',
        error: config.error || 'oauth_config_missing',
        details: {
          missing: refreshConfigMissing,
          official_auth_boundary: 'OpenAI API official docs use API key Bearer auth; Codex ChatGPT OAuth unattended refresh requires an explicitly configured OAuth client or interactive codex login.',
        },
      };
    } else {
      refresh = await withMonitorOAuthLock('openai-codex-oauth', openaiOauth.healthy ? 'refresh_window' : 'unhealthy', () =>
        refreshOpenAiCodexHubToken(openaiOauth.healthy ? 'refresh_window' : 'unhealthy'));
    }
    openaiOauth = await checkOpenAIOAuthHealth();
    const refreshedHours = tokenExpiresInHours(getProviderRecord('openai-codex-oauth')?.token || null);
    if (!refresh?.ok && (!openaiOauth.healthy || (Number.isFinite(Number(refreshedHours)) && Number(refreshedHours) <= refreshHours))) {
      reimport = await withMonitorOAuthLock('openai-codex-oauth', openaiOauth.healthy ? 'refresh_window_after_refresh' : 'unhealthy_after_refresh', () =>
        maybeReimportOpenAiCodexCredential(openaiOauth.healthy ? 'refresh_window_after_refresh' : 'unhealthy_after_refresh'));
      openaiOauth = await checkOpenAIOAuthHealth();
    }
  }

  const finalHours = tokenExpiresInHours(getProviderRecord('openai-codex-oauth')?.token || null);
  if (!openaiOauth.healthy) {
    console.error('[oauth-monitor] OpenAI OAuth 오류:', openaiOauth.error);
    await sendOAuthAlarm({
      level: 3,
      title: '[Hub OAuth] OpenAI Codex OAuth 만료/오류',
      message: `OpenAI Codex OAuth가 unhealthy 상태입니다. 브라우저 재인증 또는 Codex login 갱신이 필요합니다. error=${openaiOauth.error || 'unknown'}`,
      payload: {
        provider: 'openai-codex-oauth',
        healthy: false,
        error: openaiOauth.error || null,
        refresh,
        reimport,
      },
    });
    return { ...openaiOauth, expires_in_hours: finalHours, refresh, reimport };
  }

  if (Number.isFinite(Number(finalHours)) && Number(finalHours) <= alarmHours) {
    const level = Number(finalHours) <= criticalHours ? 3 : 2;
    const missingRefreshConfig = Array.isArray(refresh?.details?.missing) ? refresh.details.missing : refreshConfigMissing;
    const refreshHint = refresh?.error === 'oauth_flow_disabled'
      ? ` Hub OpenAI Codex OAuth refresh 설정이 비활성/누락되어 자동 refresh는 수행되지 않았습니다. missing=${missingRefreshConfig.join(',') || 'unknown'}. Codex auth.json 재동기화 결과 reimport_ok=${reimport?.ok === true}. 공식 OpenAI API 인증은 API key Bearer 방식이며, Codex ChatGPT OAuth 무인 refresh는 OAuth client 설정 또는 codex login 재인증이 필요합니다.`
      : '';
    console.warn(`[oauth-monitor] OpenAI OAuth 갱신 필요: ${Number(finalHours).toFixed(1)}h 후 만료`);
    await sendOAuthAlarm({
      level,
      title: manualReauthRequired ? '[Hub OAuth] OpenAI Codex OAuth 수동 재인증 필요' : '[Hub OAuth] OpenAI Codex OAuth 재인증 예정',
      message: `OpenAI Codex OAuth 토큰이 ${Number(finalHours).toFixed(1)}시간 후 만료됩니다. Hub는 ${refreshHours}시간 이내부터 refresh_token 갱신과 Codex auth.json 재동기화를 자동 시도합니다.${refreshHint}`,
      payload: {
        provider: 'openai-codex-oauth',
        healthy: true,
        needs_refresh: Number(finalHours) <= refreshHours,
        manual_reauth_required: manualReauthRequired,
        expires_in_hours: Math.round(Number(finalHours) * 10) / 10,
        alarm_window_hours: alarmHours,
        refresh_window_hours: refreshHours,
        refresh,
        reimport,
        refresh_config_missing: missingRefreshConfig,
      },
    });
  } else {
    const suffix = Number.isFinite(Number(finalHours)) ? ` expires_in=${Number(finalHours).toFixed(1)}h` : '';
    console.log(`[oauth-monitor] OpenAI OAuth 정상: source=${openaiOauth.source || 'unknown'} model=${openaiOauth.model || 'unknown'}${suffix}`);
  }

  return { ...openaiOauth, expires_in_hours: finalHours, refresh, reimport, manual_reauth_required: manualReauthRequired };
}

function geminiCliMonitorRequired(): boolean {
  const record = getProviderRecord('gemini-cli-oauth');
  return flag('HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI', Boolean(record?.token?.access_token || record?.token?.refresh_token));
}

function geminiCodeAssistServiceRequired(): boolean {
  return flag('HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE', geminiCliMonitorRequired());
}

async function runGeminiCliLiveRefreshProbe() {
  if (!flag('HUB_GEMINI_CLI_OAUTH_LIVE_PROBE_ON_EXPIRY', true)) {
    return { ok: false, skipped: true, error: 'live_probe_disabled' };
  }
  try {
    const probeModel = String(process.env.GEMINI_CLI_MONITOR_PROBE_MODEL || '').trim();
    if (probeModel) process.env.LLM_GEMINI_FLASH_MODEL = probeModel;
    const { callWithFallback } = await import('../lib/llm/unified-caller.ts');
    const started = Date.now();
    const result = await callWithFallback({
      callerTeam: 'hub',
      agent: 'oauth-monitor',
      selectorKey: 'hub.oauth.gemini_cli.expiry_probe',
      systemPrompt: 'You are an OAuth readiness probe. Do not reveal secrets.',
      prompt: 'Reply exactly: gemini oauth ok',
      timeoutMs: Number(process.env.GEMINI_CLI_MONITOR_PROBE_TIMEOUT_MS || 30_000),
      cacheEnabled: false,
    });
    return {
      ok: Boolean(result.ok),
      skipped: false,
      duration_ms: Number(result.durationMs || Date.now() - started),
      provider: result.provider || null,
      selected_route: result.selected_route || null,
      error: result.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

async function runGeminiCliLiveRefreshProbeWithReimport(reason: string, record: any) {
  return withMonitorOAuthLock('gemini-cli-oauth', reason, async () => {
    const probe = await runGeminiCliLiveRefreshProbe();
    const reimport = probe?.ok
      ? await maybeReimportGeminiCliCredential(`${reason}_after_live_probe`, record)
      : null;
    return { ok: Boolean(probe?.ok), probe, reimport };
  });
}

function finalizeGeminiCliMonitorState({
  expiresInHours,
  warnHours,
  liveRefreshProbe,
  postProbeReimport,
}: {
  expiresInHours: number | null;
  warnHours: number;
  liveRefreshProbe: any;
  postProbeReimport: any;
}) {
  const refreshedExpiresInHours = Number.isFinite(Number(postProbeReimport?.expires_in_hours))
    ? Number(postProbeReimport.expires_in_hours)
    : expiresInHours;
  const reimportOk = postProbeReimport?.ok === true;
  const liveRefreshOk = liveRefreshProbe?.ok === true;
  const localCredentialNeedsRefresh = reimportOk
    ? (Number.isFinite(Number(refreshedExpiresInHours)) ? Number(refreshedExpiresInHours) <= warnHours : false)
    : (Number.isFinite(Number(expiresInHours)) ? Number(expiresInHours) <= warnHours : false);
  const needsRefresh = localCredentialNeedsRefresh && !liveRefreshOk;

  return {
    expires_in_hours: refreshedExpiresInHours,
    local_credential_needs_refresh: localCredentialNeedsRefresh,
    needs_refresh: needsRefresh,
  };
}

async function checkGeminiCliOAuth() {
  const record = getProviderRecord('gemini-cli-oauth');
  const required = geminiCliMonitorRequired();
  const alarmHours = oauthAlarmHours('HUB_GEMINI_CLI_OAUTH_WARN_HOURS');
  const refreshHours = oauthRefreshHours('HUB_GEMINI_CLI_OAUTH_REFRESH_HOURS');
  const criticalHours = oauthCriticalHours('HUB_GEMINI_CLI_OAUTH_CRITICAL_HOURS');
  const cliImport = readGeminiCliCredentialForMonitor(record);

  if (cliImport.ok) {
    const metadata = {
      ...(cliImport.metadata || {}),
      imported_by: 'hub_oauth_monitor',
      imported_at: new Date().toISOString(),
      import_reason: 'monitor_sync',
    };
    setProviderToken('gemini-cli-oauth', cliImport.token, metadata);
    setProviderCanary('gemini-cli-oauth', {
      ok: true,
      details: {
        source: metadata.source,
        expires_at: cliImport.token?.expires_at || null,
        imported_by: 'hub_oauth_monitor',
        quota_project_configured: Boolean(cliImport.quota_project_configured),
        identity_present: Boolean(metadata.identity_present),
      },
    });
    const expiresInHours = tokenExpiresInHours(cliImport.token);
    const localCredentialNeedsRefresh = Number.isFinite(Number(expiresInHours))
      ? Number(expiresInHours) <= refreshHours
      : false;
    const inAlarmWindow = Number.isFinite(Number(expiresInHours))
      ? Number(expiresInHours) <= alarmHours
      : false;
    const liveRefreshResult = localCredentialNeedsRefresh
      ? await runGeminiCliLiveRefreshProbeWithReimport('refresh_window', record)
      : null;
    const liveRefreshProbe = liveRefreshResult?.probe || null;
    const postProbeReimport = liveRefreshResult?.reimport || null;
    const finalState = finalizeGeminiCliMonitorState({
      expiresInHours,
      warnHours: refreshHours,
      liveRefreshProbe,
      postProbeReimport,
    });
    const needsRefresh = finalState.needs_refresh;
    if (localCredentialNeedsRefresh && liveRefreshProbe?.ok) {
      console.log(`[oauth-monitor] Gemini CLI OAuth local token is near/after expiry, live CLI refresh probe succeeded in ${liveRefreshProbe.duration_ms || 0}ms, token-store reimport=${postProbeReimport?.ok ? 'ok' : 'not_updated'}`);
    }
    if (needsRefresh || (inAlarmWindow && !localCredentialNeedsRefresh)) {
      const level = Number(expiresInHours) <= criticalHours ? 3 : 2;
      await sendOAuthAlarm({
        level,
        title: '[Hub OAuth] Gemini CLI OAuth 재인증/자동갱신 확인 필요',
        message: localCredentialNeedsRefresh
          ? `Gemini CLI OAuth credential이 ${Number(expiresInHours).toFixed(2)}시간 후 만료되며 live refresh probe가 통과하지 못했습니다. gemini auth login 재인증이 필요할 수 있습니다.`
          : `Gemini CLI OAuth credential이 ${Number(expiresInHours).toFixed(2)}시간 후 만료됩니다. Hub는 ${refreshHours}시간 이내부터 live refresh probe와 token-store 재동기화를 자동 시도합니다.`,
        payload: {
          provider: 'gemini-cli-oauth',
          healthy: true,
          needs_refresh: localCredentialNeedsRefresh,
          local_credential_needs_refresh: localCredentialNeedsRefresh,
          live_refresh_ok: Boolean(liveRefreshProbe?.ok),
          live_refresh_error: liveRefreshProbe?.error || null,
          post_probe_reimport_ok: postProbeReimport?.ok ?? null,
          expires_in_hours: Math.round(Number(expiresInHours) * 100) / 100,
          alarm_window_hours: alarmHours,
          refresh_window_hours: refreshHours,
          quota_project_configured: Boolean(cliImport.quota_project_configured),
        },
      });
    }
    console.log(`[oauth-monitor] Gemini CLI OAuth 정상: source=${cliImport.source || 'gemini_cli'} expires_in=${Number.isFinite(Number(expiresInHours)) ? Number(expiresInHours).toFixed(2) : 'unknown'}h`);
    return {
      healthy: true,
      skipped: false,
      source: cliImport.source || 'gemini_cli_oauth_creds',
      expires_in_hours: finalState.expires_in_hours,
      needs_refresh: finalState.needs_refresh,
      local_credential_needs_refresh: finalState.local_credential_needs_refresh,
      live_refresh_ok: liveRefreshProbe?.ok ?? null,
      post_probe_reimport_ok: postProbeReimport?.ok ?? null,
      post_probe_expires_in_hours: postProbeReimport?.expires_in_hours ?? null,
      quota_project_configured: Boolean(cliImport.quota_project_configured),
      error: null,
    };
  }

  if (record?.token?.refresh_token) {
    const expiresInHours = tokenExpiresInHours(record.token);
    const localCredentialNeedsRefresh = Number.isFinite(Number(expiresInHours))
      ? Number(expiresInHours) <= refreshHours
      : false;
    const inAlarmWindow = Number.isFinite(Number(expiresInHours))
      ? Number(expiresInHours) <= alarmHours
      : false;
    const liveRefreshResult = localCredentialNeedsRefresh
      ? await runGeminiCliLiveRefreshProbeWithReimport('token_store_refresh_window', record)
      : null;
    const liveRefreshProbe = liveRefreshResult?.probe || null;
    const postProbeReimport = liveRefreshResult?.reimport || null;
    const finalState = finalizeGeminiCliMonitorState({
      expiresInHours,
      warnHours: refreshHours,
      liveRefreshProbe,
      postProbeReimport,
    });
    const needsRefresh = finalState.needs_refresh;
    if (localCredentialNeedsRefresh && liveRefreshProbe?.ok) {
      console.log(`[oauth-monitor] Gemini CLI OAuth token-store is near/after expiry, live CLI refresh probe succeeded in ${liveRefreshProbe.duration_ms || 0}ms, token-store reimport=${postProbeReimport?.ok ? 'ok' : 'not_updated'}`);
    }
    if ((needsRefresh || (inAlarmWindow && !localCredentialNeedsRefresh)) && required) {
      const level = Number(expiresInHours) <= criticalHours ? 3 : 2;
      await sendOAuthAlarm({
        level,
        title: '[Hub OAuth] Gemini CLI OAuth 로컬 credential 재동기화 필요',
        message: localCredentialNeedsRefresh
          ? `Gemini CLI OAuth token-store는 남아 있지만 로컬 credential 재동기화가 실패했고 ${Number(expiresInHours).toFixed(2)}시간 후 만료됩니다. live refresh probe도 통과하지 못했습니다.`
          : `Gemini CLI OAuth token-store는 남아 있지만 로컬 credential 재동기화가 실패했고 ${Number(expiresInHours).toFixed(2)}시간 후 만료됩니다. Hub는 ${refreshHours}시간 이내부터 live refresh probe와 token-store 재동기화를 자동 시도합니다.`,
        payload: {
          provider: 'gemini-cli-oauth',
          healthy: true,
          degraded: true,
          needs_refresh: localCredentialNeedsRefresh,
          local_credential_needs_refresh: localCredentialNeedsRefresh,
          live_refresh_ok: Boolean(liveRefreshProbe?.ok),
          live_refresh_error: liveRefreshProbe?.error || null,
          post_probe_reimport_ok: postProbeReimport?.ok ?? null,
          expires_in_hours: Math.round(Number(expiresInHours) * 100) / 100,
          alarm_window_hours: alarmHours,
          refresh_window_hours: refreshHours,
          error: cliImport.error || null,
        },
      });
    }
    console.warn(`[oauth-monitor] Gemini CLI OAuth 로컬 creds 재동기화 실패: ${cliImport.error || 'unknown'} (token-store 유지)`);
    return {
      healthy: true,
      degraded: true,
      skipped: false,
      source: record?.metadata?.source || 'token_store',
      expires_in_hours: finalState.expires_in_hours,
      needs_refresh: finalState.needs_refresh,
      local_credential_needs_refresh: finalState.local_credential_needs_refresh,
      live_refresh_ok: liveRefreshProbe?.ok ?? null,
      post_probe_reimport_ok: postProbeReimport?.ok ?? null,
      post_probe_expires_in_hours: postProbeReimport?.expires_in_hours ?? null,
      quota_project_configured: Boolean(record?.metadata?.quota_project_configured),
      error: cliImport.error || null,
    };
  }

  if (!required) {
    console.log('[oauth-monitor] Gemini CLI OAuth 스킵: CLI creds/token-store가 없고 필수 모드가 아닙니다.');
    return {
      healthy: true,
      skipped: true,
      source: null,
      expires_in_hours: null,
      needs_refresh: false,
      quota_project_configured: false,
      error: cliImport.error || null,
    };
  }

  await sendOAuthAlarm({
    level: 3,
    title: '[Hub OAuth] Gemini CLI OAuth 누락',
    message: `Gemini CLI OAuth credential을 찾지 못했습니다. gemini auth login 또는 ~/.gemini/oauth_creds.json 상태를 확인해 주세요. error=${cliImport.error || 'unknown'}`,
    payload: {
      provider: 'gemini-cli-oauth',
      healthy: false,
      error: cliImport.error || null,
    },
  });
  return {
    healthy: false,
    skipped: false,
    source: null,
    expires_in_hours: null,
    needs_refresh: false,
    quota_project_configured: false,
    error: cliImport.error || 'gemini_cli_credentials_missing',
  };
}

async function checkGeminiCodeAssistService() {
  const required = geminiCodeAssistServiceRequired();
  const record = getProviderRecord('gemini-cli-oauth');
  const accessToken = String(record?.token?.access_token || '').trim();
  const projectId = geminiQuotaProject(record, null);
  if (!accessToken || !projectId) {
    const result = {
      healthy: !required,
      skipped: !required,
      required,
      service: CLOUD_AI_COMPANION_SERVICE,
      project_id_configured: Boolean(projectId),
      state: null,
      error: !accessToken ? 'gemini_cli_access_token_missing' : 'gemini_codeassist_project_missing',
    };
    if (required) {
      await sendOAuthAlarm({
        level: 3,
        title: '[Hub OAuth] Gemini Code Assist service readiness 실패',
        message: `Gemini Code Assist service readiness를 확인할 수 없습니다. error=${result.error}`,
        payload: {
          provider: 'gemini-cli-oauth',
          service: CLOUD_AI_COMPANION_SERVICE,
          project_id_configured: result.project_id_configured,
          error: result.error,
        },
      });
    }
    return result;
  }
  const status = await checkGeminiCodeAssistServiceStatus({ projectId, accessToken });
  const healthy = status.ok === true && status.state === 'ENABLED';
  if (!healthy && required) {
    await sendOAuthAlarm({
      level: 3,
      title: '[Hub OAuth] Gemini Code Assist API 비활성/오류',
      message: `Gemini Code Assist service 상태가 ${status.state || 'unknown'}입니다. ${status.operator_action || 'Google Cloud API 상태를 확인하세요.'}`,
      payload: {
        provider: 'gemini-cli-oauth',
        service: status.service,
        state: status.state || null,
        error: status.error || null,
        activation_url: status.activation_url || null,
      },
    });
  }
  console.log(`[oauth-monitor] Gemini Code Assist service: ${status.state || status.error || 'unknown'} (${status.service})`);
  return {
    healthy: healthy || !required,
    skipped: false,
    required,
    service: status.service,
    project_id_configured: Boolean(status.project_id_configured),
    state: status.state || null,
    error: status.error || null,
    activation_url: status.activation_url || null,
  };
}

async function main() {
  const claudeOauth = await checkClaudeCodeOAuth();
  const openaiOauth = await checkOpenAiCodexOAuth();
  const geminiCliOauth = await checkGeminiCliOAuth();
  const geminiCodeAssistService = await checkGeminiCodeAssistService();

  const groq = await checkGroqAccounts();
  console.log(`[oauth-monitor] Groq 계정: ${groq.available_accounts}/${groq.total_accounts} 정상`);

  const report = {
    ok: Boolean(
      claudeOauth.healthy
        && openaiOauth.healthy
        && (geminiCliOauth.skipped || geminiCliOauth.healthy)
        && (geminiCodeAssistService.skipped || geminiCodeAssistService.healthy),
    ),
    generated_at: new Date().toISOString(),
    claude_code_oauth: {
      healthy: Boolean(claudeOauth.healthy),
      needs_refresh: Boolean(claudeOauth.needs_refresh),
      expires_in_hours: Number.isFinite(Number(claudeOauth.expires_in_hours))
        ? Math.round(Number(claudeOauth.expires_in_hours) * 10) / 10
        : null,
      refresh_ok: claudeOauth.refresh?.ok ?? null,
      refresh_source: claudeOauth.refresh?.source || null,
      local_sync_ok: claudeOauth.refresh?.local_sync?.ok ?? null,
      keychain_sync_ok: claudeOauth.refresh?.keychain_sync?.ok ?? null,
      live_probe_ok: claudeOauth.live_probe?.ok ?? null,
      live_probe_error: claudeOauth.live_probe?.ok === false ? (claudeOauth.live_probe?.error || null) : null,
      reimport_ok: claudeOauth.reimport?.ok ?? null,
      reimport_source: claudeOauth.reimport?.source || null,
      error: claudeOauth.error || null,
    },
    openai_oauth: {
      healthy: Boolean(openaiOauth.healthy),
      source: openaiOauth.source || null,
      expires_in_hours: Number.isFinite(Number(openaiOauth.expires_in_hours))
        ? Math.round(Number(openaiOauth.expires_in_hours) * 10) / 10
        : null,
      needs_refresh: Boolean(openaiOauth.needs_refresh),
      refresh_ok: openaiOauth.refresh?.ok ?? null,
      refresh_source: openaiOauth.refresh?.source || null,
      local_sync_ok: openaiOauth.refresh?.local_sync?.ok ?? null,
      reimport_ok: openaiOauth.reimport?.ok ?? null,
      reimport_source: openaiOauth.reimport?.source || null,
      manual_reauth_required: Boolean(openaiOauth.manual_reauth_required),
      refresh_config_missing: Array.isArray(openaiOauth.refresh?.details?.missing) ? openaiOauth.refresh.details.missing : [],
      error: openaiOauth.error || null,
    },
    gemini_cli_oauth: {
      healthy: Boolean(geminiCliOauth.healthy),
      skipped: Boolean(geminiCliOauth.skipped),
      degraded: Boolean(geminiCliOauth.degraded),
      source: geminiCliOauth.source || null,
      expires_in_hours: Number.isFinite(Number(geminiCliOauth.expires_in_hours))
        ? Math.round(Number(geminiCliOauth.expires_in_hours) * 100) / 100
        : null,
      needs_refresh: Boolean(geminiCliOauth.needs_refresh),
      local_credential_needs_refresh: Boolean(geminiCliOauth.local_credential_needs_refresh),
      live_refresh_ok: geminiCliOauth.live_refresh_ok ?? null,
      post_probe_reimport_ok: geminiCliOauth.post_probe_reimport_ok ?? null,
      post_probe_expires_in_hours: Number.isFinite(Number(geminiCliOauth.post_probe_expires_in_hours))
        ? Math.round(Number(geminiCliOauth.post_probe_expires_in_hours) * 100) / 100
        : null,
      quota_project_configured: Boolean(geminiCliOauth.quota_project_configured),
      error: geminiCliOauth.error || null,
    },
    gemini_codeassist_service: {
      healthy: Boolean(geminiCodeAssistService.healthy),
      skipped: Boolean(geminiCodeAssistService.skipped),
      required: Boolean(geminiCodeAssistService.required),
      service: geminiCodeAssistService.service || CLOUD_AI_COMPANION_SERVICE,
      project_id_configured: Boolean(geminiCodeAssistService.project_id_configured),
      state: geminiCodeAssistService.state || null,
      error: geminiCodeAssistService.error || null,
      activation_url: geminiCodeAssistService.activation_url || null,
    },
    groq_pool: groq,
  };

  const eventPublish = await publishOAuthMonitorEvents(report);
  console.log(JSON.stringify({
    ...report,
    event_publish: {
      ok: eventPublish.ok,
      attempted: eventPublish.attempted,
      published: eventPublish.published,
      skipped: eventPublish.skipped,
      failed: eventPublish.failed,
      error: eventPublish.results?.find((result: any) => !result.ok && !result.skipped)?.error || null,
    },
  }));
}

main().catch(e => { console.error(e); process.exit(1); });
