#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPhaseAPromotionEvaluation } from './phase-a-promotion-evaluation.ts';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export async function runPhaseAShadowToActive(options = {}) {
  const apply = options.apply === true;
  const masterApproved = ['true', '1', 'yes'].includes(String(process.env.PHASE_A_PROMOTION_APPROVED || '').toLowerCase());
  const evaluation = await runPhaseAPromotionEvaluation();
  const canPromote = Boolean(evaluation.phaseA?.canPromote);
  const changes = [
    { field: 'liveTradeImpact', from: false, to: true },
    { field: 'canPromote', from: false, to: true },
    { field: 'biasWeight', from: 0.25, to: 0.5 },
    { field: 'influenceMode', from: 'shadow_bias', to: 'active_bias' },
  ];
  const rollbackCommand = [
    'launchctl setenv PHASE_A_PROMOTION_APPROVED false',
    'launchctl setenv PHASE_A_ACTIVE false',
    'launchctl setenv LUNA_PHASE_A_INFLUENCE_MODE shadow_bias',
  ].join('\n');

  if (!masterApproved || !apply || !canPromote) {
    return {
      ok: !apply,
      status: !masterApproved
        ? 'phase_a_promotion_blocked_master_approval_required'
        : !canPromote
          ? 'phase_a_promotion_blocked_gate_failed'
          : 'phase_a_promotion_dry_run_ready',
      generatedAt: new Date().toISOString(),
      masterApproved,
      promotionEligible: canPromote,
      applied: false,
      dryRun: true,
      changes,
      rollbackCommand,
      evaluation,
      safety: {
        applyRequiresFlag: '--apply',
        applyRequiresEnv: 'PHASE_A_PROMOTION_APPROVED=true',
        liveTradeImpactBeforeApply: false,
      },
    };
  }

  const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
  const traceId = `phase-a-promotion-${Date.now()}`;
  await pgPool.query('public', `
    INSERT INTO hub.permission_audit_log
      (tool_name, agent, caller_team, tier, tier_name, decision, side_effect, risk_level, reason, trace_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [
    'phase-a-shadow-to-active',
    'phase-a-shadow-to-active',
    'luna',
    3,
    'ESCALATE',
    'allowed',
    'external_mutation',
    'high',
    'Phase A promotion approved by PHASE_A_PROMOTION_APPROVED=true',
    traceId,
  ]).catch(() => {});
  await pgPool.query('public', `
    INSERT INTO hub.token_budget_log
      (agent, caller_team, event_type, message)
    VALUES ($1,$2,$3,$4)
  `, [
    'phase-a-shadow-to-active',
    'luna',
    'promotion',
    'Phase A shadow to active promotion recorded; operator must set runtime env to active_bias',
  ]).catch(() => {});

  const record = {
    generatedAt: new Date().toISOString(),
    status: 'phase_a_promotion_applied_recorded',
    changes,
    rollbackCommand,
    traceId,
    nextOperatorCommand: 'launchctl setenv LUNA_PHASE_A_INFLUENCE_MODE active_bias',
  };
  const logPath = '/tmp/phase-a-promotion.json';
  fs.writeFileSync(logPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    status: 'phase_a_promotion_applied_recorded',
    generatedAt: record.generatedAt,
    masterApproved,
    promotionEligible: true,
    applied: true,
    dryRun: false,
    changes,
    rollbackCommand,
    logPath,
    evaluation,
    safety: {
      directLaunchctlMutation: false,
      operatorCommandRequired: record.nextOperatorCommand,
      rollbackCommand,
    },
  };
}

async function main() {
  const result = await runPhaseAShadowToActive({ apply: hasFlag('apply') });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[phase-a-shadow-to-active] ${result.status} applied=${result.applied}`);
  if (!result.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`phase-a-shadow-to-active error: ${error?.message || error}`);
    process.exit(1);
  });
}

export default { runPhaseAShadowToActive };
