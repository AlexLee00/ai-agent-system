'use strict';

const assert = require('assert');
const path = require('path');

const readinessPath = path.join(__dirname, '../scripts/darwin-autonomous-readiness.ts');

async function main() {
  delete require.cache[readinessPath];
  const readiness = require(readinessPath);

  const blocked = readiness.buildReadiness({
    total_cycles: 0,
    scanner_runs: 8,
    scanner_collected: 960,
    scanner_evaluated: 320,
    scanner_stored: 320,
    scanner_evaluation_failures: 6,
    scanner_alarm_failures: 3,
    scanner_summary_alarm_failures: 0,
    scanner_alarm_failure_reasons: 'rate_limit_cooldown',
    scanner_latest_high_relevance: 2,
    scanner_latest_alarm_sent: false,
    scanner_latest_alarm_bypassed: false,
    scanner_latest_alarm_failure: 'rate_limit_cooldown',
    scanner_registry_synced: 0,
    scanner_registry_sync_failures: 0,
    scanner_proposals: 14,
    scanner_verified: 14,
    autonomy_promotion_ready: false,
    autonomy_blocker: 'level L3/L5',
  }, {
    shadow_promotion_ready: false,
    shadow_match_rate: '22.8',
    shadow_blocker: 'avg_match 22.8%/95%',
  });

  assert.strictEqual(blocked.ok, true);
  assert.strictEqual(blocked.dryRun, true);
  assert.strictEqual(blocked.promotionReady, false);
  assert.strictEqual(blocked.checks.scanner_pipeline.ok, true);
  assert.strictEqual(blocked.checks.evaluation_stability.ok, true);
  assert.strictEqual(blocked.checks.alarm_delivery.ok, false);
  assert.strictEqual(blocked.checks.registry_sync.ok, false);
  assert.strictEqual(blocked.checks.shadow_gate.ok, false);
  assert.strictEqual(blocked.checks.autonomy_gate.ok, false);
  assert.ok(blocked.blockers.some((item: string) => item.includes('alarm_delivery')));
  assert.ok(blocked.blockers.some((item: string) => item.includes('shadow_gate')));
  assert.ok(blocked.warnings.some((item: string) => item.includes('no completed cycles')));

  const ready = readiness.buildReadiness({
    total_cycles: 3,
    scanner_runs: 3,
    scanner_collected: 30,
    scanner_evaluated: 20,
    scanner_stored: 20,
    scanner_evaluation_failures: 1,
    scanner_alarm_failures: 0,
    scanner_summary_alarm_failures: 0,
    scanner_latest_high_relevance: 0,
    scanner_latest_alarm_sent: false,
    scanner_latest_alarm_bypassed: false,
    scanner_latest_alarm_failure: '',
    scanner_registry_synced: 20,
    scanner_registry_sync_failures: 0,
    scanner_proposals: 2,
    scanner_verified: 2,
    autonomy_promotion_ready: true,
  }, {
    shadow_promotion_ready: true,
    shadow_match_rate: '96.0',
    shadow_blocker: 'none',
  });

  assert.strictEqual(ready.promotionReady, true);
  assert.deepStrictEqual(ready.blockers, []);

  console.log('✅ darwin autonomous readiness smoke ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
