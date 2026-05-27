#!/usr/bin/env node
// @ts-nocheck
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runWeek3VaultSummaryReport } from './week3-vault-summary-report.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGMA_ROOT = resolve(__dirname, '..');
const PROJECT_ROOT = resolve(SIGMA_ROOT, '../..');
const DEFAULT_OUTPUT_JSON = resolve(SIGMA_ROOT, 'output/week4-master-promotion-report.json');
const DEFAULT_OUTPUT_MD = resolve(SIGMA_ROOT, 'output/week4-master-promotion-report.md');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function loadRunner(relativeFile, exportName) {
  const url = pathToFileURL(path.join(PROJECT_ROOT, relativeFile)).href;
  const mod = await import(url);
  return mod[exportName];
}

async function safeRun(label, fn) {
  try {
    return { label, ok: true, result: await fn() };
  } catch (error) {
    return { label, ok: false, error: String(error?.message || error) };
  }
}

export async function runWeek4MasterPromotionReport() {
  const phaseRunner = await loadRunner('bots/investment/scripts/phase-a-promotion-evaluation.ts', 'runPhaseAPromotionEvaluation');
  const llmRunner = await loadRunner('bots/hub/scripts/llm-auto-routing-promotion-evaluation.ts', 'runLlmAutoRoutingPromotionEvaluation');
  const permissionRunner = await loadRunner('bots/hub/scripts/permission-tier-promotion-evaluation.ts', 'runPermissionTierPromotionEvaluation');
  const integrationRunner = await loadRunner('bots/hub/scripts/week4-integration-smoke.ts', 'runWeek4IntegrationSmoke');
  const [phaseA, llm, permission, vault, integration] = await Promise.all([
    safeRun('phaseA', phaseRunner),
    safeRun('hubLlmAutoRouting', llmRunner),
    safeRun('permissionTier', permissionRunner),
    safeRun('sigmaVault', () => runWeek3VaultSummaryReport({ days: 7 })),
    safeRun('week4IntegrationSmoke', integrationRunner),
  ]);
  const sections = { phaseA, llm, permission, vault, integration };
  const promotion = {
    phaseA: phaseA.result?.phaseA?.canPromote === true,
    hubLlmAutoRouting: llm.result?.promotionEligible === true,
    permissionTier: permission.result?.promotionEligible === true,
    sigmaVault: vault.result?.promotion?.enoughObservation === true,
  };
  const blockers = [];
  for (const [key, value] of Object.entries(promotion)) {
    if (!value) blockers.push(`${key}_not_ready`);
  }
  return {
    ok: true,
    status: blockers.length === 0 ? 'week4_master_promotion_ready_pending_master_approval' : 'week4_master_shadow_continue',
    generatedAt: new Date().toISOString(),
    promotion,
    blockers,
    sections,
    safety: {
      reportOnly: true,
      liveTradeImpact: false,
      protectedPidImpact: false,
      promotionRequiresExplicitMasterApproval: true,
      rollbackCommands: [
        'launchctl setenv LLM_AUTO_ROUTING_ENABLED shadow',
        'launchctl setenv PERMISSION_TIER_ENFORCE shadow',
        'launchctl setenv PHASE_A_PROMOTION_APPROVED false',
        'launchctl setenv LUNA_PHASE_A_INFLUENCE_MODE shadow_bias',
      ],
    },
  };
}

function summarizeSection(name, section) {
  if (!section.ok) return `- ${name}: error - ${section.error}`;
  const result = section.result || {};
  return `- ${name}: ${result.status || 'ok'}`;
}

function formatReport(result) {
  const lines = [
    '# Week 4 Master Promotion Report',
    '',
    `- Generated: ${result.generatedAt}`,
    `- Status: ${result.status}`,
    `- Blockers: ${result.blockers.length ? result.blockers.join(', ') : 'none'}`,
    '',
    '## Promotion',
    `- Phase A: ${result.promotion.phaseA ? 'ready' : 'continue shadow'}`,
    `- Hub LLM Auto-Routing: ${result.promotion.hubLlmAutoRouting ? 'ready' : 'continue shadow'}`,
    `- Permission Tier: ${result.promotion.permissionTier ? 'ready' : 'continue shadow'}`,
    `- Sigma Vault: ${result.promotion.sigmaVault ? 'ready' : 'continue observation'}`,
    '',
    '## Sections',
    summarizeSection('Phase A', result.sections.phaseA),
    summarizeSection('Hub LLM Auto-Routing', result.sections.llm),
    summarizeSection('Permission Tier', result.sections.permission),
    summarizeSection('Sigma Vault', result.sections.vault),
    summarizeSection('Integration Smoke', result.sections.integration),
    '',
    '## Safety',
    '- Report-only execution.',
    '- No live trade, protected PID, launchd bootstrap, rollback, or secret mutation is performed by this report.',
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const result = await runWeek4MasterPromotionReport();
  const report = formatReport(result);
  if (hasFlag('write')) {
    fs.mkdirSync(path.dirname(DEFAULT_OUTPUT_JSON), { recursive: true });
    fs.writeFileSync(DEFAULT_OUTPUT_JSON, `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(DEFAULT_OUTPUT_MD, report);
  }
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(report.trim());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`week4-master-promotion-report error: ${error?.message || error}`);
    process.exit(1);
  });
}

export default { runWeek4MasterPromotionReport };
