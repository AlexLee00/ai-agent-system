#!/usr/bin/env tsx
// @ts-nocheck

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildHubStageBStabilityReport } = require('../lib/stage-b/stability.ts');

const CONFIRM = 'hub-stage-b-self-healing';
const argv = process.argv.slice(2);
const hasFlag = (flag) => argv.includes(flag);
const getArgValue = (name) => {
  const prefix = `${name}=`;
  const raw = argv.find((item) => item.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
};

async function callTierProbe() {
  const port = process.env.HUB_PORT || '7788';
  const token = process.env.HUB_AUTH_TOKEN || '';
  const response = await fetch(`http://127.0.0.1:${port}/hub/llm/tier-probe`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ source: 'hub-stage-b-self-healing' }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

async function main() {
  const apply = hasFlag('--apply');
  const confirm = getArgValue('--confirm');
  const action = getArgValue('--action') || 'plan';
  const report = await buildHubStageBStabilityReport({
    skipDb: hasFlag('--skip-db'),
    skipLaunchctl: hasFlag('--skip-launchctl'),
  });

  const result = {
    ok: true,
    checkedAt: new Date().toISOString(),
    dryRun: !apply,
    action,
    confirmRequired: CONFIRM,
    stageBStatus: report.status,
    plan: report.selfHealing,
    applied: null,
  };

  if (apply && confirm !== CONFIRM) {
    result.ok = false;
    result.error = 'confirm_required';
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  if (apply && action === 'tier_probe') {
    result.applied = await callTierProbe();
    result.ok = Boolean(result.applied.ok);
  } else if (apply) {
    result.ok = false;
    result.error = 'unsupported_or_confirm_required_action';
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error('[hub-stage-b-self-healing] failed:', error?.message || error);
  process.exit(1);
});
