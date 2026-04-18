// @ts-nocheck
import { execSync } from 'child_process';

export interface OAuthHealth {
  healthy: boolean;
  expires_in_hours: number;
  needs_refresh: boolean;
  error?: string;
}

export async function checkTokenHealth(): Promise<OAuthHealth> {
  try {
    // Claude Code OAuth 토큰 상태 확인 — claude CLI 활용
    const result = execSync('claude auth status --json 2>/dev/null || echo "{}"', {
      encoding: 'utf-8', timeout: 5000
    });
    const status = JSON.parse(result.trim() || '{}');

    if (!status.authenticated) {
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
      };
    }

    // 만료 정보 없으면 authenticated면 healthy
    return { healthy: true, expires_in_hours: 720, needs_refresh: false };
  } catch (e: any) {
    return { healthy: false, expires_in_hours: 0, needs_refresh: false, error: e.message };
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
