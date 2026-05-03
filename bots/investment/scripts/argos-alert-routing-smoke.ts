#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { classifyCollectAlertRoute } from '../shared/pipeline-market-runner.ts';

const capacityRoute = classifyCollectAlertRoute(
  '암호화폐 수집',
  ['collect_overload_detected', 'debate_capacity_hot', 'weak_signal_pressure'],
  {
    collectQuality: { status: 'degraded', readinessScore: 0.72 },
    failedCoreTasks: 0,
    failedHardCoreTasks: 0,
    failedEnrichmentTasks: 0,
    llmGuardFailedTasks: 0,
  },
);
assert.equal(capacityRoute.visibility, 'digest');
assert.equal(capacityRoute.alarm_type, 'report');
assert.match(capacityRoute.incident_key, /capacity_watch$/);

const enrichmentRoute = classifyCollectAlertRoute(
  '암호화폐 수집',
  ['enrichment_collect_failure_rate_high'],
  {
    collectQuality: { status: 'degraded', readinessScore: 0.61 },
    failedCoreTasks: 0,
    failedHardCoreTasks: 0,
    failedEnrichmentTasks: 5,
    llmGuardFailedTasks: 0,
  },
);
assert.equal(enrichmentRoute.visibility, 'digest');
assert.equal(enrichmentRoute.alarm_type, 'report');
assert.match(enrichmentRoute.incident_key, /degraded_enrichment$/);

const coreFailureRoute = classifyCollectAlertRoute(
  '암호화폐 수집',
  ['core_collect_failure_rate_high'],
  {
    collectQuality: { status: 'insufficient', readinessScore: 0.18 },
    failedCoreTasks: 4,
    failedHardCoreTasks: 2,
    failedEnrichmentTasks: 0,
    llmGuardFailedTasks: 0,
  },
);
assert.equal(coreFailureRoute.visibility, 'notify');
assert.equal(coreFailureRoute.alarm_type, 'error');
assert.match(coreFailureRoute.incident_key, /core_failure$/);

console.log('argos alert routing smoke ok');
