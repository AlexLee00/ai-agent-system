#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const script = path.join(__dirname, 'jay-orchestration-readiness-smoke.ts');
  const env = {
    ...process.env,
    JAY_ORCHESTRATION_REQUIRE_ENABLED: '1',
    JAY_COMMANDER_ENABLED: '1',
    JAY_HUB_PLAN_INTEGRATION: '1',
    JAY_INCIDENT_STORE_ENABLED: '1',
    JAY_COMMANDER_DISPATCH: '1',
    JAY_TEAM_BUS_ENABLED: '1',
    JAY_3TIER_TELEGRAM: '1',
    JAY_SKILL_EXTRACTION: '1',
    JAY_COMMANDER_BOT_QUEUE_ENABLED: '1',
    HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN || 'jay-cutover-smoke-token',
    HUB_CONTROL_CALLBACK_SECRET: process.env.HUB_CONTROL_CALLBACK_SECRET || 'jay-cutover-smoke-callback-secret',
    HUB_CONTROL_APPROVER_IDS: process.env.HUB_CONTROL_APPROVER_IDS || '9001',
    HUB_CONTROL_APPROVAL_TOPIC_ID: process.env.HUB_CONTROL_APPROVAL_TOPIC_ID || '13',
    HUB_CONTROL_APPROVAL_CHAT_ID: process.env.HUB_CONTROL_APPROVAL_CHAT_ID || '-100123456789',
    TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID || '-100123456789',
    TELEGRAM_TOPIC_OPS_WORK: process.env.TELEGRAM_TOPIC_OPS_WORK || '11',
    TELEGRAM_TOPIC_OPS_REPORTS: process.env.TELEGRAM_TOPIC_OPS_REPORTS || '12',
    TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: process.env.TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION || '13',
  };
  const result = spawnSync(tsxBin, [script], {
    cwd: path.join(repoRoot, 'bots', 'hub'),
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"runtime_cutover_required":true/, 'cutover readiness should run in strict mode');
  console.log('jay_runtime_cutover_drill_smoke_ok');
}

main().catch((error) => {
  console.error(`jay_runtime_cutover_drill_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
