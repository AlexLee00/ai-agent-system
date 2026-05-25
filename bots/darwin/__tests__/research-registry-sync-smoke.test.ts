'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const scannerPath = path.join(__dirname, '../lib/research-scanner.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const runs: Array<{ schema: string; sql: string; params: unknown[] }> = [];
  let failWrites = false;

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === './arxiv-client') return { DOMAIN_KEYWORDS: {}, searchByDomain: async () => [] };
    if (request === './hf-papers-client') return { HF_KEYWORDS: [], fetchTrending: async () => [], searchByKeyword: async () => [] };
    if (request === './research-evaluator') return { evaluatePaper: async () => ({}) };
    if (request === './applicator') return { apply: async () => ({}) };
    if (request === './keyword-evolver') return { suggestKeywords: async () => [] };
    if (request === './research-monitor') return { weeklyTrend: async () => '' };
    if (request === './research-tasks') return { hasTaskForRepo: () => false, createTask: () => null };
    if (request === '../../../packages/core/lib/github-client') return {};
    if (request === '../../../packages/core/lib/rag') return {};
    if (request === '../../../packages/core/lib/event-lake') return { record: async () => null };
    if (request === '../../../packages/core/lib/agent-registry') return { getAgentsByTeam: async () => [] };
    if (request === '../../../packages/core/lib/hiring-contract') return { selectBestAgent: async () => null };
    if (request === '../../../packages/core/lib/hub-alarm-client') return { postAlarm: async () => ({ ok: true }) };
    if (request === '../../../packages/core/lib/central-logger') {
      return { createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) };
    }
    if (request === '../../../packages/core/lib/kst') {
      return { datetimeStr: () => '2026-05-03 07:00:00', today: () => '2026-05-03' };
    }
    if (request === '../../../packages/core/lib/pg-pool') {
      return {
        run: async (schema: string, sql: string, params: unknown[] = []) => {
          if (failWrites) throw new Error('registry unavailable');
          runs.push({ schema, sql, params });
          return { rowCount: 1, rows: [] };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[scannerPath];
    const scanner = require(scannerPath);
    const result = await scanner._testOnly_syncResearchRegistry([
      {
        arxiv_id: 'p-high',
        title: 'High value paper',
        source: 'arxiv',
        relevance_score: 8,
        reason: 'useful',
        domain: 'neuron',
        authors: 'Ada, Turing',
        keyword: 'agent',
      },
      {
        arxiv_id: 'p-normal',
        title: 'Normal paper',
        source: 'huggingface',
        relevance_score: 5,
        domain: 'gear',
      },
      {
        arxiv_id: 'p-failed',
        title: 'Failed evaluation',
        source: 'arxiv',
        relevance_score: 0,
        evaluation_failed: true,
        failure_code: 'paper_evaluation_parse_failed',
      },
    ], [{ arxiv_id: 'p-high', proposal: 'proposal text', verification: { passed: true } }]);

    assert.deepStrictEqual(result, { synced: 3, failures: 0 });
    assert.strictEqual(runs.length, 3);
    assert.ok(runs.every((run) => run.schema === 'public'));
    assert.ok(runs.every((run) => String(run.sql).includes('ON CONFLICT (paper_id) DO UPDATE')));
    assert.strictEqual(runs[0].params[0], 'p-high');
    assert.strictEqual(runs[0].params[6], 'planned');
    assert.deepStrictEqual(runs[0].params[2], ['Ada', 'Turing']);
    assert.strictEqual(runs[1].params[6], 'evaluated');
    assert.strictEqual(runs[2].params[6], 'discovered');
    assert.strictEqual(JSON.parse(String(runs[2].params[8])).failure_code, 'paper_evaluation_parse_failed');

    failWrites = true;
    const failed = await scanner._testOnly_syncResearchRegistry([{ arxiv_id: 'p-error', title: 'Broken' }], []);
    assert.deepStrictEqual(failed, { synced: 0, failures: 1 });
    console.log('✅ darwin research registry sync smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[scannerPath];
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
