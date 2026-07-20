#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import agentRegistry = require('../lib/agent-registry');

const competitionCollector = require('../../../bots/blog/scripts/collect-competition-results.ts');

const sql = String((agentRegistry as any)._testOnly?.MARK_AGENTS_IDLE_WITHOUT_ACTIVE_CONTRACTS_SQL || '');
const agentRegistrySource = fs.readFileSync(
  path.resolve(__dirname, '../lib/agent-registry.ts'),
  'utf8',
);
const completeContractFunction = agentRegistrySource.slice(
  agentRegistrySource.indexOf('async function completeContract'),
  agentRegistrySource.indexOf('async function registerAgent'),
);
const competitionCollectorSource = fs.readFileSync(
  path.resolve(__dirname, '../../../bots/blog/scripts/collect-competition-results.ts'),
  'utf8',
);
const supersededFunction = competitionCollectorSource.slice(
  competitionCollectorSource.indexOf('async function _markSuperseded'),
  competitionCollectorSource.indexOf('async function _collectCompetitionOutcome'),
);
const timeoutFunction = competitionCollectorSource.slice(
  competitionCollectorSource.indexOf('async function _markTimeout'),
  competitionCollectorSource.indexOf('async function _markSuperseded'),
);
const finalizeFunction = competitionCollectorSource.slice(
  competitionCollectorSource.indexOf('async function _finalizeContracts'),
  competitionCollectorSource.indexOf('async function _markTimeout'),
);
const collectOutcomeFunction = competitionCollectorSource.slice(
  competitionCollectorSource.indexOf('async function _collectCompetitionOutcome'),
  competitionCollectorSource.indexOf('async function _repairTimeoutCompetitions'),
);

