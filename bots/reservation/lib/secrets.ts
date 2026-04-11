import fs from 'fs';
import path from 'path';
import { fetchHubSecrets } from '../../../packages/core/lib/hub-client';
const env = require('../../../packages/core/lib/env');

type SecretValue = string | null | undefined;
type SecretMap = Record<string, SecretValue>;

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots/hub/secrets-store.json');

let cache: SecretMap | null = null;
let hubSharedInitDone = false;

function loadStoreSecrets(): SecretMap {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')) as Record<string, SecretMap>;
    return raw?.reservation || {};
  } catch {
    return {};
  }
}

export function loadSecrets(): SecretMap {
  if (cache) return cache;
  const store = loadStoreSecrets();
  cache = Object.keys(store).length > 0 ? store : {};
  return cache;
}

export async function initHubSecrets(): Promise<boolean> {
  if (hubSharedInitDone) return !!cache;

  const store = loadStoreSecrets();
  const base = Object.keys(store).length > 0 ? store : {};
  try {
    const hubData = await fetchHubSecrets('reservation');
    if (hubData) {
      cache = { ...base, ...hubData };
      hubSharedInitDone = true;
      return true;
    }
    const sharedData = await fetchHubSecrets('reservation-shared');
    if (sharedData) {
      cache = { ...base, ...sharedData };
      hubSharedInitDone = true;
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[reservation/secrets] Hub 시크릿 로드 실패: ${message}`);
  }

  cache = base;
  hubSharedInitDone = true;
  return false;
}

export async function initHubSharedSecrets(): Promise<boolean> {
  return initHubSecrets();
}

export function requireSecret(key: string): string {
  const value = loadSecrets()[key];
  if (!value) {
    console.error(`❌ 필수 설정 누락: reservation secrets의 "${key}" 값이 없습니다.`);
    console.error('   Hub secrets-store.json 또는 Hub API 구성을 확인한 후 다시 시작하세요.');
    process.exit(1);
  }
  return value;
}

export function hasSecret(key: string): boolean {
  const value = loadSecrets()[key];
  return !!value && String(value).trim().length > 0;
}

export function getSecret<T = SecretValue>(key: string, fallback: T | null = null): SecretValue | T | null {
  return loadSecrets()[key] ?? fallback;
}

export function isTelegramEnabled(): boolean {
  return hasSecret('telegram_bot_token');
}

export function getNaverCreds(): { id: string; pw: string } {
  return {
    id: requireSecret('naver_id'),
    pw: requireSecret('naver_pw'),
  };
}

export function getPickkoCreds(): { id: string; pw: string } {
  return {
    id: requireSecret('pickko_id'),
    pw: requireSecret('pickko_pw'),
  };
}

export function getDbKeys(): { encryptionKey: string; pepper: string } {
  return {
    encryptionKey: requireSecret('db_encryption_key'),
    pepper: requireSecret('db_key_pepper'),
  };
}

export function hasDataGokrKeys(): boolean {
  return hasSecret('datagokr_holiday_key');
}
