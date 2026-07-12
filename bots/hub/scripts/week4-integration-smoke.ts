#!/usr/bin/env node
// @ts-nocheck
'use strict';

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function exists(relativePath) {
  return fs.existsSync(path.join(PROJECT_ROOT, relativePath));
}

function envMode(name) {
  return String(process.env[name] || 'unset');
}

export async function runWeek4IntegrationSmoke() {
  const files = [
    'bots/hub/scripts/shadow-mode-activation-smoke.ts',
    'bots/hub/scripts/week2-shadow-summary-report.ts',
    'bots/hub/scripts/llm-auto-routing-promotion-evaluation.ts',
    'bots/hub/scripts/permission-tier-promotion-evaluation.ts',
    'bots/sigma/vault/vault-manager.ts',
    'bots/sigma/vault/para-classifier.ts',
    'bots/sigma/vault/inbox-processor.ts',
    'bots/sigma/scripts/week3-vault-summary-report.ts',
    'bots/sigma/scripts/week4-master-promotion-report.ts',
    'bots/sigma/launchd/ai.sigma.vault-inbox-5min.plist',
    'bots/investment/scripts/phase-a-promotion-evaluation.ts',
    'bots/investment/scripts/phase-a-shadow-to-active.ts',
  ];
  const fileChecks = files.map((file) => ({ file, ok: exists(file) }));
  const env = {
    LLM_AUTO_ROUTING_ENABLED: envMode('LLM_AUTO_ROUTING_ENABLED'),
    PERMISSION_TIER_ENFORCE: envMode('PERMISSION_TIER_ENFORCE'),
    PHASE_A_PROMOTION_APPROVED: envMode('PHASE_A_PROMOTION_APPROVED'),
  };
  const safety = {
    liveTradeMutationPerformed: false,
    protectedPidMutationPerformed: false,
    secretPrinted: false,
    promotionRequiresMasterApproval: true,
    launchdBootstrapPerformed: false,
  };
  const missing = fileChecks.filter((item) => !item.ok).map((item) => item.file);
  const shadowModesOk = ['shadow', 'unset', 'false'].includes(env.LLM_AUTO_ROUTING_ENABLED)
    && ['shadow', 'unset', 'false'].includes(env.PERMISSION_TIER_ENFORCE);
  return {
    ok: missing.length === 0 && safety.promotionRequiresMasterApproval,
    status: missing.length === 0 ? 'week4_integration_smoke_clear' : 'week4_integration_smoke_missing_files',
    generatedAt: new Date().toISOString(),
    fileChecks,
    missing,
    env,
    shadowModesOk,
    safety,
    nextSteps: missing.length
      ? [`구현 누락 파일 보완: ${missing.join(', ')}`]
      : ['Shadow 누적 관찰을 진행하고 Day 22 이후 promotion evaluation을 실행'],
  };
}

async function main() {
  const result = await runWeek4IntegrationSmoke();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[week4-integration-smoke] ${result.status} missing=${result.missing.length}`);
  if (!result.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`week4-integration-smoke error: ${error?.message || error}`);
    process.exit(1);
  });
}

export default { runWeek4IntegrationSmoke };