assert.match(sql, /UPDATE\s+agent\.registry/i);
assert.match(sql, /SET\s+status\s*=\s*'idle'/i);
assert.match(sql, /ANY\s*\(\s*\$1::int\[\]\s*\)/i);
assert.match(sql, /NOT\s+EXISTS/i);
assert.match(sql, /c\.status\s*=\s*'active'/i);
assert.match(sql, /c\.agent_id\s*=\s*r\.id/i);
assert.match(sql, /r\.status\s*=\s*'active'/i);
assert.match(completeContractFunction, /pgPool\.transaction/);
assert.match(completeContractFunction, /client\.query/);
assert.match(completeContractFunction, /WHERE id = \$2\s+AND status = 'active'/);
assert.match(completeContractFunction, /markAgentsIdleWithoutActiveContracts\(\[contract\.agent_id\], client\)/);
assert.match(competitionCollectorSource, /markAgentsIdleWithoutActiveContracts\(agentIds, client\)/);
assert.doesNotMatch(
  competitionCollectorSource,
  /UPDATE\s+agent\.registry\s+SET\s+status\s*=\s*'idle'/i,
);
assert.match(supersededFunction, /_finalizeContracts\(/);
assert.match(supersededFunction, /transaction\('agent'/);
assert.match(timeoutFunction, /transaction\('agent'/);
assert.ok(
  (finalizeFunction.match(/status\s*=\s*'active'/g) || []).length >= 1,
  'competition finalization must update active contracts only',
);
assert.match(finalizeFunction, /SELECT id, agent_id, status[\s\S]*FOR UPDATE/);
assert.ok(
  collectOutcomeFunction.indexOf('_finalizeContracts(') < collectOutcomeFunction.indexOf('completeCompetition('),
  'competition contracts must finalize before the competition becomes terminal',
);

async function verifySupersededTransaction(): Promise<void> {
  const originalLog = console.log;
  const queries: Array<{ query: string; params: unknown[] }> = [];

  const transaction = async (schema: string, run: (client: any) => Promise<unknown>) => {
    assert.equal(schema, 'agent');
    const client = {
      query: async (query: string, params: unknown[] = []) => {
        queries.push({ query, params });
        if (/SELECT status, group_a_contract_ids/i.test(query)) {
          return {
            rowCount: 1,
            rows: [{ status: 'timeout', group_a_contract_ids: [101], group_b_contract_ids: [102] }],
          };
        }
        if (/SELECT id, agent_id/i.test(query)) {
          return {
            rowCount: 2,
            rows: [
              { id: 101, agent_id: 10, status: 'active' },
              { id: 102, agent_id: 11, status: 'completed' },
            ],
          };
        }
        if (/UPDATE agent\.contracts/i.test(query)) return { rowCount: 2, rows: [] };
        if (/UPDATE agent\.registry/i.test(query)) return { rowCount: 2, rows: [] };
        if (/UPDATE agent\.competitions/i.test(query)) return { rowCount: 1, rows: [] };
        throw new Error(`unexpected query: ${query}`);
      },
    };
    return run(client);
  };
  console.log = () => {};

  try {
    await competitionCollector._testOnly.markSuperseded(7, 'prior_topic_post_exists', {}, transaction);
  } finally {
    console.log = originalLog;
  }

  assert.equal(queries.length, 5);
  assert.match(queries[0].query, /SELECT status, group_a_contract_ids/i);
  assert.match(queries[1].query, /SELECT id, agent_id/i);
  assert.match(queries[2].query, /UPDATE agent\.contracts/i);
  assert.deepEqual(queries[2].params[2], [101]);
  assert.match(queries[3].query, /UPDATE agent\.registry/i);
  assert.deepEqual(queries[3].params[0], [10, 11]);
  assert.match(queries[4].query, /UPDATE agent\.competitions/i);
}

async function verifyCompleteContractTransaction(): Promise<void> {
  const queries: Array<{ query: string; params: unknown[] }> = [];
  let committed = false;
  const transaction = async (schema: string, run: (client: any) => Promise<unknown>) => {
    assert.equal(schema, 'agent');
    const result = await run({
      query: async (query: string, params: unknown[] = []) => {
        queries.push({ query, params });
        if (/UPDATE agent\.contracts/i.test(query)) {
          return { rowCount: 1, rows: [{ id: 501, agent_id: 10, status: 'completed', score_result: 8 }] };
        }
        if (/UPDATE agent\.registry/i.test(query)) return { rowCount: 1, rows: [] };
        throw new Error(`unexpected query: ${query}`);
      },
    });
    committed = true;
    return result;
  };

  const result = await (agentRegistry as any).completeContract(501, 8, transaction);
  assert.equal((result as any)?.id, 501);
  assert.equal(committed, true);
  assert.equal(queries.length, 2);
  assert.match(queries[0].query, /WHERE id = \$2\s+AND status = 'active'/);
  assert.match(queries[1].query, /UPDATE agent\.registry/i);
  assert.deepEqual(queries[1].params[0], [10]);

  let terminalQueryCount = 0;
  const terminalResult = await (agentRegistry as any).completeContract(502, 8, async (_schema: string, run: (client: any) => Promise<unknown>) => run({
    query: async () => {
      terminalQueryCount += 1;
      return { rowCount: 0, rows: [] };
    },
  }));
  assert.equal(terminalResult, null);
  assert.equal(terminalQueryCount, 1, 'terminal contract must not update registry state');

  let failedCommit = false;
  const failingTransaction = async (_schema: string, run: (client: any) => Promise<unknown>) => {
    const result = await run({
      query: async (query: string) => {
        if (/UPDATE agent\.contracts/i.test(query)) {
          return { rowCount: 1, rows: [{ id: 503, agent_id: 12, status: 'completed', score_result: 8 }] };
        }
        if (/UPDATE agent\.registry/i.test(query)) throw new Error('registry_update_failed');
        throw new Error(`unexpected query: ${query}`);
      },
    });
    failedCommit = true;
    return result;
  };
  await assert.rejects(
    (agentRegistry as any).completeContract(503, 8, failingTransaction),
    /registry_update_failed/,
  );
  assert.equal(failedCommit, false);
}

async function verifyCompetitionFailureRollsBackBeforeTerminalState(): Promise<void> {
  for (const target of [
    { name: 'superseded', status: 'timeout', run: (transaction: any) => competitionCollector._testOnly.markSuperseded(7, 'test', {}, transaction) },
    { name: 'timeout', status: 'running', run: (transaction: any) => competitionCollector._testOnly.markTimeout(8, 25, transaction) },
  ]) {
    const queries: string[] = [];
    let committed = false;
    const transaction = async (_schema: string, run: (client: any) => Promise<unknown>) => {
      const result = await run({
        query: async (query: string) => {
          queries.push(query);
          if (/SELECT status, group_a_contract_ids/i.test(query)) {
            return { rowCount: 1, rows: [{ status: target.status, group_a_contract_ids: [101], group_b_contract_ids: [] }] };
          }
          if (/SELECT id, agent_id/i.test(query)) {
            return { rowCount: 1, rows: [{ id: 101, agent_id: 10, status: 'active' }] };
          }
          if (/UPDATE agent\.contracts/i.test(query)) throw new Error(`${target.name}_contract_update_failed`);
          throw new Error(`unexpected query: ${query}`);
        },
      });
      committed = true;
      return result;
    };

    await assert.rejects(target.run(transaction), new RegExp(`${target.name}_contract_update_failed`));
    assert.equal(committed, false);
    assert.equal(queries.some((query) => /UPDATE agent\.competitions/i.test(query)), false);
  }
}

async function main(): Promise<void> {
  await verifyCompleteContractTransaction();
  await verifySupersededTransaction();
  await verifyCompetitionFailureRollsBackBeforeTerminalState();
  console.log(JSON.stringify({
    ok: true,
    protectsConcurrentActiveContracts: true,
    protectsCompetitionFinalization: true,
    finalizesSupersededCompetitionContracts: true,
    preservesTerminalCompetitionContracts: true,
    terminalizesCompetitionLast: true,
    verifiesAtomicSupersededSequence: true,
    verifiesAtomicTimeoutSequence: true,
    verifiesCompleteContractNoopForTerminalState: true,
    verifiesCompleteContractRollback: true,
    verifiesFailureBeforeCompetitionTerminalState: true,
    preservesNonActiveRegistryStates: true,
    dbWrite: false,
  }));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
