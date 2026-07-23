#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_OPS_MCP_TOOLS,
  callLunaOpsTool,
  callLunaOpsToolWithTimeout,
  installShutdownHandlers,
  startServer,
} from '../mcp/luna-ops-mcp/src/server.ts';

async function assertServerLifecycle() {
  const started = await startServer({ port: 0 });
  try {
    const response = await fetch(`http://${started.host}:${started.port}/health`);
    const health = await response.json();
    assert.equal(response.status, 200);
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'read_only');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }

  const processRef = new EventEmitter();
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  let closeCalls = 0;
  const server = {
    close(callback) {
      closeCalls += 1;
      callback();
    },
    closeIdleConnections() {},
  };
  installShutdownHandlers(server, { processRef, timeoutMs: 100 });
  processRef.emit('SIGTERM');
  processRef.emit('SIGINT');
  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, [0]);
}

export async function runLunaOpsMcpSmoke() {
  const toolNames = LUNA_OPS_MCP_TOOLS.map((tool) => tool.name);
  assert.ok(toolNames.includes('luna_status'));
  assert.ok(toolNames.includes('luna_bottlenecks'));
  assert.ok(toolNames.includes('luna_llm_usage'));
  assert.ok(toolNames.includes('luna_guardrails'));
  assert.ok(toolNames.includes('luna_apply_plan'));
  assert.ok(toolNames.includes('luna_phase5_mcp_bridge'));
  assert.ok(toolNames.includes('luna_phase5_shadow_plan'));
  const status = await callLunaOpsTool('luna_status', { fixture: true });
  assert.equal(status.status, 'luna_bottleneck_hard_blocked');
  assert.equal(status.protected6.labels.includes('ai.luna.tradingview-ws'), true);
  const applyPlan = await callLunaOpsTool('luna_apply_plan', { fixture: true });
  assert.equal(applyPlan.mode, 'read_only_plan');
  assert.equal(applyPlan.noLiveTradeExecution, true);
  assert.ok(applyPlan.safeFixCandidates.some((item) => item.id === 'repair_llm_hotpath_plan'));
  const phase5Bridge = await callLunaOpsTool('luna_phase5_mcp_bridge', { fixture: true });
  assert.equal(phase5Bridge.toolCount, 12);
  assert.equal(phase5Bridge.directTradeAllowed, false);
  const phase5Plan = await callLunaOpsTool('luna_phase5_shadow_plan', { fixture: true });
  assert.equal(phase5Plan.noLiveTradeExecution, true);
  assert.equal(phase5Plan.summary.mcpTools, 12);
  await assert.rejects(
    callLunaOpsToolWithTimeout('luna_status', {}, {
      timeoutMs: 10,
      callTool: () => new Promise(() => {}),
    }),
    /luna_ops_tool_timeout:luna_status:100/,
  );
  await assertServerLifecycle();
  return {
    ok: true,
    tools: toolNames,
    fixtureStatus: {
      ...status,
      current: false,
      fixture: true,
      note: 'regression fixture only; do not treat as live operator state',
    },
    applyPlan,
    phase5Bridge: {
      toolCount: phase5Bridge.toolCount,
      directTradeAllowed: phase5Bridge.directTradeAllowed,
    },
    phase5Plan: phase5Plan.summary,
  };
}

async function main() {
  const result = await runLunaOpsMcpSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna ops mcp smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-ops-mcp-smoke 실패:' });
}
