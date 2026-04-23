// @ts-nocheck
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as env from '../../../../packages/core/lib/env';
const { fetchHubSecrets } = require('../../../../packages/core/lib/hub-client');

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
  source?: 'local_store' | 'hub_secret';
  model?: string;
  error?: string;
}

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

export async function checkTokenHealth(): Promise<OAuthHealth> {
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

export async function checkGroqAccounts(): Promise<{ available_accounts: number; total_accounts: number }> {
  try {
    const { loadGroqAccounts } = require('./secrets-loader');
    const accounts = await loadGroqAccounts();
    return { available_accounts: accounts.length, total_accounts: accounts.length };
  } catch {
    return { available_accounts: 0, total_accounts: 0 };
  }
}
