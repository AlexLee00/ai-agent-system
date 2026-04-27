// @ts-nocheck
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as env from '../../../../packages/core/lib/env';
const { fetchHubSecrets } = require('../../../../packages/core/lib/hub-client');
const { getProviderRecord } = require('../oauth/token-store');

export interface OAuthHealth {
  healthy: boolean;
  expires_in_hours: number;
  needs_refresh: boolean;
  error?: string;
  auth_method?: string;
  account?: string;
}

export interface OpenAIOAuthHealth {
  healthy: boolean;
  token_present: boolean;
  source?: 'hub_oauth_token_store' | 'local_store' | 'hub_secret';
  model?: string;
  error?: string;
  expires_at?: string | null;
  needs_refresh?: boolean;
}

export interface GeminiOAuthHealth {
  healthy: boolean;
  token_present: boolean;
  source?: string;
  error?: string;
  expires_at?: string | null;
  expires_in_hours?: number | null;
  needs_refresh?: boolean;
  quota_project_configured?: boolean;
}

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

function tokenExpiry(token: any): { expired: boolean; needsRefresh: boolean; expiresAt: string | null } {
  const expiresAt = token?.expires_at || token?.expiresAt || null;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresMs)) return { expired: false, needsRefresh: false, expiresAt: expiresAt || null };
  const remainingMs = expiresMs - Date.now();
  return {
    expired: remainingMs <= 0,
    needsRefresh: remainingMs > 0 && remainingMs < 24 * 60 * 60 * 1000,
    expiresAt: new Date(expiresMs).toISOString(),
  };
}

export async function checkTokenHealth(): Promise<OAuthHealth> {
  const record = getProviderRecord('claude-code-cli');
  const storedToken = record?.token || null;
  if (storedToken?.access_token) {
    const expiry = tokenExpiry(storedToken);
    return {
      healthy: !expiry.expired,
      expires_in_hours: expiry.expiresAt
        ? (new Date(expiry.expiresAt).getTime() - Date.now()) / (60 * 60 * 1000)
        : 720,
      needs_refresh: expiry.needsRefresh,
      auth_method: record?.metadata?.source || 'hub_oauth_token_store',
      account: record?.metadata?.account || record?.metadata?.email,
      ...(expiry.expired ? { error: 'token_expired' } : {}),
    };
  }

  try {
    // Claude Code OAuth 토큰 상태 확인 — claude CLI 활용
    const result = execSync('claude auth status --json 2>/dev/null || echo "{}"', {
      encoding: 'utf-8', timeout: 5000
    });
    const status = JSON.parse(result.trim() || '{}');
    const loggedIn = status.authenticated === true || status.loggedIn === true;

    if (!loggedIn) {
      return { healthy: false, expires_in_hours: 0, needs_refresh: false, error: 'not_authenticated' };
    }

    // 만료 시간 계산 (Claude CLI가 expires_at 제공 시)
    if (status.expires_at) {
      const expiresInMs = new Date(status.expires_at).getTime() - Date.now();
      const expiresInHours = expiresInMs / (60 * 60 * 1000);
      return {
        healthy: expiresInHours > 0,
        expires_in_hours: expiresInHours,
        needs_refresh: expiresInHours < 24,
        auth_method: status.authMethod,
        account: status.email,
      };
    }

    // 만료 정보 없으면 authenticated면 healthy
    return {
      healthy: true,
      expires_in_hours: 720,
      needs_refresh: false,
      auth_method: status.authMethod,
      account: status.email,
    };
  } catch (e: any) {
    return { healthy: false, expires_in_hours: 0, needs_refresh: false, error: e.message };
  }
}

export async function checkOpenAIOAuthHealth(): Promise<OpenAIOAuthHealth> {
  const record = getProviderRecord('openai-codex-oauth');
  const storedToken = record?.token || null;
  if (storedToken?.access_token) {
    const expiry = tokenExpiry(storedToken);
    return {
      healthy: !expiry.expired,
      token_present: true,
      source: 'hub_oauth_token_store',
      model: record?.metadata?.model || record?.metadata?.default_model || 'gpt-5.4',
      expires_at: expiry.expiresAt,
      needs_refresh: expiry.needsRefresh,
      ...(expiry.expired ? { error: 'token_expired' } : {}),
    };
  }

  try {
    const localStore = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const token = String(localStore?.openai_oauth?.access_token || '').trim();
    if (token) {
      return {
        healthy: true,
        token_present: true,
        source: 'local_store',
        model: localStore?.openai_oauth?.model || 'gpt-5.4',
      };
    }
  } catch {
    // fall through to hub secret
  }

  try {
    const secret = await fetchHubSecrets('openai_oauth');
    const token = String(secret?.access_token || '').trim();
    if (token) {
      return {
        healthy: true,
        token_present: true,
        source: 'hub_secret',
        model: secret?.model || 'gpt-5.4',
      };
    }
    return {
      healthy: false,
      token_present: false,
      error: 'token_missing',
    };
  } catch (e: any) {
    return {
      healthy: false,
      token_present: false,
      error: e.message,
    };
  }
}

export async function checkGeminiOAuthHealth(): Promise<GeminiOAuthHealth> {
  const record = getProviderRecord('gemini-oauth');
  const storedToken = record?.token || null;
  if (!storedToken?.access_token) {
    return {
      healthy: false,
      token_present: false,
      needs_refresh: false,
      quota_project_configured: false,
      error: 'token_missing',
    };
  }

  const expiry = tokenExpiry(storedToken);
  const expiresInHours = expiry.expiresAt
    ? (new Date(expiry.expiresAt).getTime() - Date.now()) / (60 * 60 * 1000)
    : null;
  const refreshWindowHours = Number(process.env.HUB_GEMINI_OAUTH_WARN_HOURS || 0.25);
  const needsRefresh = Number.isFinite(Number(expiresInHours))
    && Number(expiresInHours) > 0
    && Number(expiresInHours) <= (Number.isFinite(refreshWindowHours) && refreshWindowHours > 0 ? refreshWindowHours : 0.25);
  const quotaProjectConfigured = Boolean(
    process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || record?.metadata?.quota_project_id
      || record?.metadata?.project_id
      || storedToken?.quota_project_id
      || storedToken?.project_id,
  );

  return {
    healthy: !expiry.expired && quotaProjectConfigured,
    token_present: true,
    source: record?.metadata?.source || 'hub_oauth_token_store',
    expires_at: expiry.expiresAt,
    expires_in_hours: expiresInHours,
    needs_refresh: needsRefresh,
    quota_project_configured: quotaProjectConfigured,
    ...(expiry.expired ? { error: 'token_expired' } : {}),
    ...(!quotaProjectConfigured ? { error: 'missing_quota_project' } : {}),
  };
}

export async function checkGroqAccounts(): Promise<{ available_accounts: number; total_accounts: number }> {
  try {
    const { loadGroqAccounts } = require('./secrets-loader');
    const accounts = await loadGroqAccounts();
    return { available_accounts: accounts.length, total_accounts: accounts.length };
  } catch {
    return { available_accounts: 0, total_accounts: 0 };
  }
}
