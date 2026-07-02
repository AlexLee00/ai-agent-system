#!/usr/bin/env node
// @ts-nocheck

const assert = require('node:assert/strict');
const { shadowRegistryStatsViaHub, _testOnly } = require('../lib/hub-agent-registry-read.ts');

async function main() {
  const original = process.env.ORCH_REGISTRY_VIA_HUB;
  const local = { agentCount: 122, teamCount: 14 };
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        if (String(url).endsWith('/hub/agents')) {
          return { agents: [{ team: 'hub' }, { team: 'luna' }] };
        }
        return { stats: { agentCount: 122, teamCount: 14 } };
      },
    };
  };
  const log = { log() {}, warn() {} };

  process.env.ORCH_REGISTRY_VIA_HUB = 'false';
  assert.deepEqual(await shadowRegistryStatsViaHub(local, { fetchFn, log }), local);
  assert.equal(calls, 0, 'OFF mode must not call Hub');

  process.env.ORCH_REGISTRY_VIA_HUB = 'true';
  assert.deepEqual(await shadowRegistryStatsViaHub(local, { fetchFn, log }), local);
  assert.equal(calls, 2, 'ON mode must read dashboard and list');

  assert.deepEqual(_testOnly.normalizeStats({ stats: { agent_count: 9, team_count: 2 } }), {
    agentCount: 9,
    teamCount: 2,
  });

  process.env.ORCH_REGISTRY_VIA_HUB = original;
  console.log(JSON.stringify({ ok: true, checks: 4 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

