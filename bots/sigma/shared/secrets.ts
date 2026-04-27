// @ts-nocheck
/**
 * bots/sigma/shared/secrets.ts — 시크릿 로더
 *
 * 현재 우선순위: bots/sigma/secrets.json → 환경변수
 * 참고: Hub Secrets Store 연동은 아직 구현되지 않았다.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface SigmaSecrets {
  anthropic_api_key: string;
  ollama_url: string;
  hub_api_url: string;
  hub_api_token: string;
}

let _cached: SigmaSecrets | null = null;

function envFlag(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function anthropicPublicApiEnabled(): boolean {
  return envFlag('HUB_ENABLE_CLAUDE_PUBLIC_API') || envFlag('HUB_ENABLE_ANTHROPIC_PUBLIC_API');
}

export function loadSecrets(): SigmaSecrets {
  if (_cached) return _cached;

  let fileSecrets: Partial<SigmaSecrets> = {};
  try {
    const path =
      process.env.SIGMA_SECRETS_PATH ||
      join(process.cwd(), 'bots/sigma/secrets.json');
    fileSecrets = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 파일 없으면 환경변수로 폴백
  }

  _cached = {
    anthropic_api_key: anthropicPublicApiEnabled()
      ? (fileSecrets.anthropic_api_key || process.env.ANTHROPIC_API_KEY || '')
      : '',
    ollama_url: fileSecrets.ollama_url || process.env.OLLAMA_URL || 'http://localhost:11434',
    hub_api_url: fileSecrets.hub_api_url || process.env.HUB_API_URL || 'http://localhost:7788',
    hub_api_token: fileSecrets.hub_api_token || process.env.HUB_AUTH_TOKEN || '',
  };
  return _cached;
}
