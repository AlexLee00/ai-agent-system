'use strict';

const assert = require('assert');
const Module = require('module');

const monitorPath = '/Users/alexlee/projects/ai-agent-system/bots/darwin/lib/research-monitor.ts';

async function main() {
  const originalLoad = Module._load;
  const alarmCalls = [];

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../../../packages/core/lib/rag') {
      return { store: async () => {} };
    }
    if (request === '../../../packages/core/lib/pg-pool') {
      return {
        query: async () => [
          { metadata: { total_collected: 5, relevance_rate: 20, duration_sec: 120 } },
          { metadata: { total_collected: 6, relevance_rate: 22, duration_sec: 140 } },
          { metadata: { total_collected: 4, relevance_rate: 18, duration_sec: 100 } },
        ],
      };
    }
    if (request === '../../../packages/core/lib/openclaw-client') {
      return {
        postAlarm: async (payload) => {
          alarmCalls.push(payload);
        },
      };
    }
    if (request === '../../../packages/core/lib/kst') {
      return { today: () => '2026-04-17' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[monitorPath];
    const monitor = require(monitorPath);

    const metrics = monitor.collectMetrics({
      totalRaw: 12,
      total: 10,
      evaluated: 8,
      stored: 8,
      highRelevance: 2,
      alarmSent: true,
      proposals: 1,
      verified: 1,
    }, 90_000);

    assert.strictEqual(metrics.date, '2026-04-17');
    assert.strictEqual(metrics.total_collected, 10);
    assert.strictEqual(metrics.duplicate_rate, 17);
    assert.strictEqual(metrics.store_success_rate, 100);

    const healthyAlerts = await monitor.checkAnomalies({
      total_collected: 10,
      store_success_rate: 100,
      duration_sec: 90,
      relevance_rate: 25,
      alarm_sent: true,
      high_relevance: 2,
      proposals_generated: 1,
      proposal_pass_rate: 100,
      evaluated: 8,
    });
    assert.deepStrictEqual(healthyAlerts, []);
    assert.strictEqual(alarmCalls.length, 0);

    const unhealthyAlerts = await monitor.checkAnomalies({
      total_collected: 0,
      store_success_rate: 50,
      duration_sec: 400,
      relevance_rate: 2,
      alarm_sent: false,
      high_relevance: 1,
      proposals_generated: 2,
      proposal_pass_rate: 20,
      evaluated: 6,
    });
    assert.ok(unhealthyAlerts.length >= 5);
    assert.strictEqual(alarmCalls.length, 1);

    const trend = await monitor.weeklyTrend();
    assert.ok(String(trend).includes('주간 트렌드'));
    assert.ok(String(trend).includes('수집: 5건/일'));

    console.log('✅ darwin research monitor smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[monitorPath];
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
