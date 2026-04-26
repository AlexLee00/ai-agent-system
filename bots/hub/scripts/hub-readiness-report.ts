#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type CheckStatus = 'pass' | 'warn' | 'fail';

type Check = {
  name: string;
  status: CheckStatus;
  required: boolean;
  details?: Record<string, unknown>;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hubRoot = path.join(repoRoot, 'bots', 'hub');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

const PLACEHOLDER_RE = /(__SET_|CHANGE_ME|REPLACE_ME|TODO|PLACEHOLDER|changeme)/i;

function isEnabledFlag(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(raw || '').trim().toLowerCase());
}

function hasUsableSecret(value: string | undefined): boolean {
  const text = String(value || '').trim();
  return text.length >= 12 && !PLACEHOLDER_RE.test(text);
}

function readLaunchctlEnv(name: string): string {
  const result = spawnSync('launchctl', ['getenv', name], {
    encoding: 'utf8',
    maxBuffer: 1024 * 64,
  });
  if (Number(result.status ?? 1) !== 0) return '';
  return String(result.stdout || '').trim();
}

function runtimeSecretSource(name: string): string | null {
  const launchctlValue = readLaunchctlEnv(name);
  if (hasUsableSecret(launchctlValue)) return `launchctl:${name}`;
  if (hasUsableSecret(process.env[name])) return `process.env:${name}`;
  return null;
}

function runSmoke(script: string, required = true): Check {
  const result = spawnSync(tsxBin, [path.join(hubRoot, 'scripts', script)], {
    cwd: hubRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });
  const status = Number(result.status ?? 1);
  const stderr = String(result.stderr || '').trim();
  return {
    name: script.replace(/\.ts$/, ''),
    status: status === 0 ? 'pass' : required ? 'fail' : 'warn',
    required,
    details: {
      exit_code: status,
      ...(status !== 0 && stderr ? { error: stderr.split(/\r?\n/).slice(-1)[0] } : {}),
    },
  };
}

function readJson(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function tokenStoreCheck(): Check {
  const storeFile = process.env.HUB_OAUTH_STORE_FILE
    || path.join(hubRoot, 'output', 'oauth', 'token-store.json');
  const store = readJson(storeFile);
  const providers = store?.providers && typeof store.providers === 'object'
    ? store.providers
    : {};
  const providerSummary = Object.fromEntries(
    ['openai-codex-oauth', 'claude-code-cli', 'openai-api-key'].map((provider) => {
      const entry = providers[provider] || {};
      return [provider, {
        has_token: Boolean(entry.token),
        updated_at: entry.updatedAt || null,
        canary_ok: entry.canary?.ok ?? null,
        canary_checked_at: entry.canary?.checkedAt || null,
      }];
    }),
  );
  return {
    name: 'oauth_token_store_redacted',
    status: store ? 'pass' : 'warn',
    required: false,
    details: {
      store_exists: Boolean(store),
      store_file: storeFile,
      providers: providerSummary,
    },
  };
}

function hubSecretsCheck(): Check {
  const secretsFile = path.join(hubRoot, 'secrets-store.json');
  const store = readJson(secretsFile);
  const telegram = store?.telegram || {};
  const groqAccounts = Array.isArray(store?.groq?.accounts) ? store.groq.accounts : [];
  return {
    name: 'hub_secrets_store_redacted',
    status: store ? 'pass' : 'warn',
    required: false,
    details: {
      store_exists: Boolean(store),
      store_file: secretsFile,
      telegram: {
        has_bot_token: Boolean(telegram.bot_token),
        has_group_id: Boolean(telegram.group_id),
        topic_count: telegram.topic_ids && typeof telegram.topic_ids === 'object'
          ? Object.keys(telegram.topic_ids).length
          : 0,
      },
      groq: {
        account_count: groqAccounts.length,
      },
    },
  };
}

function runtimeSecretCheck(): Check {
  const callbackSecretSource = runtimeSecretSource('HUB_CONTROL_CALLBACK_SECRET');
  const hubAuthSource = runtimeSecretSource('HUB_AUTH_TOKEN');
  const allowProcessEnv = isEnabledFlag(process.env.HUB_LAUNCHD_SMOKE_ALLOW_PROCESS_ENV);
  return {
    name: 'runtime_secret_presence',
    status: callbackSecretSource && hubAuthSource ? 'pass' : 'warn',
    required: false,
    details: {
      hub_control_callback_secret_configured: Boolean(callbackSecretSource),
      hub_auth_token_configured: Boolean(hubAuthSource),
      hub_control_callback_secret_source: callbackSecretSource,
      hub_auth_token_source: hubAuthSource,
      process_env_allowed_for_launchd_smoke: allowProcessEnv,
    },
  };
}

function aggregate(checks: Check[]) {
  const requiredFailures = checks.filter((check) => check.required && check.status === 'fail');
  const warnings = checks.filter((check) => check.status === 'warn');
  return {
    ok: requiredFailures.length === 0,
    status: requiredFailures.length ? 'fail' : warnings.length ? 'warn' : 'pass',
    required_failures: requiredFailures.length,
    warnings: warnings.length,
  };
}

async function main() {
  const checks: Check[] = [
    runSmoke('secret-leak-smoke.ts', true),
    runSmoke('openclaw-independence-smoke.ts', true),
    runSmoke('runtime-workspace-independence-smoke.ts', true),
    runSmoke('llm-control-independence-smoke.ts', true),
    runSmoke('openai-oauth-direct-smoke.ts', true),
    runSmoke('openai-oauth-token-store-smoke.ts', true),
    runSmoke('claude-code-oauth-direct-smoke.ts', true),
    runSmoke('telegram-hub-secrets-smoke.ts', true),
    runSmoke('launchd-callback-secret-smoke.ts', false),
    tokenStoreCheck(),
    hubSecretsCheck(),
    runtimeSecretCheck(),
  ];
  const summary = aggregate(checks);
  const payload = {
    ...summary,
    generated_at: new Date().toISOString(),
    repo_root: repoRoot,
    checks,
    next_actions: summary.ok
      ? [
          'Run check:runtime on the deployed host before enabling mutating approvals.',
          'Run OAuth live canaries only with approved runtime credentials.',
        ]
      : [
          'Fix required failed checks before running live OAuth or Telegram alarm tests.',
        ],
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[hub-readiness-report] failed:', error?.message || error);
  process.exit(1);
});
