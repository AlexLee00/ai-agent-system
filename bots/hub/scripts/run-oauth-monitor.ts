// @ts-nocheck
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkTokenHealth, checkOpenAIOAuthHealth, checkGeminiOAuthHealth, checkGroqAccounts } from '../lib/llm/oauth-monitor.js';
const {
  readOpenAiCodexLocalCredentials,
  readClaudeCodeLocalCredentials,
  writeOpenAiCodexLocalCredentials,
  writeClaudeCodeKeychainCredentials,
} = require('../lib/oauth/local-credentials.ts');
const { getProviderRecord, setProviderCanary, setProviderToken } = require('../lib/oauth/token-store.ts');
const {
  buildOAuthProviderConfig,
  normalizeOAuthToken,
  refreshOAuthToken,
} = require('../lib/oauth/oauth-flow.ts');
const { readGeminiCliCredentials } = require('../lib/oauth/gemini-cli-credentials.ts');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');

function flag(name: string, fallback = false): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function thresholdHours(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function tokenExpiresInHours(token: any): number | null {
  const expiresAt = token?.expires_at || token?.expiresAt || null;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresMs)) return null;
  return (expiresMs - Date.now()) / (60 * 60 * 1000);
}

const DEFAULT_GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_GEMINI_SCOPE = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever';

