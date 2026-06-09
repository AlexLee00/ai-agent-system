const path = require('path');
const fs = require('fs');
const env = require('../../../../packages/core/lib/env');

let cachedAccounts: string[] | null = null;
let lastLoadAt = 0;
const CACHE_TTL_MS = 60_000;

export function loadGroqAccounts(): string[] {
  const now = Date.now();
  if (cachedAccounts && (now - lastLoadAt) < CACHE_TTL_MS) {
    return cachedAccounts;
  }

  const secretsPath = path.resolve(env.PROJECT_ROOT, 'bots/hub/secrets-store.json');
  try {
    const raw = fs.readFileSync(secretsPath, 'utf-8');
    const store = JSON.parse(raw);
    const accounts: string[] = (store?.groq?.accounts ?? [])
      .map((a: any) => a?.api_key)
      .filter(Boolean);
    cachedAccounts = accounts;
    lastLoadAt = now;
    return accounts;
  } catch {
    console.error('[llm/secrets] Groq accounts 로드 실패 (secrets-store.json 없음)');
    return [];
  }
}

let rotationIndex = 0;
const blacklistedKeys = new Map<string, number>();
const BLACKLIST_DURATION_MS = 60_000;

function groqAccountPoolEnabled(): boolean {
  // Groq docs describe rate limits as organization-level, so multiple keys from
  // the same org should not be assumed to multiply quota. Our currently
  // provisioned 9 keys were probed on 2026-06-10 with minimal chat requests:
  // each key reported an independent remaining-requests/tokens bucket, and
  // A-B-A probes decremented only the key that was used. Keep pool round-robin
  // enabled by default for this deployment, with HUB_GROQ_ACCOUNT_POOL_ENABLED=false
  // as the kill switch if future keys share one org bucket.
  return !['0', 'false', 'no', 'n', 'off'].includes(String(process.env.HUB_GROQ_ACCOUNT_POOL_ENABLED || '').trim().toLowerCase());
}

function isBlacklisted(apiKey: string, now = Date.now()): boolean {
  const until = blacklistedKeys.get(apiKey) ?? 0;
  if (until <= now) {
    if (until > 0) blacklistedKeys.delete(apiKey);
    return false;
  }
  return true;
}

export function pickGroqApiKey(): string | null {
  if (process.env.GROQ_API_KEY) {
    const envKey = process.env.GROQ_API_KEY;
    return isBlacklisted(envKey) ? null : envKey;
  }

  const accounts = loadGroqAccounts();
  if (accounts.length === 0) return null;

  const now = Date.now();

  // Clean up expired entries to prevent memory leak
  for (const [k, until] of blacklistedKeys) {
    if (until <= now) blacklistedKeys.delete(k);
  }

  if (!groqAccountPoolEnabled()) {
    const primary = accounts[0];
    return primary && !isBlacklisted(primary, now) ? primary : null;
  }

  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const idx = (rotationIndex + attempt) % accounts.length;
    const key = accounts[idx];
    if (isBlacklisted(key, now)) continue;
    rotationIndex = (idx + 1) % accounts.length;
    return key;
  }

  // 전부 블랙리스트면 곧바로 재시도하지 않는다. Groq의 retry-after
  // 힌트를 존중하지 않으면 계정 풀 전체가 429 루프에 들어간다.
  return null;
}

export function blacklistGroqKey(apiKey: string, ms = BLACKLIST_DURATION_MS): void {
  blacklistedKeys.set(apiKey, Date.now() + ms);
}

export function getGroqAccountPoolStatus(): { total: number; available: number; cooldown: number } {
  const accounts = loadGroqAccounts();
  const now = Date.now();
  if (!groqAccountPoolEnabled()) {
    const primary = accounts[0] || '';
    const primaryCooldown = primary && isBlacklisted(primary, now) ? 1 : 0;
    return {
      total: accounts.length,
      available: primary && !primaryCooldown ? 1 : 0,
      cooldown: primaryCooldown,
    };
  }

  let cooldown = 0;
  for (const key of accounts) {
    if (isBlacklisted(key, now)) cooldown += 1;
  }
  return {
    total: accounts.length,
    available: Math.max(0, accounts.length - cooldown),
    cooldown,
  };
}

export function resetGroqKeyBlacklistForTests(): void {
  blacklistedKeys.clear();
  rotationIndex = 0;
}

export function _testOnlySetGroqAccounts(accounts: string[]): void {
  cachedAccounts = accounts.filter(Boolean);
  lastLoadAt = Date.now();
  blacklistedKeys.clear();
  rotationIndex = 0;
}

export function _testOnlyResetGroqAccounts(): void {
  cachedAccounts = null;
  lastLoadAt = 0;
  blacklistedKeys.clear();
  rotationIndex = 0;
}

export const _testOnly = {
  groqAccountPoolEnabled,
};
