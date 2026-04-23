#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  applyCollectionUniverseCompletenessGate,
  buildCollectionAuditRemediation,
  inferObservedCollectQuality,
} from './runtime-collection-audit.ts';

const explicit = inferObservedCollectQuality({
  explicitQuality: { status: 'degraded', readinessScore: 0.5, reasons: ['x'] },
  nodeCoverage: { nodeIds: ['L02', 'L03', 'L04', 'L06'], total: 10 },
  market: 'kis',
});
assert.equal(explicit.source, 'explicit_meta');
assert.equal(explicit.quality.status, 'degraded');

const domesticObserved = inferObservedCollectQuality({
  nodeCoverage: { nodeIds: ['L02', 'L03', 'L06'], total: 17 },
  market: 'kis',
});
assert.equal(domesticObserved.source, 'observed_node_coverage');
assert.equal(domesticObserved.quality.status, 'ready');
assert.equal(domesticObserved.quality.collectMode, 'observed_core');

const domesticObservedWithoutUniverse = applyCollectionUniverseCompletenessGate({
  quality: domesticObserved.quality,
  source: domesticObserved.source,
  market: 'kis',
  screeningUniverseCount: 0,
  maintenanceUniverseCount: 0,
  maintenanceProfiledCount: 0,
});
assert.equal(domesticObservedWithoutUniverse.status, 'degraded');
assert.equal(domesticObservedWithoutUniverse.reasons.includes('missing_collection_universe_meta'), true);

const domesticRemediation = buildCollectionAuditRemediation({
  market: 'kis',
  quality: domesticObservedWithoutUniverse,
  screeningUniverseCount: 0,
  maintenanceUniverseCount: 0,
  maintenanceProfiledCount: 0,
  collectQualitySource: 'observed_node_coverage',
});
assert.equal(domesticRemediation.status, 'needs_universe_refresh');
assert.equal(domesticRemediation.commands.research.includes('run domestic'), true);
assert.equal(domesticRemediation.commands.maintenance.includes('--markets=kis'), true);

const domesticObservedWithUniverse = applyCollectionUniverseCompletenessGate({
  quality: domesticObserved.quality,
  source: domesticObserved.source,
  market: 'kis',
  screeningUniverseCount: 3,
  maintenanceUniverseCount: 0,
  maintenanceProfiledCount: 0,
});
assert.equal(domesticObservedWithUniverse.status, 'ready');
assert.equal(buildCollectionAuditRemediation({ market: 'kis', quality: domesticObservedWithUniverse }).status, 'none');

const overseasObserved = inferObservedCollectQuality({
  nodeCoverage: { nodeIds: ['L02', 'L03', 'L04', 'L06'], total: 31 },
  market: 'kis_overseas',
});
assert.equal(overseasObserved.source, 'observed_node_coverage');
assert.equal(overseasObserved.quality.collectMode, 'observed_screening');

const missing = inferObservedCollectQuality({
  nodeCoverage: { nodeIds: ['L02'], total: 1 },
  market: 'binance',
});
assert.equal(missing.source, 'missing_meta');
assert.equal(missing.quality.status, 'unknown');

console.log('runtime collection audit smoke ok');
