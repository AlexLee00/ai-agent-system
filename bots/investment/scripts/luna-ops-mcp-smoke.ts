#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { LUNA_OPS_MCP_TOOLS, callLunaOpsTool } from '../mcp/luna-ops-mcp/src/server.ts';

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
