'use strict';

const assert = require('assert');
const Module = require('module');

const scannerPath = '/Users/alexlee/projects/ai-agent-system/bots/darwin/lib/research-scanner.ts';

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const forbiddenCalls: string[] = [];

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === './arxiv-client') {
      return {
        DOMAIN_KEYWORDS: { neuron: ['agent'], gear: ['monitoring'] },
        searchByDomain: async (domain: string) => [{
          arxiv_id: `dry-${domain}`,
          title: `Dry Run ${domain}`,
          summary: 'dry run paper',
          domain,
          source: 'arxiv',
        }],
      };
    }
    if (request === './hf-papers-client') {
      return {
        HF_KEYWORDS: ['agent'],
        fetchTrending: async () => [],
        searchByKeyword: async () => [],
      };
    }
    if (request === './research-evaluator') {
      return {
        evaluatePaper: async () => ({
          korean_summary: 'dry run summary',
          relevance_score: 8,
          reason: 'dry run',
        }),
      };
    }
    if (request === './applicator') {
      return { apply: async () => forbiddenCalls.push('applicator.apply') };
    }
    if (request === './keyword-evolver') {
      return { suggestKeywords: async () => [] };
    }
    if (request === './research-monitor') {
      return {
        collectMetrics: (result: unknown) => result,
        storeMetrics: async () => forbiddenCalls.push('monitor.storeMetrics'),
        checkAnomalies: async () => forbiddenCalls.push('monitor.checkAnomalies'),
        weeklyTrend: async () => '',
      };
    }
    if (request === './research-tasks') {
      return {
        hasTaskForRepo: () => false,
        createTask: () => forbiddenCalls.push('researchTasks.createTask'),
      };
    }
    if (request === '../../../packages/core/lib/rag') {
      return {
        initSchema: async () => forbiddenCalls.push('rag.initSchema'),
        store: async () => forbiddenCalls.push('rag.store'),
        storeExperience: async () => forbiddenCalls.push('rag.storeExperience'),
      };
    }
    if (request === '../../../packages/core/lib/event-lake') {
      return { recordEvent: async () => forbiddenCalls.push('eventLake.recordEvent') };
    }
    if (request === '../../../packages/core/lib/agent-registry') {
      return { getAgentsByTeam: async () => [] };
    }
    if (request === '../../../packages/core/lib/hiring-contract') {
      return { selectBestAgent: async () => null };
    }
    if (request === '../../../packages/core/lib/github-client') {
      return {};
    }
    if (request === '../../../packages/core/lib/hub-alarm-client') {
      return { postAlarm: async () => forbiddenCalls.push('postAlarm') };
    }
    if (request === '../../../packages/core/lib/central-logger') {
      return { createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }) };
    }
    if (request === '../../../packages/core/lib/kst') {
      return { datetimeStr: () => '2026-05-03 07:00:00', today: () => '2026-05-03' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[scannerPath];
    const scanner = require(scannerPath);
    const result = await scanner.run({ dryRun: true, maxEvaluations: 2 });

    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.evaluated, 2);
    assert.strictEqual(result.stored, 0);
    assert.strictEqual(result.experiencesStored, 0);
    assert.strictEqual(result.alarmSent, false);
    assert.strictEqual(result.proposals, 0);
    assert.deepStrictEqual(forbiddenCalls, []);
    console.log('✅ darwin research scanner dry-run smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[scannerPath];
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
