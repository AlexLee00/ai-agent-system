'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const scannerPath = path.join(__dirname, '../lib/research-scanner.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const forbiddenCalls: string[] = [];
  const storedMetrics: unknown[] = [];
  let ragStores = 0;
  let registryRuns = 0;

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === './arxiv-client') {
      return {
        DOMAIN_KEYWORDS: { neuron: ['agent'] },
        searchByDomain: async () => [
          { arxiv_id: 'observe-high', title: 'Observe High', summary: 'agent paper', domain: 'neuron', source: 'arxiv' },
          { arxiv_id: 'observe-low', title: 'Observe Low', summary: 'low paper', domain: 'neuron', source: 'arxiv' },
        ],
      };
    }
    if (request === './hf-papers-client') {
      return { HF_KEYWORDS: [], fetchTrending: async () => [], searchByKeyword: async () => [] };
    }
    if (request === './research-evaluator') {
      let evalCall = 0;
      return {
        evaluatePaper: async () => {
          evalCall += 1;
          return evalCall === 1
            ? { korean_summary: 'high summary', relevance_score: 8, reason: 'relevant' }
            : { korean_summary: 'low summary', relevance_score: 3, reason: 'low relevance' };
        },
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
        collectMetrics: (result: any) => ({
          ...result,
          high_relevance: result.highRelevance,
          alarm_sent: result.alarmSent,
          alarm_failure: result.alarmFailure,
          alarm_bypassed: result.alarmBypassed,
        }),
        storeMetrics: async (metrics: unknown) => storedMetrics.push(metrics),
        checkAnomalies: async () => forbiddenCalls.push('monitor.checkAnomalies'),
        weeklyTrend: async () => '',
      };
    }
    if (request === './research-tasks') {
      return { hasTaskForRepo: () => false, createTask: () => forbiddenCalls.push('researchTasks.createTask') };
    }
    if (request === '../../../packages/core/lib/rag') {
      return {
        initSchema: async () => {},
        store: async () => { ragStores += 1; },
        storeExperience: async () => { ragStores += 1; },
      };
    }
    if (request === '../../../packages/core/lib/pg-pool') {
      return {
        run: async () => { registryRuns += 1; },
        query: async () => [],
      };
    }
    if (request === '../../../packages/core/lib/event-lake') {
      return { recordEvent: async () => {} };
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
      return { datetimeStr: () => '2026-05-04 07:00:00', today: () => '2026-05-04' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[scannerPath];
    const scanner = require(scannerPath);
    const result = await scanner.run({ observeOnly: true, maxEvaluations: 2 });

    assert.strictEqual(result.dryRun, false);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.evaluated, 2);
    assert.strictEqual(result.stored, 2);
    assert.strictEqual(result.highRelevance, 1);
    assert.strictEqual(result.alarmSent, false);
    assert.strictEqual(result.alarmFailure, 'observe_only');
    assert.strictEqual(result.alarmBypassed, true);
    assert.strictEqual(result.proposals, 0);
    assert.strictEqual(result.registrySynced, 2);
    assert.strictEqual(result.registrySyncFailures, 0);
    assert.ok(ragStores >= 2);
    assert.strictEqual(registryRuns, 2);
    assert.strictEqual(storedMetrics.length, 1);
    assert.deepStrictEqual(forbiddenCalls, []);

    console.log('✅ darwin research scanner observe-only smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[scannerPath];
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
