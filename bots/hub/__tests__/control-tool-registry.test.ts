'use strict';

describe('hub control tool registry', () => {
  test('lists read-only tools and blocks mutating disabled tool', async () => {
    const {
      listHubControlTools,
      callHubControlTool,
    } = require('../lib/control/tool-registry.ts');

    const tools = listHubControlTools();
    expect(tools.some((tool) => tool.name === 'hub.health.query')).toBe(true);
    expect(tools.some((tool) => tool.name === 'launchd.restart')).toBe(true);

    const disabledResult = await callHubControlTool('launchd.restart', {}, { traceId: 't1' });
    expect(disabledResult.ok).toBe(false);
    expect(disabledResult.error).toBe('mutating_tool_disabled');
  });

  test('subagent policy blocks forbidden tools', async () => {
    const { callHubControlTool } = require('../lib/control/tool-registry.ts');
    const result = await callHubControlTool('subagent.validate', {
      contextSummary: 'incident triage',
      allowedTools: ['hub.health.query', 'send_telegram'],
      parentTools: ['hub.health.query', 'send_telegram'],
    }, {});

    expect(result.ok).toBe(true);
    expect(result.result.ok).toBe(false);
    expect(String(result.result.error || '')).toContain('subagent_blocked_tool');
  });
});
