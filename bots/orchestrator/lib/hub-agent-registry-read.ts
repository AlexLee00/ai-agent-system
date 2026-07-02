// @ts-nocheck

type RegistryStats = {
  agentCount: number;
  teamCount: number;
};

type ShadowOptions = {
  fetchFn?: typeof fetch;
  log?: Pick<Console, 'log' | 'warn'>;
};

function enabled(): boolean {
  return process.env.ORCH_REGISTRY_VIA_HUB === 'true';
}

function hubBaseUrl(): string {
  return String(process.env.HUB_BASE_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');
}

function authHeaders(): Record<string, string> {
  const token = String(process.env.HUB_AUTH_TOKEN || '').trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function normalizeStats(body: any): RegistryStats | null {
  const stats = body?.stats || body?.summary || body?.dashboard?.stats || {};
  const rows = Array.isArray(body?.agents)
    ? body.agents
    : (Array.isArray(body?.rows) ? body.rows : []);
  const agentCount = Number(
    stats.agentCount
      ?? stats.agent_count
      ?? stats.totalAgents
      ?? stats.total_agents
      ?? stats.total
      ?? rows.length
      ?? 0,
  );
  const teamCount = Number(
    stats.teamCount
      ?? stats.team_count
      ?? stats.teams
      ?? new Set(rows.map((row: any) => row?.team).filter(Boolean)).size
      ?? 0,
  );
  if (!Number.isFinite(agentCount) || agentCount <= 0) return null;
  return { agentCount, teamCount: Number.isFinite(teamCount) ? teamCount : 0 };
}

async function fetchHubJson(path: string, fetchFn: typeof fetch): Promise<any> {
  const response = await fetchFn(`${hubBaseUrl()}${path}`, {
    method: 'GET',
    headers: authHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`hub_registry_read_failed:${path}:${response.status}`);
  return response.json();
}

export async function shadowRegistryStatsViaHub(
  localStats: RegistryStats,
  options: ShadowOptions = {},
): Promise<RegistryStats> {
  if (!enabled()) return localStats;
  const fetchFn = options.fetchFn || fetch;
  const log = options.log || console;
  try {
    const [dashboard, agents] = await Promise.all([
      fetchHubJson('/hub/agents/dashboard', fetchFn).catch((error) => ({ error })),
      fetchHubJson('/hub/agents', fetchFn).catch((error) => ({ error })),
    ]);
    const hubStats = normalizeStats(dashboard) || normalizeStats(agents);
    if (!hubStats) {
      log.warn('[orch-registry-dual-read] hub_stats_unavailable');
      return localStats;
    }
    const diff = {
      agentCount: hubStats.agentCount - localStats.agentCount,
      teamCount: hubStats.teamCount - localStats.teamCount,
    };
    log.log('[orch-registry-dual-read]', JSON.stringify({
      mode: 'shadow',
      matched: diff.agentCount === 0 && diff.teamCount === 0,
      local: localStats,
      hub: hubStats,
      diff,
    }));
  } catch (error) {
    log.warn('[orch-registry-dual-read] skipped:', error instanceof Error ? error.message : String(error));
  }
  return localStats;
}

export const _testOnly = {
  normalizeStats,
  enabled,
};
