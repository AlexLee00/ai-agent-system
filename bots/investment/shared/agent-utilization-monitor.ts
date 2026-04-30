// @ts-nocheck
export function summarizeAgentUtilization(events = [], { expectedAgents = [] } = {}) {
  const byAgent = {};
  for (const event of events) {
    const agent = String(event.agent || event.owner || 'unknown');
    byAgent[agent] ||= { count: 0, success: 0, failure: 0, lastAt: null };
    byAgent[agent].count += 1;
    if (event.ok === false || String(event.status).includes('fail')) byAgent[agent].failure += 1;
    else byAgent[agent].success += 1;
    byAgent[agent].lastAt = event.createdAt || event.at || byAgent[agent].lastAt;
  }
  const missingAgents = expectedAgents.filter((agent) => !byAgent[agent]);
  return {
    ok: true,
    totalEvents: events.length,
    activeAgents: Object.keys(byAgent).length,
    missingAgents,
    byAgent,
    warnings: missingAgents.length ? [`missing_agents:${missingAgents.join(',')}`] : [],
  };
}

export default { summarizeAgentUtilization };
