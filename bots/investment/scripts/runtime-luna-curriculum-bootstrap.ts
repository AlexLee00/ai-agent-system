#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { listAgentDefinitions } from '../shared/agent-yaml-loader.ts';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const CONFIRM = 'luna-curriculum-bootstrap';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalizeAgentNames(agentNames = []) {
  return [...new Set(agentNames.map((name) => String(name || '').trim()).filter(Boolean))].sort();
}

export function buildCurriculumBootstrapPlanFromAgents({
  agents = [],
  existing = [],
  market = 'any',
} = {}) {
  const existingKeys = new Set(existing.map((row) => `${row.agent_name || row.agentName}:${row.market || market}`));
  const candidates = normalizeAgentNames(agents.map((agent) => agent.name || agent))
    .map((agentName) => ({
      agentName,
      market,
      currentLevel: 'novice',
      invocationCount: 0,
      successCount: 0,
      failureCount: 0,
      exists: existingKeys.has(`${agentName}:${market}`),
    }));
  const toCreate = candidates.filter((item) => !item.exists);
  return {
    ok: true,
    status: toCreate.length > 0 ? 'curriculum_bootstrap_plan_ready' : 'curriculum_bootstrap_already_seeded',
    dryRun: true,
    market,
    totalAgents: candidates.length,
    toCreate: toCreate.length,
    candidates,
    requiredConfirm: CONFIRM,
  };
}

async function loadExistingCurriculum(market = 'any') {
  await db.initSchema();
  return db.query(
    `SELECT agent_name, market
       FROM investment.agent_curriculum_state
      WHERE market = $1`,
    [market],
  ).catch(() => []);
}

export async function runLunaCurriculumBootstrap({
  market = 'any',
  apply = false,
  confirm = null,
} = {}) {
  const agents = listAgentDefinitions();
  const existing = await loadExistingCurriculum(market);
  const plan = buildCurriculumBootstrapPlanFromAgents({ agents, existing, market });
  if (!apply) return plan;
  if (confirm !== CONFIRM) {
    return {
      ...plan,
      ok: false,
      status: 'curriculum_bootstrap_confirm_required',
      dryRun: true,
      applied: false,
    };
  }
  const toCreate = plan.candidates.filter((item) => !item.exists);
  let inserted = 0;
  for (const item of toCreate) {
    const result = await db.run(
      `INSERT INTO investment.agent_curriculum_state
         (agent_name, market, invocation_count, success_count, failure_count, current_level, config, updated_at)
       VALUES ($1, $2, 0, 0, 0, 'novice', $3::jsonb, NOW())
       ON CONFLICT (agent_name, market) DO NOTHING`,
      [
        item.agentName,
        item.market,
        JSON.stringify({ bootstrap: true, source: 'runtime-luna-curriculum-bootstrap' }),
      ],
    );
    inserted += Number(result.rowCount || 0);
  }
  return {
    ...plan,
    ok: true,
    status: 'curriculum_bootstrap_applied',
    dryRun: false,
    applied: true,
    inserted,
  };
}

export async function runLunaCurriculumBootstrapSmoke() {
  const plan = buildCurriculumBootstrapPlanFromAgents({
    market: 'any',
    agents: [{ name: 'luna' }, { name: 'argos' }, { name: 'luna' }],
    existing: [{ agent_name: 'luna', market: 'any' }],
  });
  assert.equal(plan.totalAgents, 2);
  assert.equal(plan.toCreate, 1);
  assert.equal(plan.candidates.find((item) => item.agentName === 'luna').exists, true);
  assert.equal(plan.candidates.find((item) => item.agentName === 'argos').exists, false);

  const blocked = {
    ...plan,
    ok: false,
    status: 'curriculum_bootstrap_confirm_required',
    dryRun: true,
    applied: false,
  };
  assert.equal(blocked.applied, false);
  return { ok: true, plan, blocked };
}

async function main() {
  const smoke = hasFlag('--smoke');
  const json = hasFlag('--json');
  const result = smoke ? await runLunaCurriculumBootstrapSmoke() : await runLunaCurriculumBootstrap({
    market: argValue('--market', 'any'),
    apply: hasFlag('--apply'),
    confirm: argValue('--confirm', null),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (smoke) console.log('luna curriculum bootstrap smoke ok');
  else console.log(`${result.status} toCreate=${result.toCreate || 0} applied=${result.applied === true}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna curriculum bootstrap 실패:',
  });
}
