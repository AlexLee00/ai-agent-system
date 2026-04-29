import fs from 'node:fs';
import path from 'node:path';
import env from '../../../packages/core/lib/env.legacy.js';

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

type Args = {
  thresholdDays: number;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    thresholdDays: 7,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--threshold-days') args.thresholdDays = Number(argv[++i] || 7) || 7;
    else if (token === '--json') args.json = true;
  }
  return args;
}

function loadStore(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function daysUntil(value: string): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return (ts - Date.now()) / (1000 * 60 * 60 * 24);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = loadStore();
  const github = (store.github && typeof store.github === 'object' && !Array.isArray(store.github))
    ? store.github
    : {};

  const expiresAt = String(github.expires_at || '').trim();
  const tokenName = String(github.token_name || '').trim();
  const targetName = String(github.target_name || '').trim();
  const repositories = Array.isArray(github.repositories) ? github.repositories.map(String) : [];
  const permissions = github.permissions && typeof github.permissions === 'object' && !Array.isArray(github.permissions)
    ? github.permissions
    : {};
  const remainingDays = daysUntil(expiresAt);
  const hasToken = Boolean(String(github.token || '').trim());
  const renewalNeeded = !hasToken
    || remainingDays == null
    || remainingDays <= args.thresholdDays;

  const prepareCommand = [
    'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/hub run github:pat-prepare --',
    `--token-name "${tokenName || 'team-jay-github-token'}"`,
    targetName ? `--target-name "${targetName}"` : '',
    repositories.length > 0 ? `--repositories "${repositories.join(',')}"` : '',
    '--open-browser --json',
  ].filter(Boolean).join(' ');

  const payload = {
    ok: true,
    storePath: STORE_PATH,
    hasToken,
    tokenName,
    targetName,
    expiresAt,
    remainingDays: remainingDays == null ? null : Number(remainingDays.toFixed(2)),
    thresholdDays: args.thresholdDays,
    renewalNeeded,
    repositories,
    permissions,
    status: !hasToken
      ? 'missing'
      : remainingDays == null
        ? 'unknown_expiry'
        : remainingDays <= 0
          ? 'expired'
          : remainingDays <= args.thresholdDays
            ? 'expiring_soon'
            : 'healthy',
    recommendedNextStep: renewalNeeded ? prepareCommand : 'No action needed yet.',
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[github pat readiness] status=${payload.status} token=${tokenName || '(unset)'} owner=${targetName || '(unset)'}`);
  console.log(`[github pat readiness] expires_at=${expiresAt || '(unset)'} remaining_days=${payload.remainingDays ?? 'unknown'}`);
  console.log(`[github pat readiness] renewal_needed=${renewalNeeded ? 'yes' : 'no'}`);
  if (renewalNeeded) console.log(`[github pat readiness] next=${prepareCommand}`);
}

main();
