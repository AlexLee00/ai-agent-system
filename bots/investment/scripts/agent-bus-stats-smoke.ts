#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  buildAgentBusStatsFromRows,
  renderAgentBusStatsMarkdown,
} from '../shared/agent-bus-stats.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const rows = [
    { window: '24h', from_agent: 'luna', to_agent: 'argos', message_type: 'query', cnt: 3 },
    { window: '24h', from_agent: 'argos', to_agent: 'luna', message_type: 'response', cnt: 2 },
    { window: '7d', from_agent: 'hephaestos', to_agent: 'all', message_type: 'broadcast', cnt: 5 },
  ];
  const stats = buildAgentBusStatsFromRows(rows, { generatedAt: '2026-05-01T00:00:00.000Z' });
  assert.equal(stats.window24hMessages, 5);
  assert.equal(stats.window7dMessages, 5);
  assert.equal(stats.byAgent.luna.sent, 3);
  assert.equal(stats.byAgent.luna.received, 2);
  assert.equal(stats.byType.broadcast, 5);
  assert.equal(stats.topPairs[0].pair, 'hephaestos->all');
  const markdown = renderAgentBusStatsMarkdown(stats);
  assert.ok(markdown.includes('Luna Cross-Agent Bus Stats'));
  assert.ok(markdown.includes('hephaestos->all'));
  return { ok: true, stats, markdownLength: markdown.length };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ agent-bus-stats-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ agent-bus-stats-smoke 실패:' });
}
