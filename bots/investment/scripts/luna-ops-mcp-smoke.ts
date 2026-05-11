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
  const status = await callLunaOpsTool('luna_status', { fixture: true });
  assert.equal(status.status, 'luna_bottleneck_hard_blocked');
  assert.equal(status.protected6.labels.includes('ai.luna.tradingview-ws'), true);
  const applyPlan = await callLunaOpsTool('luna_apply_plan', { fixture: true });
  assert.equal(applyPlan.mode, 'read_only_plan');
  assert.equal(applyPlan.noLiveTradeExecution, true);
  assert.ok(applyPlan.safeFixCandidates.some((item) => item.id === 'repair_llm_hotpath_plan'));
  return { ok: true, tools: toolNames, status, applyPlan };
}

async function main() {
  const result = await runLunaOpsMcpSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna ops mcp smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-ops-mcp-smoke 실패:' });
}
