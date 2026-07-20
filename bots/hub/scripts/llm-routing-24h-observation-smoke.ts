#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { buildRoutingObservationReport } from './llm-routing-24h-observation';

const report = buildRoutingObservationReport([
  {
    selector_key: 'investment.nemesis',
    runtime_purpose: 'risk_eval',
    calls: 8,
    successes: 8,
    failures: 0,
    timeout_calls: 0,
    fallback_calls: 8,
    fallback_attempts: 8,
    quarantined_route_calls: 8,
    selected_routes: ['openai-oauth/gpt-5.4-mini'],
    first_seen: '2026-07-20T01:00:00.000Z',
    last_seen: '2026-07-20T10:00:00.000Z',
  },
  {
    selector_key: 'investment.luna',
    runtime_purpose: 'final_decision',
    calls: 12,
    successes: 12,
    failures: 0,
    timeout_calls: 0,
    fallback_calls: 0,
    fallback_attempts: 0,
    quarantined_route_calls: 0,
    selected_routes: ['openai-oauth/gpt-5.4'],
    first_seen: '2026-07-20T01:00:00.000Z',
    last_seen: '2026-07-20T10:00:00.000Z',
  },
  {
    selector_key: 'blog.writer',
    runtime_purpose: 'longform',
    calls: 100,
    successes: 100,
    failures: 0,
    timeout_calls: 0,
    fallback_calls: 0,
    fallback_attempts: 0,
    quarantined_route_calls: 0,
    selected_routes: ['claude-code/sonnet'],
  },
], {
  hours: 24,
  selectors: ['investment.nemesis', 'investment.chronos', 'investment.luna'],
  generatedAt: '2026-07-20T12:00:00.000Z',
});

assert.equal(report.ok, true);
assert.equal(report.liveMutation, false);
assert.equal(report.dbWrite, false);
assert.equal(report.externalCall, false);
assert.equal(report.status, 'degraded');
assert.equal(report.totals.calls, 20);
assert.equal(report.totals.fallbackCalls, 8);

const bySelector = Object.fromEntries(report.selectors.map((item) => [item.selectorKey, item]));
assert.equal(bySelector['investment.nemesis'].status, 'degraded');
assert.deepEqual(bySelector['investment.nemesis'].reasons, [
  'fallback_observed',
  'quarantined_route_observed',
]);
assert.equal(bySelector['investment.chronos'].status, 'no_sample');
assert.deepEqual(bySelector['investment.chronos'].reasons, ['no_sample']);
assert.equal(bySelector['investment.luna'].status, 'healthy');
assert.deepEqual(bySelector['investment.luna'].reasons, []);

const incomplete = buildRoutingObservationReport([
  {
    selector_key: 'investment.nemesis',
    runtime_purpose: 'risk_eval',
    calls: 4,
    successes: 4,
    failures: 0,
    timeout_calls: 0,
    fallback_calls: 0,
    fallback_attempts: 0,
    quarantined_route_calls: 0,
    selected_routes: ['groq/openai/gpt-oss-120b'],
  },
], {
  selectors: ['investment.nemesis', 'investment.chronos'],
  generatedAt: '2026-07-20T12:00:00.000Z',
});
assert.equal(incomplete.status, 'incomplete');
assert.equal(incomplete.selectors[0].status, 'healthy');
assert.equal(incomplete.selectors[1].status, 'no_sample');

console.log(JSON.stringify({
  ok: true,
  status: report.status,
  incompleteStatus: incomplete.status,
  selectors: report.selectors.map((item) => ({ selectorKey: item.selectorKey, status: item.status })),
  liveMutation: report.liveMutation,
}));
