#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { buildTeamSsotAuditReport } from './team-ssot-audit';

const healthy = buildTeamSsotAuditReport({
  generatedAt: '2026-07-20T14:00:00.000Z',
  catalogTeams: [
    { id: 'jay', status: 'active' },
    { id: 'research', status: 'planned' },
  ],
  retiredTeams: [{ id: 'justin', status: 'retired' }],
  dbAgents: [
    { name: 'jay', team: 'jay', status: 'idle' },
    { name: 'write', team: 'jay', status: 'idle' },
    { name: 'justin', team: 'justin', status: 'archived' },
  ],
  seedAgents: [
    { name: 'jay', team: 'jay' },
  ],
  deploymentRegistry: {
    orchestrator: { status: 'planned', inventoryKind: 'planned' },
  },
  readmeText: '2 autonomous agents across 1 specialized teams\n1 Teams • 2 Agents\nAgents: 2 (across 1 teams)',
  activeContractDrift: [],
});

assert.equal(healthy.ok, true);
assert.equal(healthy.status, 'healthy');
assert.equal(healthy.summary.activeTeams, 1);
assert.equal(healthy.summary.retiredTeams, 1);
assert.equal(healthy.inventory.orchestrator.canonicalTeam, 'jay');
assert.equal(healthy.issues.length, 0);
assert.equal(healthy.dbWrite, false);

const drifted = buildTeamSsotAuditReport({
  generatedAt: '2026-07-20T14:00:00.000Z',
  catalogTeams: healthy.catalog.teams,
  retiredTeams: [{ id: 'justin', status: 'retired' }],
  dbAgents: [
    { name: 'jay', team: 'jay', status: 'idle' },
    { name: 'legacy-lawyer', team: 'justin', status: 'idle' },
    { name: 'legacy-researcher', team: 'research', status: 'idle' },
  ],
  seedAgents: [
    { name: 'jay', team: 'jay' },
    { name: 'missing-agent', team: 'jay' },
  ],
  deploymentRegistry: {
    orchestrator: { status: 'planned', inventoryKind: 'planned' },
  },
  readmeText: '121 autonomous agents across 10 specialized teams',
  activeContractDrift: [
    { name: 'write', team: 'jay', status: 'idle', active_contracts: 1 },
  ],
});

assert.equal(drifted.ok, false);
assert.equal(drifted.status, 'degraded');
assert.ok(drifted.issues.some((issue) => issue.code === 'db_active_team_mismatch'));
assert.ok(drifted.issues.some((issue) => issue.code === 'db_alias_team_rows'));
assert.ok(drifted.issues.some((issue) => issue.code === 'retired_team_runtime_rows'));
assert.ok(drifted.issues.some((issue) => issue.code === 'seed_agent_missing'));
assert.ok(drifted.issues.some((issue) => issue.code === 'readme_stats_drift'));
assert.ok(drifted.issues.some((issue) => issue.code === 'idle_agent_active_contract'));

console.log(JSON.stringify({
  ok: true,
  healthyStatus: healthy.status,
  degradedStatus: drifted.status,
  issueCodes: drifted.issues.map((issue) => issue.code),
  dbWrite: healthy.dbWrite,
}));
