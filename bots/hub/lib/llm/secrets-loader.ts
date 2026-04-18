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

export function pickGroqApiKey(): string | null {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;

  const accounts = loadGroqAccounts();
  if (accounts.length === 0) return null;

  const now = Date.now();

  // Clean up expired entries to prevent memory leak
  for (const [k, until] of blacklistedKeys) {
    if (until <= now) blacklistedKeys.delete(k);
  }

  for (let attempt = 0; attempt < accounts.length; attempt++) {
    const idx = (rotationIndex + attempt) % accounts.length;
    const key = accounts[idx];
    const blacklistUntil = blacklistedKeys.get(key) ?? 0;
    if (blacklistUntil > now) continue;
    rotationIndex = (idx + 1) % accounts.length;
    return key;
  }

  // 전부 블랙리스트 → 가장 앞 키 반환 (곧 만료)
  return accounts[rotationIndex++ % accounts.length];
}

export function blacklistGroqKey(apiKey: string, ms = BLACKLIST_DURATION_MS): void {
  blacklistedKeys.set(apiKey, Date.now() + ms);
}
