#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_ENV = [
  'HUB_AUTH_TOKEN',
  'HUB_CONTROL_CALLBACK_SECRET',
  'HUB_CONTROL_APPROVER_IDS',
  'HUB_CONTROL_APPROVAL_TOPIC_ID',
  'HUB_CONTROL_APPROVAL_CHAT_ID',
  'TELEGRAM_GROUP_ID',
  'TELEGRAM_TOPIC_OPS_WORK',
  'TELEGRAM_TOPIC_OPS_REPORTS',
  'TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION',
];

const PLACEHOLDER_PATTERN = /(__SET_|placeholder|changeme|change_me|example|dummy|test-token|smoke-token|smoke-secret)/i;

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(prefix) {
  const match = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  return match ? match.slice(prefix.length + 1) : '';
}

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function redact(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= 8) return '<redacted>';
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

function parseEnvFile(filePath) {
  const env = {};
  if (!filePath) return env;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadHubSecrets() {
  const storePath = path.resolve(__dirname, '..', 'secrets-store.json');
  try {
    if (!fs.existsSync(storePath)) return {};
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return {};
  }
}

function secretStoreValue(key, store) {
  const telegram = store?.telegram || {};
  const topicIds = telegram.topic_ids || telegram.telegram_topic_ids || {};
  if (key === 'TELEGRAM_GROUP_ID') return telegram.group_id || telegram.telegram_group_id || telegram.chat_id || telegram.telegram_chat_id || '';
  if (key === 'TELEGRAM_TOPIC_OPS_WORK') return topicIds.ops_work || '';
  if (key === 'TELEGRAM_TOPIC_OPS_REPORTS') return topicIds.ops_reports || '';
  if (key === 'TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION') return topicIds.ops_error_resolution || '';
  if (key === 'HUB_CONTROL_APPROVAL_CHAT_ID') return telegram.group_id || telegram.telegram_group_id || telegram.chat_id || telegram.telegram_chat_id || '';
  if (key === 'HUB_CONTROL_APPROVAL_TOPIC_ID') return topicIds.ops_error_resolution || '';
  return '';
}

function launchctlGetenv(key) {
  const result = spawnSync('launchctl', ['getenv', key], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (Number(result.status) !== 0) return '';
  return normalizeText(result.stdout);
}

function launchctlSetenv(key, value) {
  const result = spawnSync('launchctl', ['setenv', key, value], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: Number(result.status) === 0,
    status: Number(result.status || 0),
    error: normalizeText(result.stderr || result.stdout),
  };
}

function allowsShortRuntimeValue(key) {
  return /(TOPIC|CHAT|GROUP_ID|APPROVER_IDS)/i.test(key);
}

function classifyValue(key, value) {
  const text = normalizeText(value);
  if (!text) return { ok: false, reason: 'missing' };
  if (PLACEHOLDER_PATTERN.test(text)) return { ok: false, reason: 'placeholder' };
  if (text.length < 8 && !allowsShortRuntimeValue(key)) return { ok: false, reason: 'too_short' };
  return { ok: true, reason: 'ok' };
}

async function main() {
  const apply = hasArg('--apply');
  const json = hasArg('--json') || apply;
  const envFile = argValue('--env-file');
  const fileEnv = parseEnvFile(envFile);
  const store = loadHubSecrets();
  const entries = [];
  const installed = [];

  for (const key of REQUIRED_ENV) {
    const fileValue = normalizeText(fileEnv[key]);
    const processValue = normalizeText(process.env[key]);
    const launchctlValue = launchctlGetenv(key);
    const secretValue = normalizeText(secretStoreValue(key, store));
    const installValue = fileValue || processValue || secretValue;
    const runtimeValue = launchctlValue || processValue || fileValue || secretValue;
    const check = classifyValue(key, runtimeValue);
    if (apply) {
      const installCheck = classifyValue(key, installValue);
      if (!installCheck.ok) {
        entries.push({
          key,
          ok: false,
          source: 'install',
          reason: `cannot_install_${installCheck.reason}`,
          value: redact(installValue),
        });
        continue;
      }
      const setResult = launchctlSetenv(key, installValue);
      installed.push({ key, ok: setResult.ok, status: setResult.status, error: setResult.error || undefined });
      entries.push({
        key,
        ok: setResult.ok,
        source: fileValue ? 'env_file' : (processValue ? 'process_env' : 'secrets_store'),
        reason: setResult.ok ? 'installed' : setResult.error || 'launchctl_setenv_failed',
        value: redact(installValue),
      });
      continue;
    }
    entries.push({
      key,
      ok: check.ok,
      source: launchctlValue ? 'launchctl' : (processValue ? 'process_env' : (fileValue ? 'env_file' : (secretValue ? 'secrets_store' : 'missing'))),
      reason: check.reason,
      value: redact(runtimeValue),
    });
  }

  const payload = {
    ok: entries.every((entry) => entry.ok),
    apply,
    envFile: envFile || null,
    checked: entries.length,
    installed,
    entries,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`# Jay runtime env ${apply ? 'install' : 'check'} (${payload.ok ? 'ok' : 'needs-attention'})`);
    for (const entry of entries) {
      console.log(`- ${entry.ok ? 'ok' : 'missing'} ${entry.key} source=${entry.source} reason=${entry.reason}`);
    }
  }

  if (!payload.ok) process.exit(1);
}

main().catch((error) => {
  console.error(`jay_runtime_env_check_failed: ${error?.message || error}`);
  process.exit(1);
});