function resolveUserPath(filePath: string): string {
  const raw = String(filePath || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function defaultGeminiAdcPath(): string {
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

function readJsonFileSafely(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readGeminiAdcCredentials(record: any) {
  const candidates = [
    record?.metadata?.adc_path,
    process.env.GEMINI_OAUTH_ADC_FILE,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    defaultGeminiAdcPath(),
  ].map(resolveUserPath).filter(Boolean);

  for (const filePath of candidates) {
    const payload = readJsonFileSafely(filePath);
    if (payload?.client_id && payload?.refresh_token) {
      return { ok: true, path: filePath, payload };
    }
  }

  return {
    ok: false,
    error: 'gemini_adc_credentials_missing',
    details: {
      searched: candidates.map((candidate) => path.basename(candidate)),
    },
  };
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

function geminiScopes(record: any, adc: any): string {
  const tokenScopes = record?.token?.scopes;
  if (Array.isArray(tokenScopes) && tokenScopes.length > 0) return tokenScopes.map(String).join(' ');
  if (typeof record?.token?.scope === 'string' && record.token.scope.trim()) return record.token.scope.trim();
  if (typeof adc?.payload?.scopes === 'string' && adc.payload.scopes.trim()) return adc.payload.scopes.trim();
  if (Array.isArray(adc?.payload?.scopes) && adc.payload.scopes.length > 0) return adc.payload.scopes.map(String).join(' ');
  return String(process.env.HUB_GEMINI_OAUTH_SCOPES || process.env.GEMINI_OAUTH_SCOPES || DEFAULT_GEMINI_SCOPE).trim();
}

function geminiQuotaProject(record: any, adc: any): string {
  return String(
    process.env.GEMINI_OAUTH_PROJECT_ID
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
    const keychainSync = writeClaudeCodeKeychainCredentials(normalized.token, {
      allowKeychainPrompt: flag('HUB_OAUTH_MONITOR_ALLOW_KEYCHAIN', false),
    });
    return {
      ok: true,
      source: 'hub_oauth_refresh',
      expires_in_hours: tokenExpiresInHours(normalized.token),
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

function buildGeminiRefreshConfig(record: any) {
  const adc = readGeminiAdcCredentials(record);
  const envConfig = buildOAuthProviderConfig('gemini-oauth', { query: {}, body: {} });
  if (envConfig.ok) {
    return {
      ok: true,
      source: 'env_oauth_config',
      adc,
      config: {
        ...envConfig,
        clientSecret: envConfig.clientSecret || (adc.ok ? adc.payload?.client_secret : '') || '',
        scope: envConfig.scope || geminiScopes(record, adc.ok ? adc : null),
      },
    };
  }

  if (adc.ok) {
    return {
      ok: true,
      source: 'google_adc',
      adc,
      config: {
        ok: true,
        provider: 'gemini-oauth',
        publicProviderName: 'gemini',
        tokenUrl: String(process.env.GEMINI_OAUTH_TOKEN_URL || process.env.HUB_GEMINI_OAUTH_TOKEN_URL || DEFAULT_GEMINI_TOKEN_URL).trim(),
        clientId: String(adc.payload.client_id || '').trim(),
        clientSecret: String(adc.payload.client_secret || '').trim(),
        scope: geminiScopes(record, adc),
        tokenBodyFormat: 'form',
      },
    };
  }

  return {
    ok: false,
    source: 'gemini_refresh_config',
    error: envConfig.error || adc.error || 'gemini_oauth_config_missing',
    details: {
      missing: envConfig.missing || [],
      adc_error: adc.error || null,
    },
  };
}

async function refreshGeminiOAuthHubToken(reason: string) {
  const record = getProviderRecord('gemini-oauth');
  const cliImport = readGeminiCliCredentialForMonitor(record);
  if (cliImport.ok) {
    const cliHours = tokenExpiresInHours(cliImport.token);
    const cliFresh = Number.isFinite(Number(cliHours)) && Number(cliHours) > 0;
    if (cliFresh) {
      const metadata = {
        ...(cliImport.metadata || {}),
        imported_by: 'hub_oauth_monitor',
        imported_at: new Date().toISOString(),
        import_reason: reason,
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
    }
  }

  const built = buildGeminiRefreshConfig(record);
  const refreshToken = String(
    record?.token?.refresh_token
      || record?.token?.refreshToken
      || (built?.adc?.ok ? built.adc.payload?.refresh_token : '')
      || '',
  ).trim();
  if (!refreshToken) {
    return {
      ok: false,
      source: 'hub_oauth_refresh',
      error: 'missing_refresh_token',
    };
  }

  if (!built.ok) {
    return {
      ok: false,
      source: 'hub_oauth_refresh',
      error: built.error || 'oauth_config_missing',
      details: built.details || {},
    };
  }

  try {
    const { response, payload } = await refreshOAuthToken(built.config, refreshToken);
    if (!response.ok) {
      return {
        ok: false,
        source: 'hub_oauth_refresh',
        error: String(payload?.error_description || payload?.error?.message || payload?.error || `http_${response.status}`).slice(0, 240),
        details: { status: response.status, config_source: built.source },
      };
    }

    const normalized = normalizeOAuthToken('gemini-oauth', payload, record?.token || { refresh_token: refreshToken });
    if (!normalized.ok) {
      return {
        ok: false,
        source: 'hub_oauth_refresh',
        error: normalized.error || 'token_normalize_failed',
      };
    }

    const metadata = {
      ...(record?.metadata || {}),
      provider: 'gemini-oauth',
      source: 'hub_oauth_refresh',
      provider_name: 'gemini',
      oauth_flow: 'refresh_token',
      refreshed_at: new Date().toISOString(),
      refresh_reason: reason,
      refresh_config_source: built.source,
      runtime_enabled: true,
      ...(built.adc?.ok ? { adc_path: built.adc.path } : {}),
      ...(geminiQuotaProject(record, built.adc?.ok ? built.adc : null) ? { quota_project_id: geminiQuotaProject(record, built.adc?.ok ? built.adc : null) } : {}),
    };
    setProviderToken('gemini-oauth', normalized.token, metadata);
    setProviderCanary('gemini-oauth', {
      ok: true,
      details: {
        source: metadata.source,
        expires_at: normalized.token?.expires_at || null,
        refreshed_by: 'hub_oauth_monitor',
        refresh_config_source: built.source,
      },
    });
    return {
      ok: true,
      source: 'hub_oauth_refresh',
      refresh_config_source: built.source,
      expires_in_hours: tokenExpiresInHours(normalized.token),
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
  return postAlarm({
    team: payload?.provider === 'claude-code-oauth' ? 'claude' : 'hub',
    fromBot: 'hub-oauth-monitor',
    alertLevel: level,
    message: `${title}\n${message}`,
    payload,
  });
}

async function checkClaudeCodeOAuth() {
  const warnHours = thresholdHours('HUB_CLAUDE_OAUTH_WARN_HOURS', 4);
  const criticalHours = thresholdHours('HUB_CLAUDE_OAUTH_CRITICAL_HOURS', 1);
  let claudeOauth = await checkTokenHealth();
  let refresh = null;
  let reimport = null;
  const initialExpires = Number(claudeOauth.expires_in_hours || 0);

  if (!claudeOauth.healthy || initialExpires <= warnHours) {
    refresh = await refreshClaudeCodeHubToken(claudeOauth.healthy ? 'refresh_window' : 'unhealthy');
    claudeOauth = await checkTokenHealth();
    if (!refresh?.ok && (!claudeOauth.healthy || Number(claudeOauth.expires_in_hours || 0) <= warnHours)) {
      reimport = await maybeReimportClaudeCodeCredential(claudeOauth.healthy ? 'refresh_window_after_refresh' : 'unhealthy_after_refresh');
      claudeOauth = await checkTokenHealth();
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
      },
    });
    return { ...claudeOauth, refresh, reimport };
  }

  if (expires <= warnHours) {
    const level = expires <= criticalHours ? 3 : 2;
    console.warn(`[oauth-monitor] Claude OAuth 갱신 필요: ${expires.toFixed(1)}h 후 만료`);
    await sendOAuthAlarm({
      level,
      title: '[Hub OAuth] Claude Code OAuth 재인증 예정',
      message: `Claude Code OAuth 토큰이 ${expires.toFixed(1)}시간 후 만료됩니다. Hub는 refresh_token 갱신과 Keychain 재import를 순서대로 시도했습니다. 만료 전 브라우저 재인증을 진행해 주세요.`,
      payload: {
        provider: 'claude-code-oauth',
        healthy: true,
        needs_refresh: true,
        expires_in_hours: Math.round(expires * 10) / 10,
        refresh,
        reimport,
      },
    });
  } else {
    const refreshNote = claudeOauth.needs_refresh ? ' refresh_window=true' : '';
    console.log(`[oauth-monitor] Claude OAuth 정상: ${expires.toFixed(1)}h 남음 (${claudeOauth.account || 'unknown'})${refreshNote}`);
  }

  return { ...claudeOauth, refresh, reimport };
}

async function checkOpenAiCodexOAuth() {
  const warnHours = thresholdHours('HUB_OPENAI_OAUTH_WARN_HOURS', 24);
  const criticalHours = thresholdHours('HUB_OPENAI_OAUTH_CRITICAL_HOURS', 4);
  let openaiOauth = await checkOpenAIOAuthHealth();
  let refresh = null;
  let reimport = null;
  const expiresInHours = tokenExpiresInHours(getProviderRecord('openai-codex-oauth')?.token || null);
  const shouldRefresh = !openaiOauth.healthy
    || (Number.isFinite(Number(expiresInHours)) && Number(expiresInHours) <= warnHours);

  if (shouldRefresh) {
    refresh = await refreshOpenAiCodexHubToken(openaiOauth.healthy ? 'refresh_window' : 'unhealthy');
    openaiOauth = await checkOpenAIOAuthHealth();
    const refreshedHours = tokenExpiresInHours(getProviderRecord('openai-codex-oauth')?.token || null);
    if (!refresh?.ok && (!openaiOauth.healthy || (Number.isFinite(Number(refreshedHours)) && Number(refreshedHours) <= warnHours))) {
      reimport = await maybeReimportOpenAiCodexCredential(openaiOauth.healthy ? 'refresh_window_after_refresh' : 'unhealthy_after_refresh');
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

  if (Number.isFinite(Number(finalHours)) && Number(finalHours) <= warnHours) {
    const level = Number(finalHours) <= criticalHours ? 3 : 2;
    console.warn(`[oauth-monitor] OpenAI OAuth 갱신 필요: ${Number(finalHours).toFixed(1)}h 후 만료`);
    await sendOAuthAlarm({
      level,
      title: '[Hub OAuth] OpenAI Codex OAuth 재인증 예정',
      message: `OpenAI Codex OAuth 토큰이 ${Number(finalHours).toFixed(1)}시간 후 만료됩니다. Hub는 refresh_token 갱신과 Codex auth.json 재동기화를 순서대로 시도했습니다.`,
      payload: {
        provider: 'openai-codex-oauth',
        healthy: true,
        needs_refresh: true,
        expires_in_hours: Math.round(Number(finalHours) * 10) / 10,
        refresh,
        reimport,
      },
    });
  } else {
    const suffix = Number.isFinite(Number(finalHours)) ? ` expires_in=${Number(finalHours).toFixed(1)}h` : '';
    console.log(`[oauth-monitor] OpenAI OAuth 정상: source=${openaiOauth.source || 'unknown'} model=${openaiOauth.model || 'unknown'}${suffix}`);
  }

  return { ...openaiOauth, expires_in_hours: finalHours, refresh, reimport };
}

function geminiMonitorRequired(): boolean {
  const record = getProviderRecord('gemini-oauth');
  return flag('HUB_OAUTH_MONITOR_REQUIRE_GEMINI', Boolean(record?.token?.access_token || record?.token?.refresh_token));
}

async function checkGeminiOAuth() {
  if (!geminiMonitorRequired()) {
    console.log('[oauth-monitor] Gemini OAuth 스킵: token-store에 등록된 토큰이 없고 필수 모드가 아닙니다.');
    return {
      healthy: true,
      skipped: true,
      token_present: false,
      refresh: null,
      error: null,
    };
  }

  const warnHours = thresholdHours('HUB_GEMINI_OAUTH_WARN_HOURS', 0.25);
  const criticalHours = thresholdHours('HUB_GEMINI_OAUTH_CRITICAL_HOURS', 0.05);
  let geminiOauth = await checkGeminiOAuthHealth();
  let refresh = null;
  const expiresInHours = tokenExpiresInHours(getProviderRecord('gemini-oauth')?.token || null);
  const shouldRefresh = !geminiOauth.healthy
    || (Number.isFinite(Number(expiresInHours)) && Number(expiresInHours) <= warnHours);

  if (shouldRefresh) {
    refresh = await refreshGeminiOAuthHubToken(geminiOauth.healthy ? 'refresh_window' : 'unhealthy');
    geminiOauth = await checkGeminiOAuthHealth();
  }

  const finalHours = tokenExpiresInHours(getProviderRecord('gemini-oauth')?.token || null);
  if (!geminiOauth.healthy) {
    console.error('[oauth-monitor] Gemini OAuth 오류:', geminiOauth.error);
    await sendOAuthAlarm({
      level: 3,
      title: '[Hub OAuth] Gemini OAuth 만료/오류',
      message: `Gemini OAuth가 unhealthy 상태입니다. ADC/OAuth 재인증 또는 quota project 설정을 확인해 주세요. error=${geminiOauth.error || 'unknown'}`,
      payload: {
        provider: 'gemini-oauth',
        healthy: false,
        error: geminiOauth.error || null,
        quota_project_configured: Boolean(geminiOauth.quota_project_configured),
        refresh,
      },
    });
    return { ...geminiOauth, expires_in_hours: finalHours, refresh };
  }

  if (Number.isFinite(Number(finalHours)) && Number(finalHours) <= warnHours) {
    const level = Number(finalHours) <= criticalHours ? 3 : 2;
    console.warn(`[oauth-monitor] Gemini OAuth 갱신 필요: ${Number(finalHours).toFixed(2)}h 후 만료`);
    await sendOAuthAlarm({
      level,
      title: '[Hub OAuth] Gemini OAuth 재인증 예정',
      message: `Gemini OAuth 토큰이 ${Number(finalHours).toFixed(2)}시간 후 만료됩니다. Hub는 refresh_token 갱신을 시도했습니다.`,
      payload: {
        provider: 'gemini-oauth',
        healthy: true,
        needs_refresh: true,
        expires_in_hours: Math.round(Number(finalHours) * 100) / 100,
        refresh,
      },
    });
  } else {
    const suffix = Number.isFinite(Number(finalHours)) ? ` expires_in=${Number(finalHours).toFixed(2)}h` : '';
    console.log(`[oauth-monitor] Gemini OAuth 정상: source=${geminiOauth.source || 'unknown'} quota_project=${geminiOauth.quota_project_configured ? 'configured' : 'missing'}${suffix}`);
  }

  return { ...geminiOauth, expires_in_hours: finalHours, refresh };
}

async function main() {
  const claudeOauth = await checkClaudeCodeOAuth();
  const openaiOauth = await checkOpenAiCodexOAuth();
  const geminiOauth = await checkGeminiOAuth();

  const groq = await checkGroqAccounts();
  console.log(`[oauth-monitor] Groq 계정: ${groq.available_accounts}/${groq.total_accounts} 정상`);

  console.log(JSON.stringify({
    ok: Boolean(claudeOauth.healthy && openaiOauth.healthy && (geminiOauth.skipped || geminiOauth.healthy)),
    generated_at: new Date().toISOString(),
    claude_code_oauth: {
      healthy: Boolean(claudeOauth.healthy),
      needs_refresh: Boolean(claudeOauth.needs_refresh),
      expires_in_hours: Number.isFinite(Number(claudeOauth.expires_in_hours))
        ? Math.round(Number(claudeOauth.expires_in_hours) * 10) / 10
        : null,
      refresh_ok: claudeOauth.refresh?.ok ?? null,
      refresh_source: claudeOauth.refresh?.source || null,
      keychain_sync_ok: claudeOauth.refresh?.keychain_sync?.ok ?? null,
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
      error: openaiOauth.error || null,
    },
    gemini_oauth: {
      healthy: Boolean(geminiOauth.healthy),
      skipped: Boolean(geminiOauth.skipped),
      source: geminiOauth.source || null,
      expires_in_hours: Number.isFinite(Number(geminiOauth.expires_in_hours))
        ? Math.round(Number(geminiOauth.expires_in_hours) * 100) / 100
        : null,
      needs_refresh: Boolean(geminiOauth.needs_refresh),
      quota_project_configured: Boolean(geminiOauth.quota_project_configured),
      refresh_ok: geminiOauth.refresh?.ok ?? null,
      refresh_source: geminiOauth.refresh?.source || null,
      refresh_config_source: geminiOauth.refresh?.refresh_config_source || null,
      error: geminiOauth.error || null,
    },
    groq_pool: groq,
  }));
}

main().catch(e => { console.error(e); process.exit(1); });
