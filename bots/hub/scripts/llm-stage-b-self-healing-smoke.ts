#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../../..');
const { buildSelfHealingPlan } = require('../lib/stage-b/stability.ts');

const fixture = {
  protected: {
    missing: ['ai.hub.resource-api'],
    idleExitWarnings: [
      {
        label: 'ai.hub.weekly-advisory-digest',
        exitStatus: '1',
        diagnostic: {
          dryRunCommand: 'npm --prefix bots/hub run -s alarm:weekly-advisory-digest:dry-run',
          tailCommand: 'tail -n 120 /tmp/hub-weekly-advisory-digest.err.log',
        },
      },
    ],
  },
  circuits: {
    nonClosed: 2,
  },
  budget: {
    emergency: true,
  },
  requestLog: {
    ok: false,
    operationalUnresolvedFailures: 1,
    diagnosticUnresolvedFailures: 1,
    unresolvedOperationalErrors: [
      {
        caller_team: 'darwin',
        agent: 'synthesis',
        runtime_purpose: 'proposal_generation',
        count: 2,
      },
    ],
    slowRoutes: [
      {
        route: 'openai-oauth/gpt-5.4',
        caller_team: 'luna',
        agent: 'reporter',
        runtime_purpose: 'edux_market_post_crypto',
        count: 6,
        avg_duration_ms: 45880,
        p95_duration_ms: 103533,
      },
      {
        route: 'openai-oauth/gpt-5.4',
        caller_team: 'blog',
        agent: 'neighbor-commenter',
        runtime_purpose: 'comment',
        count: 7,
        avg_duration_ms: 2932,
        p95_duration_ms: 3443,
      },
    ],
    recentErrors: [
      { error: 'fallback_exhausted: openai_codex_oauth_bad_request:Unsupported parameter: max_output_tokens' },
    ],
  },
  sentry: {
    mode: 'adapter_ready_config_pending',
  },
};

const plan = buildSelfHealingPlan(fixture);
assert.equal(plan.mode, 'read_only_by_default');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'tier_probe'), 'tier probe should be safe read-only recovery');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'request_log_diagnostics'), 'request log diagnostics should be read-only');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'diagnostic_llm_failure_review'), 'diagnostic failures should be separated from operational blockers');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'targeted_llm_route_drill' && item.command.includes('--teams=darwin') && item.command.includes('--agents=synthesis')), 'operational unresolved failures should produce concrete mock route drills');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'targeted_llm_route_drill' && item.liveCommand?.includes('team:agent-llm-drill:live')), 'operational unresolved failures should include a separate live evidence command');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'latency_hotspot_route_drill' && item.command.includes('--teams=luna') && item.command.includes('--agents=reporter')), 'latency hotspots should produce concrete mock route drills');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'latency_hotspot_route_drill' && item.liveCommand?.includes('team:agent-llm-drill:live')), 'latency hotspots should include a separate live evidence command');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'latency_hotspot_route_drill' && item.command.includes('--teams=blog') && item.command.includes('--agents=neighbor-commenter')), 'selector alias latency hotspots should produce concrete mock route drills');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'openai_codex_bad_request_guard_verification'), 'OpenAI 400 bad-request guard must have a read-only verification action');
assert(plan.safeReadOnlyActions.some((item) => item.action === 'expected_idle_exit_status_review' && item.command.includes('weekly-advisory-digest:dry-run')), 'expected-idle warnings should provide dry-run verification');
assert(plan.confirmRequiredActions.some((item) => item.action === 'protected_service_recovery'), 'protected service recovery must require confirmation');
assert(plan.confirmRequiredActions.some((item) => item.action === 'billing_guard_review'), 'BillingGuard emergency must require review');
assert(plan.prohibitedActions.some((item) => /kickstart|kill|unload/.test(item)), 'protected restart/kill/unload must be prohibited');

const unsafeCommands = [
  ...plan.safeReadOnlyActions.map((item) => item.command || ''),
].filter((command) => /\b(kill|bootout|unload|kickstart\s+-k)\b/.test(command));
assert.deepEqual(unsafeCommands, [], 'safe actions must never contain protected mutation commands');

const zeroTargetDrill = spawnSync(process.execPath, [
  '--import',
  'tsx',
  'bots/hub/scripts/multi-team-agent-llm-primary-fallback-drill.ts',
  '--teams=blog',
  '--agents=neighbor-commenter-missing',
  '--primary-only',
], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    HUB_MULTI_AGENT_LLM_DRILL_WRITE_REPORT: '0',
  },
});
assert.notEqual(zeroTargetDrill.status, 0, 'zero-target agent drill must fail closed');
assert.match(zeroTargetDrill.stdout, /agent_filter_matched_no_targets/, 'zero-target drill must expose filter miss evidence');

console.log(JSON.stringify({
  ok: true,
  stage: 'hub_stage_b',
  safe_actions: plan.safeReadOnlyActions.length,
  confirm_required: plan.confirmRequiredActions.length,
  prohibited: plan.prohibitedActions.length,
}, null, 2));
